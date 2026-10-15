# Spec Delta

## Purpose

Unify Convoy's runner integration on one port that can carry the optional services an attempt needs — progress, approvals, deliverables, advisor consultation, and loop signals — so any harness integrates the same way and support is declared by capability rather than by which engine path runs.

## ADDED Requirements

### Requirement: The runner port can carry Convoy's optional services

An execution attempt SHALL be able to receive Convoy's optional per-attempt services — a progress sink, an approval channel, a deliverable/report contract, an advisor consultation, and loop-guard signals — in addition to its prompt and cancellation. Services SHALL be optional so a runner that does not implement one SHALL NOT be asked to.

#### Scenario: A runner that implements no services still runs

- **WHEN** an attempt runs on a runner that advertises none of the optional services
- **THEN** it executes with its prompt and cancellation only, and no service call is attempted

#### Scenario: A runner that implements a service receives it

- **WHEN** an attempt runs with an advisor configured on a runner that implements advisor consultation
- **THEN** the adapter is given the advisor service and consults it at the configured decision points

### Requirement: Support is declared by capability and validated before execution

Convoy SHALL resolve each runner's effective capabilities and SHALL refuse, before any writable work, a plan that requires an optional service the selected runner does not implement. A refusal SHALL name the missing service and the runner rather than silently dropping the feature.

#### Scenario: A plan needs an unimplemented service

- **WHEN** a step requires structured reports and the runner does not implement the deliverable service
- **THEN** preflight refuses with a reason naming the runner and the service

#### Scenario: A capable runner is accepted

- **WHEN** the runner implements the required services
- **THEN** execution proceeds and the services are delivered to the adapter

### Requirement: The engine drives every runner through the port

Core execution SHALL start attempts only through the runner port. An adapter SHALL own its harness specifics — protocol, sessions, event decoding, permission interception, process ownership — and SHALL NOT require core to branch on the harness.

#### Scenario: Adding a harness needs no core branch

- **WHEN** a new harness adapter is registered
- **THEN** it runs through the same attempt path as the others without a new harness-specific branch in core

#### Scenario: Ownership is unchanged by the port

- **WHEN** an adapter owns a child process or server
- **THEN** it keeps the existing bounded ownership and shutdown guarantees, and the port does not take them over

### Requirement: Existing runner behaviour is preserved

Migrating a runner onto the shared port SHALL NOT remove or weaken its existing behaviour: reports, advisor consultation, loop guard, approvals, live transcripts, resume, and the ownership lifecycle SHALL keep working for the runners that had them.

#### Scenario: A previously rich runner keeps its features

- **WHEN** a runner that already supported reports, advisor, loop guard, and approvals is migrated to the port
- **THEN** the same features remain available and the behaviour suite stays green

#### Scenario: Migration is incremental

- **WHEN** runners are migrated one at a time
- **THEN** unmigrated runners keep their current path until their turn, and the suite passes at each step
