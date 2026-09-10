## MODIFIED Requirements

### Requirement: Close composes explicitly reviewed worktree operations
`convoy close` and the Worktrees close action SHALL use the same optional composite operation for an explicitly selected checkout and base: review, sync as needed, archive the explicitly selected local active changes in reviewed order, then squash the entire branch result. Zero selected changes SHALL be supported; no tasks from unselected inherited changes SHALL become a close prerequisite. Selected archive inputs SHALL satisfy the ordinary archive task/cleanliness rules. Already archived local artifacts SHALL be readable context but SHALL NOT imply prior integration or require a new feature incarnation. The operator SHALL see the source/base difference as a diff-stat summary (or fuller diff) before effects, together with the fact that selecting changes controls archive inputs, not squash scope. Initial source/base and all requested steps SHALL be reviewed before effects. Push, worktree removal, and local branch deletion SHALL remain optional separately accepted actions. When a linked open PR for the branch is detected through usable hosting evidence, the landing step SHALL be the hosted path (publish the branch, request the PR's squash-merge with the reviewed message, fast-forward the local base to GitHub's squash commit) and its remote effects SHALL be disclosed as part of the reviewed plan; without a linked PR, unavailable evidence, or an operator decline of the hosted path, close SHALL land locally and there SHALL be no automatic hosted PR merge, PR closure, or remote branch deletion.

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

### Requirement: Close preserves message review and truthful operation progress
Interactive close SHALL show each selected operation's progress, verified success, skip reason, or failure, with responsive activity during asynchronous composition. The squash message SHALL describe the whole branch range using selected local proposals, capability names, and commit/diff context; an unavailable writer SHALL use an honest deterministic conventional fallback. A single selected touched capability SHALL be the composed scope; zero or multiple SHALL omit scope. Selected change IDs SHALL be included in the body when present, with no invented change for spec-less work. Context needed across archive SHALL be retained only for the unresolved operation. A detected PR number SHALL be a reviewed reference, not a guarantee of hosted merge, and an operator edit removing it SHALL be respected. Explicit `--message` SHALL win verbatim. Without that override, interactive landing SHALL require Accept/Edit/Cancel review with inline multiline editing; saving an edit SHALL not itself accept. Failed operations SHALL remain readable, terminal state SHALL be restored, and headless execution SHALL print the same facts with explicit-input/acceptance requirements rather than invoke an editor or guess a destination.

On the hosted path, the accepted message SHALL become the hosted squash commit's subject and body, and progress SHALL narrate each remote step with truthful hosting facts: the published branch revision, GitHub's squash commit and PR merged state once observed, and a skip reason when the local base was already current. After the hosted merge is observed, the summary MAY state the merge as a fact tied to the observed PR and commit; without that observation, narration SHALL NOT claim a hosted merge. Headless hosted close SHALL compose and use the explicit `--message` (or the deterministic fallback) without opening an editor.

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

#### Scenario: Hosted landing narrates the merge it observed
- **WHEN** a close with a linked PR observes the hosted squash-merge completing
- **THEN** the progress and summary name GitHub's squash commit and the PR's merged state, instead of the reference-only PR disclosure

#### Scenario: Hosted merge request fails
- **WHEN** GitHub rejects or cannot perform the squash-merge for the linked PR
- **THEN** close stops with the blocker and remediation, the local branch, worktree, and PR remain unchanged, and retry reconciles by receipt rather than duplicating effects
