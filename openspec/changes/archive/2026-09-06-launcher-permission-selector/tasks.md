## 1. Launcher selector core

- [x] 1.1 In `src/launch-tui.ts`, remove `"smart"`/`"yolo"` from `ToggleKey` and drop the two permission toggle specs from the `toggles` list; add a `permissionMode: "interactive" | "yolo" | "smart"` field with per-state names and descriptions, and seed the default as `"yolo"` (design D1/D3). Verify `bun run build` (or the repo's typecheck) passes.
- [x] 1.2 Render the permission selector as a value row (mode name, resolved flag `--yolo`/`--smart`/dimmed-neither on the right, per-state description line) following the gateway row's precedent, replacing the two switch rows (design D2). Verify by rendering the options step in a test/scratch TUI and seeing one permission row.
- [x] 1.3 Route the permission row's activation through `toggleOption()` so it advances `permissionMode` along the fixed cycle `interactive → yolo → smart → interactive` for both keyboard and mouse activation, and remove the old `smart`/`yolo` mutual-exclusion lines (design D4). Verify: activating three times returns to the starting state and other toggles still flip.
- [x] 1.4 Update the launch payload and review flag construction to map `permissionMode` → `LaunchOptions.yolo/smart` and the `--yolo`/`--smart` flags (never both), keeping `RunOptions` and everything downstream unchanged (design D1). Verify the payload for each mode in a unit test.

## 2. Tests

- [x] 2.1 Update the existing `test/launch-tui.test.ts` expectations that reference the old toggles ("Smart auto-accept" rows/switch glyphs) for the new selector row and add coverage for: default is Auto-accept, the three-state cycle wraps, and the flag/payload mapping per mode. Verify with `bun test test/launch-tui.test.ts` (or the repo's test command).
- [x] 2.2 Add/adjust any coordinate or review-pipeline test asserting a default launcher launch now resolves plan `permissions: "yolo"` and shows `--yolo` in the review flags. Verify with the repo's test command.

## 3. Docs

- [x] 3.1 Update README's launcher/options and auto-accept sections to describe the single cycling selector, its three states, and the new Auto-accept default. Verify the affected README lines read correctly.
- [x] 3.2 Run the full verification suite (`bun test` / repo test command) and confirm no regressions outside the updated launcher tests.