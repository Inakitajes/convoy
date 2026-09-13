## 1. History records

- [x] 1.1 In `src/runs.ts`, extend `RunPhaseInfo` with `tokens?`, `logicalModel?`, `startedAt?` and `endedAt?` (copied from `PhaseMetadata` in `phaseInfos`), and add `RunHistoryRecord`, `RunHistoryPhase` and `runHistoryRecord(entry)` picking only the durable keys and dropping `undefined` values. Verification: `test/runs.test.ts` shows phases carrying recorded tokens/model/timestamps, a recorded `cost: 0` emitted, absent facts absent (no `null`), an index-only run yielding `phases: []` with `finalization`, and no `live`/`waiting`/`serverUrl`/`dir` key in the record.

## 2. Filter and report

- [x] 2.1 In `src/run-history-report.ts`, add `RunHistoryFilter`, `parseSince(value, now)` (`<n>d`, `<n>h`, `YYYY-MM-DD` local midnight; throws on anything else), `runCreatedAt` (metadata `createdAt`, else the run ID's local-time stamp) and `filterRunHistory`. Verification: `test/run-history-report.test.ts` covers each accepted form and the boundary (at-or-after passes), an invalid value throwing, a workspace-less run filtered by its ID stamp, a run with neither kept only without `--since`, and `--pipeline` exact match.
- [x] 2.2 In `src/run-history-report.ts`, add `UsageReportDimension`, `UsageReportRow` and `usageReport(records, dimension)`: flatten `(record, phase)`, key by pipeline/model/step/day with `(none)` for a missing fact, fold tokens with `addTokens`, costs with `safeCost` (`cost` = executor + advisor, `advisorCost` apart), durations, distinct `runs`, `phases`, and `completed`/`failed` by run status kind on `pipeline`/`day` and by phase status on `model`/`step`; order by `tokens.total` descending (`day` ascending). Verification: the test file covers a two-pipeline history (run outcomes on `pipeline`, phase outcomes on `step`, distinct runs on both), cache-read sums on `model`, `day` ordering, `(none)` rows, a workspace-less run counted on run grains only, and NaN-safe costs.

## 3. Render

- [x] 3.1 In `src/run-history-render.ts`, add `renderUsageReportTable(rows, dimension)` (columns `<dimension> | runs | ok | failed | tokens | cache read | cost | advisor | duration`; compact tokens `412k`/`3.3M`; `$` with four fractional digits; humanized durations; right-aligned numbers; a final `total` row whose `runs` is the distinct count; header plus zeroed total for an empty report) and `renderJson(value)`. Verification: `test/run-history-render.test.ts` snapshots a three-row table and the empty table, and checks each formatter at its boundaries (`999`, `1000`, `1_000_000`; `59s`, `60s`, `3600s`).

## 4. CLI

- [x] 4.1 In `src/cli.ts`, replace the `runs` branch of `parseCommand` with `parseRunsArgs(rest)` producing the `browse`/`json`/`stats` modes (flag map and known-flag set in the style of `parseWorktreesArgs`; `--since` validated at parse time; usage error listing the three forms), extend `CliCommand`, dispatch `json`/`stats` through `listRuns` → `runHistoryRecord` → `filterRunHistory` → (`usageReport`) → renderer → stdout, and extend the help text's `runs` entry and examples. Verification: `test/cli-parser.test.ts` parses every form, rejects a run ID with `--json` or `stats`, an unknown `--group-by`, filters without a mode, an invalid `--since` and unknown flags, and shows bare `runs`/`runs <id>` unchanged; `test/cli.test.ts` drives the `json` and `stats` dispatch against a temporary `CONVOY_HOME` history and asserts stdout is parseable JSON / a table with a `total` row and that no TUI module is loaded.

## 5. Documentation

- [x] 5.1 In `README.md`, extend the `convoy runs` block with the three forms, the two filters, one `--json | jq` example and two `stats` examples, and the note that subscription models record a cost of `0`.

## 6. Verify

- [x] 6.1 `bun run typecheck` and `bun test` pass; coverage stays above the `verify.yml` threshold.
- [x] 6.2 `openspec validate run-history-report --strict`.
- [x] 6.3 Manual check against the real history: `convoy runs --json --since 2d | jq length`, `convoy runs stats --since 7d`, `convoy runs stats --pipeline implement-gpt --group-by step` and `convoy runs stats --group-by model --json` print figures consistent with `convoy runs` and the runs' `metadata.json`.
