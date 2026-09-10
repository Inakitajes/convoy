# loading-transition Specification

## Purpose

Defines the shared transition screen Convoy shows while a destination in the home session loads, animating a directional current of characters with convoys riding it, in the current theme, and handing off to the destination atomically so an operator is never left staring at an unresponsive, frozen menu.

## Requirements

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

### Requirement: Transition animates a breathing sea in the current theme

The loading transition SHALL render a field of characters whose brightness undulates like a sea surface — swells that travel across the field while the whole surface brightens and dims in place under a slow global pulse — in the terminal's current foreground and background theme. The animation SHALL be a coherent wave effect; it SHALL NOT read as expanding rings, random noise, or a scrolling glyph column.

#### Scenario: The sea uses the theme palette

- **WHEN** the transition renders in a light or dark terminal
- **THEN** its characters are drawn in the matching theme palette and remain legible against the theme background

#### Scenario: The sea breathes and undulates

- **WHEN** the transition is visible for more than a single frame
- **THEN** the character field changes over time as swells travel and the whole surface's brightness pulses in place, rather than remaining static, shuffling randomly, or expanding rings outward from points

### Requirement: The centered CONVOY card carries identity over the field

While the transition is visible, Convoy SHALL render a solid rounded card centered horizontally and vertically over the animated field. The card SHALL carry the home masthead's CONVOY wordmark above the loading status text, remain legible against the field, and mask the field behind it so the animation does not bleed through the card's own spacing.

#### Scenario: The card sits at the center

- **WHEN** the transition renders on any terminal size
- **THEN** a rounded card containing the CONVOY wordmark and the status line is positioned at the horizontal and vertical center of the terminal, above the field

#### Scenario: The card stays legible

- **WHEN** the animated field passes beneath the centered card
- **THEN** the field does not bleed through the card's surface or the status text's spacing, so the message reads as continuous words

### Requirement: Handoff to the destination is atomic

The transition SHALL hand off to the loaded destination without a blank frame and without exiting and re-entering the alternate screen between Convoy screens. The transition SHALL remain painted until the destination scene replaces it.

#### Scenario: No blank frame at handoff

- **WHEN** the destination is ready and replaces the transition
- **THEN** the destination scene paints over the transition directly with no cleared frame in between

#### Scenario: No alternate-screen toggle

- **WHEN** the transition is replaced by the destination
- **THEN** the terminal does not exit and re-enter the alternate screen during the handoff

### Requirement: Transition stays responsive on large terminals and remote sessions

The transition SHALL bound its work so it animates smoothly on large terminals and does not stall over SSH or a slow link. Convoy SHALL cap the animation frame rate and limit the number of cells evaluated per frame, and SHALL skip the animation entirely (falling back to a static message) when the terminal is not interactive.

#### Scenario: Large terminal stays responsive

- **WHEN** the transition renders on a terminal larger than a typical workstation size
- **THEN** the frame rate and computation remain bounded and the animation does not make the terminal unresponsive

#### Scenario: Non-interactive invocation skips animation

- **WHEN** the destination is opened with stdin or stdout not a TTY
- **THEN** no animated transition renders and the existing non-interactive plain output path is used

### Requirement: Transition can be interrupted

While the transition is visible, `Ctrl+C` SHALL interrupt the pending load, stop the transition, and return control to the operator without starting the destination or leaving the terminal in an unstable state.

#### Scenario: Interrupt cancels the load

- **WHEN** the operator presses `Ctrl+C` while the transition is visible
- **THEN** the pending destination load is cancelled, the transition stops, and control returns cleanly without a run or destination being started

### Requirement: Reduced motion renders a static frame

When the operator has expressed a reduced-motion preference, the transition SHALL render a static frame of the sea field instead of animating it, so the screen remains informative without motion.

#### Scenario: Reduced motion is honored

- **WHEN** the operator prefers reduced motion and a destination loads slowly
- **THEN** a static sea field renders in place of the animation and the destination replaces it when ready

### Requirement: Load failure degrades gracefully

If a destination cannot be loaded, the transition SHALL yield to a plain status message rather than hanging, and Convoy SHALL return control to the operator without leaving a stale or broken screen.

#### Scenario: Load failure reports the reason

- **WHEN** the destination load fails while the transition is visible
- **THEN** the transition gives way to a readable status message naming the failure, and control returns without a dead screen
