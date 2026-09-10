## ADDED Requirements

### Requirement: Foreground terminal handoff leaves no stray output

When Convoy hands the terminal to a foreground harness client and later reclaims it, Convoy SHALL clear the released primary screen so that neither Convoy's alternate-screen teardown nor the child client's startup terminal queries and frame setup remain visible. On client exit — normal, non-zero, startup failure, or interruption — the terminal SHALL be returned with usable input, echo, and rendering and without residual characters that leave the operator to reset the terminal or press Ctrl+C to recover a clean prompt. The cleaning SHALL be part of the shared foreground host lifecycle so every foreground handoff applies it.

#### Scenario: Opening a foreground client shows no stray output

- **WHEN** an operator opens a foreground conversation and the harness client starts
- **THEN** the released primary screen is cleared, so the client's terminal-capability queries and setup do not appear as stray characters

#### Scenario: Returning from a foreground client is clean

- **WHEN** the foreground client exits and Convoy reclaims the terminal
- **THEN** the primary screen is cleared before Convoy re-renders, and the operator returns to the destination without residual garbage

#### Scenario: A failing or interrupted client still restores cleanly

- **WHEN** the foreground client cannot start, exits non-zero, or is interrupted
- **THEN** the handoff still clears the primary screen and restores input, echo, and rendering
