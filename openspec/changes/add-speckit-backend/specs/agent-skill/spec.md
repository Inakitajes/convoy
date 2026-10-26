## MODIFIED Requirements

### Requirement: The skill asks for the OpenSpec contract
In a repository with active changes of the configured spec tool (OpenSpec changes or active Spec Kit features), the skill and every pipeline command SHALL pass `--change <id>` for each change the user named, in their order, and otherwise SHALL list the active changes and ask the user whether to run against one (suggesting the change named like the branch, or the only one), several, or none (`--manual`). They SHALL NOT select a change or fall back to `--manual` without asking. Without a spec tool's changes, or with specs off, they SHALL pass `--manual`.

#### Scenario: No change named
- **WHEN** the user types `/convoy-implement` on branch `feat/add-login` and `openspec/changes/` holds `add-login` and `fix-typo`
- **THEN** the agent lists both, suggests `add-login`, and waits for the user's choice before planning

#### Scenario: Spec Kit features listed
- **WHEN** the project sets `specs: speckit`, the branch is `feat/001-login`, and `specs/` holds active `001-login` and completed `000-setup`
- **THEN** the agent lists only `001-login`, suggests it, and waits for the user's choice before planning
