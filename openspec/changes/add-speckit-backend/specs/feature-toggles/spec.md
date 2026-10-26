## MODIFIED Requirements

### Requirement: Areas can be switched off in config
The config SHALL accept `features.worktrees` as a boolean and `features.specs` as `openspec`, `speckit`, or `false`, in the global and project files. `worktrees` SHALL be on unless set to `false`. `specs` SHALL be `openspec` unless set. The project value SHALL win over the global one per switch. Other values SHALL be rejected, including `specs: true`, with a message naming the accepted values.

#### Scenario: Project re-enables specs
- **WHEN** the global config sets `worktrees: false` and `specs: false` and the project sets `specs: speckit`
- **THEN** worktree management is off and specs are on with Spec Kit

#### Scenario: Boolean true is rejected
- **WHEN** the project config sets `features.specs: true`
- **THEN** loading the config fails, naming `features.specs` and the accepted values `openspec`, `speckit`, and `false`

#### Scenario: Default tool
- **WHEN** neither config sets `features.specs`
- **THEN** specs are on with OpenSpec

### Requirement: Without specs OpenSpec stays out of the TUI and of runs
With `features.specs: false`, Home SHALL NOT show the Specs destination, spec-tool actions, or linked specs, and the close action SHALL remain as a git operation. The launcher SHALL NOT offer change selection. Run plans SHALL attach no spec bundle and SHALL NOT require `--change` or `--manual`, even in a repository with an `openspec/` or `specs/` directory. `--change`, `convoy specs`, and `convoy spin` SHALL refuse with a message naming `features.specs: false`.

#### Scenario: Headless launch in a repo with changes
- **WHEN** a project with specs off and active OpenSpec changes or Spec Kit features launches without `--change` or `--manual`
- **THEN** the plan builds with no spec contract

#### Scenario: Explicit change requested
- **WHEN** `--change add-foo` is passed with specs off
- **THEN** the launch refuses, naming `features.specs: false`
