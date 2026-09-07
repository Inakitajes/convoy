# run-finalization Specification

## Purpose
Automatically compact a successful run into a recoverable operator-authored commit, preserve inspectable intermediate work, and make publishing a separate deliberate pull-request action.

## Requirements

### Requirement: Successful runs attempt finalization automatically

Every newly executed logical run SHALL include one terminal lifecycle row labelled `Compact run`, outside configurable pipeline steps. It SHALL attempt compaction after successful phase execution, any goal-state settlement, and successful completion of the existing success-hook lifecycle, before announcing final completion. It MUST NOT require message confirmation, an editor, or a manual finish action. Configuration and step filters MUST NOT add, remove, select, or repeat this lifecycle operation. Goal fragments SHALL remain one logical run and SHALL NOT finalize separately. Failed or aborted execution SHALL NOT trigger compaction. A normal goal stop below target SHALL retain its existing pipeline-success semantics.

#### Scenario: Successful writable pipeline

- **WHEN** a pipeline and its success hooks finish successfully with eligible current-run commits
- **THEN** its final lifecycle row compacts those commits automatically and displays the resulting commit before run completion

#### Scenario: Goal settlement selects an earlier state

- **WHEN** a goal cycle restores its best measured state and completes normally below target
- **THEN** finalization runs once against the surviving final state, not against a discarded iteration, without changing the reported goal outcome

#### Scenario: Pipeline or fatal hook failure

- **WHEN** execution is aborted or a phase or fatal success hook fails
- **THEN** automatic compaction does not execute and intermediate work remains available for recovery

### Requirement: Automatic compaction is bounded to its originating run

Convoy MUST determine eligibility from a durable run-start repository and branch boundary and current-run commit provenance, not from authorship alone. Only a verified current-run interval SHALL be compacted. Earlier runs, including failed runs, and independent operator commits MUST NOT be replaced. Accepted Convoy-mediated human iterations and recoveries belong to their recorded logical run. If independent commits, unverified merges, missing boundary evidence, or external changes prevent a complete safe interval, finalization MUST leave history unchanged and report why; it MUST NOT silently compact a suffix as though the whole run had been compacted. An execution producing no current-run commits SHALL skip without composing a message or changing Git refs. Merely browsing an old run MUST NOT mutate it.

#### Scenario: Report-only run above older machine commits

- **WHEN** a report-only run completes on a branch containing unsquashed commits from an earlier run
- **THEN** finalization reports no current-run commits and leaves the older commits and refs unchanged

#### Scenario: Consecutive successful runs

- **WHEN** two successful writable runs execute consecutively on the same branch
- **THEN** each eligible run yields its own operator-authored commit without replacing the preceding run's commit

#### Scenario: Independent operator commit interrupts the run interval

- **WHEN** an operator commits independently between two current-run commits
- **THEN** finalization refuses the rewrite and preserves every commit, rather than swallowing the operator commit or claiming a partial squash is complete

#### Scenario: Resume has no trustworthy boundary

- **WHEN** a legacy run is resumed without sufficient durable boundary or ownership evidence
- **THEN** execution can retain its existing resume behavior but automatic compaction reports unavailable evidence and performs no rewrite

#### Scenario: Verified interval has no net content change

- **WHEN** a non-empty eligible current-run interval has the same final tree as its run-start tree
- **THEN** finalization preserves recovery evidence, removes only that verified unpublished interval, and records completed with a no-net-change disposition and no produced commit, rather than manufacturing an empty commit

### Requirement: Compaction preserves recoverable intermediate history

Before any automatic rewrite, Convoy SHALL durably preserve the original run commit graph and phase/attempt endpoints, including work later discarded by goal settlement, together with a run-specific backup and finalization journal. Subsequent runs, ordinary successful-workspace cleanup, and Git garbage collection MUST NOT invalidate that recovery evidence. Historical views SHALL expose exact intermediate diffs or an executable local Git inspection command based on retained endpoints, and guarded restoration guidance. Read-only and no-change phases SHALL be identifiable as such. An inability to persist recovery evidence MUST block the rewrite. Deleting these records SHALL require an explicit retention/deletion action rather than ordinary run cleanup.

#### Scenario: Two runs followed by cleanup and garbage collection

- **WHEN** two runs compact successfully and their temporary workspaces are cleaned and Git garbage collection runs
- **THEN** both runs' individual phase changes and pre-compaction histories remain independently inspectable

#### Scenario: Recovery evidence cannot be saved

- **WHEN** saving a run's recovery record or protective refs fails
- **THEN** no history rewrite begins and the finalization outcome names the failed prerequisite

### Requirement: Automatic compaction fails closed without requiring interaction

Finalization SHALL revalidate branch identity, HEAD, clean index/worktree, ownership, and publication safety immediately before mutation. It MUST NOT replace commits known to be published on any relevant remote branch and MUST verify remote publication state before rewriting when remotes exist; unverifiable remote state SHALL block compaction. An upstream alone MUST NOT block new unpublished commits. User identity, signing configuration, hooks, and secret-file protections MUST remain effective. Detached/headless execution SHALL use bounded non-interactive subprocesses and MUST NOT hang waiting for credentials, signing, hooks, or input, or silently disable signing/hooks. Concurrent or interrupted mutations MUST be recoverable without overwriting unrelated work. No automatic finalization SHALL publish or force-push.

#### Scenario: Older history is published but this run is not

- **WHEN** the branch has an upstream containing prior history but none of the verified replacement commits
- **THEN** publication safety permits compacting the new run interval without a force-push

#### Scenario: A replacement commit was published

- **WHEN** any commit to be replaced is present on a remote branch
- **THEN** automatic compaction is blocked, all commits are preserved, and guidance explains that close can still squash-land the feature

#### Scenario: Signing requires unavailable interaction

- **WHEN** a detached coordinator cannot complete the configured signing operation without interaction or within its execution deadline
- **THEN** finalization terminates with an explicit failure and preserves recoverable original history without creating an unsigned substitute

#### Scenario: Process stops during finalization

- **WHEN** the coordinator stops between preparing and recording a compaction result
- **THEN** resuming the logical run reconciles its durable transaction before attempting another rewrite and never blindly duplicates or discards work

### Requirement: Finalization outcomes are separate and durable

Convoy SHALL persist `pending`, `running`, `completed`, `skipped`, `blocked`, or `failed` finalization state, its reason, and any resulting commit/message/recovery evidence independently of the pipeline result. A safely preserved compaction failure MUST NOT turn successful pipeline execution into failure. A transaction whose safety cannot be reconciled SHALL be disclosed as requiring recovery and MUST prevent publication until reconciled. Live dashboards, attach, historical views, and headless output SHALL show the same state and SHALL NOT present blocked compaction as a clean one-commit result. Finalization failure guidance MUST NOT reference the removed finish command.

#### Scenario: Compaction blocked after successful execution

- **WHEN** a successful run's finalization refuses to replace published commits without changing the repository
- **THEN** the run remains execution-successful, finalization visibly reports blocked, and deliberate PR creation remains available if its own preconditions hold

#### Scenario: Historical dashboard is opened

- **WHEN** a completed run is reopened after its coordinator exits
- **THEN** its finalization result, message, and recovery evidence are reconstructed without running compaction again

### Requirement: Create pull request is the only run-publication action

Run completion SHALL expose `Create pull request` in the command palette independently of compaction success, with no manual finish or standalone push action. Existing inspection and navigation actions SHALL remain. Selecting this action SHALL explicitly authorize a normal push of the current verified feature branch to a disclosed repository/remote followed by PR creation; it MUST NOT publish automatically at run completion, force-push, delete branches, or remove worktrees. The action SHALL revalidate current branch state rather than using an old run's HEAD as authority. The PR title and body SHALL be composed from persisted run and change context under a deterministic precedence — the branch's conventional prefix supplies the commit type and the attached change's proposal title, else a humanized branch slug, supplies the subject — never from the prompt's first line. The PR body SHALL present Why, What, and How-tested sections drawn from the change proposal, the run's distilled recap (or the compacted run commit's message when no recap exists), and test/validation reports, each falling back mechanically when its source is absent. Missing GitHub CLI/authentication or an unsafe/unresolved repository state SHALL disable publishing with actionable guidance. Headless output SHALL provide guidance only unless a separate explicit publication request exists.

#### Scenario: Deliberate PR creation

- **WHEN** the operator selects Create pull request on a safe feature branch
- **THEN** Convoy performs a normal push and creates the PR, displaying its URL without any separate push choice

#### Scenario: Push is rejected or PR already exists

- **WHEN** the normal push is rejected, or a matching open PR already exists
- **THEN** Convoy respectively stops before creating a PR with no force-push fallback, or opens/reports the existing PR rather than creating a duplicate

#### Scenario: GitHub CLI is unavailable

- **WHEN** a completed run is viewed without a usable GitHub CLI
- **THEN** Create pull request is unavailable with setup/manual guidance, while inspection remains usable

#### Scenario: Historical path has been reused

- **WHEN** an old run's former worktree path now belongs to another feature
- **THEN** publication resolves the old run's feature through its current verified association or explains why it is unavailable, and never pushes the replacement branch

### Requirement: Run history preserves feature identity independently of rewrite authority

New feature-backed runs SHALL retain stable repository/feature identity and their reviewed contract set in durable metadata and cleanup-surviving run records, alongside immutable run-start branch/path/commit provenance. Board, attach, and historical views SHALL join by that identity rather than reinterpret the current checkout at a stored path. Legacy records SHALL disclose missing association evidence until explicitly adopted. Rebinding a feature SHALL NOT rewrite the originating run boundary or grant permission to compact across a changed branch, independent commits, or missing evidence. Existing compaction eligibility, protected recovery history, signing/hooks, and publication-safety rules SHALL remain authoritative. Feature cleanup SHALL NOT remove run recovery evidence.

#### Scenario: Two runs and a renamed feature

- **WHEN** two runs finish for a feature and its context is later explicitly rebound after a branch rename
- **THEN** both runs remain linked to the feature, their original branch observations remain inspectable, and no automatic rewrite occurs during inspection or rebinding

#### Scenario: Association does not repair missing provenance

- **WHEN** a legacy run is adopted into a feature but lacks a trustworthy run-start boundary
- **THEN** the history link becomes available while automatic compaction still refuses to rewrite without the required provenance

### Requirement: Manual finish is removed without a compatibility execution path

Convoy SHALL remove the public finish command, its flags/help, the dashboard shortcut, manual finish modal, and finish-specific push/PR follow-up sequence. Invoking the retired `convoy finish` spelling SHALL produce an actionable non-zero diagnostic before repository or run side effects; it MUST NOT be interpreted as a new prompt or execute a hidden compatibility squash. Documentation SHALL explain automatic run compaction and feature-wide close instead. Existing run records SHALL remain readable.

#### Scenario: Retired command is invoked

- **WHEN** an operator invokes `convoy finish` with or without old options
- **THEN** Convoy exits non-zero without changing state and explains that run compaction is automatic and close squash-lands a feature

### Requirement: PR text is composed deterministically from persisted context

PR title and body composition SHALL depend only on state persisted before publication — run metadata, the change proposal, and the run's own reports — so composing twice from the same run state yields the same text. A publication whose PR creation previously failed SHALL retry with the same title and body. Composition MUST NOT require a model call and MUST NOT block publication when a source document is absent: each missing source degrades to its mechanical fallback and the PR is still created.

#### Scenario: Retry after a failed PR creation

- **WHEN** a push succeeds but PR creation fails, and the operator retries publication
- **THEN** the retry composes the same title and body and reuses the push, locating the existing PR rather than creating a duplicate

#### Scenario: Sources are absent

- **WHEN** a run publishes without an attached change proposal or validation reports
- **THEN** the PR is still created, with the affected sections falling back to branch- and metadata-derived content and the How-tested section disclosing what was not covered

#### Scenario: Conventional title within the subject budget

- **WHEN** a run on branch `feat/add-attach-flow` publishes and the branch resolves to a change titled "Attachment flow for run reports"
- **THEN** the PR title is `feat: <composed subject>` naming that change, bounded to the shared subject budget with word-boundary shortening

### Requirement: The terminal lifecycle row closes every dashboard phase list

Every dashboard phase list — a live run's initial list, a following dashboard grown additively while a goal cycle adds invocation rows, and a reconstructed or historical view — SHALL order the `Compact run` lifecycle row last, after the pipeline prefix rows, hook rows, and every goal invocation group. A live merge that appends previously unknown rows MUST NOT leave the lifecycle row above any row appended after it. Upholding the invariant MUST NOT require rebuilding the dashboard, dropping row state, or re-running phases, and the lifecycle row's position MUST NOT imply any execution-order relationship with the goal cycle: it is the run epilogue regardless of where the rows render.

#### Scenario: Live dashboard grows during a goal cycle

- **WHEN** a dashboard is following a live goal run and the scheduler's next invocation's rows arrive through the additive sync
- **THEN** the merged phase list still ends with the `Compact run` row, the goal invocation rows render above it, and the pending lifecycle row never sits above a goal invocation row

#### Scenario: Mid-cycle attach shows the row terminal

- **WHEN** a dashboard attaches to a goal run that is mid-cycle and reconstructs its phase list from durable state
- **THEN** the reconstructed list closes with the `Compact run` row after every recorded and in-flight goal invocation row

#### Scenario: Compaction starts on a grown dashboard

- **WHEN** finalization starts on a run whose dashboard grew goal invocation rows while following it
- **THEN** the `Compact run` row transitions to running and then to its outcome in place at the terminal position of the phase list
