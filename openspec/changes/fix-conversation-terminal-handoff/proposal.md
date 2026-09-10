## Why

Opening a foreground conversation hands the terminal from Convoy's OpenTUI alternate screen to `opencode`, which is itself an OpenTUI alternate-screen application. Neither side clears the primary screen, so `opencode`'s startup terminal-capability queries and frame setup land on the visible primary screen as stray characters, and once both applications exit the polluted primary screen is revealed — a garbled terminal that appears stuck until the operator presses Ctrl+C. The current handoff (`renderer.suspend()` … `renderer.resume()` around an inherited-stdio child) never cleans the surface the child transiently owns.

## What Changes

- Add a clean primary-screen handoff around foreground children that own the terminal: clear the released screen after Convoy suspends and again before Convoy reclaims it, so neither Convoy's teardown nor the child's startup queries remain visible.
- Move the suspend/clear/resume lifecycle into the shared foreground host (`runForegroundChild`) and have the conversation callers pass the real renderer suspend/resume instead of no-ops, so the lifecycle lives in one place.
- Keep headless paths and non-foreground window/pane backends unchanged.

## Capabilities

### New Capabilities

<!-- None: this refines existing foreground-conversation behavior. -->

### Modified Capabilities

- `work-conversations`: the foreground conversation handoff must clean the released primary screen so opening and returning from the client leaves no stray terminal output; the existing "return to usable input, echo, and rendering" requirement gains the visual-coherence guarantee.

## Impact

- `src/terminal-host.ts` (`runForegroundChild` terminal lifecycle).
- `src/conversations.ts` (`openConversationForeground`).
- `src/cli.ts` (the foreground conversation/propose callers that currently suspend the renderer themselves).
- No CLI surface, harness protocol, or persisted-state change.
