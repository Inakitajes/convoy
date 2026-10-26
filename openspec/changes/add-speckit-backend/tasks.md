# Tasks

## 1. Spec tool choice

- [x] 1.1 Change `features.specs` to accept `openspec | speckit | false` (default `openspec`, project wins, `true` rejected naming the accepted values) in parsing, merging, serialization, the commented template, and the config screen toggle; verify `test/config.test.ts` and `test/config-files.test.ts`.
- [x] 1.2 Add `src/spec-tools.ts` with the descriptor table and `specToolFor(config)` (design D1), register the OpenSpec descriptor over the existing readers in `src/openspec.ts`, `src/checkout-openspec.ts`, and `src/task-counts.ts`, and replace every `featuresOf(config).specs` check with it; verify the unchanged OpenSpec suites (`test/openspec.test.ts`, `test/checkout-openspec.test.ts`, `test/control-board.test.ts`) and a new `test/spec-tools.test.ts` for descriptor lookup and specs off.
- [x] 1.3 Document the new values in `docs/configuration.md` and `--help`.

## 2. Spec Kit readers

- [x] 2.1 Add `src/speckit.ts`: list features under `specs/` (real directories containing `spec.md`, sorted, ignoring dotfiles, symlinks, and files), split active from completed by `tasks.md`, read the constitution, and count tasks with the shared checkbox count and no CLI; verify `test/speckit.test.ts` against fixtures copied from the Spec Kit v1.2 templates.
- [x] 2.2 Add Spec Kit title (`# Feature Specification:` stripped, falling back to the id) and Why (from `**Input**: User description:`, omitted when absent); verify `test/speckit.test.ts`, `test/run-title.test.ts`, and `test/publish.test.ts`.
- [x] 2.3 Register the Spec Kit descriptor, and make the board fingerprint read the descriptor's roots (`specs/`, `.specify/`); verify `test/spec-tools.test.ts` and `test/board-refresh.test.ts`.

## 3. Runs

- [x] 3.1 Rename `RunPlan.openspec` to `RunPlan.specs` as `SpecBundle { tool, changeIds, specFiles }`, build it through the descriptor in `buildReviewedPlan` (refusals name the tool's change noun; the empty-state hint names its authoring command), and have resume use the frozen bundle's tool; verify `test/openspec.test.ts`, `test/cli-regression.test.ts`, and a Spec Kit bundle case covering constitution, nested `contracts/`, and selection order.
- [x] 3.2 Set `SPECIFY_FEATURE_DIRECTORY` and `SPECIFY_FEATURE_NO_PERSIST=1` on agent steps when exactly one Spec Kit feature is selected, and set neither otherwise; verify `test/runner-hosted.test.ts`.
- [x] 3.3 Make the default prompt, the system prompt's attachment sentence, the launcher picker intro, `run-review`, and `review-tui` name the tool; verify `test/launch-tui.test.ts`, `test/run-review.test.ts`, and `test/runner-hosted.test.ts`.
- [x] 3.4 Add the Spec Kit paragraph to `prompts/quality-scorer.md`, `prompts/quality-score-report.md`, and `prompts/review-scope.md` (grade against acceptance scenarios and `FR-`/`SC-` ids; no delta operations); verify `test/quality-score.test.ts`, asserting each prompt carries both tool paragraphs.
- [x] 3.5 Rewrite `docs/openspec.md` as spec-tool workflows covering both layouts, and update its links from `docs/README.md` and `README.md`.

## 4. Lifecycle

- [x] 4.1 Make spin read the change root, dirty-path tolerance, and branch prefix from the descriptor (`feat` for Spec Kit) and never move `.specify/feature.json`; verify `test/spin.test.ts`, `test/spin-registration.test.ts`, and `test/change-prefix.test.ts`.
- [x] 4.2 Gate archive on `descriptor.archives`: `convoy worktrees archive` refuses before journaling, Home and the specs browser show the archive action disabled with "Spec Kit has no archive", and close offers no archive inputs; verify `test/worktree-commands.test.ts`, `test/close-tui.test.ts`, `test/home-tui.test.ts`, and `test/specs-actions-menu.test.ts`.
- [x] 4.3 Discover the Spec Kit authoring commands (`speckit.specify`, then `speckit-specify`), including Claude `.claude/skills/<name>/SKILL.md`, and name the command looked for when none is found; verify `test/propose-service.test.ts` and `test/conversations.test.ts`.
- [x] 4.4 Update `docs/worktrees.md` for spin, archive, and close under Spec Kit.

## 5. Specs reader and agents

- [x] 5.1 Group Spec Kit artifacts into Spec, Plan, Tasks, Design Docs (merged with per-file headings), and Other; show the constitution in the canonical slot and completed features as a count in the TUI and the plain listing; verify `test/specs.test.ts`, `test/specs-reader.test.ts`, and `test/specs-board.test.ts`.
- [x] 5.2 Make the Convoy skill and pipeline commands list active changes for the configured tool (completed Spec Kit features excluded) and keep asking before choosing; update `skills/convoy/SKILL.md`, `skills/commands/pipeline.md`, and `docs/agents.md`; verify `test/skill-install.test.ts`.

## 6. Integration

- [ ] 6.1 Run an end-to-end check in a scratch Spec Kit repo (`specify init --integration claude` or the opencode integration), then `convoy --change 001-x -p review --plan`: the plan names the Spec Kit feature, lists the constitution and the feature files, and `convoy specs` shows the feature. Then run the full suite and typecheck.

The real CLI scratch-repository plan/list regression passes using Spec Kit v1.2-style files, including the constitution, nested contracts, and completed-feature count. An actual `specify init` remains unverified because the `specify` CLI is not installed; no dependency was installed. Final full-suite validation is recorded in the implementation phase report.
