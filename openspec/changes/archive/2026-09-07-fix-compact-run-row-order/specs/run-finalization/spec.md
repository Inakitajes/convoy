## ADDED Requirements

### Requirement: The terminal lifecycle row closes every dashboard phase list

Every dashboard phase list — a live run's initial list, a following dashboard grown additively while a goal cycle adds invocation rows, and a reconstructed or historical view — SHALL order the `Compact run` lifecycle row last, after the pipeline prefix rows, hook rows, and every goal invocation group. A live merge that appends previously unknown rows MUST NOT leave the lifecycle row above any row appended after it. Upholding the invariant MUST NOT require rebuilding the dashboard, dropping row state, or re-running phases, and the lifecycle row's position MUST NOT imply any execution-order relationship with the goal cycle: it is the run epilogue regardless of where the rows render.

#### Scenario: Live dashboard grows during a goal cycle

- **WHEN** a dashboard is following a live goal run and the scheduler's next invocation's rows arrive through the additive sync
- **THEN** the merged phase list still ends with the `Compact run` row, the goal invocation rows render above it, and the pending lifecycle row never sits above a goal invocation row

#### Scenario: Mid-cycle attach shows the row terminal

- **WHEN** a dashboard attaches to a goal run that is mid-cycle and reconstructs its phase list from durable state
- **THEN** the reconstructed list closes with the `Compact run` row after every recorded and in-flight goal invocation row

#### Scenario: Compaction starts on a grown dashboard

- **WHEN** finalization starts on a run whose dashboard grew goal invocation rows while following it
- **THEN** the `Compact run` row transitions to running and then to its outcome in place at the terminal position of the phase list
