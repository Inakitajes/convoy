## MODIFIED Requirements

### Requirement: Create pull request is the only run-publication action

Run completion SHALL expose `Create pull request` in the command palette independently of compaction success, with no manual finish or standalone push action. Existing inspection and navigation actions SHALL remain. Selecting this action SHALL explicitly authorize a normal push of the current verified feature branch to a disclosed repository/remote followed by PR creation; it MUST NOT publish automatically at run completion, force-push, delete branches, or remove worktrees. The action SHALL revalidate current branch state rather than using an old run's HEAD as authority. The PR title and body SHALL be composed from persisted run and change context under a deterministic precedence — the branch's conventional prefix supplies the commit type and the attached change's proposal title, else a humanized branch slug, supplies the subject — never from the prompt's first line. The PR body SHALL present Why, What, and How-tested sections drawn from the change proposal, the run's distilled recap (or the compacted run commit's message when no recap exists), and test/validation reports, each falling back mechanically when its source is absent. Missing GitHub CLI/authentication or an unsafe/unresolved repository state SHALL disable publishing with actionable guidance. Headless output SHALL provide guidance only unless a separate explicit publication request exists.

#### Scenario: Deliberate PR creation

- **WHEN** the operator selects Create pull request on a safe feature branch
- **THEN** Convoy performs a normal push and creates the PR, displaying its URL without any separate push choice

#### Scenario: Push is rejected or PR already exists

- **WHEN** the normal push is rejected, or a matching open PR already exists
- **THEN** Convoy respectively stops before creating a PR with no force-push fallback, or opens/reports the existing PR rather than creating a duplicate

#### Scenario: GitHub CLI is unavailable

- **WHEN** a completed run is viewed without a usable GitHub CLI
- **THEN** Create pull request is unavailable with setup/manual guidance, while inspection remains usable

#### Scenario: Historical path has been reused

- **WHEN** an old run's former worktree path now belongs to another feature
- **THEN** publication resolves the old run's feature through its current verified association or explains why it is unavailable, and never pushes the replacement branch

## ADDED Requirements

### Requirement: PR text is composed deterministically from persisted context

PR title and body composition SHALL depend only on state persisted before publication — run metadata, the change proposal, and the run's own reports — so composing twice from the same run state yields the same text. A publication whose PR creation previously failed SHALL retry with the same title and body. Composition MUST NOT require a model call and MUST NOT block publication when a source document is absent: each missing source degrades to its mechanical fallback and the PR is still created.

#### Scenario: Retry after a failed PR creation

- **WHEN** a push succeeds but PR creation fails, and the operator retries publication
- **THEN** the retry composes the same title and body and reuses the push, locating the existing PR rather than creating a duplicate

#### Scenario: Sources are absent

- **WHEN** a run publishes without an attached change proposal or validation reports
- **THEN** the PR is still created, with the affected sections falling back to branch- and metadata-derived content and the How-tested section disclosing what was not covered

#### Scenario: Conventional title within the subject budget

- **WHEN** a run on branch `feat/add-attach-flow` publishes and the branch resolves to a change titled "Attachment flow for run reports"
- **THEN** the PR title is `feat: <composed subject>` naming that change, bounded to the shared subject budget with word-boundary shortening
