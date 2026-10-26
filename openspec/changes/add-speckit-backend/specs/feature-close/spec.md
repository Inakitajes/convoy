## MODIFIED Requirements

### Requirement: Close composes explicitly reviewed worktree operations
`convoy close` and the Worktrees close action SHALL use the same optional composite operation for an explicitly selected checkout and base: review, sync as needed, archive the explicitly selected local active changes in reviewed order, then squash the entire branch result. Zero selected changes SHALL be supported; no tasks from unselected inherited changes SHALL become a close prerequisite. When the configured spec tool has no archive support (Spec Kit), close SHALL offer no archive inputs and SHALL review only sync and squash. Selected archive inputs SHALL satisfy the ordinary archive task/cleanliness rules. Already archived local artifacts SHALL be readable context but SHALL NOT imply prior integration or require a new feature incarnation. The operator SHALL see the source/base difference as a diff-stat summary (or fuller diff) before effects, together with the fact that selecting changes controls archive inputs, not squash scope. Initial source/base and all requested steps SHALL be reviewed before effects. Push, worktree removal, and local branch deletion SHALL remain optional separately accepted actions. When a linked open PR for the branch is detected through usable hosting evidence, the landing step SHALL be the hosted path (publish the branch, request the PR's squash-merge with the reviewed message, fast-forward the local base to GitHub's squash commit) and its remote effects SHALL be disclosed as part of the reviewed plan; without a linked PR, unavailable evidence, or an operator decline of the hosted path, close SHALL land locally and there SHALL be no automatic hosted PR merge, PR closure, or remote branch deletion.

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

#### Scenario: Linked PR discloses the hosted landing in review
- **WHEN** close review detects one open PR for the branch with usable hosting evidence
- **THEN** the reviewed plan names the branch push, the GitHub squash-merge of that PR with the reviewed message, and the local base fast-forward as the landing steps before any effect runs

#### Scenario: Operator declines the hosted landing
- **WHEN** a linked PR is detected and the operator chooses the local landing during review
- **THEN** close performs the unchanged local squash path and neither pushes nor touches the PR

#### Scenario: Close under Spec Kit
- **WHEN** the project sets `specs: speckit` and the operator closes a worktree with active features
- **THEN** review offers no archive selection, lists only sync and squash as effects, and no feature directory is moved
