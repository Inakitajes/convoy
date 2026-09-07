## Purpose

Keep each development work item associated with its checkout, optional specification, conversations, and runs throughout creation, execution, and recovery.

Work denotes the existing repository-scoped feature identity in the work-first UI. This capability builds on `stable-feature-lifecycle` and SHALL NOT introduce a second identity or ownership registry. Display name and any Git-valid branch name remain attributes; the selected contract in a reader is focus within the feature's reviewed contract set.

## ADDED Requirements

### Requirement: Work exists before a specification
Convoy SHALL allow an operator to create a work item from a short title or identifier, review its branch, base, and destination, and create its isolated checkout before launching an authoring agent. Independent work SHALL default to the detected base; starting from existing work SHALL require a deliberate choice. Work SHALL remain discoverable without a specification or run. Creating work SHALL NOT create a commit or pull request.

#### Scenario: Proposal starts in isolation
- **WHEN** an operator creates work from main and starts proposing
- **THEN** the agent starts in the reviewed worktree and its new proposal artifacts belong to that checkout, with none created in main by this flow

#### Scenario: Creation is cancelled
- **WHEN** the operator cancels before accepting the destination
- **THEN** no worktree, branch, session, or work association is created

#### Scenario: Authoring has not begun
- **WHEN** a worktree has been created but no spec or run exists
- **THEN** the work remains selectable and offers conversation and proposal actions

### Requirement: Work identity survives changing associations
Convoy SHALL reuse the existing feature identity for created or adopted work, independent of display name, arbitrary Git-valid branch names, change IDs, and session IDs. Work SHALL retain the complete explicitly reviewed contract set, permit an empty set before proposal, and add multiple conversation references without replacing the existing feature record, association revision, repository identity, run links, or close evidence. Persisted associations SHALL survive reopening Convoy from any checkout of the same repository and SHALL be validated against current repository state. Git, OpenSpec, live run control, and verified close evidence SHALL remain authoritative for operational status.

#### Scenario: Branch association is repaired
- **WHEN** a linked branch is renamed outside Convoy and the operator reconciles the association
- **THEN** the work retains its identity and linked history while showing the newly validated branch

#### Scenario: Two windows update one work item
- **WHEN** separate Convoy instances add conversation associations concurrently
- **THEN** both associations are preserved or a visible retryable conflict is returned, with no silent lost update

### Requirement: Every action uses a validated destination
Reading, conversation, proposal, pipeline preparation and execution, and close SHALL use the selected feature's validated checkout, complete reviewed contract set, and focused contract source when applicable. Convoy SHALL revalidate destination identity before effects and SHALL NOT fall back to the launch directory when that destination is missing, reused, or ambiguous. Base-checkout operations SHALL retain their explicit base target. Selecting work SHALL NOT change another action's process-wide working directory.

#### Scenario: Work selected from another checkout
- **WHEN** Convoy starts in main and an operator acts on work in a feature worktree
- **THEN** its configuration, relative attachments, specs, and execution resolve within that feature worktree without requiring a shell directory switch

#### Scenario: Destination changes during review
- **WHEN** the reviewed worktree is removed or its branch changes before an action starts
- **THEN** the action reports the stale destination and requires refreshed selection rather than executing in main or accepting the replacement silently

#### Scenario: Independent work runs concurrently
- **WHEN** actions execute on two distinct work items
- **THEN** each keeps its own checkout, selected change, and session references regardless of navigation in the other work

### Requirement: Existing work is adopted without guessing ownership
Convoy SHALL discover existing worktrees and changes without requiring an existing work record. Adoption SHALL link a validated checkout without creating another worktree. Multiple plausible owners or change candidates SHALL be presented for explicit selection. Distinct registered work items SHALL NOT be collapsed solely because their change IDs match. Changes stranded on the base checkout SHALL use the spin adoption flow before work-scoped authoring or execution.

#### Scenario: Several changes exist in adopted work
- **WHEN** adoption finds multiple eligible change IDs
- **THEN** the operator explicitly reviews the contract set before association and chooses reader focus independently

#### Scenario: Duplicate change ID
- **WHEN** two work items contain a change with the same ID
- **THEN** each remains addressable by work identity and actions use the selected work's copy

### Requirement: Interrupted creation is recoverable
Convoy SHALL report partial creation results and preserve an existing worktree when association persistence or session startup fails. Retrying SHALL reconcile and reuse a validated matching result rather than create another branch or delete possible authored content.

#### Scenario: Session startup fails after checkout creation
- **WHEN** a worktree is created successfully but its session fails to start
- **THEN** Convoy reports the session failure, preserves the worktree, and permits retrying the session on that same work

### Requirement: Propose uses the project's authoring workflow
Propose SHALL invoke an available project OpenSpec authoring workflow in the selected work's checkout. If none is available, Convoy SHALL explain the unavailable action before launching it and keep ordinary conversation available without silently installing global commands. Newly produced contracts SHALL be presented for explicit association review, even if a single candidate can be suggested; a differing change ID SHALL NOT automatically rename the work's branch.

#### Scenario: Propose produces a differently named change
- **WHEN** the project's workflow produces one eligible change whose ID differs from the work title
- **THEN** Convoy proposes the contract for explicit association review and, on acceptance, links it without renaming the branch or requiring session relocation

#### Scenario: Authoring workflow unavailable
- **WHEN** the selected project has no supported proposal workflow
- **THEN** Propose reports that condition, offers ordinary conversation, and does not claim a proposal workflow ran

### Requirement: Historical run association uses recorded work identity
Work-scoped launches SHALL reuse the existing feature plan link and durable lifecycle run records, preserving repository/feature identity, association revision, full contract set, checkout, actual branch, and intended base. No parallel work ID or historical-run store SHALL be created. History SHALL prefer this recorded association over the current branch at a reused path. Legacy runs SHALL remain readable and resumable under existing execution constraints without requiring new identity fields.

#### Scenario: Worktree disappears after a run
- **WHEN** a worktree is removed after a work-scoped run finishes
- **THEN** its history remains associated with the original work while execution actions report the missing checkout

#### Scenario: Legacy run has no work identity
- **WHEN** an operator opens a run created before this change
- **THEN** its history remains readable and existing resume validation applies without forcing metadata conversion

### Requirement: Pre-proposal state uses shared lifecycle assessment
The feature list, Home, detail, and action handlers SHALL consume the same lifecycle assessment. A feature with a verified checkout, no contracts, and no execution SHALL offer conversation and proposal without claiming implementation completion or close readiness. Contract assignment SHALL use the existing explicit association-revision workflow. Verified archive evidence for a change SHALL remain authoritative over an unarchived copy of the same change ID that exists only on a branch behind the work's recorded base; the assessment SHALL disclose that stale-copy discrepancy instead of presenting the stale copy as current state. Archived contracts, local integration, publication, and cleanup SHALL retain their separate existing evidence requirements.

#### Scenario: Empty contract set is awaiting proposal
- **WHEN** a newly created feature has no selected contracts or execution
- **THEN** Home and the board identify it as awaiting proposal and close remains unavailable with a concrete explanation

#### Scenario: Several contracts share one feature
- **WHEN** two contracts are explicitly associated with one checkout and the reader focuses one
- **THEN** pipeline review preserves both contracts and close remains an operation on the entire feature, not a partial branch landing

#### Scenario: Stale branch copy defers to verified archive evidence
- **WHEN** an active copy of an associated change exists only on the feature branch behind its recorded base while verified archive evidence for that change ID exists in the base state
- **THEN** the shared assessment reports the archived state with the stale-copy discrepancy disclosed, and neither Home nor the board presents the stale copy as awaiting proposal or implementation
