# run-launcher Specification

## Purpose
The interactive run launcher (pipelines → prompt → options → branch → review) prepares a Convoy run in the terminal. This capability covers how the launcher treats a dirty execution tree: surfacing the dirt before the operator invests in the flow, warning at review time, and offering an explicit choice at acceptance instead of failing after the session has already ended.

## Requirements

### Requirement: Options step surfaces a dirty execution tree

While the operator is choosing run options, the launcher SHALL compute the state of the execution tree — the feature worktree for a continue handoff, the target checkout otherwise — and, when that tree has uncommitted or untracked changes that the run would refuse, show a notice stating the number of dirty files and pointing at the "Include dirty tree" toggle, and enrich that toggle's label with the same live count. The notice SHALL NOT appear when the tree is clean, nor when the run will execute in a fresh isolated worktree (whose tree starts clean regardless of source dirt).

#### Scenario: Dirty tree on a plain run

- **WHEN** the options step opens for a run targeting a checkout with 7 dirty files and no worktree isolation
- **THEN** a notice appears stating 7 uncommitted files and naming the "Include dirty tree" toggle, and the toggle's label carries the count

#### Scenario: Clean tree stays quiet

- **WHEN** the options step opens for a clean execution tree
- **THEN** no dirt notice appears and the "Include dirty tree" toggle shows its standard label

#### Scenario: Worktree isolation makes source dirt irrelevant

- **WHEN** the options step opens with "Isolate in a worktree" enabled for a new run and the source checkout is dirty
- **THEN** no dirt notice appears, because the run executes in a fresh worktree that starts clean

#### Scenario: Continue handoff into a dirty feature worktree

- **WHEN** the launcher opens from a continue handoff whose feature worktree holds uncommitted leftovers (e.g. from an interrupted run)
- **THEN** the options step shows the dirt notice for that worktree, with its file count

### Requirement: Review warns when dirty changes are unhandled

The review step SHALL recheck the execution tree's dirt when it is prepared — never reuse a status cached from an earlier step — and SHALL display a warning when the tree is dirty, the run would refuse it, and "Include dirty tree" is off. No warning SHALL appear when the toggle is on or the tree is clean.

#### Scenario: Dirty tree with the toggle off

- **WHEN** the review is prepared while the execution tree is dirty and "Include dirty tree" is off
- **THEN** the review shows a warning about the uncommitted changes

#### Scenario: Dirty tree with the toggle on

- **WHEN** the same run is prepared with "Include dirty tree" on
- **THEN** the review shows no dirty-tree warning

#### Scenario: Dirt appears mid-session

- **WHEN** the execution tree was clean during the options step but a file is modified before the review is prepared
- **THEN** the review still shows the warning, because the review rechecks rather than trusting the earlier status

### Requirement: Accepting a review with unhandled dirt offers an explicit choice

When the operator accepts the review while the execution tree is dirty, the run would refuse it, and "Include dirty tree" is off, the launcher SHALL open an in-TUI choice instead of proceeding toward refusal. The choice SHALL offer: include the dirty tree (which enables the toggle and re-prepares the review so the visible flags reflect it), return to the options step, and dismiss (stay in the review). The launcher MUST NOT enable "Include dirty tree" without this explicit consent.

#### Scenario: Choosing to include

- **WHEN** the choice is offered and the operator picks include
- **THEN** the toggle turns on, the review is re-prepared showing the include-dirty flag, and accepting it again starts the run without offering the choice again

#### Scenario: Returning to options

- **WHEN** the choice is offered and the operator picks options
- **THEN** the launcher returns to the options step with the prompt, pipeline, toggles, and branch name exactly as they were

#### Scenario: Dismissing keeps the session alive

- **WHEN** the choice is offered and the operator dismisses it
- **THEN** the launcher stays in the review with the session intact, and accepting again re-offers the same choice

### Requirement: The execution-time dirty gate remains authoritative

The in-launcher preflight is advisory and interactive; it SHALL NOT replace the existing execution-time gate. A run SHALL still refuse to start when the execution tree is dirty at execution time, the run would refuse it, and "Include dirty tree" is off — including dirt that appeared after the review was prepared.

#### Scenario: Dirt appears after the review was prepared

- **WHEN** the review was prepared against a clean tree and accepted, but the execution tree becomes dirty before the run starts
- **THEN** the run refuses with the existing dirty-tree error after the launcher exits, exactly as it does today

### Requirement: Launch review distinguishes contracts from feature association

The launcher SHALL show the selected contract set separately from the stable feature and verified execution context. A feature-aware apply or continue handoff SHALL preserve that identity and associated context from any launch checkout. Automatic contract suggestions, including a sole active change or branch-name match, SHALL not silently establish ownership. An accepted new feature-backed run SHALL explicitly register or reuse the reviewed association before execution. A selected context already owned by another feature SHALL require an explicit compatible selection or rebinding decision, not overwrite that association. No-spec runs SHALL keep their existing flow without inventing a change. Cancelling before acceptance SHALL leave no new feature record or worktree.

#### Scenario: One active spec on an arbitrary branch

- **WHEN** an unassociated branch contains one active change and the launcher suggests it
- **THEN** review shows the proposed feature/context/contract association, and only acceptance records that intent

#### Scenario: Apply from another checkout

- **WHEN** Apply is invoked on a registered feature while the browser was launched in a different worktree
- **THEN** the launcher pins the selected contracts and associated execution context instead of resolving a same-id change in the launch directory

#### Scenario: Multiple changes are selected

- **WHEN** review accepts two contracts for one implementation context
- **THEN** the feature and reviewed plan record the complete selected set and explain that close integrates the whole branch

### Requirement: Execution revalidates reviewed identity and persists run linkage

Before a feature-backed run starts, Convoy SHALL revalidate the reviewed repository, feature identity, association revision, actual branch/worktree, base, and active contract sources. Persistence of the feature link in durable run metadata SHALL precede execution. A changed or unverifiable target SHALL stop with remediation rather than silently selecting another contract or branch. This check SHALL be additional to, not a replacement for, the existing dirty-tree consent and execution-time gate. Association confirmation SHALL NOT imply consent to include dirty files. Reopening a historical run SHALL not change its frozen context.

#### Scenario: Branch switches after review

- **WHEN** the worktree changes branches after an operator accepts review
- **THEN** the run refuses before execution and does not attach the new branch's changes to the reviewed feature

#### Scenario: Dirty consent remains separate

- **WHEN** a feature association is confirmed while the execution tree is dirty and include-dirty is off
- **THEN** the existing explicit dirty-tree choice and final execution gate remain effective

#### Scenario: Run survives temporary workspace cleanup

- **WHEN** an accepted feature-backed run finishes and its temporary run workspace is removed
- **THEN** its durable record still identifies the feature, selected contracts, and frozen execution context

### Requirement: Work-scoped preparation uses the execution checkout throughout

When launched for selected work, the launcher SHALL resolve configuration, available pipelines, prompt history, specs, relative attachments, and dirty-tree status from that work's validated checkout before constructing the review. It SHALL retain the complete reviewed contract set and the focused contract/source when present, reuse the existing branch and worktree, and reuse the existing feature plan link, association revision, execution revalidation, and durable feature-run records. It SHALL NOT create parallel work identity fields. It SHALL NOT invoke branch naming or create another worktree on this path. Existing dirty-tree choices and execution-time checks SHALL remain authoritative for the actual execution checkout.

#### Scenario: Main and feature configuration differ

- **WHEN** Convoy opens in main but the selected worktree has different pipeline configuration and a spec absent from main
- **THEN** the launcher uses the worktree's configuration and spec, shows its destination in Review, and starts there without another worktree

#### Scenario: Source checkout is dirty

- **WHEN** main has unrelated dirt and a clean feature worktree is selected for execution
- **THEN** preparation and the execution gate evaluate that feature worktree without rejecting it because of main's dirt

#### Scenario: Selected work is dirty

- **WHEN** the selected worktree has uncommitted proposal files
- **THEN** the existing include-dirty choice applies to that worktree and is not bypassed because the caller started in main

### Requirement: Returning from a work launch preserves selection

Cancelling a work-scoped launcher or returning from its run dashboard SHALL return to the originating work or spec view with its selection preserved and state refreshed. Cancelling before acceptance SHALL NOT start a run or create repository effects. Standalone CLI launches SHALL retain their existing headless behavior.

#### Scenario: Launcher is cancelled

- **WHEN** an operator cancels Review for a selected work item
- **THEN** Convoy returns to that selected work or spec with no run started
