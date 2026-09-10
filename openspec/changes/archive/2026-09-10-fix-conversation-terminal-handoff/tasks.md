## 1. Foreground host owns a clean handoff

- [x] 1.1 In `src/terminal-host.ts`, add an optional `clear?: () => void` to `runForegroundChild` (default writes the primary-screen clear `ESC[2J ESC[H` to stdout) and restructure the body to `suspend → clear → spawn → await → clear → resume`, with `clear` and `resume` in `finally` so failed spawns and rejected exits still clean and restore.
- [x] 1.2 Update `test/terminal-host.test.ts` to inject a recording `clear` and assert its position (after suspend, before spawn, and again before resume) on normal exit, non-zero exit, spawn failure, and interrupted exit.

## 2. Wire the conversation callers to the shared lifecycle

- [x] 2.1 In `src/cli.ts`, change `openCheckoutConversation`, `openLinkedConversation`, and `proposeInCheckout` to pass `suspend: () => renderer.suspend()` / `resume: () => renderer.resume()` into `openConversationForeground`, removing the outer `renderer.suspend()` / `finally { renderer.resume() }`.
- [x] 2.2 Confirm `openConversationExternal` and the external window/pane backends are untouched (they do not own the terminal).

## 3. Tests

- [x] 3.1 Add a regression test asserting `runForegroundChild` clears after suspend and before resume in order, including when `Bun.spawn` throws.
- [x] 3.2 Run `bun run typecheck` and `bun test`; all pass.

## 4. Verify

- [x] 4.1 `openspec validate fix-conversation-terminal-handoff --strict`.
- [x] 4.2 PTY smoke of Home → `V` → opencode → exit → quit Convoy: the captured bytes show the clear after suspend and before resume, no stray child output on the final primary screen, and a clean exit.
