## 1. CLI surface

- [x] 1.1 Add a `publish` variant to the `CliCommand` union in `src/cli.ts` carrying `{ worktree?, runDir?, runId?, title?, body?, yes, dryRun }`; verify by typechecking `bun run typecheck`.
- [x] 1.2 Parse `convoy publish [--worktree <path>] [--run-dir <path> | --run <id>] [--title <text> --body <text>] [--yes] [--dry-run]` in `parseCommand`, rejecting unknown flags and `--title` without `--body`; verify with parser tests.
- [x] 1.3 Dispatch the parsed command in `parseAndRun` to `runPublishCommand`; verify a `convoy publish` invocation reaches the module (observable via its stdout/exit code).
- [x] 1.4 Add `publishHelp()` and list `convoy publish` in `help()`; verify `./convoy publish --help` exits 0 and prints the usage.

## 2. Headless publish flow

- [x] 2.1 Create `src/publish-command.ts` exporting `runPublishCommand(options)` that resolves the checkout (`--worktree` or cwd) and run dir (`--run-dir`/`--run`), builds `createPublishSeam({ cwd, runDir })`, and runs prepare → compose → print → apply; verify with a stub seam test.
- [x] 2.2 Make `--dry-run` and invocation without `--yes` print the disclosed plan and composed title/body and perform no effect; verify the stub's `apply` is never called.
- [x] 2.3 Make `--yes` apply the reviewed text, passing `--title`/`--body` overrides through as the seam's accepted text; verify the stub receives them.
- [x] 2.4 Surface a blocked `prepare`/`compose`/`apply` message verbatim and set a non-zero exit code; verify with stub cases for each failure point.
- [x] 2.5 Print the outcome (pushed refspec and PR URL, or the existing/reported PR) on success; verify the stdout contains the URL when the stub reports one.

## 3. Tests and docs

- [x] 3.1 Add `test/publish-command.test.ts` covering dry-run, no-`--yes`, `--yes`, overrides, and each blocked stage using an injected seam (no real git/gh); verify `bun test test/publish-command.test.ts` passes.
- [x] 3.2 Add parser cases for `convoy publish` (defaults, each flag, invalid combinations) to `test/cli-parser.test.ts`; verify they pass.
- [x] 3.3 Document `convoy publish` in `README.md`, including the `ship` post-hook usage gated on `CONVOY_GOAL_REACHED` and its distinction from `convoy worktrees pr`; verify the section renders and names the command.
- [x] 3.4 Run `bun run typecheck` and `bun test` and confirm both are green.

## 4. Consumer pipeline (user-level config, outside the repo)

- [x] 4.1 Update `~/.convoy/config.yaml`: make `ship` the sync + review/triage/fix + terminal goal (target 90, 5 iterations) pipeline, add a prefix `run-report` step, and remove `quality-assurance`; verify with the loader/resolver script that `ship` resolves with the goal plan.
- [x] 4.2 Point the `ship` post-hook at `convoy publish --run-dir "$CONVOY_RUN_DIR" --worktree "$CONVOY_TARGET_DIR" --yes`, gated on `CONVOY_GOAL_REACHED`; verify the hook text and the pre-hook `git fetch origin` are present in the config.
