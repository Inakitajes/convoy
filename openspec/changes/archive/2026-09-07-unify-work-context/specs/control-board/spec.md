## MODIFIED Requirements

### Requirement: Control command is the single inferred board

`convoy specs` SHALL present the board, retaining `convoy control` as a compatibility alias, and use the shared feature resolver and lifecycle assessment. It SHALL persist explicit identity and associations but derive current worktrees, branches, task completion, run liveness, and integration eligibility from fresh evidence. Read-only OpenSpec task queries SHALL be permitted with filesystem fallback when the CLI is unavailable; unreadable evidence SHALL remain unknown. Historical run linkage SHALL use durable feature identity and frozen provenance, not the branch currently checked out at an old run path. Browsing SHALL NOT write the registry. The board SHALL distinguish unresolved legacy candidates from registered features.

#### Scenario: Deleting the worktree updates the board
- **WHEN** a feature's worktree is removed outside Convoy and the board is reopened
- **THEN** the feature remains visible without claiming a worktree and offers missing-context or remaining-cleanup guidance as appropriate

#### Scenario: One resolver everywhere
- **WHEN** a branch with any valid name is explicitly associated with a change
- **THEN** board and run selection use that association and show the same verified implementation context

### Requirement: Active change rows derive their lifecycle state

The board SHALL show registered pending features and unassociated active-change candidates, not only active directories. Each feature row SHALL show its assessed lifecycle summary, tasks done/total when known, linked runs and liveness, uncommitted proposal signal, base synchronization, artifact/archive state, and integration evidence with its certainty. Verified local landing SHALL be labelled integrated locally; patch equivalence alone SHALL remain probably merged. Archived-but-unintegrated features and integrated features with pending cleanup SHALL remain in the pending-work surface. Completed features SHALL remain accessible through history. Unassociated candidates SHALL show association or spin remediation rather than asserting ready-to-close ownership. “Ready to close” SHALL require the shared close-start prerequisites, and blockers SHALL be visible.

#### Scenario: Implementing feature
- **WHEN** a feature has two associated runs, one live
- **THEN** its row shows implementation in progress with two runs and the live one marked, rather than claiming ready to close from task counts alone

#### Scenario: Stranded change on main
- **WHEN** an uncommitted change exists on the base checkout with no feature association
- **THEN** it remains visible as unassociated work and offers spin or explicit association without inventing an implementation branch

#### Scenario: Archived before integration
- **WHEN** a feature's own change is archived while its branch also contains an unrelated active change inherited from main
- **THEN** the feature remains listed with its archived contract and pending integration; the inherited change does not replace its identity

#### Scenario: Definite local landing
- **WHEN** a feature has a verified receipt whose landing remains reachable and its feature tip is unchanged
- **THEN** the board reports integrated locally and offers only applicable follow-ups without labelling the evidence as patch-equivalence probability

The same shared assessment SHALL supply Home and feature detail summaries and action eligibility. A pre-proposal feature with zero contracts and no execution SHALL be identified as awaiting proposal, not ready to close. Fullscreen reading and navigation SHALL not silently revise contracts or mutate lifecycle state.

#### Scenario: Tasks alone do not authorize close in Home
- **WHEN** all tasks are complete but execution is active or required evidence is unknown
- **THEN** Home and the specs board show the same blockers and neither enables close from task count alone

### Requirement: Worktrees without spec get their own section

The board SHALL include a peer section for discovered worktrees without an associated feature, including those with no runs, each exposing adoption and available runs. Registered pre-proposal features with an empty contract set SHALL remain in Features, alongside other registered lifecycle work. Presence of unrelated change-directory copies SHALL NOT suppress this section. Registered features with archived contracts SHALL stay in the feature lifecycle surface rather than being downgraded to specless worktrees. Empty peer sections SHALL be omitted entirely. A non-empty worktree section SHALL make the board interactive even without changes or canonical specs.

#### Scenario: Plain isolated run appears
- **WHEN** an isolated run's worktree exists without an associated OpenSpec feature
- **THEN** it is listed with its branch and run count and can open its runs

#### Scenario: Worktree-only board remains interactive
- **WHEN** only run-bearing unassociated worktrees exist
- **THEN** the interactive board opens with that section and no empty feature or canonical-spec headers

#### Scenario: Foreign artifacts do not hide a worktree
- **WHEN** a no-spec run's worktree contains active changes copied from the base
- **THEN** those copies do not assign the run to a feature or remove the worktree's run-navigation entry

#### Scenario: New feature has no contracts yet
- **WHEN** a feature has been created before proposal with a verified checkout and no contracts or runs
- **THEN** it remains in Features with conversation/proposal actions, rather than disappearing or being treated as an unassociated worktree

### Requirement: Continue reuses the feature's worktree and branch

Launching continue from a feature SHALL carry stable feature identity, its explicit contract set, intended base, and verified implementation context into the launcher. Continue SHALL reuse that worktree and actual branch without creating another worktree or invoking the branch namer; new-worktree isolation SHALL be disabled for this handoff. The reviewed plan SHALL freeze the association revision and current context for execution-time validation. Invalid or missing associations SHALL present resolution guidance rather than silently creating replacement work. Archived contracts SHALL remain available for closing/history but SHALL require an explicit new active-work decision before another implementation run.

#### Scenario: Second run lands on the same branch
- **WHEN** an active feature already ran once and continue launches another run
- **THEN** the reviewed plan retains the same feature identity, actual branch, worktree, and contracts without minting a new branch

#### Scenario: Rename requires verified context
- **WHEN** continue is requested after an external branch rename
- **THEN** Convoy resolves a previously verified rebind or offers rebinding before launch, rather than choosing another change by branch spelling

Conversation resumption SHALL have a separate label and action from pipeline continuation, while both retain the same feature identity.

### Requirement: Change rows resolve to the owning worktree

Explicit verified feature associations SHALL determine the authoritative context and artifact sources for feature rows. Branch-name matches, Markdown presence, and worktree-list order SHALL NOT select ownership. Discovered copies SHALL remain inspectable as candidates with their source locations. Ambiguous, missing, or unreadable associations SHALL keep the feature visible without borrowing another copy's tasks, title, runs, or mutation target. Unassociated candidates SHALL offer explicit selection/adoption, with no automatic writes while browsing.

#### Scenario: A husk in an earlier worktree cannot steal the row
- **WHEN** an unrelated earlier-listed worktree contains a husk while the explicitly associated worktree carries the complete change
- **THEN** the associated context supplies the row's facts and action assessment regardless of listing order

#### Scenario: Branch match outranks a fuller foreign copy
- **WHEN** two worktrees both carry the same change and only one carries the explicitly associated implementation context
- **THEN** the explicitly associated context supplies the row even when the other copy lists more files or its branch name happens to match the change id

#### Scenario: Husk-only candidates keep the row present
- **WHEN** every discovered copy of a change id carries only husk directories and none is explicitly associated
- **THEN** the candidate remains listed with its source locations and no fabricated task counts, ownership, or close eligibility

### Requirement: The launcher warns on nested isolation
Standalone launches inside a worktree SHALL retain the current default of no new isolation and SHALL show an informational warning when new isolation is deliberately enabled, identifying the source branch. Work-scoped launches SHALL reuse existing work; deriving a separate work item SHALL explicitly review its source and destination.

#### Scenario: Warning on deliberate fork
- **WHEN** isolation is enabled for a standalone launch inside a worktree
- **THEN** the launcher warns that the new worktree derives from the current branch without blocking the deliberate choice

#### Scenario: Existing work is selected
- **WHEN** a pipeline is launched from a work detail
- **THEN** it reuses that checkout and creating a derivative requires the separate derived-work action

## MODIFIED Requirements

### Requirement: Board assessment can be refreshed without changing selection identity

The board SHALL provide an explicit refresh action, refresh after returning from lifecycle actions, and invalidate cached artifact and assessment data together. Selection SHALL remain attached to feature identity rather than list position or branch name where that identity still exists. A failed refresh SHALL disclose unavailable/stale evidence and SHALL NOT present stale readiness as a current verified fact.

#### Scenario: External archive becomes visible
- **WHEN** the operator archives a selected feature outside Convoy and refreshes the board
- **THEN** the same feature remains selected with updated artifact state and close prerequisites
