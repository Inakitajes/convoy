## ADDED Requirements

### Requirement: Areas can be switched off in config
The config SHALL accept `features.worktrees` and `features.specs` as booleans in the global and project files. Each switch SHALL be on unless set to `false`, and the project value SHALL win over the global one per switch. Non-boolean values SHALL be rejected.

#### Scenario: Project re-enables specs
- **WHEN** the global config sets `worktrees: false` and `specs: false` and the project sets `specs: true`
- **THEN** worktree management is off and specs are on

### Requirement: Without worktree management the TUI opens on Pipelines
With `features.worktrees: false`, interactive zero-argument Convoy SHALL open the run launcher as its first screen instead of the worktree board. The launcher SHALL reach Runs and Config, and Specs when specs are on; returning from any of them or from a run SHALL reopen the launcher, and quitting the launcher SHALL end the session. Runs SHALL NOT be isolated in a worktree by default; an explicit `--worktree` flag or `defaults.worktree` SHALL still decide.

#### Scenario: Back from Runs
- **WHEN** the operator opens Runs from the first-screen launcher and goes back
- **THEN** the launcher opens again

#### Scenario: Run on a trunk branch
- **WHEN** a run starts on `main` with no flag and no `defaults.worktree`
- **THEN** it runs in the current checkout

### Requirement: Without specs OpenSpec stays out of the TUI and of runs
With `features.specs: false`, Home SHALL NOT show the Specs destination, OpenSpec actions, or linked specs, and the close action SHALL remain as a git operation. The launcher SHALL NOT offer change selection. Run plans SHALL attach no OpenSpec bundle and SHALL NOT require `--change` or `--manual`, even in a repository with an `openspec/` directory. `--change`, `convoy specs`, and `convoy spin` SHALL refuse with a message naming `features.specs: false`.

#### Scenario: Headless launch in a repo with changes
- **WHEN** a project with specs off and active OpenSpec changes launches without `--change` or `--manual`
- **THEN** the plan builds with no OpenSpec contract

#### Scenario: Explicit change requested
- **WHEN** `--change add-foo` is passed with specs off
- **THEN** the launch refuses, naming `features.specs: false`
