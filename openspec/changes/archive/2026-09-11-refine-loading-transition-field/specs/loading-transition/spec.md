## REMOVED Requirements

### Requirement: Transition animates a breathing sea in the current theme
**Reason**: The two crossed plane waves read as a regular corrugated grid at terminal resolution; the operator wants a richer, organic backdrop. Superseded by the drifting organic field below.
**Migration**: The field model is internal to the loading transition with no persistence or operator action; the new model replaces it wholesale. No operator migration is required.

### Requirement: The centered CONVOY card carries identity over the field
**Reason**: With the field calm at the center, a bordered, opaque card is no longer needed, and the identity should name what is actually loading rather than always reading CONVOY. Superseded by the borderless centered name wordmark below.
**Migration**: The transition is a transient screen with no persisted state; it now renders the loading name directly over the field. No operator migration is required.

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Reduced motion renders a static frame
When the operator has expressed a reduced-motion preference, the transition SHALL render a static frame of the field instead of animating it, so the screen remains informative without motion.

#### Scenario: Reduced motion is honored
- **WHEN** the operator prefers reduced motion and a destination loads slowly
- **THEN** a static field renders in place of the animation and the destination replaces it when ready
