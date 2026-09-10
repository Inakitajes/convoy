## MODIFIED Requirements

### Requirement: Lifecycle actions are discoverable in root and detail

Root and ordinary detail views SHALL expose the same contextual action menu and shared per-action guards for the selected checkout, without lifecycle-stage gates. The browser's Actions menu SHALL offer Close (archive & merge), Archive change for the selected change, and refresh; apply, iterate, continue, and exit are the keyboard-level resolutions, and the full worktree operation surface (fetch, sync, push, PR composition, squash, removal, branch deletion) remains available through the `convoy worktrees` CLI on the same guarded handlers. Blocked actions SHALL remain inspectable with reasons and remediation rather than disappear. Footer truncation SHALL retain a discoverable action-menu entry so omitted hints do not remove access; handlers SHALL use and revalidate the same guards as menu availability. Fullscreen reader copy/close/tab keys SHALL remain unchanged; returning to detail SHALL restore contextual actions without losing the verified checkout-local subject. Browsing and fullscreen navigation SHALL NOT change action selections or mutate domain state. No menu SHALL offer adoption, binding, or Completed feature history.

#### Scenario: Narrow terminal hides the close shortcut hint

- **WHEN** footer space cannot show every shortcut
- **THEN** the action menu remains discoverable and exposes close and its current blockers

#### Scenario: Ready feature is opened in detail

- **WHEN** a local active change with completed tasks is selected and its detail reader is opened
- **THEN** its ordinary detail action menu offers the same contextual close and disabled reasons as its root worktree context, without a ready-to-close lifecycle stage

#### Scenario: Reader copy remains copy

- **WHEN** the operator presses `c` in the fullscreen reader
- **THEN** the active tab is copied as before and no mutation is triggered

#### Scenario: Archive is offered for the selected change

- **WHEN** the Actions menu opens on a selected local change
- **THEN** it offers Archive change and emits the archive resolution only for that explicit change
