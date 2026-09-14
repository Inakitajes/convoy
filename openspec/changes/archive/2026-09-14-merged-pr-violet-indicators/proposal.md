## Why

A linked pull request that has already merged can still show a green worktree marker in Home because the shared color helper only sees execution activity. The marker should distinguish the observed merged PR with violet.

## What Changes

- Use the palette's violet (`magenta`) for worktree indicators with a known merged PR, ahead of the ordinary activity/dirt colors.
- Feed Home's on-demand PR evidence into its row, inline rail, and linked-change markers. Use the same rule in the specs browser when PR evidence is available.
- Recognize hosting state spelling in either uppercase or lowercase. Checking, unknown, ambiguous, absent, open, and closed observations keep the existing activity/dirt color rules.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `control-board`: shared worktree indicators distinguish a known merged PR in violet without making a completion or cleanup claim.
- `home-launcher`: on-demand PR results update the selected and unselected worktree indicators and associated detail markers.

## Impact

`src/specs-browser.ts`, `src/home-tui.ts`, and their rendering checks. No changes to PR lookup, worktree lifecycle, action guards, or mutation behavior.
