# Spec Delta

## Purpose

Give every harness one rich, vendor-independent integration contract for execution, observations, sessions, lifecycle and optional Convoy services. Preserve supported behavior while expressing differences through effective capabilities rather than harness-specific orchestration paths.

## ADDED Requirements

### Requirement: The common harness contract is rich and vendor-independent

Convoy SHALL express execution context, observations, outcomes, session references, lifecycle controls and optional services in a common integration vocabulary independent of vendor SDKs. The contract SHALL allow Convoy domain concepts without requiring every harness to implement every capability. No harness SHALL require a separate privileged integration contract.

#### Scenario: A rich harness uses the common contract

- **WHEN** a harness supports approvals, structured deliverables, advisor checkpoints and loop limits
- **THEN** all of those features are available through the common integration contract without a parallel harness-specific execution path

#### Scenario: Different mechanisms implement the same guarantee

- **WHEN** two harnesses honor the same service through different native tools, plugins or external bridges
- **THEN** Convoy can use the same service contract and validate the same required guarantee without receiving either harness's SDK objects

### Requirement: The runner port can carry Convoy's optional services

An execution attempt SHALL be able to receive optional approval, deliverable, advisor and loop-control services alongside its prompt, context and cancellation. Progress SHALL be observable through normalized events, independently of the user interface. Only supported services SHALL be supplied; omission of a service SHALL NOT bypass a plan requirement.

#### Scenario: A runner that implements no services still runs

- **WHEN** an attempt needs none of the optional services and runs on a runner that advertises none
- **THEN** it executes through the same contract with its required context, prompt and cancellation, and no optional service call is attempted

#### Scenario: A runner that implements a service receives it

- **WHEN** an attempt runs with an advisor configured on a runner that implements advisor consultation
- **THEN** the adapter is given the advisor service and consults it at the configured decision points

#### Scenario: Progress has multiple consumers

- **WHEN** a running attempt emits reasoning, response text, tool activity or usage
- **THEN** the dashboard and execution records can consume the same normalized observations without the harness depending on a dashboard implementation

### Requirement: Support is declared by capability and validated before execution

Convoy SHALL resolve effective capabilities for the selected runtime, authentication and enforcement readiness, and refuse a plan requiring unavailable behavior before executing its attempt. A refusal SHALL identify the runner, missing capability and reason rather than silently dropping a required service. A runtime bridge health failure SHALL prevent prompt admission.

#### Scenario: A plan needs an unimplemented service

- **WHEN** a step requires structured reports and the runner does not implement the deliverable service
- **THEN** preflight refuses with a reason naming the runner and the service

#### Scenario: A capable runner is accepted

- **WHEN** the runner implements the required services
- **THEN** execution proceeds and the services are delivered to the adapter

#### Scenario: Enforcement is not ready

- **WHEN** a runner ordinarily supports a required service but its required hook, plugin or permission bridge is missing or unhealthy
- **THEN** the attempt is refused before a prompt is admitted, with an explanation of the missing enforcement

### Requirement: Capability support preserves the requested semantics

Convoy SHALL distinguish available, restricted and unavailable capabilities with their effective semantics. Native and bridged implementations SHALL qualify only when they honor the requested guarantee. A weaker observation, post-exit action or fallback SHALL NOT be advertised as an equivalent blocking or live-control capability.

#### Scenario: An advisor cannot block the first write

- **WHEN** a plan requires advisor approval before writing but a harness can only consult after completion
- **THEN** the plan is refused for that harness rather than treating the post-completion consultation as equivalent

#### Scenario: Resume is available but native live attachment is not

- **WHEN** a harness supports reopening an exited session but cannot attach a native client to a running attempt
- **THEN** Convoy exposes post-exit resume without claiming native live attachment

### Requirement: Approval and advisor checkpoints remain authoritative

For supported capabilities, Convoy SHALL apply hard policy denials and required advisor checkpoints before permitting the protected action. Ask-level requests SHALL follow the selected approval policy and settle for the requesting attempt. Advisor consultation SHALL preserve configured limits, completion checkpoints and separately attributable usage.

#### Scenario: Auto-accept cannot bypass a protected write

- **WHEN** auto-accept is selected and a write violates a hard denial or an unsatisfied required advisor checkpoint
- **THEN** the write remains blocked regardless of the harness's native approval defaults

#### Scenario: Parallel attempts wait for different decisions

- **WHEN** two attempts have pending permission requests and one is cancelled or handed to an interactive client
- **THEN** only that attempt's pending decisions are cancelled or transferred, without answering or pausing the sibling's requests

#### Scenario: Completion consultation requests a correction

- **WHEN** a supported advisor completion checkpoint requests another turn
- **THEN** the correction runs in the intended session under the same attempt limits, with advisor usage distinguishable from executor usage

### Requirement: Structured deliverables retain validation and attempt ownership

Supported deliverable services SHALL preserve report, score and structured commit-description validation, accepted-candidate precedence and recovery metadata. Invalid submissions SHALL NOT replace the last valid candidate. Submissions SHALL remain associated with their exact attempt and session, including supported human iteration, and SHALL be rejected after those handles are released.

#### Scenario: A malformed submission follows an accepted report

- **WHEN** an attempt submits an invalid score or structured commit description after a valid report was accepted
- **THEN** validation returns a correction error and preserves the last valid candidate and its accepted metadata

#### Scenario: A human gate keeps the current report handle alive

- **WHEN** a supported session is idle but remains available for human iteration at the phase gate
- **THEN** a valid report from that session can still be accepted until the gate resolves and releases its handles

#### Scenario: An old session submits after a retry

- **WHEN** a released session submits a report after a new attempt has begun
- **THEN** its submission cannot replace or mutate the new attempt's deliverable

### Requirement: Loop and budget services can control execution

A runner advertising loop control SHALL provide the observations needed for its declared limits and honor resulting nudge or stop decisions. Repeated-call, tool-failure, step and cost detection SHALL retain their supported semantics across follow-up turns. Resetting a renewable step allowance SHALL NOT erase retained cost or repetition history.

#### Scenario: Repeated calls trip the guard

- **WHEN** correlated tool calls with the same effective arguments reach the configured repetition limit
- **THEN** the affected attempt stops and reports the limit decision rather than merely logging an observation or reporting successful completion

#### Scenario: Follow-up turns refresh cumulative usage

- **WHEN** execution continues in the same attempt and the harness reports cumulative or updated usage
- **THEN** limits account for usage without double-counting earlier observations or losing earlier spend

#### Scenario: A step-budget reset does not reset the cost fuse

- **WHEN** an operator grants another step allowance through the existing budget gate
- **THEN** execution retains the cost and other non-renewable guard history required by the configured limits

### Requirement: The engine drives every runner through the port

Core execution SHALL start attempts only through the runner port. An adapter SHALL own its harness specifics — protocol, sessions, event decoding, permission interception, process ownership — and SHALL NOT require core to branch on the harness.

#### Scenario: Adding a harness needs no core branch

- **WHEN** a new harness adapter is registered
- **THEN** it runs through the same attempt path as the others without a new harness-specific branch in core

#### Scenario: Ownership is unchanged by the port

- **WHEN** an adapter owns a child process or server
- **THEN** it keeps the existing bounded ownership and shutdown guarantees, and the port does not take them over

### Requirement: Session controls and runtime release use the common integration

Convoy SHALL request supported session history, reopen, continuation and control transitions through capability-gated operations using exact runner-qualified references. Every runner SHALL provide cancellation and owned-runtime release through the common lifecycle contract. Detaching a view, reaching idle or accepting a cancellation request SHALL NOT alone prove execution or process termination.

#### Scenario: A phase gate reopens a recorded session

- **WHEN** an operator chooses a supported reopen or continuation action
- **THEN** Convoy uses the exact recorded session and verified checkout without selecting a harness-specific orchestration path or an unrelated recent session

#### Scenario: A late observer requests history

- **WHEN** a runner supports history reconstruction for a recorded session
- **THEN** Convoy receives normalized transcript observations that merge with the live stream without duplication or invented missing history

#### Scenario: Cancellation races with startup

- **WHEN** an abort arrives while an adapter is starting its owned runtime
- **THEN** the adapter retains cleanup ownership and reports a bounded observed or explicitly unresolved outcome without losing track of the spawned process

#### Scenario: Run cleanup coexists with an independent conversation

- **WHEN** Convoy releases a run's owned runtime while an independent conversation exists
- **THEN** cleanup preserves the independent conversation's required services and session identity

### Requirement: Existing runner behaviour is preserved

Migrating a runner onto the shared port SHALL NOT remove or weaken its existing behaviour: reports, advisor consultation, loop guard, approvals, live transcripts, resume, and the ownership lifecycle SHALL keep working for the runners that had them.

#### Scenario: A previously rich runner keeps its features

- **WHEN** a runner that already supported reports, advisor, loop guard, and approvals is migrated to the port
- **THEN** the same features remain available and the behaviour suite stays green

#### Scenario: A runner lacks a capability another runner supports

- **WHEN** a plan does not require that capability and the selected runner lacks it
- **THEN** the runner still executes through the same integration system without a second category of runner or a silent promise of feature parity

#### Scenario: Migration is incremental

- **WHEN** runners are migrated one at a time
- **THEN** unmigrated runners may keep their current path temporarily and the suite passes at each step, but the change is not complete until all built-in runners use the common integration and the superseded paths are removed
