## Purpose

Prevent abandoned Convoy-owned OpenCode servers from accumulating while preserving deliberate background execution and independent conversations. Make shutdown and orphan recovery bounded, attributable, and truthful about uncertain process state.

## ADDED Requirements

### Requirement: Managed servers have explicit lifetime ownership

Convoy SHALL distinguish run-owned servers, short-lived helper servers, and independently persistent authoring services. For newly launched run/helper servers it SHALL retain the actual child process identity, owner process identity, lifetime class, and lifecycle state independently of disposable run workspaces. A PID alone, process name, parent PID of 1, or answering network port SHALL NOT authorize termination. Existing coordinator identity fields SHALL retain their historical interpretation.

#### Scenario: Run server and coordinator are different processes
- **WHEN** a coordinator launches a run server
- **THEN** lifecycle evidence distinguishes the two process incarnations and can identify the child after the coordinator exits without reinterpreting historical coordinator PID fields

#### Scenario: Helper startup cannot establish recoverable ownership
- **WHEN** a helper child starts but its required ownership evidence cannot be persisted
- **THEN** Convoy refuses to expose the helper as ready, attempts bounded cleanup through its owned child handle, and reports any unresolved outcome

#### Scenario: A temporary authoring helper would start independent execution
- **WHEN** a proposal fallback intends to invoke an authoring command on a temporary server
- **THEN** Convoy first transfers that server to verified independent service ownership or reuses such a service and stops the unused helper; if neither is safe it refuses command execution and cleans up the temporary server

### Requirement: Managed shutdown observes termination within bounded waits

Convoy SHALL attempt graceful termination of run/helper servers when their owning operation ends, escalate to forced termination after a finite grace period, and await an observed outcome within a finite total shutdown budget. A successful signal submission SHALL NOT be reported as confirmed termination. Concurrent or repeated stop requests SHALL share one lifecycle outcome. Confirmed disappearance SHALL be treated as already stopped; inability to confirm termination SHALL retain diagnostic evidence rather than wait forever or claim success.

#### Scenario: Helper completes normally
- **WHEN** a short-lived provider, naming, or conversation helper completes its operation
- **THEN** its caller waits for bounded server cleanup before returning, without closing an injected independently owned service

#### Scenario: Helper operation times out
- **WHEN** an outer timeout ends a helper operation while its request remains pending
- **THEN** the timeout path cancels the operation and waits for the bounded owned-server stop outcome before returning, without waiting indefinitely for the original request to settle

#### Scenario: Server ignores graceful termination
- **WHEN** a managed server remains alive beyond the graceful-stop deadline
- **THEN** Convoy attempts forced termination, observes the result within the remaining budget, and reports whether it stopped or remains unresolved

#### Scenario: Multiple callers request stop
- **WHEN** normal release and an interrupt request cleanup concurrently
- **THEN** cleanup is idempotent and neither caller repeats destructive effects against a later process incarnation

### Requirement: Startup failures retain shutdown ownership

Convoy SHALL apply the same bounded cleanup guarantees from child creation through readiness, including boot timeout, spawn error, early exit, malformed readiness output, cancellation, and failure to construct a client after server readiness. It SHALL drain child output without unbounded diagnostic accumulation and SHALL NOT hand out a successful server connection after cancellation has won.

#### Scenario: Cancellation races with readiness
- **WHEN** an abort arrives while a child is starting or emitting its readiness URL
- **THEN** Convoy either exposes a live owned handle before cancellation takes effect or completes bounded cancellation cleanup; it never loses ownership of the spawned child

#### Scenario: Startup fails after spawning
- **WHEN** a child never reports a valid readiness URL or client creation fails after readiness
- **THEN** Convoy reports startup failure only with a bounded cleanup outcome and retains evidence if the child could not be confirmed stopped

### Requirement: Interrupt protection spans the complete owned-server lifetime

For an explicit run abort, Convoy SHALL attempt bounded session cancellation followed by bounded server shutdown. Catchable process termination signals SHALL remain handled through boot, execution, terminal hold, and final release. A repeated abort or the shutdown deadline SHALL accelerate termination of owned run/helper servers before Convoy exits, without indefinitely waiting for session APIs, metadata writes, or optional cleanup. Uncatchable termination SHALL be handled by subsequent orphan reconciliation rather than a promise of in-process cleanup.

#### Scenario: Session cancellation does not answer
- **WHEN** an explicitly aborted run's session-cancellation request hangs
- **THEN** Convoy proceeds to server termination within the shutdown budget instead of exiting while skipping that attempt

#### Scenario: Second interrupt or shutdown deadline
- **WHEN** a second abort arrives or graceful shutdown exhausts its budget
- **THEN** Convoy enters bounded forced server cleanup before exiting with the abort outcome, retaining unresolved process evidence if termination cannot be verified

#### Scenario: Signal during terminal hold or release
- **WHEN** the coordinator receives SIGTERM after execution finishes but before its owned server has stopped
- **THEN** it releases the terminal wait and performs bounded server cleanup rather than reverting to an unprotected immediate exit

### Requirement: Completed-run terminal holds follow controller lifetime

A completed or failed run awaiting only terminal-screen dismissal SHALL release that hold on valid controller departure or controller heartbeat expiry, and then perform normal run-owned server cleanup. Silent expiry SHALL be detected without requiring a new client request. A connected controller SHALL retain inspection access until dismissal, departure, expiry, or explicit abort. Controller replacement races SHALL NOT let an old controller's departure release a new live controller's hold.

#### Scenario: Controller explicitly leaves a finish screen
- **WHEN** the valid controlling client releases its claim while a completed run is waiting for dismissal
- **THEN** the terminal hold resolves and the coordinator shuts down its run server

#### Scenario: Controller disappears without goodbye
- **WHEN** the client dies during a terminal hold and sends no further requests
- **THEN** the coordinator detects expiry using the existing 15-second heartbeat lease, releases the hold within one additional second under normal scheduling, and begins bounded cleanup

#### Scenario: Controller replacement wins before expiry handling
- **WHEN** a new live controller acquires the slot before an old lease's expiry callback runs
- **THEN** the callback revalidates current ownership and does not dismiss the new controller's finish screen

#### Scenario: Departure and expiry coincide
- **WHEN** valid controller departure races with lease expiry for the same terminal hold
- **THEN** the hold resolves once and run-owned cleanup remains idempotent

### Requirement: Background execution and independent services remain protected

Controller departure or silence SHALL NOT abort an executing or paused run, answer/reject a permission or human gate, release an active writer claim, or terminate a required authoring service. Run/helper orphan recovery SHALL exclude independently persistent services and standalone OpenCode clients. Run history and stored-session reopening SHALL remain available after process cleanup under their existing contracts.

#### Scenario: Terminal closes during active or waiting execution
- **WHEN** the controlling view disappears while a run is executing, paused, or waiting for a permission or human decision
- **THEN** execution and pending decisions retain their existing background/reattach behavior and are not classified as abandoned solely from client absence

#### Scenario: Run cleanup coexists with authoring and standalone windows
- **WHEN** a run ends while independent authoring or standalone OpenCode clients exist
- **THEN** run cleanup leaves those services and clients untouched and does not invalidate durable session references

### Requirement: Orphan reconciliation is attributable and bounded

During subsequent managed-server startup, Convoy SHALL perform bounded reconciliation of its own recorded run/helper lifetimes. It SHALL terminate a recorded child only after independently confirming that its original owner incarnation is gone and that the target still matches its recorded child incarnation and expected executable role. It SHALL revalidate immediately before signaling, serialize concurrent attempts on the same record, and retain uncertain evidence. Failure of an HTTP probe SHALL NOT alone prevent cleanup when process ownership is independently verified, nor SHALL HTTP success substitute for that ownership. Recovery SHALL NOT discover kill targets by a global name, port, or PPID scan.

#### Scenario: Owner was killed uncatchably
- **WHEN** a later managed startup finds a recorded run/helper server with a provably dead original owner and matching child identity
- **THEN** it performs bounded server termination even if the server's HTTP endpoint no longer responds

#### Scenario: Owner is alive but no UI remains
- **WHEN** reconciliation finds the same live owner process for a detached run
- **THEN** it leaves the server untouched regardless of client count

#### Scenario: PID reuse or incomplete evidence
- **WHEN** a PID now belongs to a different incarnation, the record is legacy/incomplete, or a required identity probe is unavailable
- **THEN** Convoy does not signal that PID and reports a skipped or uncertain recovery outcome rather than guessing ownership

#### Scenario: Concurrent reconciliation
- **WHEN** two Convoy instances inspect the same orphan record
- **THEN** only one performs its destructive transition at a time and both respect refreshed identity and termination evidence

#### Scenario: Many records or slow probes
- **WHEN** recovery encounters more records than its bounded startup work budget permits
- **THEN** it preserves unprocessed records for subsequent passes without blocking startup indefinitely or repeatedly starving the same records

### Requirement: Cleanup evidence is truthful and privacy-conscious

Lifecycle diagnostics SHALL distinguish requested stop, graceful exit, forced exit, already gone, identity mismatch, and unresolved termination. Unresolved recovery evidence SHALL survive ordinary pending-launch and workspace cleanup. Confirmed-stop records SHALL be eligible for removal so successful lifetimes do not accumulate forever. Diagnostics SHALL NOT persist authentication tokens, full environment/configuration contents, or prompt transcripts. Existing records without child identity SHALL remain readable but SHALL NOT silently become automatic-kill authority.

#### Scenario: Termination cannot be confirmed
- **WHEN** the stop deadline expires without conclusive child-exit evidence
- **THEN** Convoy retains the relevant identity and bounded diagnostic reason and does not describe the process as successfully stopped

#### Scenario: Pending directory is swept
- **WHEN** a dead coordinator's disposable launch directory is removed
- **THEN** unresolved child lifecycle evidence remains available independently and immutable run history is not deleted by process recovery

#### Scenario: Legacy run is inspected
- **WHEN** historical metadata has only a coordinator PID and server URL
- **THEN** history remains readable, the legacy PID is not relabeled as the child, and automatic recovery does not target a process from that record
