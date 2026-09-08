## REMOVED Requirements

### Requirement: Successful spin registers an explicit feature association
**Reason**: No feature registry or durable change ownership remains.
**Migration**: Successful spin exposes the actual created worktree; it appears through Git discovery without adoption.

## MODIFIED Requirements

### Requirement: Spin hands the session over via /move
On successful standalone `convoy spin`, Convoy SHALL print the worktree path, branch, transferred-file outcome, and instruction to run OpenCode's `/move` to continue an external conversation. Spin SHALL NOT fork, copy, summarize, or relocate that session, nor register a feature. Within Convoy the new checkout SHALL become selectable through Git inventory, with managed conversation available independently. The primary creation flow SHALL be New worktree; retained spin SHALL remain an explicit legacy proposal-transfer operation, not adoption or ownership inference.

#### Scenario: Output tells the operator exactly what to do next
- **WHEN** standalone spin completes
- **THEN** output names the directory, branch, moved files, and external `/move` handoff without a feature ID

#### Scenario: Adoption from the work browser
- **WHEN** an operator explicitly requests the retained proposal-transfer flow from the browser
- **THEN** the resulting worktree is selected without creating an association or requiring adoption

#### Scenario: External history has not moved
- **WHEN** the proposal was transferred but an external conversation still belongs to the source checkout
- **THEN** Convoy distinguishes opening a managed conversation from relocating the existing one and does not claim its history moved

## ADDED Requirements

### Requirement: Legacy transfer has operation-scoped recovery only
The retained spin flow SHALL preserve existing explicit change/prefix selection, deterministic allocation, untracked-file transfer, empty-directory pruning boundaries, and opt-in wrapper behavior. Partial transfer SHALL retain source/destination evidence only until resolved, report moved versus remaining files, and refuse overwriting either copy. No spin result SHALL require registry persistence, receipt creation, or a later bind operation.

#### Scenario: Transfer stops partway through
- **WHEN** some selected untracked artifacts have moved before a failure
- **THEN** Convoy names both locations, preserves all surviving files, and retries by reconciling the pending transfer rather than repeating or registering it blindly
