## MODIFIED Requirements

### Requirement: Transition is shown only during a real load

When an operator opens Convoy's Home — at launch or on return from any home-session destination — or opens a destination from the home launcher, Convoy SHALL begin loading that screen and SHALL render the loading transition only while the load is genuinely in progress. If the load completes within a short threshold (nominally 150 ms), Convoy SHALL NOT flash the transition and SHALL move straight to the destination.

#### Scenario: Fast load shows no transition

- **WHEN** the operator opens a destination whose load completes within the threshold
- **THEN** the destination renders immediately and no loading transition is shown

#### Scenario: Slow load shows the transition

- **WHEN** the operator opens a destination whose load exceeds the threshold
- **THEN** the loading transition is rendered until the destination is ready, then the destination replaces it

#### Scenario: Home opens are covered too

- **WHEN** Convoy launches or returns to Home and the control-board load exceeds the threshold
- **THEN** the loading transition covers the Home open exactly as it covers a destination open

#### Scenario: Transition never extends the load

- **WHEN** the destination becomes ready while the transition is visible
- **THEN** the destination replaces the transition immediately and the transition is not held for any animation to finish

## REMOVED Requirements

### Requirement: The status line is centered over the field
**Reason**: Superseded by the centered CONVOY card: the transition no longer floats a bare status line; it renders a solid rounded card carrying the home masthead's wordmark above the status text.
**Migration**: See the ADDED requirement "The centered CONVOY card carries identity over the field".

## ADDED Requirements

### Requirement: The centered CONVOY card carries identity over the field

While the transition is visible, Convoy SHALL render a solid rounded card centered horizontally and vertically over the animated field. The card SHALL carry the home masthead's CONVOY wordmark above the loading status text, remain legible against the field, and mask the field behind it so the animation does not bleed through the card's own spacing.

#### Scenario: The card sits at the center

- **WHEN** the transition renders on any terminal size
- **THEN** a rounded card containing the CONVOY wordmark and the status line is positioned at the horizontal and vertical center of the terminal, above the field

#### Scenario: The card stays legible

- **WHEN** the animated field passes beneath the centered card
- **THEN** the field does not bleed through the card's surface or the status text's spacing, so the message reads as continuous words
