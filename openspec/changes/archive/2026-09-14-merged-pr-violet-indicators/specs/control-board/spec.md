## ADDED Requirements

### Requirement: Merged pull request observation color

Worktree indicators shared by Home and the specs browser SHALL use the terminal palette's violet color when their available PR observation is known and its linked PR state is merged, independent of the hosting state's letter case. This observed PR color SHALL take precedence over ordinary live-activity and dirt marker colors. Independent activity, dirt, and guard facts SHALL remain available; a violet indicator SHALL NOT assert that the current checkout is completed or safe to remove. Checking, unknown, ambiguous, absent, open, and closed PR observations SHALL retain the existing activity/dirt/neutral color rules.

#### Scenario: A known merged PR has live activity

- **WHEN** a worktree has live activity and a known linked PR with state `MERGED` or `merged`
- **THEN** its shared indicator is violet and its independent activity and dirt facts remain available

#### Scenario: There is no known merged PR

- **WHEN** the PR query is checking, unavailable, ambiguous, empty, open, or closed
- **THEN** the worktree indicator uses the existing activity, dirt, and neutral color rules rather than implying a merge
