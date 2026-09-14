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
When the operator has expressed a reduced-motion preference, the transition SHALL render a static frame of the field instead of animating it, so the screen remains informative without motion.

#### Scenario: Reduced motion is honored
- **WHEN** the operator prefers reduced motion and a destination loads slowly
- **THEN** a static field renders in place of the animation and the destination replaces it when ready

### Requirement: Load failure degrades gracefully

If a destination cannot be loaded, the transition SHALL yield to a plain status message rather than hanging, and Convoy SHALL return control to the operator without leaving a stale or broken screen.

#### Scenario: Load failure reports the reason

- **WHEN** the destination load fails while the transition is visible
- **THEN** the transition gives way to a readable status message naming the failure, and control returns without a dead screen

### Requirement: Transition animates a directional convoy current in the current theme
The loading transition SHALL render a field of characters forming a current that flows in one consistent direction — a coherent bed of streamlines that warps and travels over time — in the terminal's current foreground and background theme. Bright formations ("convoys") SHALL ride the current, each a lead that travels with the flow followed by a fading wake, and the theme's accent tone SHALL be reserved for those formations rather than the bed. The field's energy SHALL be strongest toward the terminal's edges and calmest at the center behind the name, so it frames the centered identity instead of competing with it. The animation SHALL be a coherent current; it SHALL NOT read as expanding rings, random per-cell flicker or television static, or an isotropic swirl with no direction. Neighbouring cells SHALL correlate, and the field's evolution SHALL be smooth and deterministic.

#### Scenario: The current uses the theme palette
- **WHEN** the transition renders in a light or dark terminal
- **THEN** its characters are drawn in the matching theme palette and remain legible against the theme background

#### Scenario: The current flows in one direction
- **WHEN** the transition is visible for more than a single frame
- **THEN** the pattern advances along a consistent heading over time, rather than swirling in place or flickering per cell at random

#### Scenario: Convoys ride the current
- **WHEN** the transition is visible over time
- **THEN** bright formations travel with the flow, each a lead pulsing into a fading wake, and the accent tone marks those formations while the bed beneath them never reaches it

#### Scenario: The current frames the center
- **WHEN** the transition renders on any terminal size
- **THEN** the field's average density and brightness are higher toward the terminal's edges than in the calm central region behind the name

### Requirement: The centered name wordmark carries identity over the field
While the transition is visible, Convoy SHALL render the loading name as a block wordmark above the loading status, centered horizontally and vertically over the animated field. The wordmark and status SHALL be drawn directly over the field with no card border, frame, or opaque backdrop, so the field remains visible behind them, and both SHALL use the active theme palette so they stay legible against the field.

#### Scenario: The name sits at the center
- **WHEN** the transition renders on any terminal size
- **THEN** the name wordmark and the status line are centered on both axes over the field, with no border or backdrop drawn around them

#### Scenario: The field stays visible behind the name
- **WHEN** the animated field passes beneath the centered name
- **THEN** the field is not masked by an opaque panel, and the status text reads as continuous words over the calm center

### Requirement: The transition names the destination it is loading
The transition SHALL accept the name of what is loading and render it as the centered block wordmark. The name SHALL be displayed in uppercase block form; when the name contains letters the block alphabet does not define, or when it does not fit the terminal width, Convoy SHALL fall back to plain uppercase text. Opening the app and returning to Home SHALL both name themselves `CONVOY` (Home's wordmark is the brand); the Specs destination SHALL name itself `SPECS`; the Runs destination SHALL name itself `RUNS` and its history load SHALL be covered by the transition like the other destinations. The status line SHALL read `loading` alone when the wordmark already names the destination, and SHALL name the destination otherwise (so Home reads `loading home` beneath its CONVOY wordmark).

#### Scenario: The app launch names CONVOY
- **WHEN** the app starts and its first Home load outlasts the threshold
- **THEN** the transition shows the block wordmark CONVOY

#### Scenario: Returning home names CONVOY
- **WHEN** the operator returns to Home from a destination and the load outlasts the threshold
- **THEN** the transition shows the block wordmark CONVOY, not HOME

#### Scenario: The Specs destination names SPECS
- **WHEN** the operator opens Specs and its load outlasts the threshold
- **THEN** the transition shows the block wordmark SPECS with a bare `loading…` status

#### Scenario: The Runs destination names RUNS
- **WHEN** the operator opens Runs and its history load outlasts the threshold
- **THEN** the transition shows the block wordmark RUNS with a bare `loading…` status

#### Scenario: The status does not repeat the wordmark
- **WHEN** the loading name matches the block wordmark (Specs, Runs)
- **THEN** the status reads `loading…` instead of repeating the destination, while a wordmark that does not name the destination (Home's CONVOY) keeps `loading home…`

#### Scenario: A name that cannot use the block alphabet falls back
- **WHEN** the loading name contains letters the block alphabet does not define, or does not fit the terminal width
- **THEN** the transition shows the name as plain uppercase text at the center instead
