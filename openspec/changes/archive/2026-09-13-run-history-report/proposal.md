## Why

Every run records, per phase, its status, executor cost, tokens, model and duration in `metadata.json` (`PhaseMetadata` in `src/metadata.ts`), and `convoy runs` already derives each run's cost and executor/advisor split from it (`loadRunEntry` in `src/runs.ts`). But that knowledge only reaches an operator through the runs browser or the plain text listing, one run at a time. "How much did `implement` cost this week", "which step fails most often" or "which model burns the most cache" all require scripting over `~/.convoy/runs/*/metadata.json` and re-deriving the aggregation Convoy performs internally. With subscription models the recorded cost is `0`, so the tokens — which nothing exposes outside the dashboard — are the figure that matters.

## What Changes

- Add `convoy runs --json`: the run history as a JSON array (newest first) of durable run facts — pipeline, status, cost split, goal outcome, finalization evidence, feature link and every phase's recorded usage (tokens, model, duration, timestamps). Process state (`live`, `waiting`, server URL, run directory) is never emitted.
- Add `convoy runs stats`: the usage report — the whole history's phase usage aggregated by `--group-by pipeline|model|step|day` into rows with run and phase counts, outcomes, tokens by kind, cost, advisor cost and duration; a plain text table by default, raw rows with `--json`.
- Give both outputs the same history filters: `--since <n>d|<n>h|YYYY-MM-DD` and `--pipeline <name>`.
- Document the flags and three `jq`/`stats` examples in the README's `convoy runs` block.
- The runs browser, the plain listing, `metadata.json`, the dashboard and `SUMMARY.md` are untouched; Convoy still never sends anything anywhere.

## Capabilities

### New Capabilities

- `run-history-report`: `convoy runs` exposes the run history as JSON and as a usage report aggregated by pipeline, model, step or day, so an operator can answer spend and failure questions across runs without parsing run files.

### Modified Capabilities

<!-- None: `convoy runs [run-id]` without flags keeps its exact behavior. -->

## Impact

- `src/runs.ts` (`RunPhaseInfo` gains the recorded usage fields; the durable `RunHistoryRecord` projection).
- `src/run-history-report.ts` (new: history filter and usage report aggregation, pure).
- `src/run-history-render.ts` (new: table and JSON rendering).
- `src/cli.ts` (`runs` argument parser, command modes, dispatch, help text).
- `README.md` (`convoy runs` block).
- No harness protocol, control protocol, config schema or persisted-state change. One CLI surface addition: two flags on `convoy runs` and one subcommand.
