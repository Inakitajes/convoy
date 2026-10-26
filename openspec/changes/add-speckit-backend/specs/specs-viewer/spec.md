## MODIFIED Requirements

### Requirement: Specs command discovers OpenSpec state from the filesystem

`convoy specs` SHALL discover checkouts from the current repository's complete Git worktree inventory and discover each checkout's spec artifacts only from that checkout's filesystem, using the configured spec tool's layout. With OpenSpec, active changes SHALL be real directories in its `openspec/changes/` excluding `archive`, dotfiles, and stray non-directory files; canonical specs SHALL be Markdown files under its `openspec/specs/**`. With Spec Kit, active and completed features and the constitution SHALL follow the spec-backends capability. Local archives, or completed Spec Kit features, SHALL surface as counts rather than browsable sections in the board. Read-only OpenSpec task queries SHALL be permitted with filesystem fallback when the CLI is unavailable; Spec Kit task counts SHALL be read from the filesystem only; unreadable evidence SHALL remain unknown. Discovery, refresh, and browsing MUST NOT write domain state, adopt worktrees, or consult feature associations, contract registries, or landing receipts as authority. Absence of active changes or of the launch checkout's spec directory SHALL NOT suppress any Git-registered checkout, including external, main, detached, locked, inaccessible, missing-path, spec-less, or run-less worktrees. Git-stale registrations SHALL be shown as inaccessible while still registered; removed registrations SHALL disappear without tombstones.

#### Scenario: Repo without openspec directory

- **WHEN** a repository has no `openspec/` directory but has Git-registered worktrees
- **THEN** Convoy opens the worktree inventory with available actions rather than exiting merely because no specs were found

#### Scenario: Repo with openspec directory but no active changes

- **WHEN** a selected checkout has `openspec/` but its changes directory holds only `archive`
- **THEN** its active-change section is omitted while its local canonical specs remain browsable and its archived changes surface only as a count

#### Scenario: Archived work remains pending

- **WHEN** a selected checkout contains only archived changes
- **THEN** those local archives surface as a count without a feature record, integration state, or lifecycle history, and their presence does not create a pending-feature entry

#### Scenario: Spec Kit checkout

- **WHEN** the project sets `specs: speckit` and a selected checkout has `specs/001-login/` with unchecked tasks, `specs/000-setup/` with every task checked, and `.specify/memory/constitution.md`
- **THEN** `001-login` is listed as an active change, completed features surface as a count of 1, the constitution is browsable, and `openspec/` is not read
