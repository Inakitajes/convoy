## Why

Run titles and pull-request text are derived mechanically from the prompt's first line: a spec-launched run shows up in run history as "implement the attach", and that same first line becomes the GitHub PR title while the PR body is a raw dump of the first 40 lines of `SUMMARY.md` (which the pipeline itself describes as a mechanical dump). Both artifacts already have better semantic sources — the worktree branch (cheap-model-named or `<prefix>/<change-id>`) and the OpenSpec change's proposal — so the derived text lags the quality of the data Convoy already holds.

## What Changes

- Run titles get a deterministic precedence chain: the attached OpenSpec change's proposal title first, then a humanized form of the worktree branch slug, then the prompt's first meaningful line as a legacy last resort.
- The resolved title is persisted in run metadata at run start, so run history survives workspace cleanup without recomputing from `prd.md`, and a run's title never changes after launch.
- PR creation composes a conventional, change-aware title — type from the branch's conventional prefix, subject from the change's proposal title or the humanized branch slug, bounded to the shared 72-column subject budget — instead of the prompt's first line.
- PR body becomes a structured Why / What / How-tested template fed from the change proposal, the run's distilled recap, and test/validation reports; the raw `SUMMARY.md` dump and the `Run: <title>` header line disappear.
- No new model calls: title and PR text are composed deterministically from sources Convoy already persists; model-composed text is explicitly out of scope.

## Capabilities

### New Capabilities

- `run-titles`: how Convoy resolves, persists, and displays a run's human title across the runs browser, run history records, and title consumers.

### Modified Capabilities

- `run-finalization`: the "Create pull request is the only run-publication action" requirement's PR title/body seeding rule is replaced by structured, persisted composition with a deterministic precedence and mechanical fallback.

## Impact

- `src/publish.ts` (`prBody` and its sources), `src/runs.ts` (`runTitle`), `src/finalization/compact.ts` (`runTitleFrom`), the metadata writer/reader (new persisted title field), and the launch path that writes run metadata (`src/cli.ts`, `src/launch-tui.ts`, `src/spin.ts`, `src/attach.ts`).
- Tests covering PR text composition and run title derivation (`test/publish.test.ts`, runs-history tests).
- Existing run records without a persisted title remain readable via the legacy `prd.md` fallback; no migration is required.
