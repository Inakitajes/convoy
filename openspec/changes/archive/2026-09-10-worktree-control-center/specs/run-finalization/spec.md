## MODIFIED Requirements

### Requirement: Automatic compaction fails closed without requiring interaction

Finalization SHALL revalidate the repository, Git worktree administrative directory and registration, canonical checkout, actual branch identity, HEAD, clean index/worktree, originating run commit provenance, and publication safety immediately before mutation. Historical paths, branch names, feature associations, and landing receipts SHALL NOT authorize a rewrite. It MUST NOT replace commits known to be published on any relevant remote branch and MUST verify remote publication state before rewriting when remotes exist; unverifiable remote state SHALL block compaction. An upstream alone MUST NOT block new unpublished commits. User identity, signing configuration, hooks, and secret-file protections MUST remain effective. Detached/headless execution SHALL use bounded non-interactive subprocesses and MUST NOT hang waiting for credentials, signing, hooks, or input, or silently disable signing/hooks. Concurrent or interrupted mutations MUST be recoverable without overwriting unrelated work. No automatic finalization SHALL publish or force-push. Existing run-bounded eligibility, durable backups and endpoint retention, automatic terminal lifecycle ordering, and separate durable outcomes SHALL remain effective without feature identity.

#### Scenario: Older history is published but this run is not

- **WHEN** the branch has an upstream containing prior history but none of the verified replacement commits
- **THEN** publication safety permits compacting the new run interval without a force-push

#### Scenario: A replacement commit was published

- **WHEN** any commit to be replaced is present on a remote branch
- **THEN** compaction is blocked and all commits are preserved, with guidance that an independently guarded squash-to-base can integrate the whole branch without rewriting its source history

#### Scenario: Signing requires unavailable interaction

- **WHEN** a detached coordinator cannot complete configured signing without interaction or within its deadline
- **THEN** finalization terminates with an explicit failure and preserves recoverable original history without creating an unsigned substitute

#### Scenario: Process stops during finalization

- **WHEN** the coordinator stops between preparing and recording a compaction result
- **THEN** resuming the logical run reconciles its durable transaction before another rewrite and never blindly duplicates or discards work

#### Scenario: Historical destination has been replaced

- **WHEN** the stored checkout path or branch name exists but current Git evidence cannot establish continuity with the originating run
- **THEN** compaction refuses mutation rather than treating the replacement checkout as the old run's target

### Requirement: Manual finish is removed without a compatibility execution path

Convoy SHALL remove the public finish command, its flags/help, the dashboard shortcut, manual finish modal, and finish-specific push/PR follow-up sequence. Invoking the retired `convoy finish` spelling SHALL produce an actionable non-zero diagnostic before repository or run side effects; it MUST NOT be interpreted as a new prompt or execute a hidden compatibility squash. Documentation SHALL explain automatic run compaction and optional whole-branch squash-to-base or close instead, independently of Push and Create PR. Existing run records SHALL remain readable, and no feature registry or close receipt SHALL be required to inspect them.

#### Scenario: Retired command is invoked

- **WHEN** an operator invokes `convoy finish` with or without old options
- **THEN** Convoy exits non-zero without changing state and explains automatic run compaction and optional whole-branch close without offering a hidden finish path

## REMOVED Requirements

### Requirement: Create pull request is the only run-publication action

**Reason**: Publication is an independent worktree operation, not a run-only gate or a mandatory combined push-and-create flow. GitHub availability must not gate standalone Git push.

**Migration**: Dashboards delegate to the same independent Push and Create PR operations available for a currently validated worktree without a run. Review current Git facts and publication scope; never redirect an old run through feature associations or a reused path.

### Requirement: Run history preserves feature identity independently of rewrite authority

**Reason**: FeatureRecord, FeaturePlanLink, registered contract ownership, association adoption/rebinding, and landing-receipt authority are removed. Actual run provenance and recovery remain durable.

**Migration**: Retain immutable run-start observations, accepted run-plan inputs, reports, compaction boundaries, outcomes, journals, and protected recovery refs without converting feature data to another registry. Legacy history remains readable; unprovable target links require explicit fresh target review for actions without manufacturing resume or rewrite evidence.

### Requirement: PR text is composed deterministically from persisted context

**Reason**: An old run and its persisted reports alone cannot describe the current whole branch. Semantic model proposals are allowed, while deterministic fallback and stable unresolved-operation retries remain required.

**Migration**: Compose and review against the whole current branch diff and reviewed base, explicitly selected checkout-local proposals, and optional relevant run reports. Freeze accepted text and inputs for an unresolved operation; changed branch/base observations require re-review, while a new invocation may use newly observed facts.

## ADDED Requirements

### Requirement: Run dashboards delegate independent worktree publication

Run dashboards SHALL expose independent Push and Create PR actions by delegating to the same guarded worktree operations available outside runs; neither operation SHALL require a run or successful run compaction. Existing inspection and navigation SHALL remain available. Run completion, browsing history, and automatic compaction SHALL NOT publish. Headless run completion SHALL provide guidance only unless a separate explicit publication request exists. Push SHALL work without GitHub CLI or GitHub authentication, subject to ordinary Git transport authentication and current safety checks, and SHALL use a disclosed repository, remote, source branch, destination branch, and explicit non-force refspec without force fallback. Create PR SHALL require a usable GitHub CLI and authentication and SHALL review the repository, remote, head repository/branch, and base repository/branch before any authorized push or PR effect. If a push is needed by Create PR, that push SHALL be explicitly disclosed and authorized through the same Push operation. Neither publication action SHALL delete branches or remove worktrees. Missing GitHub tooling SHALL block only the PR action, not Git push or inspection. Shared dirty-tree, managed-writer, and unresolved-operation guards SHALL remain effective. A pending or uncertain compaction transaction whose safety has not been reconciled MUST block publication regardless of entry point; a safely blocked or failed compaction with history intact SHALL not itself prohibit publication.

#### Scenario: Standalone push without a run or GitHub CLI

- **WHEN** a validated worktree has no runs, GitHub CLI is absent, and the operator authorizes a safe Push
- **THEN** Convoy pushes the reviewed source to the reviewed remote destination with an explicit non-force refspec without requiring run metadata or GitHub

#### Scenario: Dashboard delegates the same operations

- **WHEN** a successful run has safely blocked compaction and the operator opens its dashboard actions
- **THEN** Push and Create PR are independently available subject to the same current worktree guards as standalone actions, with no manual finish step

#### Scenario: Push is rejected

- **WHEN** the reviewed normal push is rejected by the remote
- **THEN** Convoy reports the rejection without force fallback and does not proceed with a PR that depended on that push succeeding

#### Scenario: GitHub CLI is unavailable

- **WHEN** a worktree or run dashboard is viewed without usable GitHub CLI or authentication
- **THEN** Create PR shows actionable setup/manual guidance while Push and inspection retain their own independent availability

#### Scenario: Compaction safety is unresolved

- **WHEN** the selected target has a pending or uncertain compaction transaction whose repository safety has not been reconciled
- **THEN** both standalone and dashboard publication refuse effects and identify recovery as a prerequisite

#### Scenario: Completion is not publication consent

- **WHEN** a run completes in either an interactive or headless session without a separate publication request
- **THEN** no push or PR creation occurs and output only exposes actions or guidance

### Requirement: Publication validates current targets and exact PR scope

Before publication effects, Convoy SHALL validate the current repository, Git worktree administrative directory and registration, canonical checkout, actual source branch and tip OID, reviewed remote/repository, and PR base and OID where applicable. These SHALL be observations, not a new persistent worktree identity. A historical path or branch spelling SHALL NOT authorize publication or redirect an old run to a replacement checkout. If continuity with a historical or legacy target cannot be proved, history SHALL remain readable but publication SHALL require explicit fresh target review as a current worktree action, without changing the run's frozen provenance or bypassing resume/recovery safety. Create PR SHALL query for an existing open PR matching the reviewed remote/repository and exact head/base scope before creating one, including on retries and after uncertain results. A matching open PR SHALL be opened or reported instead of duplicated. Query, authentication, transport, and permission errors SHALL be treated as unknown state, not proof of absence; creation SHALL stop until the query succeeds. Push and PR retries SHALL revalidate current facts and reconcile prior effects rather than blindly repeat them.

#### Scenario: Matching open PR exists

- **WHEN** the reviewed repository has an open PR for the exact reviewed head repository/branch and base repository/branch
- **THEN** Convoy reports or opens its URL instead of creating a duplicate

#### Scenario: Same head targets another base

- **WHEN** an existing PR has the same head branch spelling but a different base or head repository
- **THEN** it is not treated as the reviewed match, and Convoy resolves the explicitly reviewed scope before any creation

#### Scenario: PR lookup fails

- **WHEN** the existing-open-PR query fails because of permissions or network errors
- **THEN** Convoy reports PR state as unknown and does not interpret the failure as permission to create a new PR

#### Scenario: Old run target cannot be proved

- **WHEN** a historical run's former path or branch is reused and current evidence cannot prove target continuity
- **THEN** Convoy does not publish the replacement through that old link and requires explicit fresh worktree review for a new publication action without rewriting the historical record

### Requirement: PR drafts describe the reviewed current branch

PR composition SHALL use the WHOLE current branch diff against the explicitly reviewed base, supplemented by zero or more explicitly selected checkout-local proposals and optionally relevant run reports or compacted-run messages. Selected proposals and old run results SHALL NOT restrict branch scope or act as sole authority over current content. A selected proposal that is missing or unreadable SHALL stop composition for correction or explicit deselection, without borrowing another checkout's copy. Having no selected proposal or no relevant report SHALL NOT block publication. Convoy MAY use a model to propose semantic text, but model availability SHALL NOT be required: an honest deterministic fallback SHALL derive from the same reviewed diff and available inputs. Titles SHALL be human-readable, conventional, editable, sanitized, and bounded to the shared subject budget with word-boundary shortening; the conventional branch prefix MAY supply a default type without inferring change ownership from the branch slug. Spaces in human titles SHALL remain supported. The body SHALL provide Why, What, and How-tested sections grounded in observed changes, selected proposal rationale, and actual validation evidence. Missing rationale or tests SHALL be disclosed rather than invented, and old run validation SHALL not be claimed to cover newer branch content without supporting evidence. The operator SHALL review and accept the title, body, base, branch scope, and publication destination before effects.

#### Scenario: Branch includes work after the run

- **WHEN** the branch includes later operator commits beyond a completed run and only one local proposal is selected
- **THEN** the PR draft describes the entire current diff against the reviewed base, not just that run or proposal, and qualifies any older validation evidence

#### Scenario: Semantic proposal is available

- **WHEN** a model proposes a conventional title and body from the reviewed branch diff and selected local inputs
- **THEN** the operator can edit and accept that text rather than being forced to use an old run's deterministic text

#### Scenario: Model or optional sources are absent

- **WHEN** model composition is unavailable and the worktree has no selected proposals or relevant run reports
- **THEN** Convoy offers a deterministic current-diff-based draft with honest missing-rationale and unverified-testing disclosures for review

#### Scenario: Selected source is missing

- **WHEN** an explicitly selected proposal disappears before its text is captured for review
- **THEN** Convoy stops for correction or explicit deselection rather than silently substituting a same-id source or treating it as an unselected optional source

#### Scenario: Human title contains spaces

- **WHEN** the operator reviews `feat: Improve the worktree review flow`
- **THEN** the human-readable conventional title remains valid with spaces, subject to the shared subject length and sanitization rules

### Requirement: Publication retries freeze accepted text and inputs

An accepted publication operation SHALL freeze its title, body, reviewed destination, head/base identities and OIDs, current branch diff inputs, explicitly selected local proposal inputs, and any optional reports used for composition in an operation-scoped recovery journal before effects. An unresolved retry SHALL reuse those accepted inputs and text rather than regenerate them from edited files or a new model response. It SHALL revalidate current tip, base, destination, and Git target before effects; a changed tip or base SHALL require fresh review and acceptance of the new scope, not silent reuse or regeneration. Reconciliation SHALL first determine whether an uncertain push or PR creation already succeeded, locate the exact matching open PR, and avoid duplicate effects; an unsuccessful lookup SHALL remain unknown. A completed operation SHALL remove its temporary journal rather than persist a landing receipt or ownership record. A new invocation after resolution MAY observe new facts and compose new text. If an operation cannot be reconciled safely, its minimal recovery journal SHALL remain available outside any checkout that the operation sequence may remove until resolved, without becoming lifecycle authority.

#### Scenario: Push succeeds and PR creation fails

- **WHEN** publication is retried with unchanged reviewed tip, base, and destination after the push succeeded but PR creation failed
- **THEN** Convoy reuses the accepted title and body and reconciles the successful push and exact existing-PR query before any remaining creation

#### Scenario: Proposal changes during unresolved publication

- **WHEN** a selected proposal or optional run report is edited while publication is unresolved but the reviewed Git scope is unchanged
- **THEN** retry uses the accepted snapshots and text, not the newly edited input or a new model proposal

#### Scenario: Tip or base advances before retry

- **WHEN** either the current source tip or reviewed base OID changes before an unresolved retry
- **THEN** Convoy stops for fresh branch-range and text review and reconciles prior effects instead of publishing the stale accepted scope silently

#### Scenario: Creation succeeded but the response was lost

- **WHEN** PR creation may have succeeded before a transport failure
- **THEN** retry finds and reports the exact matching open PR before considering creation, preserving the accepted text without producing a duplicate

#### Scenario: Later publication sees new facts

- **WHEN** an earlier operation has resolved and the operator starts a new publication invocation after more branch work
- **THEN** the new invocation can compose and review updated text from current facts without treating the previous run or publication text as permanent authority

### Requirement: Run provenance outlives worktree and feature metadata

Convoy SHALL retain immutable run-start repository, Git administrative/registration observations, canonical checkout path, branch or detached state, start OID and base observations, accepted ordered checkout-local change inputs, canonical spec bundle provenance, and actual execution reports in durable run records. Run ids SHALL identify executions, not worktree ownership. Inspection, attach, and historical views SHALL use these records without reinterpreting the current contents of an old path, consulting FeatureRecord or FeaturePlanLink, or creating a replacement worktree registry. Current target observations SHALL be displayed separately from originating provenance. Existing run records and legacy feature links SHALL remain readable as historical data; a link lacking provable continuity SHALL be disclosed as unverified, not adopted or silently repaired. Explicit fresh target review for actions SHALL NOT change the original boundary or relax existing resume, compaction, signing/hooks, publication, or recovery checks. Worktree moves, branch renames, feature-state retirement, close, and ordinary cleanup SHALL NOT delete run history, run-specific backups, finalization journals, or protected phase/attempt recovery refs. Those run recovery records SHALL remain independently inspectable and subject only to their explicit retention/deletion action, separate from temporary publication or close journals.

#### Scenario: Two runs followed by a worktree move

- **WHEN** two runs finish in a worktree that is later moved or whose branch is renamed
- **THEN** both runs retain their original observations and recovery evidence, while current inventory comes from Git without binding or rewriting historical records

#### Scenario: Legacy link lacks execution evidence

- **WHEN** a legacy run can be displayed but its old feature link cannot establish the current target or a trustworthy run-start boundary
- **THEN** inspection remains available, actions require explicit fresh target review and existing resume guards, and compaction remains unavailable without sufficient run provenance

#### Scenario: Close cleanup removes a checkout

- **WHEN** whole-branch close finishes and removes its checkout and resolved operation journal
- **THEN** durable run history, compaction backup refs, phase endpoints, and run-finalization recovery remain inspectable independently, without retaining a close receipt
