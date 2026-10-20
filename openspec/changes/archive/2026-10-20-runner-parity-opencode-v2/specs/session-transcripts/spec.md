# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Sessions not watched from the start are reconstructed from the live server`
- TO: `### Requirement: Sessions not watched from the start are reconstructed from available history`

## MODIFIED Requirements

### Requirement: The session tab streams a watched phase live

While a phase's session is being watched, the session tab SHALL stream the model's verbatim reasoning when exposed by the harness and response text plus one-line tool and shell action markers as they arrive, tailing the newest content until the operator scrolls up. This SHALL apply to both Claude and OpenCode through the production coordinator/dashboard path without requiring native live-attach support. Unavailable content SHALL NOT be synthesized.

#### Scenario: Live stream renders as it arrives
- **WHEN** a watched step is streaming a response
- **THEN** the session tab shows the available reasoning and response text and tool markers as they arrive, without waiting for the step to complete

#### Scenario: Claude messages traverse the coordinator
- **WHEN** a Claude step emits text and tool events while a separate dashboard follows the coordinator
- **THEN** those events appear in that step's session tab without an OpenCode server URL or native Claude terminal attachment

### Requirement: Sessions not watched from the start are reconstructed from available history

When a dashboard begins following a run with a recorded runner-qualified session, it SHALL reconstruct available transcript content from Convoy's durable event history and, where necessary, the runner's supported history interface, including phases completed before attachment. Reconstructed content SHALL merge with live events without duplicates or cross-attempt mixing. Reconstruction MUST NOT fabricate missing content. Historical runs with captured content SHALL remain readable after runner shutdown; unavailable or incomplete content SHALL be labeled honestly. Stored-session reopening SHALL retain exact session and checkout validation.

#### Scenario: Re-attach mid-run shows the running step's earlier output
- **WHEN** an operator detaches and re-attaches while a step is mid-stream
- **THEN** the session tab shows captured messages from before the re-attach and continues tailing the live stream without duplicates

#### Scenario: A completed step remains readable after a late attach
- **WHEN** an operator attaches to a live goal run after a measurement round completed
- **THEN** the completed scoring steps' session tabs show available history rather than a no-messages placeholder merely because the dashboard was absent

#### Scenario: Historical runs do not invent transcripts
- **WHEN** a stopped run is reopened with no durable transcript and no available runner history for a phase
- **THEN** the phase shows an honest unavailable placeholder and nothing claims content the dashboard does not have

#### Scenario: Runner is gone but durable history exists
- **WHEN** a completed Claude or OpenCode run is reopened after its execution process stopped
- **THEN** captured transcripts remain readable without starting that runner or making model requests

#### Scenario: History overlaps live events
- **WHEN** replay overlaps events already received live or a stream reconnects
- **THEN** the transcript preserves ordering and shows each captured fragment once under the correct runner, phase, and attempt

#### Scenario: Captured history has a gap
- **WHEN** a crash or stream failure left an unrecoverable interval in the transcript
- **THEN** the dashboard marks the gap and retains valid earlier and later content without claiming completeness
