# Proposal: launcher-permission-selector

## Why

Every pipeline launch defaults to Smart auto-accept, but the operator's preferred default is plain Auto-accept — the default is exactly backwards for them. On top of that, the launcher presents the two auto-accept flavors as two separate toggles that are mutually exclusive ("turn one on, the other turns off"), which reads as awkward state coupling rather than one deliberate choice.

## What Changes

- **BREAKING (launcher UX only)**: Replace the two mutually exclusive permission toggles ("Smart auto-accept" / "Auto-accept permissions") in the run launcher's options step with a single cycling permission selector.
- The selector cycles through three states: **Interactive** (no auto-accept, permissions prompt) → **Auto-accept** (ask-level permissions auto-allowed, denylist still applies) → **Smart auto-accept** (AI judge allows safe requests, escalates risky ones) → back to **Interactive**.
- The launcher's default permission state becomes **Auto-accept** (today the default is Smart auto-accept).
- The selector maps to the same execution flags as before: Interactive sends neither flag, Auto-accept sends `--yolo`, Smart sends `--smart` (+ the resolved judge model).
- The other option toggles (human gates, include dirty tree, keep run dir, dashboard, worktree) are unchanged.
- CLI flags `--yolo` / `--smart` and the running dashboard's Shift+Tab cycle keep their current behavior; this change is scoped to the launcher's options step.

## Capabilities

### New Capabilities
- `run-launcher-permissions`: The run launcher's permission-mode selector — the single cycling control replacing the two toggles, its three states, its Auto-accept default, and how it maps to the run's permission flags.

### Modified Capabilities
<!-- none: the existing run-launcher capability covers dirty-tree handling only; its requirements do not change. -->

## Impact

- `src/launch-tui.ts`: toggle list (replace the two permission rows with one selector row), default `toggleState` (`smart: true, yolo: false` → auto-accept default), the mutual-exclusion logic in `toggleOption()`, and flag construction in the launch payload.
- No runtime changes: `RunOptions.yolo/smart`, `AutoAcceptMode`, the permission gate, the plan's `permissions` field, and the dashboard cycle are untouched — the launcher keeps producing the same flags it does today for each state.
- README (launcher options / auto-accept sections) and any launcher screenshots may need updating.
