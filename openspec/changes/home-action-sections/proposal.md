## Why

Home's worktree detail mixed OpenCode authoring (open conversation/window), Convoy orchestration (execute pipeline), and OpenSpec change work (propose, close) inside one "Life Cycle" section, and offered no manual archive at all. The operator could not tell which toolchain an action belonged to, the run launcher had no home of its own, and `openspec archive` had no TUI entry.

## What Changes

- Group the worktree detail actions into four labeled sections in order: **Sessions** (Open conversation, Open in window), **Runs** (a `New run` action always present as the first row of the section, with the checkout's recent runs beneath it), **git** (the guarded Git/publication operations), and **OpenSpec** (Propose a change, Archive change, Close (archive & merge)) directly above the Linked Specs observation.
- Rename `Execute pipeline` to `New run` (key `n`) and `Close review` to `Close (archive & merge)`.
- Add `Archive change`: an OpenSpec action that selects one of the checkout's active changes and archives it through the existing guarded archive operation; the specs browser Actions menu offers the same action for its selected change.
- Keep every action's shared guard; disabled actions stay visible with their reason.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `home-launcher`: the worktree detail groups actions by toolchain (Sessions/Runs/git/OpenSpec), always exposes New run in the Runs header, exposes Archive change, and renames close.
- `specs-viewer`: the root/detail Actions menu offers Archive change for the selected change.

## Impact

- `src/home-tui.ts`: the `DetailSection` model, action grouping/labels/keys, and the Runs header action.
- `src/change-picker-tui.ts` (new): the explicit change selector for archive.
- `src/cli.ts`: archive dispatch from Home (picker + guarded archive) and the specs-browser archive resolution.
- `src/worktree-commands.ts`: archive route notices (`runWorktreeArchive`).
- `src/specs.ts` / `src/specs-browser.ts`: the `archive-change` resolution and its Actions-menu entry.
- Tests: home-tui, change-picker-tui, specs-actions-menu.
