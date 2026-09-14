## Context

`worktreeDotColor` is shared by Home and the specs browser. Home stores on-demand PR results separately in `prEvidence`, so changing the helper alone would not update Home.

## Decisions

Accept an optional PR observation in the shared helper, defaulting to the worktree's own observation for existing callers. An explicit `checking` value is not evidence of a merged PR. A known PR with a case-insensitive `merged` state returns `theme.magenta`; all other cases retain the current live/dirty/neutral precedence. The palette already supplies suitable violet values for dark, light, and monochrome terminal palettes.

Pass Home's current per-worktree observation to every shared marker call. A completed on-demand lookup already triggers rendering, so no extra query or refresh mechanism is needed. Selected markers use a violet background and contrasting glyph; unselected markers and rails use violet foreground. Independent text facts continue to disclose dirt and live activity.

## Risks and verification

A green live indicator must change only after known merged evidence arrives. Rendering checks cover uppercase and lowercase hosting states, selected and unselected markers, and a new query that returns unknown. The merge observation remains a fact about the PR, not permission to delete or mark the checkout complete.
