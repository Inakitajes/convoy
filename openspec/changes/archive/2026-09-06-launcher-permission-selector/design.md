# Design: launcher-permission-selector

## Context

The launcher options step (`src/launch-tui.ts`) renders one gateway select row plus a list of boolean toggles. Today the first two toggles are the mutually exclusive permission pair:

- `ToggleKey` includes `"smart"` and `"yolo"`; `toggleState` seeds `smart: true, yolo: false` (~line 626), so every launch defaults to Smart auto-accept.
- `toggleOption()` (~line 1682) flips a boolean and enforces the exclusion (`smart on → yolo off`, and vice versa); keyboard and mouse activation both funnel through it.
- The launch payload (~line 1672) copies `toggleState.yolo/smart` straight into `LaunchOptions`; flag construction (~line 2446) pushes `--smart`/`--yolo`.
- Row rendering (~line 2238) assumes every row is an on/off switch.

The runtime below the launcher already speaks in three modes: `AutoAcceptMode`/plan `permissions` are `off|all|smart` and `interactive|yolo|smart`. The CLI flags, permission gate, dashboard Shift+Tab cycle, and goal-loop seeding are all untouched by this change — the launcher just chooses which flags to send. The existing `run-launcher` spec covers only dirty-tree handling, so the selector gets a new capability (`run-launcher-permissions`, see the delta spec).

## Goals / Non-Goals

**Goals:**
- One permission control on the options step that cycles Interactive → Auto-accept → Smart → Interactive on activation (keyboard and mouse).
- Default the launcher to Auto-accept.
- Keep producing exactly the same downstream options the old toggles produced for each reachable state (`--yolo`, `--smart`, or neither).

**Non-Goals:**
- No changes to CLI flags (`--yolo` / `--smart` / `--smart-model`), their defaults, or parsing.
- No changes to the running dashboard's Shift+Tab cycle, the permission gate, smart-judge model resolution, or `RunOptions`/plan shapes.
- No persistence of the operator's last-selected mode between launcher sessions (state resets per launch, as today).
- No redesign of the other toggles, their defaults, or the worktree/include-dirty coupling.

## Decisions

### D1: Replace the two permission toggles with a tri-state mode, not synthesized booleans

Remove `"smart"`/`"yolo"` from `ToggleKey`/`toggleState` and add a `permissionMode: "interactive" | "yolo" | "smart"` field on the launcher, with the state names aligned to the plan's existing `permissions` vocabulary. The cycle order is the fixed list `["interactive", "yolo", "smart"]`; activation advances one step and wraps.

- Alternative considered: keep both booleans and add a hidden "both off" path via the cycle. Rejected: it preserves the very state coupling the user dislikes, and the boolean pair cannot represent "interactive" without special-casing.
- Mapping (single place, in the launch payload and flag builder): `interactive` → `yolo: false, smart: false`; `yolo` → `yolo: true`; `smart` → `smart: true`. The payload keeps sending `LaunchOptions.yolo/smart`, so `RunOptions`, `buildRunPlan`, and everything downstream are untouched.

### D2: Render the selector as a value row, following the gateway row's precedent

The options step already has one non-boolean row: the gateway selector ("gateway  …  --gateway"). The permission selector renders the same way — mode name as the row's value, the flag it resolves to (`--yolo` / `--smart` / neither, dimmed when interactive) on the right, and a per-state description line beneath it, like the toggle descriptions today. The per-state description reuses the wording of the old toggle descriptions (Auto-accept and Smart keep theirs; Interactive gets a short "permissions prompt for every ask-level request" line).

- Alternative considered: keep the checkbox/switch glyph and treat "off" as interactive. Rejected: a switch suggests a binary; the mode is a three-way choice and the mode name is the information the operator needs.

### D3: Default the mode to `yolo` (Auto-accept)

`permissionMode` initializes to `"yolo"`. Nothing else seeds it: there is no config key for launcher defaults today (and config deliberately refuses permission grants — `permissions.yolo` in config is a parse error), so introducing persistence or a config default is out of scope per the proposal.

### D4: Activation stays inside the existing row-dispatch path

`toggleOption()` keeps handling the selected row; for the permission row it cycles `permissionMode` instead of flipping a boolean (mirroring how the gateway row opens its picker there). Keyboard activation and row clicks both already route through this method, so no new input plumbing.

## Risks / Trade-offs

- [Launcher tests assert the old rows ("Smart auto-accept" snapshots, switch glyphs at specific rows)] → Update the affected `test/launch-tui.test.ts` expectations and add cycle/default/mapping cases; no production test depends on the toggle internals.
- [Default `--yolo` means a fresh launcher now starts more permissive than the CLI default (neither flag)] → Intentional per the proposal; the review step still displays `--yolo` before the run starts, so the operator sees and can reject it. Document the new default in the README.
- [Cycle has no hidden "both on" or dead state] → The wrap-around list makes invalid states unrepresentable; flag construction reads only from the mapped mode.
- [Row index math shifts (the permission rows were toggle rows, now one row)] → The single selector replaces two rows, so `optionRows`/index bookkeeping must be updated together with the `toggles` array; the include-dirty count enrichment and the dirt notice keep working because they target the `includeDirty` row, which keeps its key.

## Migration Plan

Single-repo UI change, no data or persisted state to migrate: remove the two toggle specs, add the selector, flip the default, update tests and README. Rollback is a straight revert. Legacy run metadata is unaffected (plan `permissions` vocabulary is unchanged).
