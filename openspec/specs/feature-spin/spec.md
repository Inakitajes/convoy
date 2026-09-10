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
On successful standalone `convoy spin`, Convoy SHALL print the worktree path, branch, transferred-file outcome, and instruction to run OpenCode's `/move` to continue an external conversation. Spin SHALL NOT fork, copy, summarize, or relocate that session, nor register a feature. Within Convoy the new checkout SHALL become selectable through Git inventory, with managed conversation available independently. The primary creation flow SHALL be New worktree; retained spin SHALL remain an explicit legacy proposal-transfer operation, not adoption or ownership inference.

#### Scenario: Output tells the operator exactly what to do next
- **WHEN** standalone spin completes
- **THEN** output names the directory, branch, moved files, and external `/move` handoff without a feature ID

#### Scenario: Adoption from the work browser
- **WHEN** an operator explicitly requests the retained proposal-transfer flow from the browser
- **THEN** the resulting worktree is selected without creating an association or requiring adoption

#### Scenario: External history has not moved
- **WHEN** the proposal was transferred but an external conversation still belongs to the source checkout
- **THEN** Convoy distinguishes opening a managed conversation from relocating the existing one and does not claim its history moved

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

### Requirement: Legacy transfer has operation-scoped recovery only
The retained spin flow SHALL preserve existing explicit change/prefix selection, deterministic allocation, untracked-file transfer, empty-directory pruning boundaries, and opt-in wrapper behavior. Partial transfer SHALL retain source/destination evidence only until resolved, report moved versus remaining files, and refuse overwriting either copy. No spin result SHALL require registry persistence, receipt creation, or a later bind operation.

#### Scenario: Transfer stops partway through
- **WHEN** some selected untracked artifacts have moved before a failure
- **THEN** Convoy names both locations, preserves all surviving files, and retries by reconciling the pending transfer rather than repeating or registering it blindly
