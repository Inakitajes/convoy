## Context

See `proposal.md` — Why. The specs browser polls the shared board source every five seconds (`src/specs-browser.ts`), the same `BoardSource` cadence Home uses. Home's `applySnapshot()` already re-derives its open worktree detail from the refreshed inventory and falls back to the list with an explanation when the subject disappears (`src/home-tui.ts`). The specs browser's `refresh()` re-anchors only the root row selection and then clears the lazily loaded artifact bodies (`bodies`) and rendered documents (`docs`) without reloading the subject open in the reading pane.

The reading pane is a separate level (`level: "root" | "detail"`) whose state is `subject`, `groups`, `selectedGroup`, `detailScroll`, and `fullscreen`. A subject is entered by `enterSelected()`, which loads the active group through `loadSelectedGroup()`. The render path paints the loading branch whenever a group entry is not yet in `bodies`.

## Goals / Non-Goals

**Goals:**

- A refresh never leaves the reading pane empty; it reloads the open subject's active group before repainting.
- External edits to the open subject's checkout appear in the pane within the refresh cadence.
- The active tab, scroll position, and fullscreen state survive a refresh.
- A subject removed externally returns to the root list with identity-restored selection.

**Non-Goals:**

- Changing the refresh cadence, the fingerprint gating, or the shared `BoardSource`.
- Changing Home's worktree detail behavior (already correct).
- Per-artifact fingerprint/mtime tracking in the reader; a group reload on each cycle is sufficient and bounded (one subject, one group).
- Preserving the reader across a *forced* invalidation differently than a scheduled one; both follow this path.

## Decisions

### D1 — Re-derive and reload the open subject on refresh (chosen)

In `refresh()`, after the view is rebuilt and the root selection re-anchored, when `level === "detail"` and a subject is set: re-derive the subject and its `groups` from the refreshed view, then reload the active group before `render()`.

- *Alternative — never clear `bodies`/`docs` on a gated refresh:* smaller diff, but the `bodies` map is keyed by file path and would keep pre-edit content indefinitely, defeating the live-refresh intent and contradicting the spec's "external edit appears" scenario. Rejected.
- *Alternative — per-artifact fingerprint gating in the reader:* more machinery than the case warrants for a single open subject. Rejected.

This mirrors Home's proven `applySnapshot()` pattern, keeping the two board surfaces symmetric.

### D2 — Await the group reload inside the refresh cycle, then paint once

The current cycle clears the maps, then renders synchronously, which is why the loading branch is visible. The reload must be awaited before the single `render()` that concludes the cycle, so no blank/loading frame is ever presented to the operator. The existing asynchronous `loadSelectedGroup().then(render)` used by tab switching stays as is for key-driven navigation.

### D3 — Rebuild `subject` and `groups` from the refreshed view

For a change subject, find the change by id and checkout in the refreshed rows and rebuild `groups` via `groupChangeArtifacts`; for a spec subject, confirm the path still exists and keep the single group. This keeps the artifacts list current (a newly added artifact group appears; a removed one disappears) rather than holding the entry captured on entry.

### D4 — Preserve reading context by re-deriving, not resetting

Keep `selectedGroup` (clamped to the new groups length), keep `detailScroll` (the render path already clamps it to the rendered length), and keep `fullscreen`. Do not reset scroll or copy status on a refresh — only an explicit tab change resets scroll and copy status today.

### D5 — Subject disappearance falls back to the root list

When the refreshed view no longer contains the subject, call `leaveSubject()` (which clears `subject`, sets `level = "root"`, and drops `fullscreen`/menu state) after the existing identity re-anchor has restored the nearest selectable row. Never blank the pane and never retarget to a different subject.

### D6 — Failure path is untouched

The `catch` branch already returns before clearing the maps, so a failed refresh retains both the view and the loaded pane content. This change does not alter it, satisfying the "failed refresh keeps the pane" scenario without new code.

## Risks / Trade-offs

- [Stale body after an edit if `bodies` were retained] → We still clear `bodies` each cycle, so the reload reads current bytes; `docs` is content-keyed and self-invalidating.
- [Flicker or an extra frame] → The reload is awaited before the cycle's single `render()`; the loading branch only shows for a genuinely in-flight initial load.
- [Async race with a coalesced forced refresh] → The existing `refreshing`/`pendingForce` guard already serializes cycles; the subject reload happens inside the same guarded cycle, so the trailing forced cycle simply repeats it.
- [Cost per cycle] → One subject, one active group (a handful of small markdown files) re-read every five seconds; negligible next to the board refresh the cycle already performs, and Home already re-derives its detail each cycle.
- [Change archived externally while reading] → Falls back to the root list by identity, disclosed by the restored selection rather than an empty pane.

## Migration Plan

No persisted state, API, or data migration. Ship as a behavior fix; rollback is reverting the change. Existing readers and tests that do not exercise a detail-level refresh are unaffected.
