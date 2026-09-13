## MODIFIED Requirements

### Requirement: Successful runs attempt finalization automatically

Every newly executed logical run SHALL include one `Compact run` lifecycle row, outside configurable pipeline steps. It SHALL attempt compaction after successful phase execution and any goal-state settlement, and before the run's success post-hook lifecycle, so post-hooks act on the compacted result. It MUST NOT require message confirmation, an editor, or a manual finish action. Configuration and step filters MUST NOT add, remove, select, or repeat this lifecycle operation. Goal fragments SHALL remain one logical run and SHALL NOT finalize separately. Failed or aborted execution SHALL NOT trigger compaction, and failure post-hooks SHALL still run for a failed execution without a preceding compaction. A normal goal stop below target SHALL retain its existing pipeline-success semantics. A fatal success-hook failure that occurs after compaction SHALL NOT undo the compacted commit or the recorded finalization outcome.

#### Scenario: Successful writable pipeline

- **WHEN** a pipeline finishes successfully with eligible current-run commits and success post-hooks are configured
- **THEN** its lifecycle row compacts those commits and displays the resulting commit before the success post-hooks run

#### Scenario: Compaction precedes success post-hooks

- **WHEN** a successful run configures success post-hooks that push the branch or open a pull request
- **THEN** compaction completes or records its own refusal before those hooks run, so a hook that publishes reflects the compacted run rather than un-compacted history

#### Scenario: Goal settlement selects an earlier state

- **WHEN** a goal cycle restores its best measured state and completes normally below target
- **THEN** finalization runs once against the surviving final state, not against a discarded iteration, without changing the reported goal outcome

#### Scenario: Pipeline or fatal hook failure

- **WHEN** execution is aborted or a pipeline phase fails
- **THEN** automatic compaction does not execute and intermediate work remains available for recovery

#### Scenario: Success hook fails after compaction

- **WHEN** a fatal success post-hook fails after compaction completed
- **THEN** the run is reported failed with that hook's error while the compacted commit and the recorded finalization outcome remain in place

### Requirement: Dashboard phase lists follow execution order

Every dashboard phase list — a live run's initial list, a following dashboard grown additively while a goal cycle adds invocation rows, and a reconstructed or historical view — SHALL contain a row for every planned pre-hook and post-hook from before those hooks execute, and SHALL order rows by execution: pre-hook rows, pipeline step rows, goal invocation groups, the `Compact run` lifecycle row, then post-hook rows. The terminal row of the list SHALL be the last post-hook row, or the `Compact run` row when the run has no post-hooks. A live merge that appends previously unknown rows MUST NOT leave a row above a row that executes before it. Hook rows SHALL be delivered the same phase lifecycle and activity events as step rows so a hook's start, output, and outcome render in place. Upholding the invariant MUST NOT require rebuilding the dashboard, dropping row state, or re-running phases, and the `Compact run` row's position MUST NOT imply any execution-order relationship with the goal cycle: it is the run's compaction epilogue regardless of where the rows render.

#### Scenario: Live dashboard shows planned hooks before they run

- **WHEN** a run that configures pre-hooks and post-hooks starts and its dashboard attaches
- **THEN** every hook row is present as pending, in execution order, before the corresponding hook runs

#### Scenario: Post-hooks render after compaction

- **WHEN** a successful run's `Compact run` row reaches an outcome and its success post-hooks then run
- **THEN** the post-hook rows render after the `Compact run` row and transition in place as those hooks run

#### Scenario: Live dashboard grows during a goal cycle

- **WHEN** a dashboard is following a live goal run and the scheduler's next invocation's rows arrive through the additive sync
- **THEN** the merged phase list keeps goal invocation rows above the `Compact run` row and keeps post-hook rows after it, and the pending lifecycle row never sits above a row that executes before it

#### Scenario: Mid-cycle attach shows the row terminal

- **WHEN** a dashboard attaches to a goal run that is mid-cycle and reconstructs its phase list from durable state
- **THEN** the reconstructed list includes the planned hook rows in execution order and closes with the post-hook rows

#### Scenario: Compaction starts on a grown dashboard

- **WHEN** finalization starts on a run whose dashboard grew goal invocation rows while following it
- **THEN** the `Compact run` row transitions to running and then to its outcome in place, and the post-hook rows transition after it

## RENAMED Requirements

- FROM: `### Requirement: The terminal lifecycle row closes every dashboard phase list`
- TO: `### Requirement: Dashboard phase lists follow execution order`

## ADDED Requirements

### Requirement: Hook phase outcomes and captured output are durable

When a hook finishes, its phase's terminal status, duration, and a bounded tail of its captured stdout and stderr SHALL be persisted into the run's durable state, so a completion screen, an attach, and a historical view show the same hook outcome and output the live feed showed. The retained tail SHALL keep the most recent bounded lines. A failure to persist the hook's outcome or output MUST NOT fail the hook or the run; the hook's own exit status SHALL still govern hook failure, and the persistence failure SHALL be disclosed.

#### Scenario: Completed run reopened

- **WHEN** a run whose post-hook opened a pull request is reopened after its coordinator exits
- **THEN** the post-hook row shows it completed and its retained output tail, including the pull request URL the hook printed

#### Scenario: Output tail is bounded

- **WHEN** a hook prints more output than the retained bound
- **THEN** the stored tail keeps the most recent bounded lines for the row

#### Scenario: Persistence fails

- **WHEN** storing a hook's outcome or output fails
- **THEN** the hook's exit status still governs the run and the persistence failure is disclosed rather than silently dropping the record

### Requirement: Post-hooks receive the compaction outcome

Success post-hooks SHALL receive the run's compaction outcome in their execution context: the finalization state, and when compaction produced a commit, its OID and subject. A hook MUST be able to detect that compaction did not complete and adapt or skip its own work without re-deriving the state from the repository or the run directory.

#### Scenario: Hook sees a completed compaction

- **WHEN** a success post-hook runs after compaction produced a commit
- **THEN** it can observe the completed state and the produced commit's OID and subject

#### Scenario: Hook sees a blocked compaction

- **WHEN** a success post-hook runs after compaction was blocked or failed with history intact
- **THEN** it can observe that non-completed state and the recorded reason, so it can decide whether to proceed

### Requirement: Automatic compaction retries transient failures with bounded exponential backoff

Before recording a terminal `blocked` or `failed` compaction outcome, Convoy SHALL retry an attempt whose failure is transient or uncertain — remote publication probes that time out or fail at the transport, authentication, or lookup level, and any other failure that does not itself establish that history must not be rewritten — using a bounded exponential backoff with a default of three retries after the initial attempt. Retries SHALL revalidate current facts and SHALL reconcile any durable transaction journal before any mutation, and SHALL never duplicate or discard work. Definite safety refusals — a replacement commit advertised by a remote, a dirty tree, missing boundary or recovery evidence, a lease conflict, or a transaction whose safety cannot be reconciled — SHALL NOT be retried and SHALL be reported immediately. Retry exhaustion SHALL produce the same terminal outcome and guidance a single failed attempt would have produced and SHALL NOT change the run's pipeline success.

#### Scenario: Transient probe succeeds on retry

- **WHEN** the publication probe fails transiently on the first attempt and succeeds on a later attempt
- **THEN** compaction proceeds without operator action and the retry is observable in the run's output

#### Scenario: Published replacement commit

- **WHEN** a commit to be replaced is advertised by a remote branch
- **THEN** compaction is blocked immediately without retrying

#### Scenario: Retry exhaustion

- **WHEN** every attempt fails transiently
- **THEN** finalization records the terminal outcome after the bounded attempts, leaves history unchanged, and the run remains execution-successful

#### Scenario: Retry after a partial attempt

- **WHEN** a previous attempt stopped mid-transaction and a retry begins
- **THEN** the durable transaction journal is reconciled before any new mutation and no work is duplicated or discarded
