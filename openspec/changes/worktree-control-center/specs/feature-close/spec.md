## REMOVED Requirements

### Requirement: Close preflights before touching anything
**Reason**: Feature identity, owned contract sets, and receipt-based cleanup prerequisites are retired.
**Migration**: Review an explicit worktree/base and archive selection using the same independent operation guards as the control center.

### Requirement: Close syncs the base branch before archiving
**Reason**: Sync is an independent operation composed by close rather than a feature lifecycle transition.
**Migration**: Use the sync contract in worktree-operations; close orders it before selected archive actions.

### Requirement: Close archives through the OpenSpec CLI
**Reason**: Archiving all associated contracts is replaced by explicitly selected local changes.
**Migration**: Use checkout-local archive operations and temporary recovery; no cross-tree source substitution or stored contract set.

### Requirement: Close always squash-lands the complete feature
**Reason**: Whole-branch squash remains, but feature-wide authority and durable landing receipts do not.
**Migration**: Use whole-branch squash-to-base, followed only by separately accepted push and cleanup actions.

### Requirement: Merged detection reports probability, not certainty
**Reason**: The global integration assessment, permanent receipts, probable-merge lifecycle gate, and archive-on-main ownership inference are removed.
**Migration**: Display ancestry, content difference, and scoped PR facts independently. Archive on main requires explicitly selecting main's local change. Historical squash coverage can remain unknown.

### Requirement: Close attempts reconcile every mutation boundary
**Reason**: Permanent feature attempts/receipts are replaced by temporary operation recovery.
**Migration**: Retain unresolved operation inputs/effects outside the checkout and reconcile them before replay; remove resolved recovery data rather than preserving landing authority.

### Requirement: Close and cleanup expose the same recoverable action assessment
**Reason**: Feature assessment and feature/attempt-based cleanup targets are removed.
**Migration**: Use independent guards for reviewed Git targets and separate confirmations for removal and unique-history deletion.

### Requirement: The squashed commit carries a composed conventional message
**Reason**: Message context must cover the current whole branch and explicitly selected local changes, not a persistent feature contract set.
**Migration**: Preserve semantic composition, deterministic fallback, operator overrides, and interactive editing under worktree close review below.

### Requirement: Close shows its progress as a checklist
**Reason**: The feature checklist and receipt-gated follow-ups are replaced by a checklist of selected independent operations.
**Migration**: Retain responsive progress, inline message review, failure display, and headless guidance without lifecycle completion claims.

### Requirement: Close detects and discloses an open pull request for the feature branch
**Reason**: The old probe conflates lookup errors with no PR and is scoped to feature closure.
**Migration**: Use shared scoped PR observations with unknown/error states. Local close remains usable when hosting is unavailable, but cannot claim no PR or hosted merge.

## ADDED Requirements

### Requirement: Close composes explicitly reviewed worktree operations
`convoy close` and the Worktrees close action SHALL use the same optional composite operation for an explicitly selected checkout and base: review, sync as needed, archive the explicitly selected local active changes in reviewed order, then squash the entire branch result. Zero selected changes SHALL be supported; no tasks from unselected inherited changes SHALL become a close prerequisite. Selected archive inputs SHALL satisfy the ordinary archive task/cleanliness rules. Already archived local artifacts SHALL be readable context but SHALL NOT imply prior integration or require a new feature incarnation. The operator SHALL see the full source/base diff and that selecting changes controls archive inputs, not squash scope. Initial source/base and all requested steps SHALL be reviewed before effects. Push, worktree removal, and local branch deletion SHALL remain optional separately accepted actions; there SHALL be no automatic hosted PR merge, PR closure, or remote branch deletion.

#### Scenario: Close without OpenSpec
- **WHEN** an operator closes a clean worktree without selected changes
- **THEN** close offers whole-branch sync/squash and optional follow-ups without inventing a spec or feature record

#### Scenario: One of several changes is selected
- **WHEN** change A is selected for archive and change B is also present
- **THEN** review discloses that only A is archived but all branch content is integrated, and B is neither implicitly archived nor required to have complete tasks

#### Scenario: Incomplete selected tasks
- **WHEN** a selected archive input has incomplete tasks without an explicitly supported and accepted archive override
- **THEN** preflight names that input and stops before sync or archive mutations

#### Scenario: Base changes during review
- **WHEN** the reviewed base advances before landing
- **THEN** the stale candidate is not landed and the operator must review renewed synchronization and integration

#### Scenario: Cleanup is declined
- **WHEN** squash succeeds and the operator does not select removal
- **THEN** the worktree and branch remain usable without a Completed record, receipt, or mandatory new-work transition

### Requirement: Close preserves message review and truthful operation progress
Interactive close SHALL show each selected operation's progress, verified success, skip reason, or failure, with responsive activity during asynchronous composition. The squash message SHALL describe the whole branch range using selected local proposals, capability names, and commit/diff context; an unavailable writer SHALL use an honest deterministic conventional fallback. A single selected touched capability SHALL be the composed scope; zero or multiple SHALL omit scope. Selected change IDs SHALL be included in the body when present, with no invented change for spec-less work. Context needed across archive SHALL be retained only for the unresolved operation. A detected PR number SHALL be a reviewed reference, not a guarantee of hosted merge, and an operator edit removing it SHALL be respected. Explicit `--message` SHALL win verbatim. Without that override, interactive landing SHALL require Accept/Edit/Cancel review with inline multiline editing; saving an edit SHALL not itself accept. Failed operations SHALL remain readable, terminal state SHALL be restored, and headless execution SHALL print the same facts with explicit-input/acceptance requirements rather than invoke an editor or guess a destination.

#### Scenario: Edited message is not yet accepted
- **WHEN** the operator saves a multiline message edit
- **THEN** the review displays the edited text without landing until explicitly accepted

#### Scenario: Writer unavailable
- **WHEN** semantic composition cannot obtain a usable model response
- **THEN** a conventional deterministic proposal remains editable and makes no unsupported test or PR-merge claim

#### Scenario: Hosting probe fails
- **WHEN** GitHub lookup is unavailable but local operation prerequisites pass
- **THEN** close can proceed after showing PR evidence as unavailable, not as no PR or a hosted merge failure

#### Scenario: Headless close inside the target worktree
- **WHEN** close lands from a process running inside that worktree
- **THEN** removal remains deferred with commands invoking the same guarded operations after leaving the checkout, without unconditional force-deletion recipes

### Requirement: Close recovery ends with the operation rather than a receipt
Close SHALL follow the temporary recovery contract in worktree-operations. Recovery SHALL reconcile pending effects before ordinary fresh-operation preflight when those effects themselves changed checkout/index state. Candidate, source, base, selected archive output, accepted message, and requested follow-ups SHALL be retained only while unresolved. A candidate observed in the base during recovery SHALL be checked against recorded preparation before being acknowledged. Archive completion without its commit acknowledgement SHALL be verified against actual output and unrelated dirt before committing. Resolved steps SHALL not be blindly repeated; unexplained differences SHALL stop with guidance. Resolved close SHALL delete temporary journals/refs and SHALL NOT persist feature records, receipts, or an idempotency guarantee for unrelated future invocations. Subsequent content equality SHALL be reported as no difference, not proof that an earlier close happened.

#### Scenario: Crash after archive before commit
- **WHEN** OpenSpec archived a selected change but the process stopped before committing
- **THEN** resume validates actual archive output and the pending operation before committing only that output or refusing unexplained changes

#### Scenario: Crash after base advancement
- **WHEN** a pending candidate is already contained in the base but landing acknowledgement is absent
- **THEN** recovery verifies its preparation and actual effects, reconciles the existing landing before normal preflight, and does not create another candidate for that completed step

#### Scenario: Later close after resolved operation
- **WHEN** the earlier journal was removed after success and the operator invokes close again
- **THEN** current Git/content/PR facts drive a fresh review, without requiring or manufacturing a permanent landing receipt
