# Proposal

## Why

Convoy only reads OpenSpec: a run's contract, the specs reader, spin, archive, close, Propose, and the scorer prompts all assume `openspec/changes/<id>/`. Projects that plan with GitHub Spec Kit (`specs/NNN-slug/` with `spec.md`, `plan.md`, `tasks.md`, and `.specify/memory/constitution.md`) get no contract at all and must run every pipeline with `--manual`. Spec Kit is now widely used and its feature directories map closely to OpenSpec changes, so one project-level choice can give those projects the same spec-driven runs.

## What Changes

- **BREAKING** `features.specs` takes `openspec`, `speckit`, or `false` instead of a boolean. It defaults to `openspec`. `true` is rejected with a message that names the accepted values. The project setting wins over the global one. One spec tool applies per project; Convoy never auto-detects it and never falls back from one tool to the other.
- With `speckit`, a Spec Kit **feature** is a selectable **change**. The id is its directory name under `specs/`, and `--change <id>`, the launcher picker, and the specs reader keep their current vocabulary.
  - A feature is active while it has no `tasks.md` or still has unchecked tasks.
  - A feature whose tasks are all checked counts as completed. It shows up as a count, the way OpenSpec archives do.
- The contract bundle for Spec Kit is the constitution plus every Markdown file in the selected feature (spec, plan, tasks, research, data model, quickstart, contracts, checklists), attached to every agent step. When exactly one feature is selected, agent steps run with `SPECIFY_FEATURE_DIRECTORY` set to it, so Spec Kit commands inside a step resolve the right feature.
- The scorer and scope prompts grade against the feature's user-story acceptance scenarios and `FR-`/`SC-` ids under Spec Kit, and against Requirements/Scenarios under OpenSpec.
- Titles come from the `# Feature Specification:` heading. The PR body's Why comes from the spec's `**Input**` description.
- Spin moves an uncommitted `specs/<id>/`. The branch prefix defaults to `feat`, because Spec Kit has no delta operations.
- Archive is unavailable under Spec Kit: the action is shown disabled with that reason, `convoy worktrees archive` refuses, and close offers no archive inputs (sync, then squash).
- Propose invokes `speckit.specify` or `speckit-specify`. For Claude, discovery also reads `.claude/skills/<name>/SKILL.md`.
- The specs reader shows Spec Kit tabs: Spec, Plan, Tasks, a merged Design Docs tab (research, data model, quickstart, contracts), and Other. The canonical section becomes the constitution.

## Capabilities

### New Capabilities

- `spec-backends`: the project's choice of spec tool, and how each tool's files become changes, the contract bundle, task counts, titles, and authoring/archive support.

### Modified Capabilities

- `feature-toggles`: `features.specs` becomes a tool choice or `false`.
- `specs-viewer`: discovery reads the configured tool's layout instead of always reading `openspec/`.
- `feature-spin`: the moved directory and the prefix inference depend on the tool.
- `worktree-operations`: archive is refused for a tool without archive support.
- `feature-close`: close offers no archive inputs when the tool has no archive.
- `work-context`: Propose uses the configured tool's authoring command.
- `agent-skill`: the skill lists changes for the configured tool.

## Impact

- New `src/speckit.ts`, plus a `SpecBackend` contract shared with `src/openspec.ts`. Every OpenSpec-specific reader is called through it: `src/checkout-openspec.ts`, `src/specs.ts`, `src/task-counts.ts`, `src/change-selection.ts`, `src/run-title.ts`, `src/publish.ts`, `src/spin.ts`, `src/worktree.ts`, `src/worktree-commands.ts`, `src/operation-reconcile.ts`, `src/board-refresh.ts`, `src/propose-service.ts`, and `src/conversations.ts`.
- `src/config.ts` (`features.specs` schema and template), `src/cli.ts` (plan building, refusals, help), `src/runner.ts` (attachment wording, step env), `src/launch-tui.ts`, `src/home-tui.ts`, `src/specs-browser.ts`, `src/review-tui.ts`, `src/run-review.ts`.
- Prompts: `prompts/quality-scorer.md`, `prompts/quality-score-report.md`, `prompts/review-scope.md`. Skills: `skills/convoy/SKILL.md`, `skills/commands/pipeline.md`.
- Docs: `docs/openspec.md` (becomes spec-tool workflows), `docs/configuration.md`, `docs/worktrees.md`, `docs/agents.md`.
- No new runtime dependency: Spec Kit files are read directly, and Convoy never calls the `specify` CLI.
