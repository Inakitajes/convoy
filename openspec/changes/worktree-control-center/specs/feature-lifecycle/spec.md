## REMOVED Requirements

### Requirement: Features have stable repository-scoped identities
**Reason**: Git worktrees replace registered features; no durable identity, ownership, or completion model is needed.
**Migration**: Discover existing worktrees directly. Do not convert feature records into worktree records.

### Requirement: Associations express explicit intent rather than naming heuristics
**Reason**: Explicit operation input replaces durable branch/change associations.
**Migration**: Select the checkout and local changes for each operation without adopt, bind, or register.

### Requirement: One resolver supplies all lifecycle action targets
**Reason**: Feature association resolution is removed.
**Migration**: Validate explicit Git checkout targets and operation-specific prerequisites.

### Requirement: Lifecycle facts remain orthogonal and evidence-based
**Reason**: Feature lifecycle assessment is replaced by independent worktree observations, not another summary state machine.
**Migration**: Use control-board observations; task, archive, ancestry, remote, and PR facts retain their separate meanings.

### Requirement: Shared action capabilities explain eligibility and revalidate execution
**Reason**: Feature lifecycle gates and Ready to close are removed.
**Migration**: Use shared operation-specific guards from worktree-operations without association revisions.

### Requirement: Discovery survives archive and cleanup without inventing ownership
**Reason**: Deleted checkouts must not leave registered unfinished/completed features.
**Migration**: Git inventory drives the list; existing run history remains independently inspectable.

### Requirement: Legacy evidence is adopted conservatively
**Reason**: Adoption and receipt import would recreate the retired domain.
**Migration**: Keep legacy run history readable, leave old registry data inert, and inspect unresolved operations only for safe recovery.

### Requirement: Contract sets and new incarnations have explicit reviewed transitions
**Reason**: Persistent contract sets and feature incarnations are removed.
**Migration**: Review local change selection per action; a retained worktree can be used again without new-work registration.

### Requirement: Recovery reconciles interrupted work after a context moves
**Reason**: Feature rebinding is not the recovery mechanism.
**Migration**: Preserve temporary operation inputs and reconcile against current Git targets; stale targets require renewed review, not bind.

### Requirement: Lifecycle records preserve safety across concurrent updates
**Reason**: Feature records and immutable landing receipts are retired.
**Migration**: Keep generic writer coordination, mutation guards, and unresolved-operation recovery; preserve independent run compaction evidence.

## ADDED Requirements

### Requirement: Feature lifecycle authority is retired without destructive migration
Convoy SHALL stop creating or consulting feature identities, associations, persisted contract sets, and durable landing receipts as discovery or mutation authority. It MUST NOT replace them with a worktree registry, ownership manifest, landing ledger, or completion tombstones. Existing files SHALL remain inert until an explicit scoped cleanup request; cleanup MUST preserve run history, run recovery refs, sessions, and unresolved operations. Retired `convoy feature` commands and feature-ID selectors SHALL fail before effects with replacement guidance, not become pipeline prompts. An unresolved legacy operation SHALL be reported separately and SHALL block conflicting mutation until explicitly reconciled; old receipts alone SHALL NOT authorize cleanup.

#### Scenario: Legacy completed records exist
- **WHEN** a repository contains feature records and receipts for removed worktrees
- **THEN** those records create no Worktrees rows, new identities, completion states, or automatic deletion effects

#### Scenario: Legacy operation is unresolved
- **WHEN** a legacy close journal indicates an unacknowledged repository mutation
- **THEN** inspection remains available, conflicting operations are blocked with recovery guidance, and evidence is not deleted or silently imported into a new domain

#### Scenario: Removed command is invoked
- **WHEN** an operator invokes `convoy feature bind` or passes an obsolete feature-ID selector
- **THEN** Convoy exits non-zero with worktree-selection guidance before any Git or pipeline action
