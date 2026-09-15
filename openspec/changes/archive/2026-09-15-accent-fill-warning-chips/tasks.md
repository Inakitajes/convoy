## 1. Palette tokens

- [x] 1.1 Add `warning` (fill) and `warningInk` fields to the `Palette` type and to the dark, light, and neutral palettes in `src/tui-theme.ts`, excluding `warningInk` from `PaletteColor`; verify with `bun run typecheck`.
- [x] 1.2 Pick values per palette so the warning ink clears 4.5:1 against the warning fill and the fill stays distinguishable from the accent fill (dark/light: `#E0AF68` + `#0A0E1A`; neutral: `#B59B3A` + `#000000` or the same pair); verify with a contrast test added in `test/tui-theme.test.ts` (`bun test test/tui-theme.test.ts`).

## 2. Rendering

- [x] 2.1 Extract the "preserve a chunk's own background" rule into one shared helper in `src/home-tui.ts` and use it from both `highlighted()` and `filledLines()`; verify existing Home tests still pass with `bun test test/home-tui.test.ts`.
- [x] 2.2 Add a `warnChip` helper that builds the warning fill + ink chunk (`bg(warning)(fg(warningInk)(value))`); verify it via the fold tests in group 3.
- [x] 2.3 Apply the chip to the fold's warning facts in `inlineDetailLines` (managed writer, unknown working-tree dirt, unknown changes); verify the selected-row fold shows the value on the warning fill with `warningInk` text.
- [x] 2.4 Apply the chip to the detail zone's non-known linked-PR value in `detailLines`, and leave the detail's plain observations on yellow ink; verify via the tests in group 3.

## 3. Tests

- [x] 3.1 Replace the "zone's PR warning stays yellow on the accent fill" expectation in `test/home-tui.test.ts` with the chip contract (warning fill background + `warningInk` foreground); verify with `bun test test/home-tui.test.ts`.
- [x] 3.2 Add a fold scenario asserting a live/uncertain managed writer value renders on the warning chip; verify with `bun test test/home-tui.test.ts`.
- [x] 3.3 Add coverage that an unknown dirt or changes value in the fold renders on the warning chip, and that a warning on a plain detail fact keeps yellow ink; verify with `bun test test/home-tui.test.ts`.

## 4. Verification

- [x] 4.1 Run `bun run typecheck` and the full `bun test` suite; verify both pass with no failures.
- [x] 4.2 Confirm in a rendered Home frame (or captured spans) that the writer value is legible as a chip under the dark, light, and neutral palettes and that non-warning facts are unchanged.
