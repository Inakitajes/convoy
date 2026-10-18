# Tasks

## 1. Config screen

- [x] 1.1 Add `src/config-files.ts`: list each scope's config file and agent prompt overrides with their load state (never writing), create a missing config from the init template, and resolve the editor command; verify `test/config-files.test.ts`.
- [x] 1.2 Rewrite `src/config-tui.ts` as the file list that opens the editor in the foreground and reports the file's state when it closes; verify the screen test in `test/config-files.test.ts` and `test/tui-session.test.ts`.
- [x] 1.3 Remove the form editor's tests and smoke script, the model catalog, `defaultConfigTemplate`, `materializePipelineSpec`, and `checkPipelineResolves`; verify typecheck and the full suite.
- [x] 1.4 Show the feature switches as toggles at the top of the config screen, saving a flip to the project config by editing only that key's line; verify `test/config-files.test.ts`.

## 2. Feature toggles

- [x] 2.1 Add `features: { worktrees, specs }` to parsing, merging, serialization, and the commented template; verify `test/config.test.ts`.
- [x] 2.2 With specs off, keep OpenSpec out of run plans, refuse `--change`, `convoy specs`, and `convoy spin`; verify `test/openspec.test.ts` and `test/cli-regression.test.ts`.
- [x] 2.3 With specs off, drop the Specs destination, OpenSpec actions, and linked specs from Home, keep close as a git action, and skip the launcher's change list; verify `test/home-tui.test.ts`.
- [x] 2.4 With worktrees off, open the session on a root launcher (q quits, o opens Specs) that reopens after each destination or run, and stop isolating runs by default; verify `test/launch-tui.test.ts`, `test/git.test.ts`, and `test/cli-regression.test.ts`.

## 3. Documentation

- [x] 3.1 Document the config screen and the `features` switches in `docs/configuration.md`, `docs/running.md`, `docs/development.md`, and `--help`.
