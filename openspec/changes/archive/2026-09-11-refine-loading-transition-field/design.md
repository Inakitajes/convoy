## Context

`src/loading-transition.ts` already separates a **pure, renderer-free model** (grid sampling, brightness, quantization, row painting) from a thin OpenTUI **scene** that mounts the field plus the centered card. Tests unit-test the pure model and capture rendered frames. See proposal.md — Why for the motivation.

Constraints that shape the approach:

- Terminal cells have no alpha; brightness is expressed as a glyph plus a themed foreground tone. Backgrounds are not painted (the terminal's own background shows through).
- The field must stay a **pure function of position and time** (no PRNG, no seed state) so a resize never strands state and tests can pin frames.
- The theme is dynamic (dark/light/neutral palettes; `text`, `dim`, `faint`, `accent`, …), so tones must be picked from `theme` at paint time.
- Cost is bounded today by a clamped sampling grid (`transitionGrid`: ≤110×60 cells) and a ~30 fps cadence; the field must stay cheap enough over SSH.
- The center carries an opaque CONVOY card; the field behind it is masked.

## Goals / Non-Goals

**Goals:**
- An organic, slowly drifting character field that reads as alive rather than as a regular corrugated grid.
- A tone/ramp mapping that feels richer than two glyphs but still stays behind the card's identity.
- A composition that frames the centered card: livelier toward the terminal edges, calm in the middle.
- Preserve every behavioral contract: threshold, atomic handoff, interrupt, reduced-motion static frame, performance caps.

**Non-Goals:**
- Changing the card, the handoff/scene contract, or the reduced-motion detection mechanism.
- Image- or bitmap-based backgrounds, true alpha, or per-cell blending beyond a foreground tone.
- A baked density figure (e.g. Zeron's hand maps): explicitly out of scope for this change.

## Decisions

### 1. A directional "convoy current", not an isotropic organic swirl

`fieldValue(x, y, t)` samples two crossing streamlines in a frame tilted off horizontal, then warps their phases so the pattern bends organically while it advances along the heading:

```
along = x·cosθ + y·sinθ − flow·t
cross = −x·sinθ + y·cosθ
v1 = sin(cross·1.15 + 1.6·sin(along·0.2 + 0.5t) + 0.6t)
v2 = sin(cross·0.55 − 1.1·sin(along·0.13 − 0.4t) − 0.3t)
return 0.5 + 0.25·(v1 + v2)     // [0,1]
```

with `θ ≈ 12°` and `flow ≈ 3.4` cells/s. The bed is shaped (`value^1.3 · gain`), vignetted, and **capped below the accent band**, so it reads as glassy streamlines flowing one way.

- **Why:** "convoy" means ordered movement with a direction; an isotope-agnostic plasma swirl says nothing about the product. A heading + streamline bed gives the field meaning while staying deterministic, branch-free, stateless, and O(1) per cell.
- **Alternatives considered:** the previous isotropic Zeron-style plasma — pretty but semantically mute and, per the operator, "an organic spiral" that does not read as Convoy; true Perlin/simplex flow — more code and state for no visible gain at this cell size; a rigidly translating field — directional but lifeless, so a slow phase warp keeps it evolving.

### 2. Traveling convoys over the bed, carrying the accent

On top of the bed sit a fixed set of deterministic formations (`fieldConvoys`: lane, speed, offset, length). Each is a lead that glides with the flow followed by a fading, pulsing wake; the lead is boosted so it stays the accent even while its sub-cell position is split across two cells. The accent band is unreachable by the bed, so **the only accent marks on screen are convoys**.

- **Why:** this is the literal "convoy" — units moving together down a lane — and reserving accent for it makes the movement the subject. Sub-cell interpolation keeps the glide smooth instead of stepping column by column.
- **Alternatives considered:** a single comet per convoy — reads as one object, not a chain; convoys without a bed — spare and less alive; convoys in the calm center — would fight the name, hence the separate center fade (Decision 3).

### 3. Radial vignette: calm center, lively edges (and convoys pass "behind" the name)

The field intensity is multiplied by a radial envelope over grid coordinates, using `smoothstep(inner, outer, r)` with `r` = normalized distance from center (`0` center → `1` corner). Convoys fall off with a slightly tighter envelope (`smoothstep(0.3, 0.45, r)`), so they vanish inside the calm pocket and reappear past the name.

- **Why:** the name is the identity anchor; clearing its center keeps the composition readable while the border region reads as a frame, and fading convoys there lets them pass "behind" the name without hurting legibility.
- **Alternatives considered:** per-axis edge falloff like the reference's page rails — leaves the corners active but the exact center only partially clear; no vignette — the current competes with the name.

### 4. Isotropy of the sampling grid lets the vignette be circular

`transitionGrid` samples one cell per two terminal columns and per row; a cell is therefore roughly physically square, so Euclidean distance over grid coordinates is a fair approximation of on-screen radius. No aspect correction is needed.

### 5. Density ramp `. · : × *` mapped to faint / dim / accent — never `text`

`fieldCell(intensity)` quantizes into a small ordered ramp: blank → `.`/`·` faint → `:`/`×` dim → `*` accent. The bed is capped below the accent band, so the accent is reserved for the convoys; neither reaches the theme's bright `text` tone.

- **Why:** more textural range than `·`/`:` alone; reserving accent for the convoys makes the movement the one thing that pops; `text` stays reserved for foreground UI so the field never out-shouts content.
- **Alternatives considered:** Zeron's full `" .:~×*#"` ramp — `#` and `*` at every band read too solid at terminal cell size; keeping two glyphs — the status quo being improved.

### 6. Reuse the existing sampled-grid + `paintSpan` stretch pipeline

The pure model produces `cols×rows` intensities; the row painter quantizes each cell and repeats its glyph across its proportional column span so a clamped grid still fills the terminal edge to edge. Cadence, caps, reduced-motion single frame, and the renderable structure are unchanged.

### 7. A dedicated 5-row block alphabet for the loading name

The loading name renders through a new 5-row block alphabet (letters covering `CONVOY`, `SPECS`, `RUNS`, `HOME`) defined alongside the transition, rather than extending the masthead's 3-row `CONVOY_WORDMARK`.

- **Why:** the 3-row font cannot distinguish S/E/R legibly at terminal cell size, and enlarging it would also change the Home masthead. A separate 5-row loading font keeps the masthead untouched while making `SPECS`/`RUNS`/`HOME` crisp. The loading screen owns its typography; `CONVOY` there and `HOME` are drawn in the same font, so Home "uses the same letters" as the app name.
- **Fallback:** a name with a letter the alphabet lacks, or one too wide for the terminal, renders as plain uppercase accent text at the center — no clipping, no overflow.
- **Alternatives considered:** extending the shared 3-row font — rejected for legibility and masthead coupling; a full A–Z font — unnecessary for the fixed destination names; plain text only — rejected because the operator asked for the block style.

### 8. Drop the card frame; center the name directly over the field

The bordered, opaque card is replaced by a borderless centered column (name wordmark over the status line) with no background.

- **Why:** the radial vignette leaves the center calm, so there is nothing for the card to mask; the field can show through behind the name without hurting legibility, which is exactly why the frame is no longer needed.
- **Alternatives considered:** keeping the border only — rejected by the operator; keeping the opaque backdrop without a border — an invisible panel adds nothing and hides the calm center.

### 9. Name plumbing: a wordmark name plus an optional destination label

`withLoadingTransition(route, name, load, options)` takes the **wordmark** name positionally and an optional `label` (the destination) for the status line and failure messages; it defaults to the wordmark. Home passes `name: "CONVOY"`, `label: "home"` (the brand wordmark, the destination named once), while `browseSpecs`/`browseRuns` pass just `specs`/`runs`. The status line prints `loading` alone when the wordmark already shows the same word, and names the destination otherwise. Runs' history load is wrapped in the same transition, mirroring the specs pattern (interrupt → quiet exit).

- **Why:** the wordmark and the destination are genuinely two different things for Home (brand vs. place), and the status should not repeat a wordmark that already names the destination (the operator asked for `loading…`, not `loading specs…`). One optional field expresses both without a special-case table.
- **Alternatives considered:** a first-launch/return flag switching `CONVOY`/`HOME` — the operator reversed this: Home always shows the brand; deriving the status by string-matching the wordmark against the destination — works, but an explicit `label` keeps the intent readable at the call site.

## Risks / Trade-offs

- **The current could read as "random noise"** (the spec forbids it) → the bed is continuous, deterministic and capped below the accent band; tests assert its temporal/spatial smoothness, that neighbouring samples correlate, and that only convoys reach the accent.
- **The loading wordmark no longer matches the masthead's 3-row CONVOY** → accepted: the loading screen uses one consistent 5-row font, and the masthead is a separate surface. A test pins the block name rendering and the plain fallback.
- **Accent convoys could compete with the borderless accent name** → convoys fade inside the calm pocket (a tighter envelope than the bed), so a formation passes behind the name without touching it.
- **A name could overflow a narrow terminal** → the renderer falls back to plain uppercase text when the block wordmark does not fit; tests cover the fallback.
- **Status text could duplicate the name** → the status drops the destination when the wordmark already names it (`SPECS` + `loading…`); Home keeps `loading home…` because its wordmark is the brand, not the destination.
- **Routing Runs adds a transition where the load is often fast** → the existing no-flash threshold means a fast runs list never shows it; a slow one is covered and named `RUNS`.
- **Light terminals / limited palettes could look washed out** → tones are taken from the active palette, and a test paints with the light palette to prove the mapping stays distinct and legible.
- **Thresholds might leave a ramp band unreached** → thresholds are tuned against the sampled distribution and a test asserts every band is reachable across samples and time.
- **Performance on very large terminals** → unchanged caps (≤110×60) and an O(cells) branch-free field; the extra `sin`/`cos` cost is trivial next to the existing per-frame paint.

## Migration Plan

Internal module with no persistence or public API change. Rollback is a file-level revert of `src/loading-transition.ts` and its test; no data or config migration.

## Open Questions

- Exact flow speed, tilt, convoy lanes/speeds/lengths and vignette radii are tuned visually; they do not change the specs or the task breakdown and can be adjusted during review.
