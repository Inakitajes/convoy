# Proposal

## Why

The config screen edits every YAML key through forms. Its 2.2k lines cost more to maintain than the use they get: anyone configuring Convoy is comfortable in a text editor, and YAML in an editor is clearer than nested pickers. Meanwhile two product areas can't be turned off. A project that doesn't use OpenSpec still sees Specs in the TUI and, in a repo with an `openspec/` folder, has to pass `--change` or `--manual` on every headless launch. An operator who doesn't manage worktrees through Convoy still lands on the worktree board, one step away from the pipelines they came for.

## What Changes

- Replace the form editor with a config screen that shows the feature switches as toggles (saved to the project config without touching its other lines) and lists the files that shape the project (global and project config, and agent prompt overrides in both scopes), says whether each one loads, and opens the selected one in `$VISUAL`, `$EDITOR`, or `nano`/`vim`/`vi`. Missing config files are created from the `convoy init` template, and a file that stops loading is reported when the editor closes.
- Add `features: { worktrees, specs }` to the config (each on unless set to `false`, the project winning per switch).
- `worktrees: false` opens the TUI on the run launcher as its first screen, with Runs, Config, and Specs reachable from it, and stops isolating runs by default. An explicit `--worktree` or `defaults.worktree` still isolates.
- `specs: false` removes OpenSpec from the TUI (the Specs destination, OpenSpec actions, linked specs, and the launcher's change picker) and from run plans (nothing attached, no selection required). `--change`, `convoy specs`, and `convoy spin` refuse with a message naming the switch.
- Remove what only the form editor used: the model catalog, `defaultConfigTemplate`, `materializePipelineSpec`, and `checkPipelineResolves`.

## Capabilities

### New Capabilities

- `config-screen`: lists configuration files, their load state, and opens them in the operator's editor.
- `feature-toggles`: project and global switches that remove the worktree and OpenSpec areas.

### Modified Capabilities

<!-- None: home, launcher, and specs requirements still hold when both areas are on (the default). -->

## Impact

- `src/config-tui.ts` (rewritten), `src/config-files.ts` (new), `src/config.ts` (`features` schema), `src/cli.ts` (launcher-first session, plan gating, command refusal), `src/home-tui.ts`, `src/launch-tui.ts`, `src/git.ts`.
- Removes `src/model-catalog.ts` and the form editor's tests and smoke script.
- Docs: `configuration.md`, `running.md`, `development.md`, and `--help`.
