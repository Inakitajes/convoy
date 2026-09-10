# work-context Specification

## Purpose

Keep each development work item associated with its checkout, optional specification, conversations, and runs throughout creation, execution, and recovery.

Work denotes the existing repository-scoped feature identity in the work-first UI. This capability builds on `stable-feature-lifecycle` and SHALL NOT introduce a second identity or ownership registry. Display name and any Git-valid branch name remain attributes; the selected contract in a reader is focus within the feature's reviewed contract set.

## Requirements

### Requirement: Work exists before a specification
Convoy SHALL offer **New worktree**, ask what the operator wants to build, and propose a Git-valid conventional branch name and worktree destination using the repository's existing location convention. The proposal SHALL support model-backed naming with a deterministic fallback that is editable through the manual refine mode. Before creation the operator SHALL review the name, branch, base, and derived destination; the branch and base SHALL be editable, while the destination — derived from the branch — SHALL be shown for review in the accepted proposal rather than being directly editable. Independent creation SHALL suggest the detected repository base, not silently derive from the selected feature branch; deliberate derived work SHALL disclose its source. Creation SHALL always mint a free conventional branch: a deliberately typed existing branch name SHALL be suffixed by the collision policy rather than checked out in place, and existing branches SHALL be reached by selecting their already-registered checkouts in the inventory. Creating a worktree SHALL NOT create a feature record, spec, commit, PR, or authoring session. The new worktree SHALL be selectable before any change or run exists.

#### Scenario: Proposal starts in isolation
- **WHEN** an operator approves a new worktree from main and subsequently starts proposing
- **THEN** creation first establishes the reviewed checkout and the authoring agent later writes there, not in main

#### Scenario: Creation is cancelled
- **WHEN** the operator cancels the naming or destination review
- **THEN** no worktree, branch, session, or domain association is created

#### Scenario: Authoring has not begun
- **WHEN** a worktree exists without any change or run
- **THEN** it remains selectable with conversation, propose, and applicable pipeline actions

#### Scenario: Naming service unavailable
- **WHEN** model-backed naming fails or is unavailable
- **THEN** Convoy offers an editable conventional fallback and does not execute Git until the destination is accepted

#### Scenario: An existing branch name is deliberately typed

- **WHEN** the operator types an existing branch name into the manual refine form and approves creation
- **THEN** the collision policy suffixed a free branch instead of checking out the existing one, and the reviewed proposal named that suffixed branch before any Git effect

### Requirement: Every action uses a validated destination
Reading, conversation, proposal, pipeline preparation/execution, publication, archive, and close SHALL target the explicitly selected Git worktree. Configuration, relative attachments, canonical specs, and selected changes SHALL resolve within that checkout. Explicit selectors MUST agree; missing or replaced destinations SHALL require refreshed selection rather than a fallback to the launch directory. Operations SHALL validate repository membership, worktree registration, current branch/HEAD, and relevant reviewed refs immediately before effects. Base-checkout operations SHALL disclose and validate their separate destination. Selection SHALL NOT mutate a process-wide working directory or establish ownership. Session/navigation hints and historical run provenance SHALL NOT substitute for current validation.

#### Scenario: Work selected from another checkout
- **WHEN** Convoy starts in main and the operator acts on another worktree
- **THEN** that worktree supplies all checkout-relative resources and receives the requested effects without a parent-shell directory switch

#### Scenario: Destination changes during review
- **WHEN** the reviewed worktree is removed, replaced, or changes branches before execution
- **THEN** the action refuses the stale review rather than accepting a replacement or executing in main

#### Scenario: Independent work runs concurrently
- **WHEN** operations run in two distinct worktrees
- **THEN** navigation in either view does not alter the other operation's target, local inputs, or session

### Requirement: Interrupted creation is recoverable
Convoy SHALL preserve partial creation results and explain precisely which branch and checkout exist. Retrying SHALL reconcile an unresolved creation intent against actual Git state before reusing a matching result; it SHALL NOT overwrite a directory, delete possible authored content, or create duplicate worktrees. Required temporary recovery data SHALL be stored outside the destination and removed when resolved. Session startup is a separate action whose failure SHALL NOT invalidate successful worktree creation.

#### Scenario: Session startup fails after checkout creation
- **WHEN** creation succeeded but a subsequently requested authoring session fails
- **THEN** the worktree remains usable and the operator can retry only the session

#### Scenario: Acknowledgement of creation was lost
- **WHEN** Git created the reviewed checkout but the process stopped before reporting success
- **THEN** retry verifies the pending operation's target and reuses it or reports a conflict without creating another branch

### Requirement: Propose uses the project's authoring workflow
Propose SHALL invoke the available project OpenSpec authoring workflow in the selected checkout. If unavailable, Convoy SHALL explain the condition and keep ordinary conversation usable without silently installing global commands. On return it SHALL refresh that checkout's local changes; new artifacts SHALL be usable without association review or registry writes. A differing change ID SHALL NOT rename the branch. Later pipeline/archive inputs SHALL still require explicit selection.

#### Scenario: Propose produces a differently named change
- **WHEN** authoring produces a change whose ID differs from the worktree or branch name
- **THEN** the change appears under that checkout without rebinding, registration, or renaming

#### Scenario: Authoring workflow unavailable
- **WHEN** the project has no supported proposal workflow
- **THEN** Convoy reports that condition, offers conversation, and does not claim a proposal ran
