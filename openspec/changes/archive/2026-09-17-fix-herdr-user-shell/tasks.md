## 1. Herdr pane backend

- [x] 1.1 Remove the `--env ZDOTDIR=/var/empty` pair from the split arguments in `openInHerdr` and update its explanatory comment to say the pane loads the operator's shell (`src/terminal-host.ts`). Verify with `bun test test/opencode.test.ts` that the Herdr split assertion no longer expects `ZDOTDIR`.
- [x] 1.2 Replace the first-output wait (`waitForHerdrPanePrompt`) with a quiet-settled readiness wait bounded by a timeout, keeping the existing `pane run` retry loop (`src/terminal-host.ts`). Verify a unit test injects a spawn whose pane output settles after startup lines and asserts the command is submitted once.
- [x] 1.3 Confirm the split still injects working directory, `PATH`, and per-open env (e.g. `OPENCODE_CONFIG_CONTENT`) alongside the removed override. Verify the existing PATH and extra-env Herdr tests pass unchanged.

## 2. Tests

- [x] 2.1 Update the Herdr tests in `test/opencode.test.ts` that assert `ZDOTDIR=/var/empty` and the `--regex .` / `--timeout 1500` wait to match the new split arguments and readiness behavior. Verify `bun test test/opencode.test.ts` is green.
- [x] 2.2 Add a test that a command is not submitted before the pane settles and is submitted exactly once, covering the startup-output case. Verify the new test passes and fails against the old first-output behavior.
- [x] 2.3 Run `bun run typecheck` and the full `bun test` suite. Verify both pass.

## 3. Documentation and end-to-end verification

- [x] 3.1 Update `docs/running.md` (the pane sentence near the `o`/`i` behavior) so it describes the pane opening in the operator's normal shell rather than a suppressed one. Verify the wording matches the implemented behavior.
- [x] 3.2 Manually verify inside Herdr: open a client from Convoy (`[o]` / `[i]` / authoring conversation) and confirm the pane resolves the same `opencode` as the operator's shell, the client starts, and exiting it leaves the operator's normal interactive shell. Verify with `herdr pane read` that `which -a opencode` in the pane matches the operator's shell order.
- [x] 3.3 Run `openspec validate fix-herdr-user-shell --strict` and confirm the change validates. Verify the command reports the change as valid.
