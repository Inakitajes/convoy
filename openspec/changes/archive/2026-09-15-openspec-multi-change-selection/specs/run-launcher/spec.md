## ADDED Requirements

### Requirement: Launcher change picker offers ordered multi-selection

When the launcher prompt step opens for a checkout with active local OpenSpec changes, the picker SHALL let the operator select zero, one, or several of them before confirming: toggling the highlighted row marks or unmarks that change, a select-all action marks every active change, and the explicit no-change row remains available as the manual/no-change mode. Confirming SHALL attach exactly the marked changes, ordered by the picker's active-change listing, independent of the order in which the rows were toggled; confirming the no-change row SHALL select nothing. No change SHALL be attached without an explicit confirmation, and a sole active change SHALL remain unselected until confirmed.

#### Scenario: Several changes are marked and confirmed

- **WHEN** the operator marks the second and then the first active change and confirms
- **THEN** review and the run plan carry both changes ordered by the picker's listing, with the no-change mode not set

#### Scenario: Select-all marks every active change

- **WHEN** the operator invokes select-all and confirms
- **THEN** every active change is attached in the picker's listing order

#### Scenario: No-change row selects nothing

- **WHEN** the operator confirms the explicit no-change row
- **THEN** the run proceeds in manual/no-change mode with zero attached changes

#### Scenario: A sole active change still needs confirmation

- **WHEN** the checkout has exactly one active change and the picker opens on it
- **THEN** the change is attached only when the operator confirms, never on open alone

### Requirement: Launcher change picker opens focused on the first active change

When the launcher prompt step opens, or is re-entered, for a checkout with active local OpenSpec changes and no already-preset selection, the picker SHALL place its highlight on the first active change rather than on the no-change row. When a selection was already made, the highlight SHALL return to the first selected change. The no-change row SHALL remain reachable.

#### Scenario: Fresh worktree with active changes

- **WHEN** the prompt step opens in a checkout with active changes and no preset selection
- **THEN** the highlight sits on the first active change, not on the no-change row

#### Scenario: Re-entry returns to the selection

- **WHEN** the operator returns to the picker after a selection was made
- **THEN** the highlight sits on the first selected change

#### Scenario: Manual/no-change remains reachable

- **WHEN** the picker opens focused on the first active change
- **THEN** the operator can still move to the no-change row and choose it explicitly
