# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Iterate on this plan opens an OpenCode session on the change`
- TO: `### Requirement: Iterate on this plan opens a selected-harness session on the change`

## MODIFIED Requirements

### Requirement: Iterate on this plan opens a selected-harness session on the change

Iterate SHALL open or explicitly resume an authoring conversation using the selected supported harness, OpenCode or Claude, in the verified checkout containing the selected active change. The selected authentication mode SHALL be preserved without silently substituting another harness or billing mode. Only explicitly selected local planning files SHALL be supplied as selected-change context; the focused proposal, design, tasks, and delta files SHALL be initial context without inferring a broader contract set. Checkout reads SHALL be pre-granted and writes SHALL retain normal permissions and shared managed-writer coordination. Foreground presentation with return to the originating verified checkout and local change SHALL be the default; external presentation SHALL remain explicit. Missing, stale, or ambiguous targets SHALL require explicit correction or reselection, never binding or cross-tree fallback. Archived artifacts SHALL remain readable, but editing them SHALL require an explicit new active-work decision rather than silent archive reactivation. OpenSpec authoring SHALL remain owned by the operator and the project workflow. Session references and checkout locators SHALL be navigation metadata only, not spec ownership or mutation authority.

#### Scenario: Iterate opens a repo-rooted session
- **WHEN** Iterate is selected for an active local change in another worktree
- **THEN** the selected harness session opens at that verified worktree's root with its selected planning files as context

#### Scenario: Iterate requires no launcher
- **WHEN** the operator iterates and closes the session without running a pipeline
- **THEN** no run starts and the conversation returns to the originating checkout and local selection

#### Scenario: Iterate session is pre-authorized to read the repository
- **WHEN** Iterate opens on a verified planning checkout
- **THEN** reads across that checkout are pre-granted while writes follow normal session permissions and shared writer guards

#### Scenario: Revisit a plan conversation
- **WHEN** the operator chooses to resume an available authoring conversation for the selected checkout and its session reference and target validate
- **THEN** Convoy opens that exact harness-qualified session and returns to the same verified checkout and local change on client exit

#### Scenario: Claude subscription authoring without OpenCode
- **WHEN** the operator selects Claude subscription mode to iterate on a plan and OpenCode is not installed
- **THEN** the conversation opens through the supported Claude interface without requiring OpenCode or an API key
