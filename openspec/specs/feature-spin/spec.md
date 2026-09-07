# feature-spin Specification

## Purpose
Deterministically materialize a working context — isolated worktree, conventional branch — for an OpenSpec change proposed on the base checkout, register the feature's stable identity and association durably as part of a successful spin, and hand the operator's existing OpenCode session over to it without summarizing, forking, or touching any session state.

## Requirements

### Requirement: Spin creates a worktree with a deterministically named branch

`convoy spin` run inside a repository checkout with an uncommitted OpenSpec change SHALL create an isolated worktree and a branch whose name is `<prefix>/<change-id>`: the change id verbatim, prefixed by a conventional-commit type inferred deterministically from the change's own delta specs — `feat` when any requirement is ADDED, `change` when every requirement is MODIFIED, `fix` when requirements are only REMOVED — falling back to `feat` when the change has no delta specs yet. The operator SHALL be able to override the prefix (`--prefix`) and the change (`--change <id>`) and, when several uncommitted changes exist without `--change`, spin SHALL list them and stop for a choice rather than guessing. The worktree location SHALL follow the repository's documented worktree convention, exactly as launcher-isolated runs do.

#### Scenario: Happy path spin

- **WHEN** the base checkout holds exactly one uncommitted change `specs-viewer-tabbed-reading` whose delta spec adds a requirement, and the operator runs `convoy spin`
- **THEN** a worktree exists at the location the repository convention dictates, on branch `feat/specs-viewer-tabbed-reading`, and the branch's base is the base ref a launcher-isolated run would use

#### Scenario: Prefix follows the delta operations

- **WHEN** a change's delta spec contains only `MODIFIED Requirements`
- **THEN** the proposed branch is `change/<change-id>`; and when it contains only `REMOVED Requirements`, `fix/<change-id>`

#### Scenario: Ambiguity stops instead of guessing

- **WHEN** two uncommitted changes exist and spin runs without `--change`
- **THEN** spin lists both ids and exits non-zero without creating any worktree

### Requirement: Spin moves the uncommitted change into the worktree

Spin SHALL move the uncommitted `openspec/changes/<id>/` files from the base checkout into the new worktree and SHALL NOT commit anything on either side: committing the proposal is the operator's next step, in the worktree. After moving the files, spin SHALL remove every directory in the selected source change tree that became empty, including intermediate artifact directories and `openspec/changes/<id>/` itself. Cleanup SHALL NOT remove paths outside the selected change tree or directories that still contain any filesystem entry. Changes already committed on the base branch SHALL be left exactly where they are — no reverts, no cleanup commits — because the worktree's base ref carries them along and any overlap resolves at merge time. If the base checkout's working tree is dirty outside `openspec/`, spin SHALL refuse rather than interact with unrelated changes.

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

### Requirement: Spin hands the session over via /move

On successful standalone `convoy spin`, Convoy SHALL print the worktree path, branch, moved-change state, and instruction to run OpenCode's `/move` to continue an existing external conversation. Spin SHALL NOT fork, copy, summarize, or relocate that external session itself. When spin is invoked as adoption within Convoy, Convoy SHALL select the stable feature already registered by spin, preserve its complete association and recovery evidence, and offer its managed conversation action without requiring a shell directory switch. This action SHALL NOT claim to have preserved an external conversation unless the operator explicitly relocated or linked that session through a supported mechanism.

#### Scenario: Output tells the operator exactly what to do next

- **WHEN** standalone spin completes
- **THEN** its output names the directory, branch, and moved files and explains the `/move` handoff for continuing the external conversation

#### Scenario: Adoption from the work browser

- **WHEN** the operator adopts a stranded proposal through Convoy and spin succeeds
- **THEN** the feature identity returned by spin is selected without creating a second record and can open a managed conversation in its worktree without a manual `cd`

#### Scenario: External history has not moved

- **WHEN** adoption creates work but an earlier conversation still belongs to the source checkout
- **THEN** Convoy distinguishes opening a new managed conversation from relocating the external conversation and does not claim its history moved

### Requirement: The global /convoy-spin OpenCode command is opt-in

`convoy opencode install` SHALL install and keep updated a single global OpenCode command file (`~/.config/opencode/commands/convoy-spin.md`, the `/convoy-spin` command) that instructs the agent to run `convoy spin` in the repository and relay its output — nothing more: no branch inference, no pipeline selection, no summaries. No other convoy path SHALL write into the operator's global OpenCode config: `convoy spin` and config saves SHALL NOT install or refresh the command as a side effect. The installer SHALL be idempotent, overwrite only its own file, leave any operator-authored command files (including an operator-authored `spin.md` or `convoy-spin.md` without the convoy marker) untouched, and remove a convoy-owned legacy `spin.md` left by the pre-rename install.

#### Scenario: Opt-in install, no side effects

- **WHEN** `convoy spin` completes without `convoy opencode install` ever having been run
- **THEN** no file has been written into `~/.config/opencode/commands/`

#### Scenario: Install then reinstall

- **WHEN** the install runs twice
- **THEN** exactly one convoy-owned `convoy-spin.md` exists with the current template, and any other command files in the directory are byte-identical to before

#### Scenario: Legacy convoy-owned /spin is migrated away

- **WHEN** the install runs on a machine with a convoy-owned legacy `spin.md` (pre-rename)
- **THEN** `convoy-spin.md` is written and the legacy `spin.md` is removed; an operator-authored `spin.md` without the convoy marker is left untouched

#### Scenario: The command is a thin wrapper

- **WHEN** `/convoy-spin` runs in an OpenCode session
- **THEN** the agent runs `convoy spin` via the shell and reports its output verbatim instead of performing git operations or naming branches itself

### Requirement: Successful spin registers an explicit feature association

Spin SHALL durably register a stable feature identity linking the selected change, resolved base, actual created branch, and registered worktree before reporting success. Conventional initial naming and documented worktree allocation SHALL remain unchanged; the name SHALL not become identity authority for subsequent operations. Spin SHALL continue to transfer proposal files without committing them or modifying OpenCode sessions. Record persistence failure SHALL prevent a success handoff and expose any created context and transferred files with recovery guidance, preserving operator work. Retrying or adopting that partial result SHALL not create a duplicate feature/context. Read-only preview and refusal before creation SHALL not persist a feature.

#### Scenario: Spin establishes ownership

- **WHEN** spin successfully creates a worktree for `add-widget`
- **THEN** its output identifies the stable feature, selected contract, actual branch/worktree, and existing `/move` handoff, and all repository worktrees resolve that same association

#### Scenario: Association persistence fails

- **WHEN** the worktree and proposal transfer succeed but association persistence fails
- **THEN** spin reports the partial operation and exact recovery context without claiming successful registration, committing files, or deleting the transferred proposal

#### Scenario: Rename after spin

- **WHEN** the operator renames a spun-out branch and explicitly rebinds its verified context
- **THEN** the original feature, contract, and history remain associated without requiring restoration of the conventional branch name
