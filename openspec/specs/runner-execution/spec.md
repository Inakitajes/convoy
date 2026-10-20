# runner-execution Specification

## Purpose
Let Convoy execute and recover pipelines through independently usable harnesses while preserving shared scheduling, lifecycle, and repository guarantees.

## Requirements

### Requirement: A selected runner is independently usable

Convoy SHALL support OpenCode v2 and Claude as independent runners for pipeline execution and associated helpers. A Claude-only plan SHALL NOT require an OpenCode installation, server, credentials, or model catalog. Runner selection SHALL NOT alter the pipeline's report, quality, Git, or OpenSpec contracts.

#### Scenario: Claude-only workstation
- **WHEN** an operator launches a Claude-only pipeline with Claude-routed helpers and OpenCode is absent
- **THEN** preflight, execution, reports, quality loops, human iteration, and finalization work without attempting to start OpenCode

#### Scenario: Unsupported OpenCode version
- **WHEN** a selected OpenCode execution uses a v1 or otherwise unsupported CLI/API combination
- **THEN** preflight identifies the incompatible version and remediation before submitting a prompt or granting write access

### Requirement: Both runners execute the full pipeline step set

Convoy SHALL support writable implementation, read-only review, controlled verification, scoring, consensus, and bounded improvement steps with either runner on supported installations. Eligibility SHALL depend on the required behavior and effective capabilities, not a hardcoded restriction that Claude is read-only.

#### Scenario: Claude full cycle
- **WHEN** a Claude-only full-cycle pipeline runs with appropriate permissions
- **THEN** it implements, audits, executes checks, scores, and performs bounded corrections under the same acceptance rules as OpenCode

### Requirement: Parallel scheduling is independent of the harness

Convoy SHALL schedule parallel nodes and model fan-out for either runner and mixed-runner pipelines, respecting dependencies, concurrency limits, budgets, and existing writer coordination. Each attempt SHALL have independent identity and outputs. Parallelism SHALL NOT implicitly authorize conflicting writes to one checkout.

#### Scenario: Mixed parallel review
- **WHEN** two Claude reviewers and one OpenCode reviewer share a parallel group
- **THEN** they execute within the configured concurrency bound with separately attributed sessions and reports, and dependent consensus waits for the required outcomes

#### Scenario: Concurrent writes conflict
- **WHEN** parallel attempts would acquire incompatible write authority in the same checkout
- **THEN** the existing writer policy serializes or refuses them rather than permitting a conflict because the runners differ

### Requirement: Models and helpers resolve before execution

Convoy SHALL resolve runner-qualified models, variants or effort, authentication modes, and helper routes across the complete plan, including goal subflows and advisors. Unsupported selections SHALL fail before affected work starts. Global overrides SHALL have explicit runner scope. Deterministic operations SHALL NOT gain mandatory model dependencies.

#### Scenario: Claude fan-out and scoped override
- **WHEN** a plan fans out over supported Claude models and supplies a Claude-scoped model override
- **THEN** review shows the effective Claude models without replacing any OpenCode model or silently ignoring an incompatible selection

#### Scenario: Missing helper dependency in a goal fragment
- **WHEN** a later goal fragment requires a runner, judge, or advisor unavailable on this installation
- **THEN** initial plan preflight reports that dependency rather than discovering it after earlier steps have changed the repository

#### Scenario: Naming and commit helpers without OpenCode
- **WHEN** an operator uses Claude-only helper routes for branch naming or commit composition
- **THEN** those helpers use the reviewed route or an existing documented deterministic fallback, while run-title generation remains deterministic

### Requirement: Effective capabilities are truthful and actionable

Convoy SHALL disclose effective capabilities by runner, version, authentication mode, and policy in validation, configuration, launch review, and interaction controls. Required unavailable capabilities SHALL block execution with a reason and remedy. Lack of implementation SHALL NOT be represented as proof that the harness cannot support a feature.

#### Scenario: Capability needs API billing
- **WHEN** a requested feature is verified only for API-key mode but the plan selects subscription mode
- **THEN** preflight identifies the specific feature and API-key requirement without switching modes or silently omitting it

#### Scenario: Native attachment unavailable
- **WHEN** the selected execution transport cannot safely attach a native terminal client to a live attempt
- **THEN** Convoy still offers live dashboard observation and explains the available safe handoff or post-exit resume instead of labeling those actions as live attach

### Requirement: Attempts preserve exact provenance and recovery identity

Convoy SHALL persist each attempt's runner, authentication mode without secrets, model, native session reference, checkout, and execution identity. Recovery SHALL distinguish continuing an exact session, starting a new attempt, and reopening history. It SHALL NOT replay uncertain writes or silently substitute another harness, session, or billing mode.

#### Scenario: Resume interrupted mixed run
- **WHEN** an operator resumes a run with completed Claude steps and an interrupted OpenCode step
- **THEN** completed results remain intact and recovery reconciles the interrupted step's recorded execution and Git effects before continuing or explicitly starting a new attempt

#### Scenario: Legacy metadata lacks new provenance
- **WHEN** an older run is opened
- **THEN** its history stays readable using its original runner evidence and field meanings, with unavailable or ambiguous resume reported rather than guessed

### Requirement: Execution resources have bounded attributable ownership

Each adapter SHALL retain ownership of resources it creates through startup, execution, cancellation, and observed release. Shutdown and orphan recovery SHALL be bounded, identity-checked, idempotent, and secret-free. A PID, port, or process name alone SHALL NOT authorize termination. The existing OpenCode server lifecycle guarantees SHALL remain effective.

#### Scenario: Claude child stalls during abort
- **WHEN** cancellation of an owned Claude process does not complete within the shutdown budget
- **THEN** Convoy attempts bounded escalation against verified owned resources and records confirmed exit or unresolved termination without hanging or killing unrelated sessions

#### Scenario: Cancellation wins startup race
- **WHEN** cancellation arrives while a runner child or bridge is starting
- **THEN** Convoy retains cleanup ownership and never exposes an executable handle after cancellation has won

#### Scenario: Stale identity during orphan recovery
- **WHEN** a recorded child PID has been reused or its ownership evidence is incomplete
- **THEN** reconciliation preserves diagnostic evidence and does not signal the process

### Requirement: View lifetime is separate from execution lifetime

Detaching a dashboard SHALL NOT cancel active execution, settle pending decisions, or release writer authority. Explicit stop SHALL cancel the selected work before releasing owned resources. Finished-run holds SHALL follow the current controller lease; releasing a hold SHALL NOT stop independent authoring sessions or borrowed services.

#### Scenario: Mixed run continues without a dashboard
- **WHEN** the controlling dashboard disconnects while Claude and OpenCode steps run or wait for permission
- **THEN** the coordinator preserves their execution, decisions, and writer claims for reattachment

#### Scenario: Finished hold expires
- **WHEN** a completed run loses its controlling client and the existing controller lease expires
- **THEN** Convoy releases the hold within the existing lease timing contract and performs bounded owned-resource cleanup without touching independent conversations
