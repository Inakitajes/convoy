## Applied behavior

Known merged PR evidence now paints the shared worktree indicator with `theme.magenta`. Home passes its on-demand evidence to row markers, inline rails, and linked-change markers; the specs browser consumes the same helper when its worktree carries PR evidence. State matching accepts `MERGED` and `merged`.

## Verification

- `bun run typecheck`: passed.
- Targeted Home, specs TUI, and worktree-location checks: 109 passed; one existing worktree-location test could not write its home-directory fixture inside the sandbox. The Home rendering tests, including both merged-state spellings, selected/unselected colors and refresh-to-unknown behavior, passed.
- The relocated documentation example regression passed: copying the wiki configuration example into a fixture README does not create a worktree-location convention.
- `openspec validate merged-pr-violet-indicators --strict`: passed before archival.
- The compiled local binary reports its version successfully.
- The initial complete-suite attempt was blocked by the workspace spend cap. During release preparation, `bun run test:coverage` subsequently passed outside the sandbox: all tests passed, with 92.59% line coverage and 92.98% function coverage (both above the 90% threshold).
