# run-launcher Specification

## Purpose
The interactive run launcher (pipelines → prompt → options → branch → review) prepares a Convoy run in the terminal. This capability covers how the launcher treats a dirty execution tree: surfacing the dirt before the operator invests in the flow, warning at review time, and offering an explicit choice at acceptance instead of failing after the session has already ended.

## Requirements

### Requirement: Options step surfaces a dirty execution tree

While the operator is choosing run options, the launcher SHALL compute the state of the explicitly selected execution checkout, including for a continue handoff, and, when that tree has uncommitted or untracked changes that the run would refuse, show a notice stating the number of dirty files and pointing at the "Include dirty tree" toggle, and enrich that toggle's label with the same live count. The notice SHALL NOT appear when the tree is clean, nor when the run will execute in a fresh isolated worktree whose tree starts clean regardless of source dirt. Worktree or change selection SHALL NOT imply dirty-tree consent.

#### Scenario: Dirty tree on a plain run

- **WHEN** the options step opens for a run targeting a checkout with 7 dirty files and no worktree isolation
- **THEN** a notice states 7 uncommitted files and names the "Include dirty tree" toggle, whose label carries the same count

#### Scenario: Clean tree stays quiet

- **WHEN** the options step opens for a clean execution tree
- **THEN** no dirt notice appears and the toggle shows its standard label

#### Scenario: Worktree isolation makes source dirt irrelevant

- **WHEN** a new run will execute in a fresh isolated worktree and the source checkout is dirty
- **THEN** no dirt notice appears for source dirt, without authorizing a transfer of those dirty files

#### Scenario: Continue handoff into a dirty feature worktree

- **WHEN** the launcher opens from a continue handoff into a validated worktree containing uncommitted leftovers
- **THEN** the options step shows that worktree's dirt notice and file count without consulting a feature association

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

### Requirement: Execution revalidates reviewed identity and persists run linkage

Before starting a run or causing execution effects, Convoy SHALL revalidate the reviewed repository, Git worktree administrative directory and registration, canonical checkout path, actual branch or detached state, HEAD OID, selected base and its OID when applicable, and selected local artifact inputs. These SHALL be observed Git and filesystem inputs, not a minted worktree identifier or an association revision. Changed or unverifiable inputs SHALL stop for explicit fresh target/input review with remediation rather than silently selecting another checkout, branch, or change. A reused historical path or branch name SHALL NOT establish continuity with an old run. Convoy SHALL persist the accepted run plan and immutable run-start provenance in durable, cleanup-surviving run metadata before execution, including the ordered selected local changes, their source paths and consumed input snapshots or verifiable content references, and the canonical spec bundle used. This SHALL be run history, not persisted checkout ownership, a FeatureRecord, or a FeaturePlanLink. Reopening a historical run SHALL NOT change its frozen context. Existing resume boundary, recovery, managed-writer, permission, dirty-tree consent, and execution-time checks SHALL remain authoritative; target review SHALL NOT supply missing commit provenance or authorize inclusion of dirty files.

#### Scenario: Branch switches after review

- **WHEN** the selected worktree changes branch or HEAD after review and before execution
- **THEN** Convoy stops before execution and requires review of the new facts rather than running on the replacement target

#### Scenario: Selected inputs change after review

- **WHEN** a selected proposal or an input in the reviewed canonical spec bundle changes or becomes unreadable before execution
- **THEN** Convoy requires fresh input review or reports the unavailable input rather than silently executing a different plan

#### Scenario: Dirty consent remains separate

- **WHEN** the target and selected changes validate but the execution tree is dirty and include-dirty is off
- **THEN** the existing explicit dirty-tree choice and final execution gate remain effective

#### Scenario: Run survives temporary workspace cleanup

- **WHEN** an accepted run finishes and its temporary run workspace is removed
- **THEN** its durable history still exposes the reviewed checkout observations, ordered local change inputs, canonical bundle provenance, and immutable run-start boundary without feature linkage

#### Scenario: Historical path or branch is reused

- **WHEN** an old run's path or branch spelling now identifies a checkout whose continuity with that run cannot be proved
- **THEN** the run remains readable but no resume or mutation is redirected there, and an action requires explicit fresh target review plus all existing resume and recovery checks

### Requirement: Work-scoped preparation uses the execution checkout throughout

When launched for a selected worktree, the launcher SHALL resolve configuration, available pipelines, prompt history, selected change artifacts, the canonical spec bundle, relative attachments, and dirty-tree status from that validated execution checkout before constructing review. It SHALL retain the complete ordered local change selection and focused source when present and reuse the existing branch and worktree. It SHALL NOT invoke branch naming, create another worktree, create parallel work identity fields, or consult feature plans, associations, or receipts on this path. A missing or unreadable selected source or required canonical bundle input SHALL stop preparation with an actionable explanation, never fall back to the launch directory, another checkout, or a branch-inferred change. An explicitly selected spec-less manual/no-change run SHALL remain available without inventing or importing specs. Existing dirty-tree choices and execution-time checks SHALL remain authoritative for the actual execution checkout.

#### Scenario: Main and feature configuration differ

- **WHEN** Convoy opens in main but the selected worktree has different pipelines, a proposal absent from main, and different canonical specs
- **THEN** preparation uses only the selected checkout's configuration and spec inputs, shows that destination in Review, and starts there without another worktree

#### Scenario: Source checkout is dirty

- **WHEN** main has unrelated dirt and a clean worktree is selected for execution
- **THEN** preparation and the execution gate evaluate the selected worktree without rejecting it because of main's dirt

#### Scenario: Selected work is dirty

- **WHEN** the selected worktree has uncommitted proposal files
- **THEN** its existing include-dirty choice applies and is not bypassed because the caller started in main

#### Scenario: Same-id copy cannot repair missing inputs

- **WHEN** a selected change or required canonical spec input is missing in the execution checkout but exists in the launch checkout
- **THEN** preparation stops and identifies the missing local input rather than borrowing the other copy

### Requirement: Returning from a work launch preserves selection

Cancelling a worktree-scoped launcher or returning from its run dashboard SHALL return to the originating worktree or spec view with its checkout-local selection preserved and observations refreshed. If that target or source is no longer verifiable, Convoy SHALL return to the Worktrees list with an explanation rather than select a replacement. Cancelling before acceptance SHALL NOT start a run, create a worktree, or cause repository effects. Standalone CLI launches SHALL retain headless operation while obeying explicit target and change-selection requirements, without interactive inference or a new worktree registry. User-facing navigation SHALL use Worktrees, not Spaces; this branding SHALL NOT restrict whitespace in human run, proposal, or worktree display titles.

#### Scenario: Launcher is cancelled

- **WHEN** an operator cancels Review for a selected worktree and local change
- **THEN** Convoy returns to that same valid selection with refreshed state and no run or repository effects

#### Scenario: Origin disappears during a run

- **WHEN** the operator returns from a dashboard after the originating checkout is removed
- **THEN** Convoy shows the current Worktrees list and explains the missing origin without redirecting the old selection to a same-named branch or change

### Requirement: Launch review selects explicit checkout-local run inputs

Every new run SHALL review an explicit execution checkout and an operator-selected ordered list of zero or more active local OpenSpec changes, separately from branch-wide Git action scope. The list SHALL exist only as run-plan input and its immutable historical record, never persisted ownership or a reusable registered contract set. File presence, matching branch names, matching change ids in other checkouts, and legacy feature metadata SHALL NOT select or expand the list. A sole active local change MAY be suggested interactively but SHALL become selected only when the operator explicitly accepts that suggestion. Multiple changes SHALL require explicit selection and order review; Convoy MUST NOT infer an implicit composite. A headless launch SHALL require explicit `--change` selection or an explicit manual/no-change mode, even if only one change is present. Zero selected changes SHALL remain valid in that mode without inventing a change. Review SHALL identify checkout, branch or detached state, base when applicable, local change sources, and the same-checkout canonical spec bundle, and SHALL explain that selecting changes does not narrow whole-branch publication or squash scope. A missing selected artifact SHALL stop, not silently downgrade the run to manual/no-change mode.

#### Scenario: Singleton suggestion requires acceptance

- **WHEN** an arbitrary branch contains one active local change and the launcher suggests it
- **THEN** only explicit acceptance selects it, and proceeding without it requires an explicit manual/no-change decision rather than automatic attachment

#### Scenario: Apply from another checkout

- **WHEN** Apply is invoked on a change in another explicitly selected worktree
- **THEN** review retains that checkout and local source without consulting a same-id change in the launch directory or recording an association

#### Scenario: Multiple changes are selected

- **WHEN** the operator selects local changes B then A while an inherited change C is also present
- **THEN** review and durable run-plan history contain B then A only, with the canonical bundle from the same checkout and no ownership claim over any change

#### Scenario: Headless launch omits its mode

- **WHEN** a headless launch supplies neither explicit `--change` selection nor an explicit manual/no-change mode
- **THEN** Convoy stops with actionable selection guidance, even when a singleton or branch-name match exists

#### Scenario: Explicit manual launch

- **WHEN** the operator explicitly selects manual/no-change execution in a spec-less checkout
- **THEN** the plan contains zero local changes and records the absence of local specs without consulting another checkout
