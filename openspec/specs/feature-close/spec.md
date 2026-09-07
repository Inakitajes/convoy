# feature-close Specification

## Purpose
Close a feature in one orchestrated sequence — sync, archive, squash, merge, optional cleanup — so canonical specs are produced against a fresh base branch and no drift window or stale-change state can survive.

## Requirements

### Requirement: Close preflights before touching anything

`convoy close` SHALL resolve stable feature identity, its explicit contract set, intended local base, and verified current context through the shared lifecycle assessment. Branch/change selectors SHALL be validated against that identity; unresolved legacy work SHALL require explicit adoption rather than a branch-name guess. For a new integration, the feature tree SHALL be clean, all associated contracts' task prerequisites SHALL be verified complete, no live run SHALL be attached to the feature or implementation context, and the base checkout SHALL be clean and on the intended local base branch. Required repository identities, context registration, current branch/HEAD, and Git/run state MUST be verifiable. An archived contract SHALL require positive archive/task evidence; missing active files SHALL not bypass task checks. Each blocker SHALL include remediation. Cleanup-only continuation of verified landing SHALL assess remaining cleanup prerequisites without demanding removed worktrees or active task files. A published branch SHALL NOT block close merely because it is published; known remote context SHALL be disclosed without asserting a PR exists or merged. An upstream alone SHALL NOT be proof of publication. Close MUST NOT force-push or automatically publish.

#### Scenario: Incomplete tasks stop the sequence

- **WHEN** close runs on a feature with an associated change at 8 of 11 tasks complete
- **THEN** no branch changes and the blocker identifies the change and missing task count

#### Scenario: Main checkout is unavailable for landing

- **WHEN** the base checkout is dirty or not on the intended local base branch
- **THEN** close stops before sync or archive with the concrete prerequisite

#### Scenario: Published feature closes normally

- **WHEN** a complete clean feature has published commits and all other preconditions hold
- **THEN** close discloses remote context and proceeds without rewriting published feature history or requiring a force-push

#### Scenario: A mistyped change is not an archive

- **WHEN** an explicit change selector is absent from the feature's contract set or its required artifact/evidence source cannot be verified
- **THEN** close refuses before mutation rather than skipping tasks or declaring the change already archived

#### Scenario: Worktree and branch disagree

- **WHEN** explicit or recorded worktree/branch selectors refer to different checked-out contexts or repositories
- **THEN** close refuses before sync or archive and identifies the conflicting context

### Requirement: Close syncs the base branch before archiving

Close SHALL merge the local base branch into the feature branch inside the feature worktree as its first repository mutation when synchronization is necessary. Sync SHALL NOT mean fetch or pull and MUST NOT move the base checkout. The fork relationship SHALL be derived from Git merge-base, without a configurable boundary or preserve-commits mode; unrelated or ambiguous bases SHALL be refused rather than guessed. Close SHALL capture the base revision used for sync and revalidate it before landing. A conflicting merge SHALL stop with the conflict state left for the operator to resolve and SHALL support `close --resume` without blindly repeating completed steps. If the base advances after sync or during review, close SHALL stop for renewed integration and validation rather than claiming the landing is necessarily conflict-free.

#### Scenario: Clean sync

- **WHEN** the local base has advanced and integration applies cleanly
- **THEN** the feature contains the captured local base tip before archive, while the base checkout and remote refs are not advanced by sync

#### Scenario: Conflicting sync pauses the sequence

- **WHEN** the sync merge conflicts
- **THEN** close stops with the conflict listed and resume after resolution continues from the first unmet prerequisite

#### Scenario: Base advances during message review

- **WHEN** the operator confirms a message after the base moved beyond the synchronized revision
- **THEN** close refuses that stale landing and requests resume with fresh integration and archive-result validation

### Requirement: Close archives through the OpenSpec CLI

After required synchronization, close SHALL archive each associated active change through the OpenSpec CLI in the verified feature checkout and commit the archive result under the operator's identity; Convoy SHALL not author OpenSpec artifacts itself. Archive success SHALL require verified correspondence between the selected change, archive artifacts, canonical-spec synchronization, completed task evidence, and committed result. An absent active directory alone SHALL never mean already archived. An externally archived change SHALL be accepted only after locating and validating its unambiguous archived artifacts, task completion, and canonical-spec result; otherwise close SHALL stop with remediation. For previously verified archives, close SHALL revalidate their applicability after base synchronization and SHALL not archive them a second time. Failure or ambiguity SHALL stop before landing, preserve completed archive evidence, and support resumption of remaining contracts. Message context SHALL include verified archived proposal/capability artifacts when active artifacts are no longer present.

#### Scenario: Archive then commit

- **WHEN** sync completes and an associated contract is active
- **THEN** OpenSpec archives it in the feature worktree, canonical specs receive the deltas, the result is committed on the feature branch, and close retains its archive evidence

#### Scenario: External archive before close

- **WHEN** an operator already archived a feature's change and its archived tasks and canonical-spec result can be verified
- **THEN** close shows archive verified/skipped, retains the proposal context, and continues integration without recreating the active directory

#### Scenario: Archive directory exists but canonical sync is missing

- **WHEN** archived delta artifacts are present but their required canonical-spec effect cannot be established
- **THEN** close blocks before landing and asks for archive/spec reconciliation rather than treating directory presence as success

#### Scenario: Multi-contract archive is interrupted

- **WHEN** one contract is verified archived and archiving the next fails
- **THEN** no landing occurs and resume revalidates the first result before continuing only the unmet archive work

#### Scenario: Overlapping contracts compose their effects

- **WHEN** two associated contracts modify the same requirement and both must be verified before landing
- **THEN** close verifies the ordered composed effect against retained per-contract evidence, or refuses before the first archive mutation when it cannot establish that composition

### Requirement: Close always squash-lands the complete feature

After verified archive processing, close SHALL land the entire feature-exclusive result as exactly one regular conventional commit under the operator's identity on the captured local base revision. The commit SHALL have one parent, that base revision, and include operator commits, previous run-compaction results, remaining intermediate run work, sync resolutions, and archive output as content rather than additional base-history commits. Commits already reachable from the base SHALL NOT be duplicated. Close MUST NOT squash-rewrite the feature branch, fast-forward the base to its tip, or create an additional merge commit. Feature history SHALL remain intact apart from additive sync/archive work. Review SHALL identify the feature, complete contract set, source branch, intended base, and whole-branch landing scope; selecting a contract SHALL NOT imply path-filtered integration. Empty aggregate changes SHALL produce an explicit no-change result, not an empty commit or unsupported prior-landing claim.

The landing SHALL preserve operator signing, hooks, and secret-file protections and guard against stale association, branch/base/index/worktree state. A failure before landing MUST leave the base unadvanced; interrupted operations SHALL expose durable recovery evidence and MUST NOT discard unrelated work. Landing and cleanup evidence SHALL be tied to stable feature identity, an individual attempt, exact prepared feature tip/tree, and the captured base and resulting landing. Conflicting Convoy mutations SHALL be serialized and final ref changes SHALL be guarded against intervening external changes.

After verified landing, base push, worktree removal, and local feature-branch deletion SHALL remain separate deliberate choices. Push SHALL be normal, never forced. Both worktree removal and branch deletion SHALL require a verified landing still contained in the intended base and a verified association to the exact unchanged feature tip, not squash ancestry assumptions or tree equality alone. Worktree removal SHALL precede branch deletion, refuse dirty/changed contexts, and preserve unrelated branches at reused names or paths. Inside the feature worktree, removal/deletion SHALL remain deferred guarded guidance, not runnable in-session actions. Headless guidance SHALL name the configured remote/base and preserve the same identity, landing, tip, and execution-order guards. Missing base upstream SHALL disable push with setup guidance. Remote feature-branch deletion SHALL NOT be automatic. Run recovery refs and completed landing evidence SHALL survive ordinary cleanup.

#### Scenario: One conventional commit lands

- **WHEN** close completes for a branch containing an operator proposal, two compacted runs, and archive output
- **THEN** the base gains exactly one regular commit containing the complete result and the feature worktree remains until deliberate cleanup

#### Scenario: Advanced base still receives one commit

- **WHEN** the base advanced since the fork and sync resolved integration before archive
- **THEN** close lands one commit on the synchronized base without an extra merge commit or duplicated base changes

#### Scenario: Uncompacted or operator-only feature

- **WHEN** a feature contains unsquashed machine commits or only operator-authored work
- **THEN** close includes the complete result without depending on automatic compaction success

#### Scenario: Empty aggregate change

- **WHEN** the verified archived feature tree equals the captured base tree and no landing receipt exists
- **THEN** close reports no content to land, creates no empty commit, and does not authorize destructive cleanup on equality alone

#### Scenario: Cleanup respects git dependencies

- **WHEN** close has verified evidence, runs outside the unchanged feature worktree, and that worktree still exists
- **THEN** push and clean worktree removal are runnable after consent, branch deletion remains unavailable until removal succeeds, and every operation revalidates its evidence

#### Scenario: Cleanup is deferred inside the feature worktree

- **WHEN** close completes from within that worktree
- **THEN** configured base push remains runnable while worktree/branch cleanup is shown as guarded continuation commands for execution after leaving it

#### Scenario: Feature changes before cleanup

- **WHEN** the feature tip changes, association changes, or worktree becomes dirty after landing
- **THEN** cleanup refuses removal/deletion rather than applying a stale receipt or unconditional force-delete

#### Scenario: Missing upstream disables push

- **WHEN** the base has no configured upstream after close
- **THEN** push is unavailable with setup guidance and no invalid push command is printed

#### Scenario: Reused branch is not cleaned up

- **WHEN** an old feature's original branch name now points to another feature's work
- **THEN** old-receipt cleanup refuses to remove that branch or its worktree even if names match

### Requirement: Merged detection reports probability, not certainty

Board and close SHALL use the same integration assessment. Patch equivalence without verified Convoy landing evidence SHALL remain *probably merged*, never a completed close or cleanup authorization. A verified durable receipt for the selected feature and unchanged feature tip, with its landing still reachable from the intended base, SHALL establish completed local integration even after base advancement. Every close invocation, with or without `--resume`, SHALL consult existing attempts and receipts before new sync/archive work and SHALL not create another landing for the same closed tip. Missing worktree or renamed branch SHALL not erase the feature's evidence; any current binding SHALL be verified before mutation. Tree equality alone SHALL not establish a previous close or authorize branch deletion. Probable external integration SHALL stop direct close before duplicate landing and retain deliberate archive-on-main remediation for active contracts. Archive-on-main SHALL verify a clean checkout on the intended base, invoke OpenSpec there, and commit only the archive result without feature sync/landing. Neither local landing, base push, nor archive-on-main SHALL assert hosted PR merge.

#### Scenario: Squash-merged change shows honestly

- **WHEN** a feature appears externally squash-merged without a Convoy receipt and remains unarchived
- **THEN** the board reports probably merged and offers deliberate archive-on-main guidance without inventing a certain landing

#### Scenario: Direct close encounters probable external landing

- **WHEN** direct close finds patch-equivalence evidence without a verified receipt
- **THEN** it stops before sync or another landing and provides inspection/archive-on-main guidance

#### Scenario: Archive on main

- **WHEN** the operator accepts archive on main and the base checkout is verified clean and on the intended base branch
- **THEN** OpenSpec archives there and the result is committed without feature sync, squash, or merge

#### Scenario: Archive on main verifies its source

- **WHEN** archive-on-main is selected for a feature whose active artifacts also exist in the feature worktree
- **THEN** Convoy verifies the base-checkout copy corresponds to the selected contract before archiving, records the archive source and evidence, and leaves integration reported as probably merged or pending rather than confirmed

#### Scenario: Resume after base advances beyond a completed landing

- **WHEN** close targets an unchanged feature whose recorded landing remains reachable from the advanced base
- **THEN** it reports the existing landing and offers only applicable safe follow-ups without another commit, regardless of whether `--resume` was supplied

#### Scenario: Resume after worktree removal

- **WHEN** verified close removed a feature's worktree but branch cleanup was interrupted
- **THEN** feature-identity lookup reconstructs remaining cleanup without requiring the worktree and rechecks the current branch tip and landing

#### Scenario: Landing evidence becomes stale

- **WHEN** the base no longer contains the recorded landing or the associated feature tip has advanced
- **THEN** close reports stale evidence and requests explicit recovery or new-work planning instead of relanding or deleting automatically

### Requirement: Close attempts reconcile every mutation boundary

Close SHALL persist feature/attempt identity and the intended operation before each irreversible or externally visible repository mutation, and persist verified outcomes after it. Sync conflicts, archive execution/commit, candidate creation, base landing, and cleanup SHALL have recoverable before/after evidence. Resumption SHALL inspect current Git and artifact state to reconcile a completed operation whose acknowledgement was not saved; it SHALL not rely solely on the journal's last phase label. A candidate already reachable from the base with the recorded parent/tree and unchanged feature preparation SHALL be reconciled as the existing landing even if the base advanced afterward. Unexplained divergence SHALL stop for recovery. Renewed integration after an unrelated base advance SHALL retain prior evidence and revalidate archive output against the new preparation. Successful receipts SHALL be immutable and survive later attempts, no-change outcomes, and cleanup.

#### Scenario: Crash after base landing before receipt acknowledgement

- **WHEN** the base contains the recorded candidate but the journal still describes landing as pending
- **THEN** resume verifies candidate, preparation, and ancestry, records the existing landing, and does not create another commit

#### Scenario: Crash after archive before archive commit

- **WHEN** OpenSpec completed archive but the process stopped before committing it
- **THEN** resume checks the recorded archive intent, expected artifact effects, and absence of unrelated dirt before committing only the verified archive result or stops with recovery guidance

#### Scenario: Base moves without containing the candidate

- **WHEN** a pending candidate was built against an older base and the current base does not contain it
- **THEN** close refuses the stale candidate and requests renewed integration/review without deleting its recovery evidence

#### Scenario: Repeated close after success

- **WHEN** the operator invokes close again for the same feature and unchanged landed tip
- **THEN** the prior receipt remains intact and no sync, archive, or second landing is performed

### Requirement: Close and cleanup expose the same recoverable action assessment

Interactive close SHALL retain its existing checklist, message-review, and failure-display behavior while adding verified feature/context identification and explicit archive/integration/cleanup distinctions. Applicable blocked actions SHALL expose reasons rather than disappear. Completed steps SHALL show verified skip/completion reasons; missing evidence SHALL not be rendered as completion. Cleanup eligibility and evidence SHALL be preserved through command output, TUI follow-up selection, and action-time revalidation. Deferred/headless follow-ups SHALL invoke the same guarded operations rather than print an unprotected check-then-force-delete recipe. Cancellation SHALL preserve recoverable preparation but SHALL not authorize landing or cleanup.

#### Scenario: Cleanup evidence reaches the action

- **WHEN** the operator chooses worktree removal or branch deletion from close's result screen
- **THEN** the operation receives the selected feature/attempt identity, reloads and validates current evidence, and either performs that authorized action or explains its blocker

#### Scenario: Close review is opened while blocked

- **WHEN** a feature has complete tasks but an unresolved association or live run
- **THEN** close review remains reachable, explains what must be resolved, and performs no Git or archive mutation

### Requirement: The squashed commit carries a composed conventional message

The squash-merge commit's message SHALL be composed from the change's proposal, capability names, all feature-exclusive commit subjects, and the aggregate feature change against the captured base, with deterministic fallback when the writer cannot provide a usable proposal. Close SHALL preserve this context across archive and resume so a retry does not degrade into an archive-only description. Regardless of writer output, composed messages SHALL use the single touched capability as scope and omit scope when zero or several capabilities are touched. The subject SHALL be a readable imperative line derived from the change, not the change ID slug; the fallback SHALL use a type-appropriate verb and normalized proposal title. Composed messages SHALL name the change ID in the body. When close detected an open pull request for the feature branch, the composed subject SHALL carry that pull request's number in the `(#N)` reference form GitHub recognizes for squash landings, applied before message review so the operator sees the exact subject that lands; an operator edit that removes the reference SHALL be respected, and close SHALL NOT re-append it. An explicit `--message` SHALL win verbatim and bypass composition, message review, and the pull-request reference.

#### Scenario: Writer proposal lands

- **WHEN** the writer answers for a change touching one capability
- **THEN** the composed subject is readable and imperative, the scope is that capability, and the body names the change ID

#### Scenario: Broad writer proposal loses its scope

- **WHEN** the writer proposes a scope for a change touching several capabilities
- **THEN** close removes the scope while preserving the readable subject and change ID body

#### Scenario: Deterministic fallback without a model

- **WHEN** no writer is available
- **THEN** close derives the branch type, appropriate capability scope, readable imperative subject, and change ID body without preventing message review

#### Scenario: Explicit override wins

- **WHEN** close runs with an explicit message override
- **THEN** that exact message is used without composition or message confirmation

#### Scenario: Resume after archiving

- **WHEN** the operator resumes after archive and a cancelled message review
- **THEN** the writer still receives the preserved proposal and complete feature context rather than only the archive commit

#### Scenario: Detected pull request rides the reviewed subject

- **WHEN** close composes the landing message for a feature branch with an open pull request
- **THEN** the subject shown for review ends with the pull request's `(#N)` reference and the landing commit uses that exact subject

#### Scenario: Operator edit removing the reference is respected

- **WHEN** the operator edits the reviewed message and removes the `(#N)` reference
- **THEN** the landing commit uses the edited message without the reference, and close does not re-append it

### Requirement: Close shows its progress as a checklist

Interactive close SHALL retain its full-screen TUI with preflight as a one-line summary followed by sync, archive, and squash-merge rows. Every row SHALL report completion, skip with reason, or failure. Squash-merge SHALL distinguish composing the message, awaiting review, and creating the landing commit, with a changing running indicator during asynchronous work. The result SHALL name the base and landing SHA and report one feature landing, not a fast-forward or merge-commit shape. The message review SHALL retain a vertical Accept/Edit/Cancel selector, Up/Down navigation, direct shortcuts, and inline multiline editing: saving returns to review without acceptance, cancelling preserves the reviewed value, and no landing happens until acceptance except with explicit `--message` or the existing headless acceptance policy. Failed operations SHALL remain readable until dismissed. Resume SHALL show verified completed steps without replaying them. Optional cleanup SHALL remain in the same interface with retries and deferred prerequisites as guidance. Headless mode SHALL print the same operational facts and guarded continuation commands without interactive offers.

#### Scenario: Checklist completes in a terminal

- **WHEN** close succeeds in a TTY
- **THEN** sync, archive, and squash-merge states stay visible, the base and landing commit are reported, and safe optional cleanup appears in the same interface

#### Scenario: Message composition remains visibly live

- **WHEN** the writer takes time without emitting intermediate events
- **THEN** the squash-merge row names composition and continues animating until the operation advances

#### Scenario: Review choices follow their visual direction

- **WHEN** Accept, Edit, and Cancel appear vertically
- **THEN** Up/Down moves selection, Enter activates it, and the direct shortcuts remain available

#### Scenario: The message is confirmed before landing

- **WHEN** interactive close reaches message review without an explicit override
- **THEN** the operator can accept, edit, or cancel before anything lands on the base

#### Scenario: The message is edited and confirmed inside the TUI

- **WHEN** the operator saves a multiline edit
- **THEN** close returns to review without opening an external editor or landing until the edited message is accepted

#### Scenario: Cancelling an inline edit preserves the reviewed message

- **WHEN** the operator cancels an inline draft
- **THEN** the prior reviewed message is restored and no landing happens

#### Scenario: A stop keeps the state readable

- **WHEN** a step fails
- **THEN** the TUI retains the failed row and remediation until dismissed, and resume reconstructs verified completed work

#### Scenario: Headless cleanup commands are executable

- **WHEN** close completes without a TTY
- **THEN** output names the remote and base explicitly, orders worktree removal before branch deletion, and includes landing/tip guards rather than an unconditional branch force-delete

### Requirement: Close detects and discloses an open pull request for the feature branch

During the squash-merge step, close SHALL probe for an open pull request whose head is the feature branch using the GitHub CLI when it is installed and authenticated. The probe SHALL be tolerant: a missing GitHub CLI, missing authentication, a probe error, or no matching pull request SHALL all degrade to no detected pull request without blocking close, emitting a failure, or asserting anything about hosted merge state. When an open pull request is detected, close SHALL disclose it — its number, title, and URL — in the interactive checklist and the headless summary, without asserting that the pull request is or will be merged. The detected pull request SHALL appear in the follow-up guidance with a deliberate fallback close command naming the pull request and the landing commit, for the case where GitHub does not mark the pull request merged after the push. Close MUST NOT push, merge, or close the pull request itself; every pull-request mutation remains a printed, deliberate operator action.

#### Scenario: Open pull request is detected and disclosed

- **WHEN** the feature branch has an open pull request and the GitHub CLI is available and authenticated
- **THEN** close discloses the pull request number, title, and URL without asserting merge, and the follow-up guidance includes the deliberate fallback close command naming the pull request and the landing commit

#### Scenario: Probe degrades without blocking

- **WHEN** the GitHub CLI is absent, unauthenticated, or the probe fails, and the preflight otherwise passes
- **THEN** close proceeds with no pull-request disclosure and reports no failure

#### Scenario: No pull request mutation is automatic

- **WHEN** close completes with a detected open pull request
- **THEN** close has not pushed, merged, or closed anything on GitHub; only the printed follow-up commands perform those actions when the operator runs them
