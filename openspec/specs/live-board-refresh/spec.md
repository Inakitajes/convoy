# live-board-refresh Specification

## Purpose
Keeps the worktree board current without making the operator wait: a repository-scoped cache lets the board paint from last-known observations, and a fingerprint-gated background refresh updates it continuously while disclosing how fresh the displayed evidence is.

## Requirements

### Requirement: Board cache is repository-scoped and safely ignorable

Convoy SHALL persist the last assembled board for a repository under the user's Convoy home directory (`~/.convoy`), keyed by the repository's Git common directory, and SHALL write it atomically. The cache SHALL carry a schema version and each stored observation's collection time and unknown reason. A missing, corrupt, unsupported-version, or unreadable cache SHALL be treated as no cache and SHALL NOT fail the Home open. The cache SHALL be disposable: removing it SHALL cost only a cold load and SHALL leave no other state behind.

#### Scenario: Cached board is reused

- **WHEN** a repository's board cache exists, is readable, and carries the supported schema version
- **THEN** Home can render from it without waiting for a fresh assembly

#### Scenario: Unreadable or corrupt cache is ignored

- **WHEN** the cache cannot be read or fails validation
- **THEN** Convoy ignores it and performs a fresh load, without reporting an error for the cache itself

#### Scenario: Newer schema is not interpreted

- **WHEN** the cache was written with a newer schema version than this build supports
- **THEN** it is ignored and a fresh load is performed

#### Scenario: Deleting the cache is safe

- **WHEN** the operator deletes the cached board
- **THEN** Home opens with a cold load and produces no error or repair prompt

### Requirement: Background refresh is continuous and fingerprint-gated

While a board surface is displayed, Convoy SHALL refresh it at a bounded cadence no slower than five seconds. Before recomputing, Convoy SHALL compare a cheap fingerprint of the repository — the Git worktree listing plus the change-relevant modification times of each checkout — and SHALL recompute only the parts whose fingerprint changed. A poll whose fingerprint is unchanged SHALL NOT invoke expensive readers, including the OpenSpec task query or a full run-history scan. Convoy SHALL also trigger a refresh immediately after returning from a destination or completing a mutating action.

#### Scenario: Idle poll avoids expensive work

- **WHEN** a scheduled refresh runs and the fingerprint is unchanged
- **THEN** no OpenSpec task query or full run-history read is issued

#### Scenario: A worktree created elsewhere appears

- **WHEN** a worktree is created in another Convoy window or outside Convoy
- **THEN** it appears in the open board within the refresh cadence

#### Scenario: Local changes edited elsewhere update

- **WHEN** a checkout's active changes or task files are edited outside the visible board
- **THEN** that checkout's rows update within the refresh cadence without recomputing unchanged checkouts

#### Scenario: Return triggers an immediate refresh

- **WHEN** the operator returns to Home from a destination or completes a mutating action
- **THEN** a refresh is triggered immediately rather than waiting for the next scheduled poll

### Requirement: Stale evidence is disclosed and never presented as current

The board SHALL expose the age of the displayed snapshot. Evidence older than the freshness bound, or left in place after a failed refresh, SHALL be marked as stale or aged rather than presented as a currently verified fact, and action eligibility SHALL be revalidated before any mutation. Cached unknown observations SHALL retain their reason. A failed refresh SHALL NOT discard the last usable snapshot; it SHALL retain it with its age and disclose that the refresh failed.

#### Scenario: Aged snapshot is marked

- **WHEN** the displayed snapshot is older than the freshness bound
- **THEN** its age is shown and its facts are not presented as currently verified

#### Scenario: Failed refresh keeps the last snapshot as stale

- **WHEN** a scheduled refresh fails to read Git or checkout evidence
- **THEN** the previous snapshot remains displayed with its age and the failure is disclosed, and no stale eligibility is treated as verified before a mutation

#### Scenario: Cached unknown stays unknown

- **WHEN** an observation was unknown with a reason when it was cached
- **THEN** it is rendered as unknown with that reason, not as a negative fact

### Requirement: Refresh in flight is indicated in the top-right corner

While a refresh is in flight, the board SHALL show a minimal indicator in the top-right corner of the screen. The indicator SHALL clear when the refresh settles and SHALL NOT displace the worktree list, its detail, or its actions; on narrow terminals it SHALL degrade without overflowing.

#### Scenario: Refresh in flight shows the indicator

- **WHEN** a refresh is running
- **THEN** a minimal indicator appears in the top-right corner

#### Scenario: Indicator clears on settle

- **WHEN** the refresh completes or fails
- **THEN** the indicator clears

#### Scenario: Narrow terminal keeps the board usable

- **WHEN** the terminal is too narrow for the full indicator
- **THEN** the board content is not displaced or overflowed
