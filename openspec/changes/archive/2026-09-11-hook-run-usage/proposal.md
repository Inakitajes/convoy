## Why

Post-hooks receive `CONVOY_RUN_STATUS`, `CONVOY_RUN_SCORE` and the `CONVOY_GOAL_*` outcome (`src/hooks.ts`, `runHookCommand`), but nothing about what the run spent or how long it worked. The runner invokes them while it still holds the run's metadata store in memory, and that store already carries every phase's executor cost, tokens, advisor cost and duration (`PhaseMetadata` in `src/metadata.ts`). A hook that wants to comment "this run cost $3.20 in 14 min" on the pull request, post the figure to a webhook, or fail a CI job above a budget has to re-open `$CONVOY_RUN_DIR/metadata.json` and reimplement the aggregation `convoy runs` performs — and every such hook does it slightly differently.

## What Changes

- Add a run-level usage aggregate to the metadata store: total cost (executor plus advisor), advisor cost, tokens and run duration, summed over every recorded phase in memory, with the same "absent when nothing was recorded" rule `CONVOY_RUN_SCORE` follows.
- Pass that aggregate to post-hooks — on success and on failure — as `CONVOY_RUN_COST`, `CONVOY_RUN_ADVISOR_COST`, `CONVOY_RUN_TOKENS_{INPUT,OUTPUT,REASONING,CACHE_READ,CACHE_WRITE,TOTAL}` and `CONVOY_RUN_DURATION_MS`, with a fixed, documented format.
- Document the variables in the README hooks paragraph with a post-hook that comments cost and duration on the PR and a one-line budget guard.
- Pre-hooks, the dashboard, `convoy runs`, `SUMMARY.md` and the metadata file format are untouched; Convoy still never publishes anything itself — the hook decides what to do with the numbers.

## Capabilities

### New Capabilities

- `hook-run-usage`: post-hooks receive the run's aggregated usage — cost, advisor cost, tokens and duration — from the run's own metadata, so a project can report or gate on spend without parsing run files.

### Modified Capabilities

<!-- None: pre-hooks and every existing hook variable keep their behavior. -->

## Impact

- `src/usage.ts` (run-level sum over recorded phases).
- `src/metadata.ts` (`RunMetadataStore.runUsage()`).
- `src/hooks.ts` (`RunHookContext.usage` and the new environment variables).
- `src/runner.ts` (both post-hook call sites pass the aggregate).
- `README.md` (hooks paragraph and example).
- No CLI surface, harness protocol, control protocol, config schema or persisted-state change.
