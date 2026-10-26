## MODIFIED Requirements

### Requirement: Spin creates a worktree with a deterministically named branch

`convoy spin` run inside a repository checkout with an uncommitted change of the configured spec tool SHALL create an isolated worktree and a branch whose name is `<prefix>/<change-id>`: the change id verbatim, prefixed by a conventional-commit type inferred deterministically. For OpenSpec the type comes from the change's own delta specs — `feat` when any requirement is ADDED, `change` when every requirement is MODIFIED, `fix` when requirements are only REMOVED — falling back to `feat` when the change has no delta specs yet. For Spec Kit, which has no delta operations, the type SHALL be `feat`. The operator SHALL be able to override the prefix (`--prefix`) and the change (`--change <id>`) and, when several uncommitted changes exist without `--change`, spin SHALL list them and stop for a choice rather than guessing. The worktree location SHALL follow the repository's documented worktree convention, exactly as launcher-isolated runs do.

#### Scenario: Happy path spin

- **WHEN** the base checkout holds exactly one uncommitted change `specs-viewer-tabbed-reading` whose delta spec adds a requirement, and the operator runs `convoy spin`
- **THEN** a worktree exists at the location the repository convention dictates, on branch `feat/specs-viewer-tabbed-reading`, and the branch's base is the base ref a launcher-isolated run would use

#### Scenario: Prefix follows the delta operations

- **WHEN** a change's delta spec contains only `MODIFIED Requirements`
- **THEN** the proposed branch is `change/<change-id>`; and when it contains only `REMOVED Requirements`, `fix/<change-id>`

#### Scenario: Ambiguity stops instead of guessing

- **WHEN** two uncommitted changes exist and spin runs without `--change`
- **THEN** spin lists both ids and exits non-zero without creating any worktree

#### Scenario: Spec Kit feature spin

- **WHEN** the project sets `specs: speckit` and the base checkout holds exactly one uncommitted feature `003-export`
- **THEN** spin creates a worktree on branch `feat/003-export`

### Requirement: Spin moves the uncommitted change into the worktree

Spin SHALL move the uncommitted change directory of the configured spec tool — `openspec/changes/<id>/` for OpenSpec, `specs/<id>/` for Spec Kit — from the base checkout into the new worktree and SHALL NOT commit anything on either side: committing the proposal is the operator's next step, in the worktree. After moving the files, spin SHALL remove every directory in the selected source change tree that became empty, including intermediate artifact directories and the change directory itself. Cleanup SHALL NOT remove paths outside the selected change tree or directories that still contain any filesystem entry. Changes already committed on the base branch SHALL be left exactly where they are — no reverts, no cleanup commits — because the worktree's base ref carries them along and any overlap resolves at merge time. If the base checkout's working tree is dirty outside the tool's change root (`openspec/`, or `specs/` for Spec Kit), spin SHALL refuse rather than interact with unrelated changes. Spin SHALL NOT move `.specify/feature.json`.

#### Scenario: Uncommitted change travels

- **WHEN** spin succeeds on an uncommitted change
- **THEN** `openspec/changes/<id>/` no longer exists physically in the base checkout and exists untracked in the worktree, and `git status` on the base checkout shows no trace of it

#### Scenario: Nested artifact directories are removed

- **WHEN** an uncommitted change contains artifacts below nested directories such as `specs/<capability>/spec.md` and spin succeeds
- **THEN** every now-empty source directory from the artifact's former parent through `openspec/changes/<id>/` no longer exists in the base checkout

#### Scenario: Cleanup is isolated to the selected change

- **WHEN** the operator uses `--change <id>` to spin one of several uncommitted changes
- **THEN** spin removes only the selected change's emptied source directories and leaves every other active change in the base checkout intact

#### Scenario: Committed change on main is untouched

- **WHEN** the target change's files are already committed on the base branch
- **THEN** spin creates the worktree (the files arrive via the base ref) and reports that nothing was moved, leaving the base branch's history and change directory untouched

#### Scenario: Spec Kit feature travels

- **WHEN** the project sets `specs: speckit` and spin succeeds on uncommitted `specs/003-export/` with `contracts/api.md`
- **THEN** `specs/003-export/` exists untracked in the worktree, no longer exists in the base checkout, and `.specify/feature.json` stays where it was
