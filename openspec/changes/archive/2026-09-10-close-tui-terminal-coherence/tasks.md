## 1. Isolate inherited-terminal git output in the archive path

- [x] 1.1 In `src/worktree-commands.ts`, add an optional `withTerminal` seam to `archiveSelectedChanges` and wrap only its `commitAsUser` call (`withTerminal ? withTerminal(() => commitAsUser(...)) : commitAsUser(...)`).
- [x] 1.2 Add the same optional seam to `reconcilePendingArchiveOperations` and `completeInterruptedArchiveCommit`, wrapping the reconcile commit.
- [x] 1.3 In `driveClose`, pass `progress.withTerminal` into both the archive reconcile and `archiveSelectedChanges` so the interactive close suspends around those commits. Headless (`withTerminal` undefined) stays untouched.
- [x] 1.4 Update the `CloseProgress.withTerminal` doc comment to name the archive commit alongside the squash candidate and remote effects.

## 2. Release close input before the completion notice

- [x] 2.1 In `runClose`'s interactive branch, on the successful/cancelled path call `tui.destroy()` before `showNoticeTui(route, ...)` (keep the `finally { tui.destroy() }`; `destroy` is idempotent and leaves a shared renderer alive).
- [x] 2.2 Leave the failure path (`tui.showFailure`) owning input until the operator dismisses it.

## 3. Tests

- [x] 3.1 Add a close-hosted/worktree-commands regression test that drives `driveClose` with selected changes and a recording `withTerminal`, asserting the archive commit runs inside the seam (and that the archive still lands).
- [x] 3.2 Add a `close-tui` regression test that mounts the close screen and then a shared-session notice, dispatches a real parsed `q` (and Ctrl+C), and asserts the notice resolves. The test must fail if the close screen's keypress listener is still installed when the notice is shown.
- [x] 3.3 Run `bun run typecheck` and `bun test`; all pass.

## 4. Verify

- [x] 4.1 `openspec validate close-tui-terminal-coherence --strict`.
- [x] 4.2 Manually run `convoy close` on a scratch worktree with a selected change: the archive commit output must not appear over the close interface, the review screen must be clean, and the completion notice must dismiss on `q`/Ctrl+C.
