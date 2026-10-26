## MODIFIED Requirements

### Requirement: Propose uses the project's authoring workflow
Propose SHALL invoke the available project authoring workflow of the configured spec tool in the selected checkout: `opsx-propose` (or a command ending in `propose`) for OpenSpec, `speckit.specify` or `speckit-specify` for Spec Kit, discovered from the harness's commands and, for Claude, also from `.claude/skills/<name>/SKILL.md`. If unavailable, Convoy SHALL explain the condition, naming the command it looked for, and keep ordinary conversation usable without silently installing global commands. On return it SHALL refresh that checkout's local changes; new artifacts SHALL be usable without association review or registry writes. A differing change ID SHALL NOT rename the branch. Later pipeline/archive inputs SHALL still require explicit selection.

#### Scenario: Propose produces a differently named change
- **WHEN** authoring produces a change whose ID differs from the worktree or branch name
- **THEN** the change appears under that checkout without rebinding, registration, or renaming

#### Scenario: Authoring workflow unavailable
- **WHEN** the project has no supported proposal workflow
- **THEN** Convoy reports that condition, offers conversation, and does not claim a proposal ran

#### Scenario: Spec Kit propose with Claude
- **WHEN** the project sets `specs: speckit`, the harness is Claude, and the checkout has `.claude/skills/speckit-specify/SKILL.md`
- **THEN** Propose invokes `/speckit-specify` in that checkout and the new `specs/<id>/` appears as an active change on return
