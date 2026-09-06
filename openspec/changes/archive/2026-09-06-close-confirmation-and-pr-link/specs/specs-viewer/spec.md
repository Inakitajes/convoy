## ADDED Requirements

### Requirement: Close handoff from the browser is confirmed

Pressing the close key (`x`) in the root list, or selecting the close action in the lifecycle Actions menu at any level, SHALL NOT emit the close resolution immediately. The browser SHALL first show a confirmation modal that names the selected feature, its source branch, the intended base, and the sequence the close command runs (sync → archive → squash-merge), so an accidental keystroke cannot start the sequence. Only an explicit confirm (`y` or Enter on the confirm choice) SHALL emit the close resolution; cancel (`n` or escape) SHALL dismiss the modal and leave the browser on the same subject with no mutation. The confirmation SHALL NOT alter what close itself does afterward, and non-TTY invocations SHALL remain unchanged.

#### Scenario: The close key opens a confirmation

- **WHEN** the user presses `x` on a registered feature in the root list
- **THEN** a confirmation modal names the feature, branch, base, and the sync → archive → squash-merge sequence, and no close resolution is emitted yet

#### Scenario: Confirm hands off to close

- **WHEN** the user confirms the modal with `y` or Enter on the confirm choice
- **THEN** the browser emits the same close resolution it emitted before this change, and close proceeds as usual

#### Scenario: Cancel keeps the browser state

- **WHEN** the user cancels the modal with `n` or escape
- **THEN** the modal closes, the same feature stays selected at the same level, and no handoff or mutation happened

#### Scenario: The Actions menu's close entry also confirms

- **WHEN** the user selects the close action from the lifecycle Actions menu
- **THEN** the same confirmation modal appears before the close resolution is emitted
