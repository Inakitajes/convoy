## ADDED Requirements

### Requirement: Board assembly avoids work whose inputs did not change

The board SHALL derive evidence with work bounded by what actually changed. It SHALL NOT invoke the OpenSpec task query for a checkout whose active-change set is empty, SHALL serve a checkout's task counts without re-querying while that checkout's change content is unchanged, SHALL read the shared run history at most once per refresh cycle, and SHALL observe registered checkouts concurrently under a bounded limit. Evidence whose inputs changed SHALL be recomputed; evidence whose inputs did not SHALL not be.

#### Scenario: Empty change set skips the task query

- **WHEN** a checkout has no active changes
- **THEN** no OpenSpec task query is issued for that checkout

#### Scenario: Unchanged tasks reuse the last counts

- **WHEN** a checkout's change content is unchanged since the previous cycle
- **THEN** its task counts are served without re-running the OpenSpec task query

#### Scenario: One run-history read per cycle

- **WHEN** the board refreshes with several registered checkouts
- **THEN** the shared run history is read once for the cycle rather than once per checkout

#### Scenario: Many checkouts are observed concurrently

- **WHEN** many checkouts are registered
- **THEN** they are observed concurrently under a bounded limit, each reporting its own independent facts

## MODIFIED Requirements

### Requirement: Board assessment can be refreshed without changing selection identity

The board SHALL provide an explicit refresh action, refresh after returning from contextual operations, and invalidate cached artifact and observation data together. While a board is displayed, it SHALL also continue refreshing at the bounded background cadence, rendering the last cached board before a fresh observation completes. Selection SHALL remain attached to the selected verified Git checkout and local artifact source rather than list position or a globally deduplicated change id. If the selected checkout disappears or its continuity cannot be verified, the board SHALL return to the inventory with an explanation rather than choosing another execution target. A failed refresh SHALL disclose unavailable or stale evidence and SHALL NOT present stale action eligibility as a current verified fact. Refresh and navigation SHALL NOT create persistent worktree identities, ownership manifests, or completed-work records.

#### Scenario: External archive becomes visible

- **WHEN** the operator archives a selected local change outside Convoy and refreshes the board
- **THEN** the same verified worktree remains selected, its active children update, and the archive is available locally on demand without a lifecycle summary

#### Scenario: External move remains discoverable

- **WHEN** Git reports a worktree at a new location after `git worktree move`
- **THEN** the inventory shows the current location without a bind operation and preserves the prior selection only if continuity can be verified

#### Scenario: Refresh fails

- **WHEN** a refresh cannot read Git or artifact evidence needed for an action
- **THEN** the board marks that evidence unavailable or stale and the shared action guard supplies the corresponding reason instead of reusing stale permission to mutate

### Requirement: Worktree rows expose independent observations

Each worktree SHALL expose independently observed Git dirt, ahead/behind relative to the explicitly selected base, ahead/behind relative to its upstream, execution activity, and the managed writer holding the checkout's writer claim (kind, owner, and liveness). Pull request facts SHALL be observed on demand when the operator's selection lands on a worktree row or opens that row's detail — cached, bounded, and refreshed on each landing or detail open — rather than eagerly for every row or on every background cycle; rows not yet selected SHALL disclose no PR facts. PR observations SHALL disclose number, title, URL, and state when known, with known, unknown, or ambiguous availability; unavailable evidence SHALL NOT imply no PR or a merged PR. Base and upstream comparisons SHALL remain distinct, identify their comparison refs, and disclose unknown results when unavailable. Task counts SHALL report known done/total or unknown without inventing counts. Runs and conversations SHALL show actual activity separately from client attachment, and the managed writer claim SHALL be reported independently of that activity, with live, uncertain, and stale liveness distinguished (an unreadable or newer-schema record is unknown, never free). These facts SHALL NOT collapse into lifecycle stages, ownership assertions, integrated/completed summaries, or task-count stage gates. Home, the board, and detail menus SHALL consume the same per-action guards and disclose blockers and remediation; handlers SHALL revalidate those guards before mutation.

#### Scenario: Tasks are complete while execution remains active

- **WHEN** local tasks are complete but a managed writer remains active
- **THEN** the row reports both facts independently and actions conflicting with that writer show the same reason in Home and the board rather than enabling close from task counts

#### Scenario: Base and upstream differ

- **WHEN** a branch is ahead of its upstream but behind its selected base
- **THEN** both comparisons are shown independently with their refs and neither is replaced by a single synchronization status

#### Scenario: PR observation is unavailable

- **WHEN** Git is readable but the PR provider cannot be queried
- **THEN** Git facts remain available and PR facts are reported unknown with their reason, not as absent or merged

#### Scenario: PR facts refresh on landing and detail

- **WHEN** the operator lands on a worktree row or opens its detail
- **THEN** that row's PR facts are observed on demand and cached, and rows the operator has not selected request no PR facts
