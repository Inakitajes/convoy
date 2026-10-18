# Spec Delta

## MODIFIED Requirements

### Requirement: Every intermediate commit identifies its run

Convoy SHALL append exactly one machine-readable `Convoy-Run: <run-id>` Git trailer containing the complete originating run ID to every intermediate commit it creates. This SHALL cover normal writable agent phases, accepted interrupted-phase recovery, and each committed human iteration through either supported harness. Convoy, rather than agent-supplied content, MUST determine the trailer value.

#### Scenario: Normal writable phase is linked
- **WHEN** a writable agent phase leaves repository changes and Convoy commits them
- **THEN** the commit contains exactly one `Convoy-Run` trailer whose value equals the active workspace run ID

#### Scenario: Recovered phase is linked
- **WHEN** an operator accepts recovery of uncommitted changes from an interrupted writable phase
- **THEN** the recovery commit contains the run ID of the resumed workspace as its `Convoy-Run` trailer

#### Scenario: Human iteration is linked
- **WHEN** a human OpenCode or Claude iteration leaves changes that Convoy commits
- **THEN** that iteration commit contains the active workspace run ID as its `Convoy-Run` trailer

#### Scenario: A step leaves no changes
- **WHEN** a writable phase or human iteration leaves no staged repository changes
- **THEN** Convoy creates no empty commit merely to record the run trailer
