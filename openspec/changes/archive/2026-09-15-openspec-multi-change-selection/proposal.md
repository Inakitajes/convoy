## Why

The run launcher and the archive picker only let the operator select exactly one active OpenSpec change, but the specs already require an ordered list of zero or more (`run-launcher`: "an operator-selected ordered list of zero or more active local OpenSpec changes"; `worktree-operations`: "an explicitly reviewed ordered batch"). The selection plumbing downstream (`selectedChangeIds: string[]`, `--change` repeated, `resolveChange`, `loadOpenSpecBundle`, `archiveSelectedChanges`) already handles N, so today the capability is reachable only from the headless CLI, never from the TUI. In addition, opening the launcher prompt step lands the cursor on "Manual prompt", forcing an operator who wants the active change as the contract to move down first.

## What Changes

- The launcher's OpenSpec contract picker supports selecting all, several, one, or none of the checkout's active changes: `space` toggles the highlighted row, `a` selects every active change, and `enter` confirms the marked set. `Manual prompt` remains the explicit no-change mode.
- The archive picker supports the same multi-select, returning the ordered batch instead of a single change id.
- Both pickers order a multiple selection by the change list (alphabetical), independent of the order in which rows were toggled; `a` uses the same order.
- When the launcher opens the prompt step in a checkout with active changes and no preset selection, the cursor lands on the first active change instead of `Manual prompt`; the same rule applies on every re-entry into the picker.
- Selecting a change still requires explicit confirmation: no change is attached without `enter`, and the no-change mode stays explicit.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `run-launcher`: the explicit checkout-local change selection is reachable from the launcher UI as an ordered list of zero or more (all/several/one/none), and the picker opens focused on the first active change.
- `worktree-operations`: the reviewed archive batch is reachable from the archive picker UI (all/several/one), not only from repeated `--change`.

## Impact

- `src/launch-tui.ts` — contract picker key handling, state, and detail/footer rendering; initial and re-entry focus.
- `src/change-picker-tui.ts` — multi-select result and rendering; `src/cli.ts` archive call site passes the ordered batch to `runWorktreeArchive`.
- Selection helpers (toggle/all/order) and their unit tests, plus launcher and picker TUI tests.
- No changes to the downstream run-plan, bundle resolution, archive journal, or headless `--change` behavior; explicit-acceptance and no-silent-attach invariants are preserved.
