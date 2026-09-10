# feature-close Specification

## Purpose
Close a feature in one orchestrated sequence — sync, archive, squash, merge, optional cleanup — so canonical specs are produced against a fresh base branch and no drift window or stale-change state can survive.

## Requirements

### Requirement: Close composes explicitly reviewed worktree operations
`convoy close` and the Worktrees close action SHALL use the same optional composite operation for an explicitly selected checkout and base: review, sync as needed, archive the explicitly selected local active changes in reviewed order, then squash the entire branch result. Zero selected changes SHALL be supported; no tasks from unselected inherited changes SHALL become a close prerequisite. Selected archive inputs SHALL satisfy the ordinary archive task/cleanliness rules. Already archived local artifacts SHALL be readable context but SHALL NOT imply prior integration or require a new feature incarnation. The operator SHALL see the source/base difference as a diff-stat summary (or fuller diff) before effects, together with the fact that selecting changes controls archive inputs, not squash scope. Initial source/base and all requested steps SHALL be reviewed before effects. Push, worktree removal, and local branch deletion SHALL remain optional separately accepted actions; there SHALL be no automatic hosted PR merge, PR closure, or remote branch deletion.

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
