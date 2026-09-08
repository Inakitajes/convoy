## MODIFIED Requirements

### Requirement: Worktree location resolution order

For allocation of a new isolated worktree, Convoy SHALL resolve the proposed directory from, in order: the repository's documented worktree convention, the configured `defaults.worktreeLocation`, and the built-in default. The first usable location SHALL be used; a declared or configured location that is not usable SHALL be skipped in favor of the next option. This resolution SHALL apply only to new-worktree allocation and preview, never to discovery or reconstruction of an existing target. The selected base and actual destination SHALL be available for operator review/edit before creation; a changed destination after review SHALL require renewed review rather than silently allocating elsewhere. Existing built-in location, recognized machine-readable documentation markers, placeholder and home expansion, branch-slug separation, collision handling, and conventional branch-naming guarantees SHALL remain effective.

#### Scenario: Repo convention wins over config

- **WHEN** repository documentation declares a usable worktree convention and `defaults.worktreeLocation` is also set
- **THEN** the proposed new-worktree destination uses the documented convention and is shown for review before creation

#### Scenario: Config wins over built-in default

- **WHEN** no repository convention is declared but `defaults.worktreeLocation` is usable
- **THEN** the proposed new-worktree destination uses the configured template

#### Scenario: Unusable declared location falls back

- **WHEN** a documented or configured location cannot be used because it is missing, non-writable, or unsafe
- **THEN** allocation falls back to the next usable option, ultimately the built-in default, and review shows the actual proposed destination

#### Scenario: Existing checkout differs from current convention

- **WHEN** a registered worktree lives outside every current location template
- **THEN** discovery and actions use its current validated Git location rather than allocating or searching for a convention-derived replacement

### Requirement: Consistent path across decision points

New-worktree creation, collision handling, and launcher preview SHALL use the same documented/configured/default location allocation. A path already considered taken SHALL never be handed to `git worktree add` again. Review SHALL show the actual selected branch, base, and destination, and a collision or changed target after review SHALL require renewed review rather than a silent change. Existing targets SHALL be discovered from the current repository's Git worktree inventory and validated using the repository, Git administrative directory and registration, canonical checkout path, actual branch or detached state, and observed HEAD OID before effects. These SHALL be observed inputs, not a minted worktree ID, FeatureRecord, FeaturePlanLink, ownership manifest, receipt, or association. A worktree moved through Git SHALL appear at its current location on inventory refresh without adoption or rebinding; branch renaming SHALL NOT rename or recreate its directory to match current spelling. Historical run paths and branch names SHALL remain immutable observations, not current mutation targets. A reused path or branch name or otherwise unprovable continuity SHALL require explicit fresh target review for actions while preserving read-only history and all existing resume/recovery checks. Branch slug templates SHALL remain allocation/display conventions only. User-facing navigation SHALL call these checkouts Worktrees, not Spaces, without imposing slug or no-whitespace restrictions on human titles or rejecting otherwise valid paths solely because they contain spaces.

#### Scenario: Suffix avoids collision at a declared location

- **WHEN** worktree allocation finds the resolved branch location occupied
- **THEN** the existing suffix policy selects a non-colliding branch/location consistently for review and creation without recording a feature association

#### Scenario: Destination becomes occupied after review

- **WHEN** another process occupies the reviewed destination before creation
- **THEN** creation stops for renewed destination review rather than passing the taken path to `git worktree add` or silently switching destinations

#### Scenario: Close and continue locate a non-default worktree

- **WHEN** close or continue explicitly targets a registered worktree outside the built-in default location
- **THEN** Convoy validates its actual Git inventory and checkout facts instead of reconstructing a path or consulting an association

#### Scenario: Finish locates a non-default worktree

- **WHEN** an operator requests a supported completion operation such as close for an explicitly selected non-default worktree
- **THEN** Convoy resolves and validates the target from Git inventory without reconstructing a branch-derived location, and the retired `convoy finish` spelling remains unavailable rather than becoming a compatibility path

#### Scenario: Worktree moves outside Convoy

- **WHEN** Git reports a worktree moved to a new path
- **THEN** inventory refresh shows the new location without binding, while actions validate current facts and historical run paths remain unchanged

#### Scenario: Old path is reused

- **WHEN** an old run's path now hosts a newly registered checkout with the same branch spelling but unprovable continuity
- **THEN** current inventory can show that checkout independently, but the historical run is not redirected there and an action requires explicit fresh target review and its existing safety checks

#### Scenario: Branch rename leaves its directory alone

- **WHEN** a registered worktree's branch is renamed and no longer matches its directory slug
- **THEN** actions use current validated Git observations without moving the directory or requiring rebinding

#### Scenario: Valid destination contains spaces

- **WHEN** the operator reviews an otherwise valid destination such as `~/dev/client worktrees/report flow`
- **THEN** location handling preserves that path with correct argument handling rather than rejecting it because Worktrees is the navigation brand
