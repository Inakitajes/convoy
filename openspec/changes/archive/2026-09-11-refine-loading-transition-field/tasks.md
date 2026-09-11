## 1. Field model (pure, renderer-free)

- [x] 1.1 In `src/loading-transition.ts`, replace the swell/breath constants with the field constants (spatial frequencies `0.55`/`0.35`, drift rate, and vignette `inner`/`outer`), and implement the pure `fieldValue(x, y, t)` as the product of two mutually-warping sinusoids returning `[0,1]`. Verify with a unit test that the value stays in `[0,1]`, is deterministic for equal inputs, and varies with position and time.
- [x] 1.2 Implement the pure `vignetteAt(x, y, cols, rows)` radial `smoothstep` envelope (calm center → lively edges). Verify with a unit test that the center is below the edges, corners reach the top of the range, and the result stays in `[0,1]`.
- [x] 1.3 Implement `fieldIntensities(cols, rows, now)` (field × vignette) and remove the old `Swell`/`seaSwells`/`breathPeriodMs`/`breathFloor`/`breathAmplitude`/`seaIntensities`/`seaDimFactor`/`dimmedSea` symbols. Verify `bun run typecheck` passes with no references to the removed names.
- [x] 1.4 Implement `fieldCell(intensity)` mapping the ordered ramp to `faint`/`dim`/`accent` tones and never to `text`. Verify with a unit test that every band is reachable across a sampled field and that no mapped tone is `text`.
- [x] 1.5 Rename `seaRow` to `fieldRow` (defaulting to `fieldCell`) while keeping `transitionGrid` and `paintSpan` behavior. Verify the existing grid/span/row-width unit tests still pass against the renamed function.

## 2. Scene rendering

- [x] 2.1 Update `LoadingTransition.render`/`fieldRows` to paint `fieldIntensities` via `fieldRow`, and refresh the class/module comments from "sea" to the organic field. Verify a captured frame test contains ramp glyphs (`·`, `:`, `×`, `*`) while the CONVOY wordmark and status line still render.
- [x] 2.2 Confirm the reduced-motion static frame, the light/dark theme mapping, and the centered card are preserved over the new field. Verify a captured reduced-motion frame is unchanged after a delay and paints with the active palette.

## 3. Tests and verification

- [x] 3.1 Rewrite the model tests in `test/loading-transition.test.ts` for the field API (value range, vignette framing, smooth/deterministic drift, ramp/tones, grid/spans/rows) and update the symbol imports. Verify `bun test test/loading-transition.test.ts` passes.
- [x] 3.2 Run `bun run typecheck` and the full `bun test` suite, and fix any fallout from removed exports. Verify both commands exit successfully.
- [x] 3.3 Validate the change artifacts and confirm the spec delta applies cleanly. Verify `openspec validate refine-loading-transition-field --strict` (and `openspec validate --all` if supported) reports no errors.

## 4. Name the loading screen over a frameless field

- [x] 4.1 Add the dedicated 5-row block alphabet and a `blockWordmark(name)` helper (returns the glyph rows, or `undefined` when a letter is unknown) in `src/loading-transition.ts`. Verify a unit test renders `CONVOY`/`SPECS`/`RUNS`/`HOME` and returns `undefined` for an unknown letter.
- [x] 4.2 Remove the card border and opaque backdrop; render the name wordmark above the status in a borderless centered column, falling back to plain uppercase text when the block glyphs are missing or the wordmark does not fit. Verify a captured frame has no card border (`╭`) and still shows the status and block glyphs.
- [x] 4.3 Thread the loading name through `LoadingTransition` and render the status as `loading <name-lowercased>…`. Verify the render tests assert the name-specific status for specs/home.

## 5. Labels: launch vs return, and the Runs destination

- [x] 5.1 In `src/cli.ts`, have Home always name itself `CONVOY` (the brand wordmark) with `home` as the status destination, on both the launch and every return. Verify a render test shows the CONVOY wordmark over `loading home…`.
- [x] 5.2 In `src/runs.ts`, wrap the runs history load in the transition named `runs` (mirroring specs' interrupt → quiet-exit pattern). Verify the interactive path mounts the transition scene and the non-interactive path still prints the plain list.

## 6. Verification (name + frameless)

- [x] 6.1 Run `bun test test/loading-transition.test.ts`, `bun run typecheck`, and the full `bun test` suite; verify all pass.
- [x] 6.2 Validate the revised change. Verify `openspec validate refine-loading-transition-field --strict` and `openspec validate --all` report no errors.

## 7. Status de-duplication (operator revision)

- [x] 7.1 Thread an optional destination `label` through `withLoadingTransition` (defaulting to the wordmark) and render the status as `loading…` when the wordmark already names the destination, `loading <label>…` otherwise. Verify a render test shows `loading…` for specs/runs and `loading home…` under the CONVOY wordmark.
- [x] 7.2 Re-run `bun test test/loading-transition.test.ts`, `bun run typecheck`, the full suite, and `openspec validate --all`; verify all pass.

## 8. Directional convoy current (operator revision)

- [x] 8.1 Replace the isotropic plasma with a directional bed — a heading, advected streamlines, shaped and capped below the accent band — and add deterministic traveling convoys with sub-cell glide. Verify the model tests cover bed range/smoothness/cap, convoy travel (`convoyHeadX`), and that only convoys reach the accent.
- [x] 8.2 Update the proposal, spec delta and design to the convoy-current requirement (the field is no longer an organic swirl). Verify `openspec validate refine-loading-transition-field --strict` passes.
- [x] 8.3 Run `bun test test/loading-transition.test.ts`, `bun run typecheck`, the full suite, and `openspec validate --all`; verify all pass.
