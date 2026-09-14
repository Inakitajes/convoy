## ADDED Requirements

### Requirement: Home paints from the cached board before refreshing

Home SHALL render the last cached board for the repository immediately when a usable cache exists, and SHALL NOT show the loading transition in that case; it SHALL start a background refresh in parallel. When no usable cache exists, Home SHALL show the shared loading transition while the first load runs. A completed refresh SHALL update the rendered board in place, without remounting Home, resetting its scroll, or interrupting the operator.

#### Scenario: Warm open paints the cached board

- **WHEN** Home opens and a usable cached board exists
- **THEN** the board renders immediately, no loading transition is shown, and a background refresh is already in flight

#### Scenario: Cold open falls back to the loading transition

- **WHEN** Home opens and no usable cached board exists
- **THEN** the shared loading transition covers the first load and the board replaces it when ready

#### Scenario: Refresh updates in place

- **WHEN** a background refresh completes while Home is open
- **THEN** the rendered board reflects the refreshed observations without a remount and without losing the current selection

## MODIFIED Requirements

### Requirement: Navigation preserves the selected work

Returning from a conversation, launcher, dashboard, spec reader, or cancelled action SHALL return to Home with refreshed independent Git, spec, publication, and activity observations. Within one Home session, returning SHALL reopen on the checkout the operator was viewing, selected by its verified identity (path plus branch or detached state) rather than by list position; if that checkout is no longer registered, Home SHALL open on the New worktree entry. The first Home open of a process SHALL select the New worktree entry. Persisted last-selection hints SHALL remain optional, non-authoritative diagnostics that never drive selection on the first open and SHALL NOT start an agent. Convoy SHALL NOT restore selection by list position, change id, branch spelling, or a reused path. Only explicitly leaving Convoy SHALL end the surrounding Home workflow.

#### Scenario: Reopen from another worktree

- **WHEN** an operator restarts Convoy from another checkout of the same repository
- **THEN** Home opens with the New worktree entry selected and starts no session or action

#### Scenario: Return within a session restores the viewed checkout

- **WHEN** the operator returns to Home from a destination and the checkout they were viewing is still registered
- **THEN** Home opens with that checkout selected by its verified identity and starts no session or action

#### Scenario: Last selected checkout disappeared

- **WHEN** the checkout the operator was viewing is no longer registered on return
- **THEN** Home opens with the New worktree entry selected, retains no tombstone for the missing checkout, and starts no action on a replacement checkout

#### Scenario: A recorded hint never chooses a target

- **WHEN** a persisted last-selection hint names a worktree, whether still registered or not, and Convoy has just started
- **THEN** nothing is automatically selected, restored, or started from the hint

#### Scenario: No navigation hint is retained

- **WHEN** Convoy reopens without a persisted navigation hint
- **THEN** it opens the current Worktrees list without inventing a work record or starting an agent
