# Spec Delta

## MODIFIED Requirements

### Requirement: The selected permission mode maps to the run's permission flags

The launcher SHALL translate the selected permission state into the same run options the previous toggles produced: Interactive sends neither auto-accept flag, Auto-accept sends the auto-accept (`--yolo`) flag, and Smart auto-accept sends the smart (`--smart`) flag. The launcher MUST NOT emit both flags at once. Smart auto-accept SHALL resolve an explicit runner-qualified judge route and authentication mode, preserving existing explicit OpenCode judge choices while allowing Claude-only judging without OpenCode. The resolved route and any API billing requirement SHALL be disclosed and validated before execution. Unavailable judges SHALL NOT silently change runner, model, or billing mode.

#### Scenario: Auto-accept selected
- **WHEN** the review is accepted with the selector on Auto-accept
- **THEN** the run's flags show `--yolo` and not `--smart`

#### Scenario: Smart auto-accept selected
- **WHEN** the review is accepted with the selector on Smart auto-accept
- **THEN** the run's flags show `--smart` and not `--yolo`

#### Scenario: Interactive selected
- **WHEN** the review is accepted with the selector on Interactive
- **THEN** the run's flags show neither `--yolo` nor `--smart`, and permission requests prompt the operator during the run

#### Scenario: Claude-only smart approval
- **WHEN** Smart auto-accept is selected with a supported Claude subscription judge route
- **THEN** launch review identifies that route and permissions are judged without installing OpenCode or requiring an API key

#### Scenario: Explicit judge is unavailable
- **WHEN** the configured judge model or authentication mode is unavailable
- **THEN** preflight explains the missing dependency and requires an explicit correction without starting affected execution
