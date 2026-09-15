## Context

See `proposal.md` for motivation. Current state that shapes the approach:

- The launcher's contract picker is inline in `src/launch-tui.ts` (`handleContractKey`, `acceptContract`, `contractDetail`) and pins exactly one change into `selectedChangeIds`.
- The archive picker is a standalone component, `src/change-picker-tui.ts`, returning `{ kind: "select", changeId }`; `src/cli.ts` wraps it as `[choice.changeId]`.
- Selection downstream already accepts ordered lists: `enabledFlags` emits one `--change` per id, `runSelection.changes` feeds the run plan, `resolveChange`/`loadOpenSpecBundle` preserve order and dedupe, and `archiveSelectedChanges` journals one step per change and commits the batch.
- `src/change-selection.ts` already models `SelectedChangeInput[]`, validation, and freezing, but is only exercised by tests; the interactive surfaces never produce more than one entry.

## Goals / Non-Goals

**Goals:**

- Make the existing 0..N ordered selection reachable from both TUI pickers (all / several / one / none).
- Open the launcher prompt step focused on the first active change, consistently on first open and re-entry.
- Preserve the explicit-acceptance invariant: nothing attaches without an explicit confirm.

**Non-Goals:**

- No downstream run-plan, bundle-resolution, archive-journal, or headless `--change` changes.
- No arbitrary reorder affordance in the TUI (order is the picker's listing order).
- No new "auto-attach" mode: the change is attached on confirm, never on open.
- No unification of the two pickers into one shared component (they keep separate rendering).

## Decisions

### D1: Keys — `space` toggles, `a` selects all, `enter` confirms, the no-change row is "none"

Both pickers gain `space` to toggle the highlighted row and `a` to mark every active change. The launcher keeps its `Manual prompt` row as the explicit no-change gesture rather than adding a hidden "none" key, so the manual/no-change mode stays a visible, deliberate row. Alternatives: a separate `n` key for none (rejected: hides the explicit decision); `enter`-to-toggle (rejected: breaks the existing confirm gesture).

### D2: Multiple selection is ordered by the picker listing

A confirmed multi-selection is ordered by the active-change listing (alphabetical, as `listOpenSpecChanges` returns it), not by toggle order. This is deterministic, matches select-all, and keeps the visible list order equal to the reviewed order. Alternative: toggle order with numeric badges (rejected by the operator as irrelevant). The headless CLI still preserves a verbatim `--change` sequence; that path is unchanged.

### D3: `enter` semantics — confirm marks, else pin the highlighted row

If any row is marked, `enter` confirms the marked set. If nothing is marked, `enter` pins the highlighted row only: the no-change row selects manual/no-change mode, a spec row attaches just that change. This keeps today's single-pick behavior (and makes the focused-first-change flow attach with one `enter`) while adding multi-select on top.

### D4: One focus rule across every entry path

`openPrompt`, the options-step `p`/`escape` return, and the prompt-editor `escape` return all compute the picker highlight with the same rule: if a selection exists, first selected change; else if active changes exist, the first active change; else the no-change row. The rule is centralized so the three paths cannot drift.

### D5: Shape changes are minimal and local

The launcher keeps `selectedChangeIds: string[]`. The archive picker's result becomes `{ kind: "select", changeIds: string[] } | { kind: "cancel" }`, and the `src/cli.ts` call site passes that batch to `runWorktreeArchive`. Downstream signatures already accept a list.

### D6: Pure selection helpers, unit-tested

Toggle, select-all, and "confirm in listing order" are extracted as pure functions so the multi-select behavior is testable without the renderer; the TUI layers call them. This mirrors the existing pure/it's-I/O-free split used by `resolveChange`.

## Risks / Trade-offs

- [The default `enter` now attaches the first change instead of opening the manual editor] → Accepted per the request; attachment still requires an explicit `enter`, the highlight is visible, and the resulting prompt/notice names the change.
- [A marked set can look reordered relative to toggle order] → Ordering is always the visible listing order, so the marks and the reviewed order agree.
- [Footer counters and picker notices still say "pick one"] → Update the picker intro, footer counter, and the OpenSpec notice alongside the behavior; cover with TUI tests.
- [Archive confirms with nothing marked] → Keep the confirm a no-op that does not report success, and test it.

## Migration Plan

No data or config migration. Rollback is reverting the UI changes; the downstream ordered-selection support predates this change and stays.

## Open Questions

None.
