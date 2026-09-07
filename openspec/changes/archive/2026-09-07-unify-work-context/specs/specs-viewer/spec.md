## MODIFIED Requirements

### Requirement: Specs command discovers OpenSpec state from the filesystem

`convoy specs` SHALL discover OpenSpec artifacts from the filesystem: active changes are real directories in `openspec/changes/` excluding `archive`, dotfiles, and stray non-directory files; canonical specs are Markdown files under `openspec/specs/**`. It SHALL also read repository-scoped feature associations, referenced archives, run/close evidence, and current Git context for lifecycle discovery. Read-only OpenSpec task queries SHALL be permitted by the shared assessment contract. Discovery, refresh, and browsing MUST NOT write any file or silently adopt/migrate features. Absence of active changes or of the launch checkout's `openspec/` SHALL NOT suppress registered features or discoverable unassociated worktrees, including those without runs.

#### Scenario: Repo without openspec directory
- **WHEN** a repository has no `openspec/` directory and no discoverable registered features or discoverable unassociated worktrees
- **THEN** Convoy reports that no specs were found and exits successfully without launching a UI

#### Scenario: Repo with openspec directory but no active changes
- **WHEN** a repository has `openspec/` but its changes directory holds only `archive` and there are no pending registered features
- **THEN** the pending-feature section is omitted, canonical specs remain browsable, and registered completed features remain accessible in history

#### Scenario: Archived work remains pending
- **WHEN** only archived contracts remain for a registered feature awaiting integration
- **THEN** the feature remains discoverable and its verified archived artifacts are readable

### Requirement: Worktree-backed changes read their artifacts from the worktree

The specs view SHALL load a registered feature's title and artifact inventory from its verified associated contract source, using absolute paths into its active change tree or verified archive. That source SHALL take precedence over same-id copies in the launch checkout. A missing, ambiguous, or unreadable associated source SHALL display its condition rather than fall back silently to another checkout. Unassociated active changes SHALL remain readable from explicitly identified discovered sources; multiple copies SHALL be selectable without assigning ownership. The operator SHALL not need to relaunch from the source checkout to read available artifacts.

#### Scenario: Stale skeleton on the launch checkout
- **WHEN** the launch checkout holds a husk while the verified associated worktree contains the change's full artifacts
- **THEN** the worktree supplies the title and readable artifact inventory

#### Scenario: Reading works from any launch directory
- **WHEN** a feature's artifacts live outside the browser's process directory
- **THEN** absolute artifact paths load the associated source without read placeholders caused by the launch location

#### Scenario: Diverging copies resolve to the worktree
- **WHEN** the launch checkout and the verified associated worktree carry differing copies of a change
- **THEN** the associated source supplies feature artifacts and facts without mixing in the launch copy

#### Scenario: Changes without a worktree are unchanged
- **WHEN** an active change is not associated with any feature context and is discovered in the launch checkout
- **THEN** its files remain readable there with unassociated status and no inferred mutation target

#### Scenario: Associated artifacts are missing
- **WHEN** the associated worktree is absent but another checkout has the same slug
- **THEN** the feature shows missing-source remediation and exposes the other copy only as a candidate, not as a replacement owner

### Requirement: Root view shows only non-empty sections

The root SHALL present non-empty sections in this order: **Features**, **Worktrees without spec**, and **Canonical Specs**. Features SHALL include registered pending lifecycle work, pre-proposal features with no contracts, and unassociated active-change candidates. A discoverable history view SHALL expose completed registered features without requiring them to clutter pending work. Section headers SHALL remain distinct and reachable while scrolling; empty sections and headers SHALL be omitted. Missing proposals SHALL not hide entries; features SHALL use their recorded display identity and unassociated changes their change id. Selection SHALL use stable feature identity where available, not a mutable branch or directory name.

#### Scenario: Sections appear in order
- **WHEN** all three root sections have entries
- **THEN** Features precedes Worktrees without spec, which precedes Canonical Specs, with distinct headers

#### Scenario: Empty root sections disappear
- **WHEN** any root section is empty
- **THEN** neither its rows nor its title are rendered

#### Scenario: Change missing its proposal
- **WHEN** a candidate change has no readable proposal
- **THEN** the candidate remains listed by id with its artifact availability disclosed

#### Scenario: Completed feature is inspected
- **WHEN** the operator opens feature history after worktree cleanup
- **THEN** the feature's recorded contracts, runs, and integration evidence remain inspectable

### Requirement: Apply this spec hands off to the launcher preselected

While browsing an active contract, **Apply this spec** SHALL open the standard launcher with the selected contract and its explicit source pinned. For a registered feature it SHALL also carry feature identity, complete associated contract set, verified context, and intended base; execution SHALL reuse that context unless the operator explicitly chooses a separate new feature. For an unassociated candidate, normal context selection and association review SHALL precede execution. No missing preset SHALL silently fall back to another contract. A cancelled launcher SHALL start no run and leave no newly created context or association. An archived contract SHALL remain readable but implementation SHALL require an explicit new active-work decision, not silently reactivate the archive.

#### Scenario: Handoff preselects the change
- **WHEN** Apply is selected on an active `add-specs-viewer` feature and accepted through the launcher
- **THEN** the resulting run uses its reviewed contract set and associated context without re-asking which copy to use

#### Scenario: Launcher cancelled after handoff
- **WHEN** the operator invokes Apply and aborts before acceptance
- **THEN** no run starts and no new context or association remains

#### Scenario: Selected source disappears
- **WHEN** an active contract disappears between browsing and launch review
- **THEN** the launcher reports the missing selected source instead of choosing a different active change

Launcher resource loading SHALL use the verified execution checkout from the start, including configuration, history, specs, and relative attachments. Returning from a cancelled launcher or dashboard SHALL restore the originating feature/contract selection and refresh its assessment.

### Requirement: Iterate on this plan opens an OpenCode session on the change

Iterate SHALL open or explicitly resume an authoring conversation linked to the existing feature identity in the verified checkout containing the selected active contract source. It SHALL preserve the feature's complete contract set even when the reader focuses one contract. The selected proposal, design, tasks, and delta files SHALL be initial context; checkout reads SHALL be pre-granted and writes SHALL retain normal permissions and shared writer coordination. Foreground presentation with return to the originating feature/contract SHALL be the default; external presentation SHALL remain explicit. Missing or ambiguous contexts SHALL offer association/binding remediation. Archived artifacts SHALL remain readable, but editing them SHALL require the existing explicit new active-work decision rather than reactivating a completed feature. OpenSpec authoring remains owned by the operator and the project workflow.

#### Scenario: Iterate opens a repo-rooted session
- **WHEN** Iterate is selected for an active change associated with another worktree
- **THEN** the standalone session opens at that worktree's root with its planning files as context

#### Scenario: Iterate requires no launcher
- **WHEN** the operator iterates and closes the session without running a pipeline
- **THEN** no run starts and the conversation returns to the originating feature without starting a run

#### Scenario: Iterate session is pre-authorized to read the repository
- **WHEN** Iterate opens on a verified planning checkout
- **THEN** reads across that checkout are pre-granted while writes follow normal session permissions

#### Scenario: Revisit a plan conversation
- **WHEN** the feature has a linked authoring conversation and the operator chooses resume
- **THEN** Convoy opens that exact session and returns to the same selected feature and contract on client exit

### Requirement: Non-TTY invocations print a plain listing

Non-TTY `convoy specs` SHALL print a plain listing of pending features/candidates, their artifact inventories and lifecycle summaries, applicable actions with blocker/remediation information, run-bearing unassociated worktrees, and canonical specs, rather than launching a TUI. Headless and interactive listings SHALL use the same assessment and expose history inspection guidance. Listing SHALL not mutate or silently adopt work.

#### Scenario: Piped output
- **WHEN** `convoy specs` runs with stdout redirected in a repository containing lifecycle work
- **THEN** it prints the shared lifecycle facts and action reasons without terminal control sequences and exits successfully

#### Scenario: Empty state when piped
- **WHEN** no OpenSpec artifacts or lifecycle work are discoverable
- **THEN** a single empty-state message prints and the process exits successfully

## ADDED Requirements

### Requirement: Lifecycle actions are discoverable in root and detail

The selected feature's root and ordinary detail views SHALL expose the same applicable lifecycle action menu, including close review, association/rebinding, refresh, and history navigation as appropriate. Blocked actions SHALL remain inspectable with reasons and remediation rather than disappear. Footer truncation SHALL retain a discoverable action-menu entry so omitted hints do not remove access; handlers and menu availability SHALL consume shared capabilities. Fullscreen reader copy/close/tab keys SHALL remain unchanged; returning to detail SHALL restore lifecycle actions without losing subject identity. Invoking close review SHALL disclose the feature, contracts, entire source branch, base, and any blockers before mutation.

#### Scenario: Narrow terminal hides the close shortcut hint
- **WHEN** footer space cannot show every shortcut
- **THEN** the action menu remains discoverable and exposes close review and its current blockers

#### Scenario: Ready feature is opened in detail
- **WHEN** a feature assessed ready to close is selected and its detail reader is opened
- **THEN** its ordinary detail action menu offers the same close action as the root

#### Scenario: Reader copy remains copy
- **WHEN** the operator presses `c` in the fullscreen reader
- **THEN** the active tab is copied as before and no lifecycle mutation is triggered
