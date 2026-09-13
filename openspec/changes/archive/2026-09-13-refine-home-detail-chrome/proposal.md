## Why

The worktree detail screen buries the checkout's own context: the block that says which branch, writer, path, and upstream the operator is working in is painted like everything else, so the active checkout does not read as a distinct working zone. The Linked Specs observation also sits below the git actions that have nothing to do with it, and it renders an empty state even when the checkout has no linked changes.

## What Changes

- Paint the detail's checkout identity — folder basename, path, branch, and the linked pull request — as one solid light-blue (accent) zone, so the working context is visually separated from the remaining observations and the action sections. The other observed facts (writer, dirt, upstream, base, activity, change counts, and the lock/prunable/inaccessible states) stay plain beneath it.
- Remove the leading indent from the Runs section's `no runs recorded for this checkout` empty line.
- Move the Linked Specs observation to immediately follow the OpenSpec action section (before git), in both render order and selection order.
- Hide the Linked Specs section entirely when the checkout has no linked changes; an unreadable change list (`changesUnknown`) still renders its `unknown — <reason>` observation, because unknown is not none.
- **BREAKING** (spec-level): the `home-launcher` requirement currently mandates that the Linked Specs observation follows the git section; this reverses that order and gates the section on having linked changes.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `home-launcher`: the worktree detail's checkout identity, path, branch, and linked PR render as a distinct highlighted zone; the Linked Specs observation follows the OpenSpec section and is hidden when the checkout has no linked changes.

## Impact

- `src/home-tui.ts`: `detailLines()` (identity-zone fill — name/path/branch/PR —, Runs empty-line indent, Linked Specs placement and emptiness gate), `detailEntries()` (selection order must stay in lockstep with render order).
- Tests: `test/home-tui.test.ts` (the accent identity zone and its plain facts, the Runs empty line, the section order, and the down-count that reaches a linked change).
- No handler, guard, key, label, or resolution changes; every action keeps its behavior and its enabled/blocked state.
