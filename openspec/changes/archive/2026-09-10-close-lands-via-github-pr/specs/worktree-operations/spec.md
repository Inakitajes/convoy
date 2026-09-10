## MODIFIED Requirements

### Requirement: Squash integration is whole-branch and does not rewrite its source
Squash-to-base SHALL review the entire source/base difference, require the pinned base to be contained in the clean source (or explicitly perform sync first), and create exactly one operator-authored conventional candidate with that base as its only parent. Signing, hooks, secret protections, and existing run-recovery refs SHALL remain effective. The source's history SHALL NOT be rewritten. The base checkout SHALL be validated clean and on the intended branch before landing; movement of source/base or unknown state SHALL stop for renewed review. Empty aggregate content SHALL produce no commit and no historical integration claim. Successful integration SHALL report the actual base and commit, not create a permanent receipt or mark a domain entity completed.

When close detects a linked open PR for the source branch through usable hosting evidence, the landing SHALL switch to the hosted path instead of the local base advancement: the reviewed branch tip SHALL be published to its destination remote with a normal non-force update, the hosted squash-merge SHALL be requested for that PR with the reviewed message as the squash subject and body, and the local base SHALL then be advanced to the hosted squash commit with a fast-forward-only update. The hosted squash commit SHALL carry the PR number in its subject. The source branch SHALL NOT be force-pushed, rewritten, or deleted by this path. Local landing SHALL remain the only path when no linked PR exists, hosting evidence is unavailable, or the operator declines the hosted path.

#### Scenario: Source contains several runs and archive output
- **WHEN** a reviewed branch is squash-integrated into its selected base
- **THEN** that base receives one conventional commit containing the entire result while the source history remains intact

#### Scenario: Content is identical
- **WHEN** source and base have equal committed trees
- **THEN** Convoy reports no content difference without claiming a previous landing or authorizing deletion of unique source history

#### Scenario: Linked PR routes the landing through GitHub
- **WHEN** close detects one open PR for the current branch and hosting evidence is usable
- **THEN** the branch is pushed normally, GitHub squash-merges the PR with the reviewed message, the local base fast-forwards to the hosted squash commit, and the progress narration names GitHub's commit and the PR's merged state

#### Scenario: No linked PR keeps the local path
- **WHEN** PR discovery reports no open PR for the branch
- **THEN** close lands the local squash exactly as before and push, worktree removal, and branch deletion remain separate actions

### Requirement: Push is independent and never forced
Push SHALL work without a run, spec, feature record, or GitHub CLI. It SHALL disclose and confirm the source revision and destination remote/ref; absent or ambiguous upstream configuration SHALL require explicit destination selection rather than a guessed remote. Push SHALL publish the reviewed committed revision using a normal non-force update. Dirty local files SHALL be disclosed as excluded, not committed implicitly; unreadable state and unresolved conflicting operations SHALL block. A moved source before execution SHALL require renewed review. Rejection SHALL stop without force fallback. Push SHALL NOT create a PR unless that additional action was explicitly accepted.

Standalone push remains a separately accepted action. When close routes landing through a linked PR, the branch push SHALL be integrated into the close transaction as a reviewed step: its destination (the PR's head remote/branch) SHALL be disclosed during review, an uncertain push SHALL be reconciled by receipt on retry rather than duplicated or force-updated, and a rejected update SHALL stop close without force fallback.

#### Scenario: No GitHub CLI is installed
- **WHEN** the operator requests push with a valid Git remote and no GitHub CLI
- **THEN** normal push remains available and reports the exact published revision and destination

#### Scenario: Uncommitted work exists
- **WHEN** a readable checkout has committed changes to push and additional uncommitted files
- **THEN** review explains that only the committed revision is published and leaves local files unchanged

#### Scenario: Hosted close discloses its push
- **WHEN** a close with a linked open PR is reviewed
- **THEN** the review names the branch push to the PR's head remote as one of the accepted steps before any effect runs

### Requirement: PR discovery distinguishes absence from unavailable evidence
PR lookup SHALL scope the hosting repository, head repository/branch, and base, and report number, title, URL, state, and observation time. Missing tooling, authentication, network failures, or ambiguous matches SHALL remain unavailable/ambiguous evidence, not no PR. A merged PR SHALL be reported as a fact about that PR; it SHALL NOT prove coverage of an advanced or reused branch. Current-head coverage SHALL be asserted only when the available hosting evidence supports the exact merged head and intended base. Local landing, equal trees, a commit's PR-number reference, and push SHALL NOT claim hosted merge.

Close SHALL use this same evidence as the routing criterion for its landing path: exactly one open PR on the current head with usable evidence SHALL select the hosted path; no PR SHALL select the local path; unavailable evidence SHALL select the local path and disclose that PR evidence could not be read; a merged PR or ambiguous match SHALL select the local path without asserting hosted coverage.

#### Scenario: PR is merged but work continued
- **WHEN** a matching merged PR describes an older head than the checkout's current tip
- **THEN** the view reports the merged PR and subsequent or unverified current work separately and grants no deletion authority from the PR state

#### Scenario: API request fails
- **WHEN** PR discovery cannot query the hosting service
- **THEN** the view reports unavailable evidence and PR creation does not treat the failure as proof that no PR exists

#### Scenario: Unavailable evidence falls back to local landing
- **WHEN** close runs while GitHub lookup fails but local prerequisites pass
- **THEN** close lands through the local squash path and discloses that PR evidence was unavailable, without claiming any hosted state

## ADDED Requirements

### Requirement: Hosted landing reconciles uncertain remote effects
A close that routes through a linked PR SHALL record each remote step's intent (branch push, hosted squash-merge, local base advancement) before its effect and reconcile it by receipt afterward. A retry SHALL read the current hosting and Git state to decide whether a step already happened — a PR already merged SHALL be recognized as completed, not re-merged; a pushed branch SHA SHALL be recognized, not re-pushed or force-updated; a base already containing the hosted squash commit SHALL be recognized without a second advancement. Contradictory evidence (a merged PR whose squash commit is absent from the recorded base lineage, a moved branch, a non-fast-forwardable base) SHALL stop with guidance instead of guessing. Hosted landing failures SHALL keep the local branch, worktree, and PR unchanged so the operation can be retried or safely cancelled.

#### Scenario: Crash after push before the hosted merge
- **WHEN** an unresolved close records the branch push and the process stops before requesting the hosted merge
- **THEN** recovery observes the pushed branch and the still-open PR, continues with the hosted merge only after explicit acceptance, and does not re-push or duplicate the branch

#### Scenario: Retry after an uncertain hosted merge
- **WHEN** a hosted squash-merge request completes with an unknown outcome and the operation is retried
- **THEN** Convoy reads the PR state, treats a merged PR as the completed step (recording the hosted squash commit), and never issues a second merge request for the same operation
