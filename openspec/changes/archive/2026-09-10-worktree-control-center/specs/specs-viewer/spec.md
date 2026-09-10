## MODIFIED Requirements

### Requirement: Specs command discovers OpenSpec state from the filesystem

`convoy specs` SHALL discover checkouts from the current repository's complete Git worktree inventory and discover each checkout's OpenSpec artifacts only from that checkout's filesystem. Active changes SHALL be real directories in its `openspec/changes/` excluding `archive`, dotfiles, and stray non-directory files; canonical specs SHALL be Markdown files under its `openspec/specs/**`. Local archives SHALL surface as counts rather than browsable sections in the board. Read-only OpenSpec task queries SHALL be permitted with filesystem fallback when the CLI is unavailable; unreadable evidence SHALL remain unknown. Discovery, refresh, and browsing MUST NOT write domain state, adopt worktrees, or consult feature associations, contract registries, or landing receipts as authority. Absence of active changes or of the launch checkout's `openspec/` SHALL NOT suppress any Git-registered checkout, including external, main, detached, locked, inaccessible, missing-path, spec-less, or run-less worktrees. Git-stale registrations SHALL be shown as inaccessible while still registered; removed registrations SHALL disappear without tombstones.

#### Scenario: Repo without openspec directory

- **WHEN** a repository has no `openspec/` directory but has Git-registered worktrees
- **THEN** Convoy opens the worktree inventory with available actions rather than exiting merely because no specs were found

#### Scenario: Repo with openspec directory but no active changes

- **WHEN** a selected checkout has `openspec/` but its changes directory holds only `archive`
- **THEN** its active-change section is omitted while its local canonical specs remain browsable and its archived changes surface only as a count

#### Scenario: Archived work remains pending

- **WHEN** a selected checkout contains only archived changes
- **THEN** those local archives surface as a count without a feature record, integration state, or lifecycle history, and their presence does not create a pending-feature entry

### Requirement: Worktree-backed changes read their artifacts from the worktree

The specs view SHALL load a selected change's title and artifact inventory using absolute paths into the explicitly selected worktree's local active or archive directory. The selected checkout SHALL also supply canonical spec content. Same-id copies in other checkouts SHALL remain independent sources and SHALL NOT override or supplement the selected source. A missing, stale, or unreadable source SHALL display its condition rather than silently fall back to another checkout. Filesystem presence SHALL NOT establish ownership, and no adoption or binding SHALL be required to read a local change. The operator SHALL not need to relaunch from the source checkout to read available artifacts.

#### Scenario: Stale skeleton on the launch checkout

- **WHEN** the launch checkout holds a husk and the operator selects another worktree's complete local change
- **THEN** the selected worktree alone supplies the title and readable artifact inventory

#### Scenario: Reading works from any launch directory

- **WHEN** the selected artifacts live outside the browser's process directory
- **THEN** absolute paths load that source without read placeholders caused by the launch location

#### Scenario: Diverging copies resolve to the worktree

- **WHEN** the launch checkout and selected worktree carry differing copies of a change
- **THEN** the selected local copy supplies its artifacts and facts without mixing in the launch copy or asserting ownership over either copy

#### Scenario: Changes without a worktree are unchanged

- **WHEN** an active change exists in the main checkout without any separate linked worktree or Convoy registration
- **THEN** its files remain readable under main and main is its explicit local action target, subject to the normal action guards

#### Scenario: Associated artifacts are missing

- **WHEN** the selected worktree's artifact source is absent but another checkout has the same slug
- **THEN** the browser reports the missing source without substitution; inspecting the other copy requires selecting that checkout explicitly

### Requirement: Root view shows only non-empty sections

The root SHALL present Worktrees from Git inventory rather than Features, Worktrees without spec, or Completed feature history. Each registered checkout SHALL have its own root entry regardless of repeated change ids or inherited artifacts. The board SHALL be a list-only browse surface whose non-empty sections appear in the order Active Changes and Canonical Specs; archived changes SHALL appear only as a per-checkout count. Section headers SHALL remain distinct and reachable while scrolling; empty sections and headers SHALL be omitted. Missing proposals SHALL not hide local changes, which SHALL use their local title when readable or their change id otherwise. Worktree names SHALL derive from folder basename, actual branch or detached status, and path without a display-name record. Selection SHALL identify the verified checkout and local artifact, not a global change id or mutable branch name alone. Actual global run history SHALL remain independently reachable without retaining removed worktrees as completed entries.

#### Scenario: Sections appear in order

- **WHEN** a selected checkout has active changes and canonical specs
- **THEN** its distinct local sections appear in that order, beneath its worktree context

#### Scenario: Empty root sections disappear

- **WHEN** an artifact section is empty
- **THEN** neither its rows nor its title are rendered, without hiding the containing worktree

#### Scenario: Change missing its proposal

- **WHEN** a local active change has no readable proposal
- **THEN** the change remains listed by id with its artifact availability disclosed

#### Scenario: Completed feature is inspected

- **WHEN** the operator looks for historical work after Git worktree removal
- **THEN** that checkout is absent from the root without a Completed entry, and any retained run history remains accessible independently

### Requirement: Change detail groups artifacts by type

Entering an active change, a local archived change, or a canonical spec SHALL show one full-width reading pane under a horizontal tab strip, with one tab per artifact group: Proposal, Design, Tasks, Delta Specs, and Other when present. All delta spec files SHALL share a single Delta Specs tab regardless of how many capabilities they span, concatenated with a small heading naming each capability before that capability's files. The tab strip SHALL be omitted when the subject has a single group (a canonical spec, or a change with one artifact group), leaving only a title row identifying the subject. Tabs SHALL switch with left/right keys (or `h`/`l`) and digit keys `1` through `9`; up/down keys SHALL scroll the active tab's content line by line. Each tab's content SHALL render as markdown with YAML frontmatter stripped; delta spec content MAY style its requirement-operation headers (`ADDED`, `MODIFIED`, `REMOVED`) distinctly. Files that cannot be read SHALL render as a placeholder instead of failing the browser. All groups SHALL remain scoped to the selected checkout-local source.

#### Scenario: All artifact types present

- **WHEN** a change contains `proposal.md`, `design.md`, `tasks.md`, and `specs/cli/spec.md`
- **THEN** the detail view shows tabs Proposal, Design, Tasks, and Delta Specs in a horizontal strip above one full-width reading pane, each tab rendering that file's content

#### Scenario: Multiple delta capabilities merge into one tab

- **WHEN** a change contains `specs/cli/spec.md` and `specs/ui/spec.md`
- **THEN** a single Delta Specs tab shows both files' content, with a heading naming `cli` before its file and a heading naming `ui` before its file

#### Scenario: Single-group subject hides the tab strip

- **WHEN** the user enters a canonical spec or a change with only one artifact group
- **THEN** no tab strip renders; only the title row identifying the subject and the full-width reading pane, whose content is scrollable and readable without tab navigation

#### Scenario: Arrow keys scroll the reading pane

- **WHEN** the active tab's rendered content is taller than the pane and the user presses up/down or `k`/`j`
- **THEN** the content scrolls line by line within the same tab instead of moving between sections

#### Scenario: Unreadable artifact

- **WHEN** one of a change's markdown files cannot be read
- **THEN** its tab shows a placeholder, and the remaining tabs render normally

#### Scenario: Local archive uses the same reader

- **WHEN** the operator opens an archived change from the selected checkout
- **THEN** its local artifacts use the same grouped tabs, fullscreen, and copy behavior without loading another checkout's active copy

### Requirement: Apply this spec hands off to the launcher preselected

While browsing an active local change, **Apply this spec** SHALL open the standard launcher with that change and its explicit checkout-local source preselected. Execution SHALL reuse the selected checkout and actual Git context, with its selected base reviewed, rather than creating or adopting a feature. Adding other local changes SHALL require explicit selection; inherited files and same-id copies elsewhere SHALL NOT expand the selection. No missing preset SHALL silently fall back to another change or checkout. A cancelled launcher SHALL start no run and leave no newly created checkout or domain state. An archived change SHALL remain readable but implementation SHALL require an explicit new active-work decision, not silently reactivate the archive. Main SHALL remain an available target with explicit dirty-tree review and consent instead of forced spin.

Launcher resource loading SHALL use the verified execution checkout from the start, including configuration, history, specs, and relative attachments. Execution SHALL revalidate the reviewed target and selected inputs. Returning from a cancelled launcher or dashboard SHALL restore the originating verified checkout and local change selection and refresh its observations; if no longer verifiable, the browser SHALL return to the worktree list with an explanation rather than retarget.

#### Scenario: Handoff preselects the change

- **WHEN** Apply is selected on an active local `add-specs-viewer` change and accepted through the launcher
- **THEN** the resulting run uses the reviewed checkout and explicitly selected local inputs without re-asking which copy to use or including unrelated changes

#### Scenario: Launcher cancelled after handoff

- **WHEN** the operator invokes Apply and aborts before acceptance
- **THEN** no run starts and no new checkout or domain state remains

#### Scenario: Selected source disappears

- **WHEN** an active change disappears between browsing and launch review
- **THEN** the launcher reports the missing selected source instead of choosing a different active change or a same-id copy elsewhere

### Requirement: Iterate on this plan opens an OpenCode session on the change

Iterate SHALL open or explicitly resume an authoring conversation in the verified checkout containing the selected active change. Only explicitly selected local planning files SHALL be supplied as selected-change context; the focused proposal, design, tasks, and delta files SHALL be initial context without inferring a broader contract set. Checkout reads SHALL be pre-granted and writes SHALL retain normal permissions and shared managed-writer coordination. Foreground presentation with return to the originating verified checkout and local change SHALL be the default; external presentation SHALL remain explicit. Missing, stale, or ambiguous targets SHALL require explicit correction or reselection, never binding or cross-tree fallback. Archived artifacts SHALL remain readable, but editing them SHALL require an explicit new active-work decision rather than silent archive reactivation. OpenSpec authoring SHALL remain owned by the operator and the project workflow. Session references and checkout locators SHALL be navigation metadata only, not spec ownership or mutation authority.

#### Scenario: Iterate opens a repo-rooted session

- **WHEN** Iterate is selected for an active local change in another worktree
- **THEN** the standalone session opens at that verified worktree's root with its selected planning files as context

#### Scenario: Iterate requires no launcher

- **WHEN** the operator iterates and closes the session without running a pipeline
- **THEN** no run starts and the conversation returns to the originating checkout and local selection

#### Scenario: Iterate session is pre-authorized to read the repository

- **WHEN** Iterate opens on a verified planning checkout
- **THEN** reads across that checkout are pre-granted while writes follow normal session permissions and shared writer guards

#### Scenario: Revisit a plan conversation

- **WHEN** the operator chooses to resume an available authoring conversation for the selected checkout and its session reference and target validate
- **THEN** Convoy opens that exact session and returns to the same verified checkout and local change on client exit

### Requirement: Non-TTY invocations print a plain listing

Non-TTY `convoy specs` SHALL print a plain worktree inventory rather than launching a TUI, including all Git-registered checkouts regardless of specs or runs, their independent observations, applicable guard conditions with their reasons, and local active changes and artifact inventories. It SHALL provide explicit checkout-local archive and canonical browsing guidance without a global deduplicated change list or Completed feature history. Headless and interactive listings SHALL use the same discovery and per-action guards. Listing SHALL not mutate or silently adopt work, and unavailable evidence SHALL remain unknown rather than absent.

#### Scenario: Piped output

- **WHEN** `convoy specs` runs with stdout redirected in a repository containing worktrees
- **THEN** it prints the shared worktree and local artifact facts and guard-condition reasons without terminal control sequences and exits successfully

#### Scenario: Empty state when piped

- **WHEN** no worktrees or OpenSpec artifacts are discoverable
- **THEN** a single empty-state message prints and the process exits successfully

#### Scenario: Spec-less worktrees when piped

- **WHEN** Git reports worktrees but none has OpenSpec artifacts or runs
- **THEN** the plain listing includes those worktrees rather than reporting an empty repository

### Requirement: Lifecycle actions are discoverable in root and detail

Root and ordinary detail views SHALL expose the same contextual action menu and shared per-action guards for the selected checkout, without lifecycle-stage gates. The browser's Actions menu SHALL offer close review and refresh; apply, iterate, continue, and exit are the keyboard-level resolutions, and the full worktree operation surface (fetch, sync, push, PR composition, squash, removal, branch deletion) remains available through the `convoy worktrees` CLI on the same guarded handlers. Blocked actions SHALL remain inspectable with reasons and remediation rather than disappear. Footer truncation SHALL retain a discoverable action-menu entry so omitted hints do not remove access; handlers SHALL use and revalidate the same guards as menu availability. Fullscreen reader copy/close/tab keys SHALL remain unchanged; returning to detail SHALL restore contextual actions without losing the verified checkout-local subject. Browsing and fullscreen navigation SHALL NOT change action selections or mutate domain state. No menu SHALL offer adoption, binding, or Completed feature history.

#### Scenario: Narrow terminal hides the close shortcut hint

- **WHEN** footer space cannot show every shortcut
- **THEN** the action menu remains discoverable and exposes close review and its current blockers

#### Scenario: Ready feature is opened in detail

- **WHEN** a local active change with completed tasks is selected and its detail reader is opened
- **THEN** its ordinary detail action menu offers the same contextual close review and disabled reasons as its root worktree context, without a ready-to-close lifecycle stage

#### Scenario: Reader copy remains copy

- **WHEN** the operator presses `c` in the fullscreen reader
- **THEN** the active tab is copied as before and no mutation is triggered

### Requirement: Close handoff from the browser is confirmed

Pressing the close key (`x`) on a selected change whose containing checkout has an attached branch, or selecting close in the contextual Actions menu at any level, SHALL NOT emit the close resolution immediately. The browser SHALL first show a confirmation modal naming the selected source worktree and path, actual source branch, selected base, explicitly selected local archive set including an empty set, and reviewed operation sequence. The confirmation SHALL explicitly disclose that squash-to-base integrates the WHOLE reviewed branch scope, not only selected changes, and SHALL state that nothing is pushed, merged, or deleted by close itself while push, worktree removal, and branch deletion remain separate optional operations. Close SHALL be an optional convenience rather than an inferred lifecycle transition: when chosen it SHALL synchronize as needed, archive only explicitly selected active changes, and then squash, with push and cleanup separately optional. These operations SHALL also remain independently available. Only an explicit confirm (`y` or Enter on the confirm choice) SHALL emit the reviewed resolution; cancel (`n` or escape) SHALL dismiss the modal and leave the browser on the same subject with no mutation. Confirmation SHALL NOT bypass operation-time guard revalidation or dirty-tree protections, and non-TTY listing SHALL remain non-mutating without a modal.

#### Scenario: The close key opens a confirmation

- **WHEN** the user presses `x` on a selected change whose containing checkout has an attached branch
- **THEN** confirmation identifies source, base, explicit archive set, whole-branch scope, and the separate optional push and cleanup operations, and no close resolution is emitted yet

#### Scenario: Confirm hands off to close

- **WHEN** the user confirms the modal with `y` or Enter on the confirm choice
- **THEN** the browser emits the reviewed checkout-targeted close resolution and close revalidates the selected operations before mutation

#### Scenario: Cancel keeps the browser state

- **WHEN** the user cancels the modal with `n` or escape
- **THEN** the modal closes, the same checkout-local subject stays selected at the same level, and no handoff or mutation happened

#### Scenario: The Actions menu's close entry also confirms

- **WHEN** the user selects close from the contextual Actions menu
- **THEN** the same confirmation modal appears before the close resolution is emitted

#### Scenario: One archive does not narrow squash scope

- **WHEN** a source branch contains two changes and the operator explicitly selects only one to archive during close
- **THEN** review names that one archive selection and separately warns that squash covers the whole reviewed branch, including other edits

## REMOVED Requirements

### Requirement: Canonical selection keeps the root list full-size
**Reason**: Superseded by the list-only root board: the redundant details panel is gone in wide and compact layouts for every selection, so there is no canonical-selection-specific panel behavior left to keep.
**Migration**: See the ADDED requirement "The root list is the whole board".

## ADDED Requirements

### Requirement: The root list is the whole board

The root SHALL be a list-only browse board: the navigation list SHALL fill the body in both wide and compact layouts, with no secondary details panel beside or beneath it — a row's divider rule and its own line already carry the facts the operator needs. Pressing Enter SHALL open the selected change or canonical spec in the full-width reading level, and returning to the root SHALL restore the list-only full-body layout for the still-selected subject and checkout. The reading pane exists only at the detail level (the Actions menu MAY borrow a pane beside the narrowed list while it is open at the root). The board SHALL present two named sections — `changes`, whose worktree dividers carry each checkout's local active changes beneath them, and `specs`, the checkout-local canonical specs — each drawn as its own rounded container whose header is visually distinct from the plain worktree rules inside it, with worktree sections separated by a full blank line and the two containers opening back-to-back. The board SHALL render no header row: the section containers and the footer are its only chrome, and the section containers SHALL span the body minus the shell's single-column margin on each edge.

#### Scenario: Root renders as a single list

- **WHEN** the browse board renders at the root in either a wide or compact terminal, regardless of which row is selected
- **THEN** the browse list fills the body and no details panel is present

#### Scenario: Return from a reader

- **WHEN** the user presses Enter on any row and then returns from its reading level
- **THEN** that subject remains selected at the root and the list-only full-body layout is restored

#### Scenario: Worktree sections sit apart

- **WHEN** more than one checkout is registered
- **THEN** a full blank line separates each worktree section from the next, beneath the `changes` header
