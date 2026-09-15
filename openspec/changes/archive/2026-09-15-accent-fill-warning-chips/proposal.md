## Why

Home's selected-row fold and the worktree detail's identity zone paint a solid accent fill behind every fact. Warning values — the managed writer's live/uncertain liveness, an unknown dirt or changes observation, and an unavailable PR — keep their yellow ink on that fill, where yellow-on-accent measures about 1.26:1 in the dark palette and 1.21:1 in the light palette. The warning is signalled at the cost of the text being effectively unreadable, so an operator can see that something needs attention but cannot read what it says.

## What Changes

- A warning value rendered on a filled surface (the selected row's fold and the worktree detail's filled zone) SHALL render as a filled chip: the warning color becomes the background and a contrasting ink carries the text, so the warning signal is preserved and the value is legible.
- A warning value rendered on a plain, unfilled surface (the detail's remaining facts) SHALL keep its yellow ink, which is already legible against the terminal background. Warnings become context-sensitive: ink on plain surfaces, fill on filled surfaces.
- The warning chip's fill SHALL be guaranteed to contrast with its text across the dark, light, and neutral palettes. This requires a dedicated warning-chip color pair rather than reusing the palette's `yellow`, which is tuned as ink on a light canvas and is too dark to serve as a fill there.
- This reverses the current deliberate presentation contract that a warning "stays yellow on the accent fill".

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `home-launcher`: warning observations shown on the accent-filled fold and the detail's filled zone render as a contrasting filled chip instead of yellow ink, preserving both the warning signal and legibility; warnings on the detail's plain facts keep their yellow ink.

## Impact

- `src/tui-theme.ts`: add a warning-chip fill/ink pair to the dark, light, and neutral palettes, chosen so the ink meets contrast against the fill (and the fill stays distinguishable from the accent fill).
- `src/home-tui.ts`: render warning values as chips in the selected-row fold (`inlineDetailLines`) and in the detail zone (`detailLines`), and let `filledLines` preserve a chunk's own background the way `highlighted` already does.
- `test/home-tui.test.ts`: replace the "stays yellow on the accent fill" expectation with the chip contract, and cover the two contexts (filled chip vs plain yellow ink).
- `test/tui-theme.test.ts`: cover the warning-chip pair's contrast in each palette.
