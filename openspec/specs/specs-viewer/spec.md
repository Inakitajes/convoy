# specs-viewer Specification

## Purpose

The `convoy specs` command lets an operator browse OpenSpec state — registered features and active changes (lifecycle work), canonical specs — in a terminal UI, read each change's artifacts as rendered markdown from its authoritative source, hand a selected change straight to the interactive run launcher with it already pinned as the contract, or open a standalone OpenCode session on the repo rooted at the change's planning files.

## Requirements

### Requirement: Specs command discovers OpenSpec state from the filesystem

`convoy specs` SHALL discover OpenSpec artifacts from the filesystem: active changes are real directories in `openspec/changes/` excluding `archive`, dotfiles, and stray non-directory files; canonical specs are Markdown files under `openspec/specs/**`. It SHALL also read repository-scoped feature associations, referenced archives, run/close evidence, and current Git context for lifecycle discovery. Read-only OpenSpec task queries SHALL be permitted by the shared assessment contract. Discovery, refresh, and browsing MUST NOT write any file or silently adopt/migrate features. Absence of active changes or of the launch checkout's `openspec/` SHALL NOT suppress registered features or run-bearing worktrees.

#### Scenario: Repo without openspec directory

- **WHEN** a repository has no `openspec/` directory and no discoverable registered features or run-bearing worktrees
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

The root SHALL present non-empty sections in this order: **Features**, **Worktrees without spec**, and **Canonical Specs**. Features SHALL include registered pending lifecycle work and unassociated active-change candidates. A discoverable history view SHALL expose completed registered features without requiring them to clutter pending work. Section headers SHALL remain distinct and reachable while scrolling; empty sections and headers SHALL be omitted. Missing proposals SHALL not hide entries; features SHALL use their recorded display identity and unassociated changes their change id. Selection SHALL use stable feature identity where available, not a mutable branch or directory name.

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

### Requirement: Canonical selection keeps the root list full-size

While a canonical spec is selected at the root, the redundant details panel SHALL be hidden and the browse list SHALL use the full body in both wide and compact layouts. Pressing Enter SHALL still open that spec in the full-width reading level. Returning to the root SHALL restore the list-only full-body layout for the still-selected canonical spec. Active-change and worktree selections SHALL retain their useful root details panel.

#### Scenario: Canonical spec selected at root

- **WHEN** the root selection lands on a canonical spec in either a wide or compact terminal
- **THEN** the details panel is absent and the browse list fills the body

#### Scenario: Return from a canonical reader

- **WHEN** the user presses Enter on a canonical spec and then returns from its reader
- **THEN** that spec remains selected at the root and the redundant details panel is hidden again

#### Scenario: Change and worktree previews remain

- **WHEN** the root selection lands on an active change or a worktree without spec
- **THEN** the details panel remains visible with the selected row's useful lifecycle or worktree information

### Requirement: Change detail groups artifacts by type

Entering an active change or a canonical spec SHALL show one full-width reading pane under a horizontal tab strip, with one tab per artifact group — Proposal, Design, Tasks, Delta Specs, and Other when present. All delta spec files SHALL share a single Delta Specs tab regardless of how many capabilities they span, concatenated with a small heading naming each capability before that capability's files. The tab strip SHALL be omitted when the subject has a single group (a canonical spec, or a change with one artifact group), leaving only a title row identifying the subject. Tabs SHALL switch with left/right keys (or `h`/`l`) and digit keys `1`–`9`; up/down keys SHALL scroll the active tab's content line by line. Each tab's content renders as markdown with YAML frontmatter stripped; delta spec content MAY style its requirement-operation headers (`ADDED`, `MODIFIED`, `REMOVED`) distinctly. Files that cannot be read render as a placeholder instead of failing the browser.

#### Scenario: All artifact types present

- **WHEN** a change contains `proposal.md`, `design.md`, `tasks.md`, and `specs/cli/spec.md`
- **THEN** the detail view shows tabs Proposal, Design, Tasks, and Delta Specs in a horizontal strip above one full-width reading pane, each tab rendering that file's content

#### Scenario: Multiple delta capabilities merge into one tab

- **WHEN** a change contains `specs/cli/spec.md` and `specs/ui/spec.md`
- **THEN** a single Delta Specs tab shows both files' content, with a heading naming `cli` before its file and a heading naming `ui` before its file

#### Scenario: Single-group subject hides the tab strip

- **WHEN** the user enters a canonical spec (or a change with only one artifact group)
- **THEN** no tab strip renders; only the title row identifying the subject and the full-width reading pane, whose content is scrollable and readable without tab navigation

#### Scenario: Arrow keys scroll the reading pane

- **WHEN** the active tab's rendered content is taller than the pane and the user presses up/down (or `k`/`j`)
- **THEN** the content scrolls line by line within the same tab instead of moving between sections

#### Scenario: Unreadable artifact

- **WHEN** one of a change's markdown files cannot be read
- **THEN** its tab shows a placeholder, and the remaining tabs render normally

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

### Requirement: Iterate on this plan opens an OpenCode session on the change

**Iterate on this plan** SHALL open a standalone OpenCode session rooted at the verified checkout containing the selected active planning artifacts, with proposal, design, tasks, and delta specs referenced as context. For a registered feature the source SHALL come from its association; for an unassociated candidate the source SHALL be explicitly selected. The session SHALL be pre-authorized to read the entire selected repository checkout without per-file read confirmations; only reads are pre-granted and writes retain normal defaults. The session SHALL outlive the browser and use OpenSpec authoring commands for edits, not Convoy artifact writes. Missing, ambiguous, or archived-only planning sources SHALL yield guidance rather than silently opening an unrelated checkout for editing.

#### Scenario: Iterate opens a repo-rooted session

- **WHEN** Iterate is selected for an active change associated with another worktree
- **THEN** the standalone session opens at that worktree's root with its planning files as context

#### Scenario: Iterate requires no launcher

- **WHEN** the operator iterates and closes the session without running a pipeline
- **THEN** no run starts and only the standalone session was opened

#### Scenario: Iterate session is pre-authorized to read the repository

- **WHEN** Iterate opens on a verified planning checkout
- **THEN** reads across that checkout are pre-granted while writes follow normal session permissions

### Requirement: Non-TTY invocations print a plain listing

Non-TTY `convoy specs` SHALL print a plain listing of pending features/candidates, their artifact inventories and lifecycle summaries, applicable actions with blocker/remediation information, run-bearing unassociated worktrees, and canonical specs, rather than launching a TUI. Headless and interactive listings SHALL use the same assessment and expose history inspection guidance. Listing SHALL not mutate or silently adopt work.

#### Scenario: Piped output

- **WHEN** `convoy specs` runs with stdout redirected in a repository containing lifecycle work
- **THEN** it prints the shared lifecycle facts and action reasons without terminal control sequences and exits successfully

#### Scenario: Empty state when piped

- **WHEN** no OpenSpec artifacts or lifecycle work are discoverable
- **THEN** a single empty-state message prints and the process exits successfully

### Requirement: Fullscreen reader

At the detail level, pressing `v` SHALL toggle an immersive reader that replaces the entire board — no header, footer, or tab chrome — leaving a single title bar that identifies the subject, the active tab, the copy hint (`c copy`), the close hint (`v/esc close`), and the scroll position. Within the reader, line keys SHALL scroll by line, paging keys by page, and home/end (with `g`/`G`) SHALL jump to the start or end; the tab-switching keys SHALL change the active tab inside the reader, resetting its scroll, and the title bar SHALL reflect the new tab. `v`, `q`, or escape SHALL close the reader and return to the detail level with the same active tab. The fullscreen reader MUST NOT be reachable from the root level, and scroll hints MUST NOT appear in the title bar.

#### Scenario: Toggle in and out

- **WHEN** the user presses `v` while reading a change's detail view
- **THEN** the reader replaces the header, footer, and tab chrome with one full-width pane plus its title bar, and pressing `v` (or escape, or `q`) returns to the detail view showing the same tab

#### Scenario: Tabs switch inside the reader

- **WHEN** the user presses right (or `l`) inside the reader
- **THEN** the next tab's content renders full width with its scroll reset, and the title bar names the new tab

#### Scenario: Not offered at the root level

- **WHEN** the board sits at the root list with a change selected
- **THEN** pressing `v` does nothing — the fullscreen reader exists only at the detail level

### Requirement: Copy the active tab

Inside the fullscreen reader, pressing `c` SHALL copy the active tab's markdown source to the system clipboard through the same clipboard pipeline the run dashboard uses. The copied payload SHALL be the frontmatter-stripped file bodies of that tab, joined, including the injected per-capability headings when the active tab is Delta Specs. The title bar SHALL report the outcome of the copy attempt, including when no clipboard mechanism is available or the transport rejects the payload, without interrupting reading.

#### Scenario: Copy succeeds

- **WHEN** the user presses `c` in the reader while the Proposal tab is active and a clipboard mechanism is available
- **THEN** the clipboard receives the proposal's markdown source (frontmatter stripped) and the title bar reports the copy

#### Scenario: Copy with multiple delta capabilities

- **WHEN** the user presses `c` while the merged Delta Specs tab is active
- **THEN** the clipboard receives every delta file's markdown source in order, each preceded by its capability heading

#### Scenario: Copy fails gracefully

- **WHEN** the user presses `c` and no clipboard mechanism is available
- **THEN** the title bar reports the failure and the reader continues functioning

### Requirement: Minimal chrome

The board's chrome SHALL stay lean. The header SHALL show exactly one content line in the unified home-session header style: a faint `project ` label followed by the normalized target project directory supplied by the loaded specs view; the browser SHALL NOT substitute its process working directory. Live change and spec counts SHALL NOT appear there. The footer SHALL advertise only actions that are not universal navigation conventions: hints for arrow-key selection, paging, or scrolling MUST NOT appear in the footer at any level, nor in the fullscreen reader's title bar. The footer's hint-overflow behavior (truncation with a more-actions marker) is retained.

#### Scenario: Header identifies the loaded project

- **WHEN** the board renders at any non-fullscreen level for a normalized target directory
- **THEN** the header's only content line shows `project  ` followed by that directory and does not show live change/spec counts or the browser process's working directory

#### Scenario: Footer drops obvious navigation hints

- **WHEN** the detail level renders with actions available
- **THEN** the footer hints list actions like read, apply, iterate, full, and quit — and contains no arrow-key or paging hints

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

### Requirement: Close handoff from the browser is confirmed

Pressing the close key (`x`) in the root list, or selecting the close action in the lifecycle Actions menu at any level, SHALL NOT emit the close resolution immediately. The browser SHALL first show a confirmation modal that names the selected feature, its source branch, the intended base, and the sequence the close command runs (sync → archive → squash-merge), so an accidental keystroke cannot start the sequence. Only an explicit confirm (`y` or Enter on the confirm choice) SHALL emit the close resolution; cancel (`n` or escape) SHALL dismiss the modal and leave the browser on the same subject with no mutation. The confirmation SHALL NOT alter what close itself does afterward, and non-TTY invocations SHALL remain unchanged.

#### Scenario: The close key opens a confirmation

- **WHEN** the user presses `x` on a registered feature in the root list
- **THEN** a confirmation modal names the feature, branch, base, and the sync → archive → squash-merge sequence, and no close resolution is emitted yet

#### Scenario: Confirm hands off to close

- **WHEN** the user confirms the modal with `y` or Enter on the confirm choice
- **THEN** the browser emits the same close resolution it emitted before this change, and close proceeds as usual

#### Scenario: Cancel keeps the browser state

- **WHEN** the user cancels the modal with `n` or escape
- **THEN** the modal closes, the same feature stays selected at the same level, and no handoff or mutation happened

#### Scenario: The Actions menu's close entry also confirms

- **WHEN** the user selects the close action from the lifecycle Actions menu
- **THEN** the same confirmation modal appears before the close resolution is emitted
