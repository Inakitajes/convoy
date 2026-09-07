## Purpose

The run launcher's permission-mode control: a single cycling selector on the options step that chooses how ask-level permission requests are handled during the run — fully interactive prompting, blanket auto-accept, or judge-mediated smart auto-accept — replacing the previous pair of mutually exclusive toggles.

## ADDED Requirements

### Requirement: The options step presents one cycling permission selector

The run launcher's options step SHALL present exactly one permission control — a cycling selector — in place of the previous "Smart auto-accept" and "Auto-accept permissions" toggles. Activating it SHALL advance through the three permission states in a fixed cycle: Interactive → Auto-accept → Smart auto-accept → Interactive. The selector's row SHALL always display the currently selected state's name and description.

#### Scenario: Selector cycles through all three states

- **WHEN** the operator activates the permission selector three times in a row
- **THEN** it moves Interactive → Auto-accept → Smart auto-accept, and a fourth activation returns it to Interactive

#### Scenario: The two old toggles no longer appear

- **WHEN** the options step is rendered
- **THEN** no separate "Smart auto-accept" or "Auto-accept permissions" toggle rows exist; the permission selector is the only permission control

### Requirement: The permission selector defaults to Auto-accept

When the launcher opens, the permission selector SHALL start on Auto-accept (ask-level permission requests are allowed automatically; the hard denylist still applies), not on Smart auto-accept and not on Interactive.

#### Scenario: Fresh launcher opens

- **WHEN** the launcher's options step opens with no prior permission selection
- **THEN** the permission selector shows Auto-accept

#### Scenario: Default is sent without operator interaction

- **WHEN** the operator accepts the review without touching the permission selector
- **THEN** the run starts with auto-accept enabled, exactly as if `--yolo` had been passed

### Requirement: The selected permission mode maps to the run's permission flags

The launcher SHALL translate the selected permission state into the same run options the previous toggles produced: Interactive sends neither auto-accept flag, Auto-accept sends the auto-accept (`--yolo`) flag, and Smart auto-accept sends the smart (`--smart`) flag. The judge-model resolution for Smart auto-accept SHALL be unchanged. The launcher MUST NOT emit both flags at once.

#### Scenario: Auto-accept selected

- **WHEN** the review is accepted with the selector on Auto-accept
- **THEN** the run's flags show `--yolo` and not `--smart`

#### Scenario: Smart auto-accept selected

- **WHEN** the review is accepted with the selector on Smart auto-accept
- **THEN** the run's flags show `--smart` and not `--yolo`

#### Scenario: Interactive selected

- **WHEN** the review is accepted with the selector on Interactive
- **THEN** the run's flags show neither `--yolo` nor `--smart`, and permission requests prompt the operator during the run

### Requirement: Other launcher options are unaffected

The permission selector change SHALL NOT alter the other options-step controls (human gates, include dirty tree, keep run directory, progress dashboard, worktree isolation, gateway selection), their defaults, or their mutual couplings (worktree/include-dirty). The review step SHALL keep displaying the resolved permission flags alongside the other flags.

#### Scenario: Review reflects the selector

- **WHEN** the operator reaches the review step with the selector on Smart auto-accept
- **THEN** the review shows the `--smart` flag alongside the other selected flags

#### Scenario: Other toggles keep their behavior

- **WHEN** the operator cycles the permission selector
- **THEN** the other toggles' states, labels, and defaults are unchanged, and worktree/include-dirty remain coupled as before