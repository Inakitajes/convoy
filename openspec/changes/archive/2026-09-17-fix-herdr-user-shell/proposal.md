## Why

Convoy's Herdr pane backend forces `ZDOTDIR=/var/empty` on `herdr pane split` so the pane shell skips the operator's shell startup (`~/.zprofile`, `~/.zshrc`) and its prompt appears immediately, shrinking the window in which `herdr pane run` types the command before the shell is ready. That shortcut is observably wrong twice over. After the client exits, the pane is left in a bare, unconfigured shell instead of the operator's normal one. And because the skipped startup files are also what re-establish the operator's PATH ordering, the pane can resolve `opencode` to a *different* binary than the operator's own shell does — on Herdr 0.9.0 this surfaces as `zsh: killed opencode` (SIGKILL 137) whenever a stale Homebrew `opencode` shadows the operator's `~/.opencode/bin/opencode`.

## What Changes

- Remove the `ZDOTDIR=/var/empty` override from the Herdr pane backend so the pane shell loads the operator's normal login/interactive startup.
- Keep injecting the working directory, PATH, and extra environment variables on the split; only the user-startup suppression is removed.
- Make the pane-ready wait robust to a real shell startup that can emit output (banners, prompt) before the command is safe to type.
- Update the Herdr tests that assert the removed env pair and the documentation describing the pane's post-exit shell.

## Capabilities

### New Capabilities

<!-- None: this corrects behavior of an existing capability's external presentation. -->

### Modified Capabilities

- `work-conversations`: external pane presentation must host the harness client inside the operator's normal shell environment instead of a suppressed shell, so the launched client resolves as it does in the operator's shell and the pane returns to a normal interactive shell once the client exits.

## Impact

- `src/terminal-host.ts` (`openInHerdr` split arguments; `waitForHerdrPanePrompt` readiness).
- `test/opencode.test.ts` (Herdr split / wait-output / pane-run expectations).
- `docs/running.md` (pane shell wording).
- No CLI surface, persisted state, or harness protocol change.
