## ADDED Requirements

### Requirement: Warning observations stay legible on filled surfaces

A warning observation rendered on a filled surface SHALL render as a filled chip: the warning color becomes the chip's background and a contrasting ink carries its text, so the warning stays visible and its value stays legible against the surrounding fill. A warning observation rendered on a plain, unfilled surface SHALL retain its yellow ink. The warning chip's fill and ink SHALL be chosen per palette so the ink contrasts with the fill and the fill remains distinguishable from the accent fill. In particular, the selected row's inline detail (a managed writer's live or uncertain liveness, an unknown working-tree dirt observation, an unknown changes observation) and the worktree detail's filled identity zone (a linked-PR observation that is not known) SHALL use the chip, while the detail's remaining plain observations SHALL keep yellow ink. The conditions that raise a warning and the independence of the underlying observations SHALL NOT change, and no additional observation query SHALL be introduced.

#### Scenario: Live writer in the selected row's inline detail

- **WHEN** a selected worktree holds a live or uncertain managed writer claim and its inline detail renders on the accent fill
- **THEN** the writer value renders on the warning chip fill with contrasting ink, legible against the accent fill

#### Scenario: Unknown observation in the selected row's inline detail

- **WHEN** the selected worktree's working-tree dirt or changes observation is unknown
- **THEN** the unknown value renders on the warning chip fill with contrasting ink instead of yellow ink on the accent fill

#### Scenario: Unavailable linked PR in the detail's filled zone

- **WHEN** the worktree detail's filled identity zone shows a linked-PR observation that is not known
- **THEN** the value renders on the warning chip fill with contrasting ink

#### Scenario: Plain facts keep yellow ink

- **WHEN** a warning observation renders outside any filled surface, among the detail's remaining plain facts
- **THEN** it keeps its yellow ink and does not render as a chip

#### Scenario: Warning chip contrasts across palettes

- **WHEN** the warning chip renders under the dark, light, or neutral palette
- **THEN** its ink contrasts legibly with its fill and its fill remains distinguishable from the accent fill
