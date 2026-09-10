## Context

Convoy's Home runs on an OpenTUI alternate screen. Pressing `v` (Open conversation) calls `openCheckoutConversation`, which suspends the renderer and spawns `opencode <checkout> --session <id>` with inherited stdio. `opencode` is itself an OpenTUI application (its binary contains `switchToAlternateScreen`/`opentui-notifications`), so the handoff is nested OpenTUI.

A PTY capture of the real flow shows the gap clearly. Convoy's `suspend()` emits mouse-off, `?2004l` (bracketed paste off), `?1049l` (leaves the alternate screen), `?2031l`, and the title/background reset. Then, **before** opencode enters its own alternate screen (`?1049h`), opencode's OpenTUI startup writes `?2031h` and a burst of terminal-capability queries — `ESC]10;?`, `ESC]11;?`, `ESC[>0q`, `ESC[s`, `ESC[6n`, the XTVERSION DCS `ESC P +q4d73 ST`, `ESC]99;…opentui-notifications…`, `ESC]1337;Capabilities`, `ESC]66;…` — onto the primary screen. On exit opencode leaves its alternate screen and Convoy resumes (`?1049h`), but the primary screen still holds the child's setup output; when Convoy finally exits, that polluted primary screen is revealed and the terminal looks garbled. Because only Ctrl+C is handled while the post-return loading transition is up, the operator's only escape is Ctrl+C.

The existing caller shape also scatters ownership: `cli.ts` suspends the renderer itself and passes `suspend: () => {}` / `resume: () => {}` into `openConversationForeground`, so `runForegroundChild` — documented as the owner of the terminal lifecycle — never actually controls it.

## Goals / Non-Goals

**Goals**

- No stray child output remains visible when the client starts, while it runs, or after it exits.
- The terminal is returned with usable input, echo, and rendering on every exit path.
- One place owns the suspend/clear/spawn/clear/resume lifecycle.

**Non-Goals**

- Changing the loading transition's deliberate Ctrl+C-only interrupt contract.
- Clearing terminals owned by external window/pane backends (Herdr, Zellij, Ghostty, Terminal.app) — Convoy does not own those.
- Resetting arbitrary terminal modes a child may leave behind; Convoy re-asserts its own modes on resume.

## Decisions

### D1: Clear the primary screen on release and on reclaim

Add a `clear()` step to the foreground host: after `suspend()` (Convoy has left the alternate screen) and again after the child exits and before `resume()`. The clear writes `ESC[2J ESC[H` to stdout, wiping the visible primary screen. This removes opencode's capability-query burst on the way in and its leftovers on the way out, so the surface Convoy eventually reveals is clean.

Alternative considered: only clear on reclaim. Rejected because the child's startup queries would still flash on the primary screen while it boots.

### D2: The shared foreground host owns the lifecycle

`runForegroundChild` becomes `suspend → clear → spawn → await → clear → resume`, with both `clear` and `resume` in `finally` so a failed spawn or a rejected exit promise still cleans and restores. A `clear?: () => void` injection seam defaults to the stdout write, keeping the host unit-testable without a terminal.

### D3: Callers pass the real renderer lifecycle

`openConversationForeground` already forwards `suspend`/`resume` to the host; the `cli.ts` conversation and propose callers stop calling `renderer.suspend()` themselves and pass `() => renderer.suspend()` / `() => renderer.resume()`. This removes the no-op seam and puts the whole handoff in one place. `runForegroundChild`'s existing tests are updated to expect the clear steps.

## Risks / Trade-offs

- Clearing the visible primary screen removes any content that was there before the handoff. That is the intended trade for a full-screen client takeover; the scrollback above the screen is left intact (only `ESC[2J`/`ESC[H`, not `ESC[3J`).
- A child that leaves global terminal modes enabled is still the child's responsibility; `resume()` re-asserts Convoy's raw mode and input listeners.

## Migration

None. Behavior-only; no CLI, harness-protocol, or persisted-state change.
