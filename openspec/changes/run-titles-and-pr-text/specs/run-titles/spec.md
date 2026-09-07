## Purpose

Names a run for humans — in the runs browser and run history records — from the semantic context Convoy already holds (the attached change's proposal, the worktree branch), so a run launched from a spec pointer is never titled by the pointer prompt's first line.

## ADDED Requirements

### Requirement: Run titles follow a deterministic precedence

At run start Convoy SHALL resolve a human title for the run from the first available source, in order: the proposal title of the OpenSpec change the run is attached to (resolved by the shared branch↔change rule); otherwise a humanized form of the run's feature branch name — the conventional prefix dropped and the slug rendered as words; otherwise the prompt's first meaningful line. The prompt's first line SHALL be used only when the run has no attached change and no feature branch. Title resolution MUST NOT require a model call.

#### Scenario: Run attached to a change is titled by the proposal

- **WHEN** a run launches on branch `feat/specs-viewer-tabbed-reading` and the branch resolves to an OpenSpec change whose proposal is titled "Tabbed reading in the specs viewer"
- **THEN** the run's title is "Tabbed reading in the specs viewer", not the prompt's first line

#### Scenario: Branch-named run without a change

- **WHEN** a run launches on a model-named branch `feat/quiet-notifications` that resolves to no OpenSpec change
- **THEN** the run's title is derived from the branch slug ("quiet notifications")

#### Scenario: Prompt-only run keeps the legacy fallback

- **WHEN** a run launches without a worktree or attached change from a prompt whose first meaningful line is "Refactor the retry loop"
- **THEN** the run's title is that first line

### Requirement: Run titles are persisted and stable

The resolved title SHALL be persisted with the run's metadata at run start. Run discovery surfaces — the runs browser and run history records — SHALL prefer the persisted title. Once persisted, the title MUST NOT change during the run, after a goal-loop reset, or after workspace cleanup. Legacy run records persisted before this behavior SHALL remain readable: when no stored title exists, discovery SHALL fall back to the current first-heading-of-the-prompt derivation without rewriting the record.

#### Scenario: History survives workspace cleanup

- **WHEN** a completed run's workspace is cleaned up and the runs browser later lists it
- **THEN** the run displays its persisted title rather than a workspace-derived placeholder

#### Scenario: Prompt rewrite does not rename a live run

- **WHEN** a run's stored prompt document is rewritten during a goal-loop reset
- **THEN** the run's title stays the persisted one

#### Scenario: Legacy record without a stored title

- **WHEN** run discovery reads a run record that predates persisted titles
- **THEN** the run is titled by the prompt-document first-line fallback and the record is left unmodified
