## MODIFIED Requirements

### Requirement: Control command is the single inferred board

`convoy worktrees` SHALL present the worktree control board, retaining `convoy control` as a compatibility alias. `convoy specs` SHALL be its artifact-focused reader entry point, using the same worktree-rooted inventory when no checkout is selected and opening the selected checkout's local artifacts when one is supplied. It SHALL NOT maintain a separate board model. The board SHALL use the current repository's Git worktree inventory as its single source of checkout discovery and SHALL derive Git, checkout-local OpenSpec, run, conversation, and publication observations from fresh evidence. Read-only OpenSpec task queries SHALL be permitted with filesystem fallback when the CLI is unavailable; unreadable evidence SHALL remain unknown. Historical run context SHALL use frozen run provenance, not the branch currently checked out at an old run path. Browsing SHALL NOT write domain state or consult legacy feature records, contract registries, associations, or landing receipts as authority. Worktrees SHALL be the user-facing vocabulary, not Spaces or Features.

#### Scenario: Deleting the worktree updates the board

- **WHEN** a worktree is removed outside Convoy and is no longer registered in Git when the board is reopened
- **THEN** it is absent from the inventory without a tombstone or completed-work row, while actual run history remains independently available

#### Scenario: One resolver everywhere

- **WHEN** a registered worktree has an arbitrary branch name and no Convoy metadata
- **THEN** the board, Home, and target selection discover the same checkout from Git without requiring adoption or binding

#### Scenario: Historical path is reused

- **WHEN** an old run path now contains another checkout or branch
- **THEN** historical run provenance remains unchanged and does not establish a link to the current checkout solely through that path

### Requirement: Continue reuses the feature's worktree and branch

Pipeline continuation SHALL pass the selected Git checkout, its actual branch or detached state, selected base, and explicitly selected local changes to the standard launcher. It SHALL reuse that checkout without branch naming or another worktree; new-worktree isolation SHALL be disabled for this handoff. The reviewed plan SHALL freeze the execution target and selected inputs for execution-time validation without feature identity or association revisions. Missing targets or selected artifacts SHALL require explicit correction rather than replacement or cross-checkout fallback. External branch renames or Git worktree moves SHALL use freshly verified Git context without rebinding; an unverifiable stale selection SHALL require reselection. Archived changes SHALL remain readable but SHALL require an explicit new active-work decision before another implementation run. Conversation resumption SHALL have a separate label and action from pipeline continuation.

#### Scenario: Second run lands on the same branch

- **WHEN** an operator continues a pipeline from a worktree that already has a run
- **THEN** review retains the selected checkout and actual branch with only the explicitly selected local changes, without minting a branch

#### Scenario: Rename requires verified context

- **WHEN** pipeline continuation is requested after an external branch rename
- **THEN** review shows the verified current branch and target or requires explicit reselection, without binding or choosing a change by branch spelling

#### Scenario: Selected input disappears

- **WHEN** a selected change disappears before execution-time validation
- **THEN** launch refuses that stale input rather than substituting an inherited or same-id copy

### Requirement: The launcher warns on nested isolation

Standalone launches inside a worktree SHALL retain the current default of no new isolation and SHALL show an informational warning when new isolation is deliberately enabled, identifying the source branch. Worktree-scoped launches SHALL reuse the explicitly selected checkout; deriving a separate worktree SHALL explicitly review its source and destination. Main SHALL remain a usable explicit target subject to the same applicable dirty-tree protections, not a target that forces spin or isolation.

#### Scenario: Warning on deliberate fork

- **WHEN** isolation is enabled for a standalone launch inside a worktree
- **THEN** the launcher warns that the new worktree derives from the current branch without blocking the deliberate choice

#### Scenario: Existing work is selected

- **WHEN** a pipeline is launched from a worktree detail
- **THEN** it reuses that checkout and creating a derivative requires a separate explicitly reviewed new-worktree action

#### Scenario: Dirty main is selected

- **WHEN** an operator launches in the main checkout with uncommitted changes
- **THEN** the launcher applies explicit dirty-tree review and consent without forcing transfer to another worktree

### Requirement: Board assessment can be refreshed without changing selection identity

The board SHALL provide an explicit refresh action, refresh after returning from contextual operations, and invalidate cached artifact and observation data together. Selection SHALL remain attached to the selected verified Git checkout and local artifact source rather than list position or a globally deduplicated change id. If the selected checkout disappears or its continuity cannot be verified, the board SHALL return to the inventory with an explanation rather than choosing another execution target. A failed refresh SHALL disclose unavailable or stale evidence and SHALL NOT present stale action eligibility as a current verified fact. Refresh and navigation SHALL NOT create persistent worktree identities, ownership manifests, or completed-work records.

#### Scenario: External archive becomes visible

- **WHEN** the operator archives a selected local change outside Convoy and refreshes the board
- **THEN** the same verified worktree remains selected, its active children update, and the archive is available locally on demand without a lifecycle summary

#### Scenario: External move remains discoverable

- **WHEN** Git reports a worktree at a new location after `git worktree move`
- **THEN** the inventory shows the current location without a bind operation and preserves the prior selection only if continuity can be verified

#### Scenario: Refresh fails

- **WHEN** a refresh cannot read Git or artifact evidence needed for an action
- **THEN** the board marks that evidence unavailable or stale and the shared action guard supplies the corresponding reason instead of reusing stale permission to mutate

## REMOVED Requirements

### Requirement: Active change rows derive their lifecycle state

**Reason**: Global feature lifecycle summaries, integration receipts, contract ownership, and Completed history are no longer part of the control board.

**Migration**: Show independent observations on Git worktree rows and checkout-local changes beneath them. Preserve actual run history separately; do not migrate legacy features into another registry or tombstone collection.

### Requirement: Worktrees without spec get their own section

**Reason**: Spec-less worktrees are ordinary peers in the complete Worktrees inventory, not unassociated candidates needing adoption.

**Migration**: List all Git-registered checkouts together, including those with no specs or runs. Expose their available actions and runs without registering a feature.

### Requirement: Change rows resolve to the owning worktree

**Reason**: Filesystem presence is not ownership and no checkout is elected authoritative for all copies of a change id.

**Migration**: Nest each change under its containing worktree and keep same-id copies independent. Never borrow artifacts, tasks, titles, or mutation targets across checkouts.

## ADDED Requirements

### Requirement: Every registered worktree is a root inventory entry

The board SHALL enumerate every Git-registered worktree, including externally created, main, detached, locked, inaccessible or missing-path, and spec-less checkouts, whether or not they have runs. Git-stale registrations SHALL remain visible as inaccessible while Git still reports them; disappeared registrations SHALL leave the list without tombstones. Root entries SHALL NOT be globally deduplicated by change id or suppressed by inherited OpenSpec files. An inventory containing any worktree SHALL remain interactive even with no readable OpenSpec artifacts. Display names SHALL use the checkout folder basename with its actual branch and path, or an explicit detached status, without a separate display-name record; human-readable titles SHALL be allowed to contain whitespace.

#### Scenario: Plain isolated run appears

- **WHEN** an isolated run's worktree is registered without any OpenSpec directory
- **THEN** it appears with its actual branch, path, and available run navigation in the same inventory as other worktrees

#### Scenario: All checkout kinds remain visible

- **WHEN** Git reports main, an external detached checkout, a locked checkout, and a stale registration whose path is missing
- **THEN** each has its own root row with its actual conditions and action-specific disabled reasons, without adoption prompts

#### Scenario: Worktree-only board remains interactive

- **WHEN** the repository has registered worktrees but no changes, canonical specs, or runs
- **THEN** the interactive board opens with Worktrees and omits empty artifact sections

#### Scenario: Disappeared registration is not history

- **WHEN** Git no longer reports a previously observed worktree
- **THEN** refresh removes its row instead of preserving completed or missing-worktree history

### Requirement: Worktree rows expose independent observations

Each worktree SHALL expose independently observed Git dirt, ahead/behind relative to the explicitly selected base, ahead/behind relative to its upstream, execution activity, and the managed writer holding the checkout's writer claim (kind, owner, and liveness). Pull request facts SHALL be observed on demand when the operator's selection lands on a worktree row — cached, bounded, and refreshed on reselection — rather than eagerly for every row; rows not yet selected SHALL disclose no PR facts. PR observations SHALL disclose number, title, URL, and state when known, with known, unknown, or ambiguous availability; unavailable evidence SHALL NOT imply no PR or a merged PR. Base and upstream comparisons SHALL remain distinct, identify their comparison refs, and disclose unknown results when unavailable. Task counts SHALL report known done/total or unknown without inventing counts. Runs and conversations SHALL show actual activity separately from client attachment, and the managed writer claim SHALL be reported independently of that activity, with live, uncertain, and stale liveness distinguished (an unreadable or newer-schema record is unknown, never free). These facts SHALL NOT collapse into lifecycle stages, ownership assertions, integrated/completed summaries, or task-count stage gates. Home, the board, and detail menus SHALL consume the same per-action guards and disclose blockers and remediation; handlers SHALL revalidate those guards before mutation.

#### Scenario: Tasks are complete while execution remains active

- **WHEN** local tasks are complete but a managed writer remains active
- **THEN** the row reports both facts independently and actions conflicting with that writer show the same reason in Home and the board rather than enabling close from task counts

#### Scenario: Base and upstream differ

- **WHEN** a branch is ahead of its upstream but behind its selected base
- **THEN** both comparisons are shown independently with their refs and neither is replaced by a single synchronization status

#### Scenario: PR observation is unavailable

- **WHEN** Git is readable but the PR provider cannot be queried
- **THEN** Git facts remain available and PR facts are reported unknown with their reason, not as absent or merged

### Requirement: Local changes are children of their containing checkout

Each readable worktree SHALL expose its local active changes and tasks as children, with local archives collapsed or loaded on demand and canonical specs scoped to that checkout. Inherited files SHALL count only as present. Same-id changes in different worktrees SHALL remain independent and SHALL NOT share tasks, titles, run selections, or mutation authority. Missing proposals and husk directories SHALL not hide active entries; unreadable or absent facts SHALL be disclosed. A missing or unreadable selected source SHALL NOT fall back to another worktree. Reading and navigation SHALL NOT change artifact scope or ownership.

#### Scenario: Same-id copies differ

- **WHEN** two registered worktrees contain different copies of the same change id
- **THEN** each worktree has its own child with its own title, inventory, and task facts regardless of branch spelling or inventory order

#### Scenario: Husk-only copies remain visible

- **WHEN** a worktree contains only a husk for a local active change
- **THEN** that child remains listed by id with missing artifacts and unknown counts without borrowing a fuller copy from another checkout

#### Scenario: Inherited changes do not determine scope

- **WHEN** a worktree contains one intended change and another change copied from main
- **THEN** both are browsable local children but neither is automatically selected for archive or execution
