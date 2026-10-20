# runner-deliverables Specification

## Purpose
Give every supported runner the same validated reporting and quality-contract behavior without making successful delivery depend on one harness's custom-tool API.

## Requirements

### Requirement: Both runners submit the same deliverable contracts

Claude and OpenCode steps SHALL submit Markdown reports, structured scores, and optional structured commit descriptions through equivalent validated contracts. Convoy SHALL select authoritative destinations and attempt identity. Agent-supplied paths or metadata SHALL NOT redirect outputs to another attempt or override run provenance.

#### Scenario: Writable Claude report
- **WHEN** a Claude implementation step submits a valid report and commit description
- **THEN** Convoy persists and validates them using the same rules and commit-message precedence as an OpenCode step

#### Scenario: Foreign report submission
- **WHEN** a tool call attempts to submit a report for a sibling attempt or an arbitrary path
- **THEN** Convoy rejects the submission without replacing that attempt's accepted artifacts

### Requirement: Delivery validation controls phase completion

A runner's successful process exit or idle event SHALL NOT imply a valid Convoy deliverable. Convoy SHALL validate the selected contract, support bounded correction through either runner, and preserve the last valid candidate when a malformed replacement arrives. Required reporting bridges SHALL be ready before affected execution starts.

#### Scenario: Claude returns malformed score
- **WHEN** Claude finishes successfully but its score violates the contract
- **THEN** Convoy requests bounded correction or fails the phase rather than advancing consensus on invalid data

#### Scenario: Report corrected before completion
- **WHEN** either runner corrects an invalid submission within the configured correction bound
- **THEN** the corrected artifact is accepted exactly once and normal phase completion proceeds

### Requirement: Deliverables survive interruption without fabricated success

Accepted deliverables and commit descriptions SHALL remain correlated to their original attempt across interruption and recovery. Repeated submission or recovery SHALL NOT duplicate commits or silently attribute an old report to a new attempt. Missing reports SHALL retain the existing explicit fallback or failure behavior for the selected contract.

#### Scenario: Crash after report acceptance
- **WHEN** Convoy stops after accepting a Claude report but before committing changes
- **THEN** recovery can reuse the accepted metadata after reconciling Git state, without rerunning the write step merely to obtain the report
