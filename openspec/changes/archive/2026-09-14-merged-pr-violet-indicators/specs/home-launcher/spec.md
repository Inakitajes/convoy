## ADDED Requirements

### Requirement: Home indicators follow observed pull request state

Home SHALL supply its current on-demand PR evidence to the shared worktree indicator rule. A known merged result SHALL update the selected marker background, unselected marker foreground, inline detail rail, and linked-change markers to violet. A new pending or unknown observation SHALL NOT retain a merged color solely from an earlier query. This presentation SHALL NOT introduce additional PR queries or change worktree action guards.

#### Scenario: A lookup detects a merged PR

- **WHEN** Home's on-demand lookup resolves to a known merged PR for a selected live worktree
- **THEN** the marker updates from green to violet and remains violet as an unselected foreground indicator when selection moves elsewhere

#### Scenario: A refreshed observation is unknown

- **WHEN** the operator lands again on a previously observed merged worktree and the new lookup is pending or resolves unknown
- **THEN** Home uses the ordinary worktree color rules until it has a known merged observation again
