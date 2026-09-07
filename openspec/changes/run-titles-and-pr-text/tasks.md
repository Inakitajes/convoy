## 1. Title resolution module

- [x] 1.1 Create `src/run-title.ts` with pure helpers `humanizeBranchSlug(branch)` (drop conventional `type/` prefix, `-`/`_` → spaces, collapse whitespace, `stripControlBytes`) and `resolveRunTitle({ changeTitle, branch, prompt })` implementing the precedence change title → humanized slug → `firstMeaningfulLine(prompt)`; no truncation inside the module. Verify with unit tests covering each precedence level, prefix variants (`feat/x`, `change/y`, no slash), and empty inputs.
- [x] 1.2 Add a change-title lookup helper that resolves `branchIdFromBranch(branch)` to the change id and reuses the existing proposal-title reader (`titleFromProposal`-backed, as the control board does) against a target directory, returning `undefined` when the change or proposal is missing. Verify: unit test with a temp openspec tree (proposal present, absent, unreadable) resolves accordingly.

## 2. Title persistence and discovery

- [x] 2.1 Add optional `title` to `RunMetadata`; resolve it once in `newMetadata`/`openRunMetadata` (`src/metadata.ts`) from the workspace branch, prompt document, and change-title lookup, and never overwrite an existing value. Verify: unit test that a metadata file written with `title` round-trips, and that re-opening an existing record does not recompute or replace it.
- [x] 2.2 Update `runTitle` in `src/runs.ts` and the history-entry title path in `src/finalization/compact.ts` to prefer the stored title, keeping the current prompt-document first-heading fallback for records without one, preserving the 60-char display truncation in the runs list only. Verify: unit tests — stored title wins; legacy record (no `title`) falls back without writing; a record whose prd changed after goal-loop reset keeps the stored title.

## 3. PR text composition

- [x] 3.1 Replace `prBody` in `src/publish.ts` with the deterministic composer over `{ cwd, runDir, branch }`: title = conventional type from the branch prefix (none if unrecognizable) + change proposal title else humanized slug, bounded via `capSubjectWithin` at 72, never the prompt first line. Verify: unit tests pin title format for `feat/add-attach-flow` with and without an attached change, a prefixed non-change branch (`fix/quiet-notifications`), an unprefixed branch, and the 72-char cap.
- [x] 3.2 Compose the body sections per design D4: `## Why` (proposal Why section, else capped prompt-document excerpt), `## What` (`reports/run-reporter.md`, else finalization commit message body, else capped `SUMMARY.md` excerpt), `## How tested` (test/validation step reports by step-name substring, else explicit not-covered line); drop the `Run: <title>` line; cap every section. Verify: unit tests with seeded `runDir`/target fixtures covering each fallback level and the not-covered disclosure.
- [x] 3.3 Assert determinism at the seam: `prepare`→`apply` twice over identical persisted state produces identical title/body, and a missing source never blocks PR creation. Verify: extend `test/publish.test.ts` (and the fake runner) with a repeat-composition test and a missing-sources publish success case.

## 4. Integration and regression

- [x] 4.1 Run the full test suite (`bun test`) and fix any regressions in `test/publish.test.ts`, `test/runs*.test.ts`, and finalization/compact tests that encode the old first-line behavior. Verify: suite passes.
- [x] 4.2 End-to-end sanity on a scratch repo: launch a run from a change (spin-style branch), let it title from the proposal, complete it, and publish — the PR preview shows the conventional title and the three body sections. Verify: `convoy runs` list shows the proposal title, and a dry review of the composed PR text (or a recorded `gh` run) shows the structured body.
