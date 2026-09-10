# feature-lifecycle Specification

## Purpose

Track a unit of implementation through explicit repository-scoped identity and independently verified lifecycle evidence, so branch names, artifact copies, archive operations, and checkout cleanup do not redefine or erase the operator's work.

## Requirements

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
