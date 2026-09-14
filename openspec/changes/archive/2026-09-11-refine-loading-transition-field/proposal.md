## Why

The current loading transition paints a "breathing sea" built from two crossed plane waves. At terminal resolution that interference reads as a regular corrugated grid — technically a wave, but visually monotonous. Borrowing Zeron's organic noise field fixed the texture but introduced a new problem: an isotropic swirl says nothing about Convoy, which is an orchestration harness of agents **in a chain** — ordered, purposeful, moving together. The loading screen should carry that meaning while keeping Convoy's calm, theme-adaptive, low-cost contract.

## What Changes

- Replace the sea model (two crossed traveling swells under a global breathing envelope) with a **directional "convoy current"**: a bed of streamlines flowing along one heading (a gentle tilt off horizontal), warped and shaped so it stays a subtle, coherent texture rather than an isotropic swirl. It is a pure function of position and time — no PRNG, no seed state.
- Add **traveling convoys** riding the current: deterministic formations, each a lead pulsing into a fading wake. The theme **accent** tone is reserved for them, so the brightest marks on screen always read as movement with a direction.
- Add a **radial vignette** so the current is livelier toward the terminal edges and calm behind the centered name; convoys fade inside that pocket, so a formation passes "behind" the name.
- Broaden the painted **glyph ramp** from two glyphs (`·`, `:`) to a small density ramp (`·`, `:`, `×`, `*`). The bed never reaches the accent band — only the convoys do — and neither reaches the theme's bright text tone, so the field stays behind the name's identity.
- **Remove the card's border and opaque backdrop.** Now that the current is calm at the center, the centered content needs no framed rectangle; the field stays visible behind the name and status.
- **Name what is loading.** The transition takes the loading name and renders it as the centered block wordmark: `CONVOY` for Home (both the app launch and every return — Home's wordmark is the brand), and `SPECS` / `RUNS` for those destinations. The block alphabet is extended to cover those names; a name that does not fit (or has unknown letters) falls back to plain uppercase text. The status line reads `loading` alone when the wordmark already names the destination, and names it otherwise (`loading home` under the CONVOY wordmark).
- **Route Runs through the transition** so opening the runs browser from Home also names itself (`RUNS`) while its history loads.
- Keep every existing contract unchanged: atomic handoff, no-flash threshold, reduced-motion static frame, frame-rate and cell caps, non-interactive skip, and Ctrl+C interrupt.

**Non-goals:** changing the name's vertical position, the handoff/scene contract, or the reduced-motion detection mechanism.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `loading-transition`: the "breathing sea" animation requirement is replaced by a directional convoy current — a flowing bed with traveling formations that carry the accent, edge falloff, and a broader glyph ramp; the bordered CONVOY card requirement is replaced by a borderless centered wordmark that names what is loading (with the Run destination routed through the transition); the reduced-motion requirement's wording is generalized from "sea field" to "field". Coherence (smooth, correlated, non-random), theme adaptation, and atomic handoff are preserved.

## Impact

- `src/loading-transition.ts`: the pure field model (`seaSwells`/`seaIntensities`/`breath*`/`dimmedSea`/`seaCell`/`intensityCell`/`seaRow`) is replaced by a `field*` model; the `LoadingTransition` renderer paints it, drops the card frame, and renders the loading **name** with an extended block alphabet (plain-text fallback).
- `src/cli.ts`: Home's loader always names itself `CONVOY` (wordmark) with `home` as the status destination.
- `src/runs.ts`: the runs history load is wrapped in the transition so it names itself `RUNS`.
- `test/loading-transition.test.ts`: model and render assertions updated to the new field, ramp, vignette, and name wordmark.
- No public CLI, config, or dependency changes; `withLoadingTransition`'s signature keeps the same shape (the name parameter is already positional).
