# Spec Delta

## Purpose

Decides which spec tool, OpenSpec or GitHub Spec Kit, supplies a project's changes, and how that tool's files become the change list, run contract, task counts, titles, and lifecycle support Convoy uses.

## ADDED Requirements

### Requirement: One spec tool per project
The effective `features.specs` value SHALL name exactly one spec tool, `openspec` or `speckit`, or SHALL be `false`. Convoy SHALL read changes only from that tool's layout. It SHALL NOT detect the tool from the files present, SHALL NOT read the other tool's layout as a fallback, and SHALL NOT merge changes from both tools.

#### Scenario: Both layouts present
- **WHEN** a checkout holds `openspec/changes/add-login/` and `specs/001-checkout/` and the project sets `specs: speckit`
- **THEN** only `001-checkout` is listed as a change, and `--change add-login` refuses because no active change has that id

#### Scenario: Configured layout absent
- **WHEN** the project sets `specs: speckit` and the checkout has no `specs/` directory
- **THEN** the checkout reads as having no changes, without an error and without reading `openspec/`

### Requirement: Spec Kit features are the changes
With `speckit`, each real directory directly under the checkout's `specs/` that contains `spec.md` SHALL be a change. The change id SHALL be the directory name, verbatim. Directories without `spec.md`, dotfiles, symlinks, and non-directory entries SHALL be ignored. Changes SHALL be listed sorted by id.

#### Scenario: Numbered features listed
- **WHEN** `specs/` holds `001-login/spec.md`, `002-search/spec.md`, a `notes.md` file, and an empty `drafts/` directory
- **THEN** the changes are `001-login` and `002-search`, in that order

### Requirement: Spec Kit active and completed features
A Spec Kit feature SHALL be active when it has no `tasks.md` or its `tasks.md` has at least one unchecked task. It SHALL be completed when its `tasks.md` has at least one task and every task is checked. A feature whose tasks cannot be read SHALL stay active with unknown tasks. Only active features SHALL be selectable for runs, spin, or Propose follow-ups.

#### Scenario: Finished feature leaves the picker
- **WHEN** every task line in `specs/001-login/tasks.md` is `- [x]`
- **THEN** the launcher does not offer `001-login`, `--change 001-login` refuses because it is not an active change, and the specs reader counts it as completed

#### Scenario: Feature still being planned
- **WHEN** `specs/002-search/` holds `spec.md` and `plan.md` but no `tasks.md`
- **THEN** `002-search` is active with no task counts

### Requirement: Spec Kit task counts are read from the file
For a Spec Kit feature, Convoy SHALL count tasks in its `tasks.md` the same way it counts OpenSpec checkboxes, so `- [ ] T001 [P] [US1] …` lines count as tasks. It SHALL NOT invoke any external CLI to count Spec Kit tasks.

#### Scenario: Spec Kit task format
- **WHEN** `tasks.md` holds `- [x] T001 Setup`, `- [ ] T002 [P] [US1] Add model`, and a `## Phase 1` heading
- **THEN** the feature reports 1 of 2 tasks done

### Requirement: Spec Kit contract bundle
When Spec Kit changes are selected for a run, the contract bundle SHALL be `.specify/memory/constitution.md`, when present, followed by every Markdown file under each selected feature directory in the selected order, including nested `contracts/` and `checklists/`, plus every non-Markdown text file under `contracts/`. Files SHALL be repository-relative paths in the run's checkout and attached to every agent step, as OpenSpec bundles are.

#### Scenario: Bundle contents
- **WHEN** a run selects `001-login`, whose directory holds `spec.md`, `plan.md`, `tasks.md`, `research.md`, and `contracts/api.md`, and the repository has a constitution
- **THEN** every agent step receives the constitution and those five files, and no file from another feature

#### Scenario: Non-Markdown contracts
- **WHEN** the selected feature's `contracts/` holds `openapi.yaml`, `schema.graphql`, `auth.proto`, `diagram.png`, and a hidden `.draft.yaml`
- **THEN** the bundle includes `openapi.yaml`, `schema.graphql`, and `auth.proto`, and omits the binary and the hidden file

### Requirement: Spec Kit commands in a step resolve the selected feature
When a run selects exactly one Spec Kit feature, every agent step SHALL run with `SPECIFY_FEATURE_DIRECTORY` set to that feature's absolute directory in the run's checkout, and with `SPECIFY_FEATURE_NO_PERSIST=1`. With zero or several selected features, neither variable SHALL be set by Convoy.

#### Scenario: Single feature run
- **WHEN** a run selects only `001-login` in checkout `/w/app`
- **THEN** each agent step's environment has `SPECIFY_FEATURE_DIRECTORY=/w/app/specs/001-login` and `SPECIFY_FEATURE_NO_PERSIST=1`

#### Scenario: Two features selected
- **WHEN** a run selects `001-login` and `002-search`
- **THEN** Convoy sets neither variable for the steps

### Requirement: Contract wording follows the tool
The default prompt, the shared attachment instructions, and the plan review line SHALL name the configured tool. Under Spec Kit, the scorer's `prd` and `scope` dimensions and the scope review SHALL grade against the feature's user-story acceptance scenarios and its `FR-` and `SC-` ids. Under OpenSpec, they SHALL keep grading against Requirements/Scenarios and delta operations.

#### Scenario: Spec Kit default prompt
- **WHEN** a Spec Kit feature is selected for the `review` pipeline without a typed prompt
- **THEN** the prompt is "Review the attached Spec Kit feature." and the plan review names the feature and the number of attached spec files

#### Scenario: Scorer cites Spec Kit ids
- **WHEN** the scorer grades a run against a Spec Kit feature
- **THEN** its `prd` and `scope` findings cite the feature's `FR-`/`SC-` ids or user-story scenarios rather than OpenSpec requirement names

### Requirement: Spec Kit titles and PR description
A Spec Kit feature's title SHALL be the first `# ` heading of its `spec.md` with a leading `Feature Specification:` removed, or the feature id when no heading exists. The PR description's Why SHALL come from the spec's `**Input**:` line with its `User description:` label and surrounding quotes removed, and it SHALL be omitted when that line is absent.

#### Scenario: Template heading
- **WHEN** `spec.md` starts with `# Feature Specification: Passwordless login` and has `**Input**: User description: "Let users sign in by email link"`
- **THEN** the run title is `Passwordless login` and the PR Why is `Let users sign in by email link`

### Requirement: Archive support depends on the tool
OpenSpec SHALL support archive. Spec Kit SHALL NOT: with `speckit`, every archive action SHALL stay visible but disabled with the reason "Spec Kit has no archive", `convoy worktrees archive` SHALL refuse with that reason before any effect, and no surface SHALL move, rename, or delete a feature directory.

#### Scenario: Archive requested under Spec Kit
- **WHEN** `convoy worktrees archive --worktree /w/app --change 001-login` runs with `specs: speckit`
- **THEN** it exits non-zero, names that Spec Kit has no archive, and leaves the checkout unchanged

### Requirement: Spec Kit reader sections
The specs reader SHALL group a Spec Kit feature's files into Spec (`spec.md`), Plan (`plan.md`), Tasks (`tasks.md`), Design Docs (`research.md`, `data-model.md`, `quickstart.md`, `contracts/**`, merged with per-file headings), and Other. In place of canonical specs, it SHALL show the checkout's constitution, when present, and SHALL show completed features as a count.

#### Scenario: Reading a planned feature
- **WHEN** the operator opens a Spec Kit feature with spec, plan, research, and `contracts/api.md`
- **THEN** the tab strip shows Spec, Plan, and Design Docs, and Design Docs holds research and the API contract under their own headings
