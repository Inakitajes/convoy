# worktree-operations Specification

## Purpose
Let operators perform independent, explicitly scoped Git, OpenSpec, and publication actions on selected worktrees without maintaining feature lifecycle state or permanent landing authority.

## Requirements

### Requirement: Operations expose specific prerequisites and explicit targets
CLI and TUI SHALL use the same operation-specific prerequisite checks and report blocked reasons without a global ready/completed stage. Review SHALL disclose the selected checkout, actual source branch/HEAD, applicable local change selection, base, and remote destination. Effects SHALL revalidate those inputs and refuse changed or unreadable required evidence. Managed writer conflicts SHALL block incompatible operations, while unrelated worktrees remain usable. Unknown Git status SHALL NOT mean clean. Main and detached checkouts SHALL remain inspectable; operations requiring an attached branch or removable linked checkout SHALL explain their narrower prerequisites. No operation SHALL require feature registration or a landing receipt. Blocked operations SHALL surface every blocker (reason and remediation) in the interface that launched the action: a TUI menu action SHALL present them as a visible notice and SHALL never silently return to the menu, and headless surfaces SHALL report them through their error channel.

#### Scenario: A blocked menu action stays visible
- **WHEN** a TUI menu operation is refused by a shared prerequisite check that does not throw
- **THEN** the launching menu shows the blockers and their remediations before returning, instead of losing them to an unwritten process stream

#### Scenario: A target is replaced after review
- **WHEN** the checkout path now names another branch, repository, or unverifiable worktree incarnation
- **THEN** the pending operation stops and requires renewed selection and review without touching the replacement

#### Scenario: A writer is active
- **WHEN** a managed pipeline writes in the selected checkout while archive or sync is requested
- **THEN** the conflicting action reports the writer and does not start a second mutation

### Requirement: Fetch and synchronization are distinct actions
Fetch SHALL update the explicitly selected remote references without merging into a checkout. Sync SHALL merge a reviewed base revision into the selected branch, without implicit fetch, pull, rebase, stash, archive, push, or base-checkout movement. Sync SHALL require a readable clean source, related histories, and no incompatible in-progress operation. If the selected base is already contained in the source, it SHALL report no sync needed; merely sharing an ancestor SHALL NOT satisfy that check. Conflicts SHALL remain visible for operator resolution with abort/resume guidance; no agent SHALL silently resolve them.

#### Scenario: Base has new commits
- **WHEN** the branch shares an ancestor with the selected base but lacks its current tip
- **THEN** sync offers a merge of the disclosed base revision rather than reporting up to date

#### Scenario: Merge conflicts
- **WHEN** the requested sync conflicts
- **THEN** Convoy stops with the Git conflict state preserved, does not push or archive, and refreshes the worktree facts

#### Scenario: Remote observations are old
- **WHEN** upstream divergence is computed before a new fetch
- **THEN** the interface identifies the values as based on locally known remote refs and offers explicit fetch without claiming live server freshness

### Requirement: Push is independent and never forced
Push SHALL work without a run, spec, feature record, or GitHub CLI. It SHALL disclose and confirm the source revision and destination remote/ref; absent or ambiguous upstream configuration SHALL require explicit destination selection rather than a guessed remote. Push SHALL publish the reviewed committed revision using a normal non-force update. Dirty local files SHALL be disclosed as excluded, not committed implicitly; unreadable state and unresolved conflicting operations SHALL block. A moved source before execution SHALL require renewed review. Rejection SHALL stop without force fallback. Push SHALL NOT create a PR unless that additional action was explicitly accepted.

#### Scenario: No GitHub CLI is installed
- **WHEN** the operator requests push with a valid Git remote and no GitHub CLI
- **THEN** normal push remains available and reports the exact published revision and destination

#### Scenario: Uncommitted work exists
- **WHEN** a readable checkout has committed changes to push and additional uncommitted files
- **THEN** review explains that only the committed revision is published and leaves local files unchanged

### Requirement: PR discovery distinguishes absence from unavailable evidence
PR lookup SHALL scope the hosting repository, head repository/branch, and base, and report number, title, URL, state, and observation time. Missing tooling, authentication, network failures, or ambiguous matches SHALL remain unavailable/ambiguous evidence, not no PR. A merged PR SHALL be reported as a fact about that PR; it SHALL NOT prove coverage of an advanced or reused branch. Current-head coverage SHALL be asserted only when the available hosting evidence supports the exact merged head and intended base. Local landing, equal trees, a commit's PR-number reference, and push SHALL NOT claim hosted merge.

#### Scenario: PR is merged but work continued
- **WHEN** a matching merged PR describes an older head than the checkout's current tip
- **THEN** the view reports the merged PR and subsequent or unverified current work separately and grants no deletion authority from the PR state

#### Scenario: API request fails
- **WHEN** PR discovery cannot query the hosting service
- **THEN** the view reports unavailable evidence and PR creation does not treat the failure as proof that no PR exists

### Requirement: PR creation reviews semantic text for the whole current range
Create PR SHALL be available for an explicitly selected branch without requiring a run or selected change. It SHALL resolve and review the hosting repository/head/base, inspect the complete current branch range, and propose a conventional human-readable title and semantic description. Explicitly selected checkout-local proposals and applicable run reports SHALL be supporting context, not a substitute for the whole diff. Model-backed proposals SHALL have editable deterministic fallback; unverified tests SHALL be disclosed rather than invented. Push, if needed, SHALL be a separately disclosed prerequisite accepted with the PR plan or performed independently. Matching open PRs SHALL be reused rather than duplicated; ambiguous matches or failed lookups SHALL require resolution. A changed source/base after text review SHALL require re-review. No remote merge, PR closure, or branch deletion SHALL be implicit.

#### Scenario: PR without a run
- **WHEN** an operator requests a PR for a branch with several code changes and no Convoy run
- **THEN** Convoy proposes text describing the full range, allows editing, and creates or reports the explicitly scoped PR after approval

#### Scenario: Only one of several changes is focused
- **WHEN** the reader focuses one change but the PR diff includes other changes
- **THEN** the PR review includes the whole branch range and does not describe the focused change as its exclusive scope

#### Scenario: PR creation response was lost
- **WHEN** the push succeeded and the hosting request timed out after submission
- **THEN** retry queries the same repository/head/base before creating anything, preserves accepted text for unchanged inputs, and reports uncertain evidence rather than blindly duplicating the request

### Requirement: Archive acts only on selected local changes
Archive SHALL invoke the supported OpenSpec workflow in the explicitly selected checkout on the explicitly selected active change, or an explicitly reviewed ordered batch. It SHALL display tasks and artifact availability, refuse missing/unreadable targets, require clean tracked/untracked state for its managed commit, and never archive every directory by discovery alone. Incomplete or unknown tasks SHALL block ordinary archive; an explicit warning/override SHALL be offered only if supported by OpenSpec and SHALL never imply implementation validation. Convoy SHALL inspect the actual OpenSpec output and changed paths, respect the CLI's archive naming, and commit only verified archive output under the operator's signing/hooks. Errors or unrelated changes SHALL stop before commit. External archive/delete SHALL simply change the next local listing; absence alone SHALL NOT count as a completed pending archive. Archived files SHALL remain inspectable without reactivating them.

#### Scenario: An inherited change is present
- **WHEN** a checkout contains selected change A and inherited change B
- **THEN** archiving A does not archive, attach, hide, or require completion of B

#### Scenario: Archive was performed outside Convoy
- **WHEN** OpenSpec moves a change into a dated archive directory outside Convoy
- **THEN** refresh shows the local archive and no association repair, branch rename, or lifecycle update is required

#### Scenario: Archive modifies unrelated files
- **WHEN** an archive attempt leaves changes outside its verified output
- **THEN** Convoy preserves the files, stops before an automatic commit, and explains the recovery requirement

### Requirement: Squash integration is whole-branch and does not rewrite its source
Squash-to-base SHALL review the entire source/base difference, require the pinned base to be contained in the clean source (or explicitly perform sync first), and create exactly one operator-authored conventional candidate with that base as its only parent. Signing, hooks, secret protections, and existing run-recovery refs SHALL remain effective. The source's history SHALL NOT be rewritten. The base checkout SHALL be validated clean and on the intended branch before landing; movement of source/base or unknown state SHALL stop for renewed review. Empty aggregate content SHALL produce no commit and no historical integration claim. Successful integration SHALL report the actual base and commit, not create a permanent receipt or mark a domain entity completed.

#### Scenario: Source contains several runs and archive output
- **WHEN** a reviewed branch is squash-integrated into its selected base
- **THEN** that base receives one conventional commit containing the entire result while the source history remains intact

#### Scenario: Content is identical
- **WHEN** source and base have equal committed trees
- **THEN** Convoy reports no content difference without claiming a previous landing or authorizing deletion of unique source history

### Requirement: Worktree removal and branch deletion are independent decisions
Worktree removal SHALL explicitly review the Git-registered linked checkout, lock state, local changes including untracked/ignored files and relevant submodule state, and active writers. Unsafe or unreadable checks SHALL stop; ordinary removal SHALL not force away local data, remove the main checkout, or remove the process's own checkout. Removal SHALL require explicit launch-time confirmation, like other destructive hard-to-revert actions, naming the checkout and stating that its branch is retained. When ordinary removal is blocked, the launching interface SHALL show every blocker with its remediation and MAY then offer an explicit force path: force consent SHALL be deliberate — a confirmation that names exactly what would be deleted (uncommitted, untracked, and ignored content) — SHALL bypass only content blockers, SHALL never bypass the main checkout, the process's own checkout, an unverified registration, or a lock (unlock remains the path for locks), and SHALL never treat unknown or unreadable state as clean. Stale-target revalidation SHALL apply identically to ordinary and forced removal. Branch retention SHALL be the default. Local branch deletion SHALL be a separate explicit action after verifying the branch is not checked out, rechecking the reviewed tip, and explaining whether its history remains reachable. Deleting unique history after squash SHALL require explicit destructive confirmation, not a receipt, PR badge, tree equality, or expected-tip comparison masquerading as proof of preservation. Conflicting changes SHALL abort; remote deletion SHALL not be automatic. Removal SHALL report removal, never completion.

#### Scenario: Worktree is removed but branch is retained
- **WHEN** the operator confirms removal of a safe linked checkout without branch deletion
- **THEN** the checkout disappears from inventory, its branch remains, and no Completed record is created

#### Scenario: Removal is confirmed at launch
- **WHEN** the operator selects removal from a menu
- **THEN** a confirmation naming the checkout and branch-retention outcome is accepted before the guarded removal runs, and cancelling it performs nothing

#### Scenario: Blocked removal is disclosed with a force option
- **WHEN** removal is blocked by ignored or uncommitted content
- **THEN** the interface shows each blocker and its remediation and offers force removal only as a separate deliberate confirmation listing that content, while main, process, unregistered, and locked targets remain refused

#### Scenario: Squash left unique source history
- **WHEN** branch deletion is requested after a squash while source commits are not preserved by retained refs
- **THEN** the review explicitly warns of unique-history loss and requires separate destructive consent or retains the branch

#### Scenario: Branch moves after review
- **WHEN** a branch tip or worktree registration changes before removal/deletion
- **THEN** the stale action refuses instead of deleting the replacement target

### Requirement: Temporary recovery is not permanent lifecycle state
Operations with non-atomic side effects SHALL retain only the reviewed inputs, expected effects, and acknowledgements needed while unresolved, in storage that survives removal of the target checkout. Before replay, recovery SHALL inspect actual Git, OpenSpec, and hosting results, including effects whose acknowledgement was lost. Conflicting or unverifiable evidence SHALL stop rather than guess. Resolved operations SHALL release their journals and temporary refs; they SHALL NOT become a landing ledger, worktree history registry, or cleanup authority for future unrelated actions. Independent run compaction recovery SHALL remain durable under its existing contract. A fresh invocation after a resolved local squash SHALL not promise retrospective integration certainty unavailable from current Git/hosting evidence.

#### Scenario: Crash after landing before acknowledgement
- **WHEN** an unresolved operation records a candidate that is already reachable from the reviewed base
- **THEN** recovery validates the recorded inputs/candidate and current state before recognizing that effect, avoids creating a duplicate, and retains evidence until all requested steps are resolved

#### Scenario: Checkout removed before final acknowledgement
- **WHEN** the operation loses its process after worktree removal
- **THEN** the external temporary journal permits checking remaining requested steps without recreating the checkout or a feature record

#### Scenario: Operation is fully resolved
- **WHEN** requested steps are completed or safely reconciled and cancelled
- **THEN** operation recovery data is removed without deleting independent run reports or compaction recovery evidence

### Requirement: Recovery targets a pending operation explicitly
`convoy worktrees recover --operation <id>` SHALL inspect the named unresolved operation in the current repository, disclose its recorded targets, intended steps, observed effects, and remaining uncertainty, and require explicit acceptance before continuing effects or safely cancelling. An unknown ID, another repository's evidence, corrupt/unsupported data, or contradictory current targets SHALL stop with actionable guidance and no guessed operation. Recovery SHALL retain evidence until reconciled; deleting evidence SHALL not substitute for reconciliation. Non-interactive recovery SHALL require explicit continuation/cancellation consent and fail non-zero when necessary inputs or safe evidence are unavailable.

#### Scenario: Operation ID is wrong
- **WHEN** the requested recovery ID cannot be validated in the current repository
- **THEN** no operation is replayed and Convoy reports the invalid selection rather than finding a similar branch or change name

#### Scenario: Recovery is inspected without consent
- **WHEN** a valid pending operation is opened for inspection
- **THEN** its known effects and remaining steps are shown without mutating refs, files, or hosting state until continuation or safe cancellation is explicitly accepted
