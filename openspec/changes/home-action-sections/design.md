## Context

See `proposal.md` — Why. The detail renders actions from `actionsFor(worktree)` grouped by `DetailSection`, while the selection index maps over `detailEntries()`; any regrouping must keep the action ordering, `detailEntries`, and the render order in lockstep. The specs browser's Actions menu is a list of dispatchable `MenuItem`s whose default selection is the first enabled entry.

## Goals / Non-Goals

**Goals:**
- Toolchain-aligned action sections; `New run` always reachable; explicit-selection archive from Home and the specs browser.

**Non-Goals:**
- No behavior change to the underlying operations or their guards.
- No archive-by-discovery; the operator always names the change.

## Decisions

**D1 — Runs section with a leading New run row.** The pipeline launcher becomes `New run` and is the first selectable row of the `Runs` section, with the recent-runs list beneath it. Section headings stay plain headings. Rationale: the run entry is a launcher, not an observation, so it leads the runs it produces while keeping every header purely a header.

**D2 — OpenSpec section sits directly above Linked Specs.** Propose/Archive/Close are grouped with the spec observation they act on, and `git` keeps its guarded operations above. Rationale: the operator reads change work next to the changes it concerns.

**D3 — Archive is an explicit selection.** `runArchive` never discovers changes, so Home opens `change-picker-tui` over the checkout's own active changes and then runs `runWorktreeArchive` (which shows a notice instead of raw stdout); the specs browser emits an `archive-change` resolution for the selected change. Rationale: preserves the operation's explicitness contract.

## Risks / Trade-offs

- [Reordering changes the selection indices] → action ordering, `detailEntries`, and render order are kept in lockstep; tests pin the section order and entry counts.
- [Adding archive changes the specs-browser menu's default selection] → on a detached checkout archive is the first enabled entry, so Enter runs archive; the blocked-close test now moves the selection explicitly onto close.
