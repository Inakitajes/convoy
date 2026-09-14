## Context

`convoy runs` (`src/runs.ts`) is the only reader of the run history. `listRuns()` merges the runs that still have a workspace under `~/.convoy/runs` with the cleanup-surviving run records under `~/.convoy/run-records`, and `loadRunEntry` derives, per run, the pipeline name, a status summary, the executor/advisor cost split (from `metadata.json` plus the attempt logs `readAdvisorSplit` reads) and a `RunPhaseInfo` per phase (`name`, `status`, `durationMs`, `cost`, `advisorCost`, `model`). That `RunEntry` also carries process state probed at read time — `live`, `waiting`, `serverUrl` — and the workspace path. The two consumers are the browser (`src/runs-tui.ts`) and `printRunList`, the plain listing used when no terminal is attached.

`parseCommand` (`src/cli.ts`) accepts `convoy runs [run-id]` and nothing else: a second argument is a usage error. The repository has no shared flag parser; `parseWorktreesArgs` (`src/worktree-commands.ts`) is the reference pattern — a `Map<flag, string[]>`, a `knownFlags` set and a usage error carrying the help text. There is no `--json` flag anywhere in Convoy's own CLI; every `--json` in `src/` is an argument passed to `gh` or `openspec`.

Per phase, `PhaseMetadata` (`src/metadata.ts`) records `tokens` (`ProgressTokens`), `logicalModel`, `startedAt` and `endedAt` in addition to what `RunPhaseInfo` surfaces. Subscription-billed models record `cost: 0` — a fact, not an absence — so a report that only shows cost shows `$0.00` for such users; tokens are the figure that varies. `metadata.phases` also holds rows that are not pipeline steps: hook rows such as `Compact run` and goal-fragment invocations. Run IDs begin with a local-time `YYYYMMDD-HHMMSS` stamp, which is the only creation time a workspace-less run record retains.

Vocabulary (from the contribution glossary): *run history* is everything Convoy knows about, workspaces and run records alike; *phase usage* is what one phase recorded; the *usage report* is the history's phase usage aggregated by one dimension.

## Goals / Non-Goals

**Goals**

- A stable, script-friendly JSON view of the run history, limited to durable facts and reusing `RunEntry`'s field names.
- A usage report by pipeline, model, step or day, readable as a table and consumable as JSON, with tokens as a first-class figure.
- One filter vocabulary (`--since`, `--pipeline`) shared by both outputs, parsed once.
- Pure, disk-free aggregation and rendering, tested with in-memory `RunEntry` fixtures.

**Non-Goals**

- A CSV export (`--json` piped through `jq -r '@csv'` covers it; a dedicated `export` can follow if asked).
- Any change to the runs browser, the plain listing, the dashboard, `SUMMARY.md` or `metadata.json`.
- Averages, percentiles or trends (derivable from the sums; not part of the contract).
- A shared flag parser for the whole CLI (an opportunistic refactor).
- Reading attempt logs beyond what `loadRunEntry` already reads.

## Decisions

### D1: `RunHistoryRecord` — the durable projection of `RunEntry`, in `src/runs.ts`

```ts
export type RunHistoryPhase = RunPhaseInfo // name, status, durationMs?, cost?, advisorCost?, model?, plus:
//   tokens?: ProgressTokens; logicalModel?: string; startedAt?: number; endedAt?: number
export type RunHistoryRecord = Pick<RunEntry,
  "runID" | "title" | "pipeline" | "targetDir" | "status" | "statusKind" | "createdAt"
  | "cost" | "executorCost" | "advisorCost" | "goal" | "finalization" | "feature"> & { phases: RunHistoryPhase[] }
export function runHistoryRecord(entry: RunEntry): RunHistoryRecord
```

`phaseInfos` gains the four fields straight from `PhaseMetadata`; they are optional and no existing consumer reads them. `runHistoryRecord` copies the listed keys only when the entry holds them (`undefined` values are dropped, so `JSON.stringify` never prints `null` and absent facts stay absent). `live`, `waiting`, `serverUrl` and `dir` are deliberately not in the pick: they are process state or internals, and a public contract must not promise the result of a socket probe.

Alternative rejected: emitting `RunEntry` as is. It would freeze `dir` and the liveness probe as a contract and make the output non-reproducible across invocations.

### D2: History filter in `src/run-history-report.ts`

```ts
export type RunHistoryFilter = { since?: number; pipeline?: string }
export function parseSince(value: string, now: number): number   // "7d" | "36h" | "YYYY-MM-DD" → epoch ms; throws on anything else
export function runCreatedAt(entry: Pick<RunEntry, "runID" | "createdAt">): number | undefined // createdAt ?? stamp parsed from the run ID
export function filterRunHistory<T extends Pick<RunEntry, "runID" | "createdAt" | "pipeline">>(entries: T[], filter: RunHistoryFilter): T[]
```

`YYYY-MM-DD` resolves to local midnight (`new Date(y, m - 1, d)`), matching how a person reads "since Monday". The run-ID fallback parses `YYYYMMDD-HHMMSS` as local time, which is how `newRunID` stamps it. A run with neither is kept when no `--since` is given and dropped when one is (nothing says it is inside the window). `--pipeline` is exact string equality on `pipeline`; a run without a pipeline name never matches a filter.

### D3: Usage report aggregation in `src/run-history-report.ts`

```ts
export type UsageReportDimension = "pipeline" | "model" | "step" | "day"
export type UsageReportRow = {
  key: string            // the group value, "(none)" when the fact is missing
  runs: number           // distinct runs contributing to the row
  phases: number
  completed: number      // runs (pipeline, day) or phases (model, step)
  failed: number
  tokens: ProgressTokens
  cost: number           // executor + advisor
  advisorCost: number
  durationMs: number
}
export function usageReport(records: RunHistoryRecord[], dimension: UsageReportDimension): UsageReportRow[]
```

The aggregation flattens `(record, phase)` pairs, computes the key per pair (`record.pipeline`, `phase.model`, `phase.name`, or the local `YYYY-MM-DD` of `runCreatedAt(record)`), and folds with `addTokens`/`safeCost` from `src/usage.ts`. Phase cost is `phase.cost + phase.advisorCost` when recorded, so `cost` matches what `convoy runs` shows as the run's cost when every phase has a cost; `advisorCost` is the advisor part alone. Workspace-less runs contribute to `runs`, `completed`/`failed` on run-grained rows and nothing else. Outcome counting follows the dimension (glossary ADR *usage report grain*): `statusKind === "completed"` / `"failed"` per distinct run on `pipeline`/`day`; `status === "completed"` / `"failed"` per phase on `model`/`step` (`skipped` and `pending` count in `phases` only). Ordering: `tokens.total` descending, ties by key; `day` ascending by key. The `total` row is a rendering concern (D4): the JSON rows are the groups, nothing else, so a script can sum them without special-casing.

Alternative rejected: one schema per grain (two output shapes to document) and phase-only counting everywhere (makes the `pipeline` row answer a question nobody asks).

### D4: Rendering in `src/run-history-render.ts`

```ts
export function renderUsageReportTable(rows: UsageReportRow[], dimension: UsageReportDimension): string
export function renderJson(value: unknown): string   // JSON.stringify(value, null, 2) + "\n"
```

Columns: `<dimension> | runs | ok | failed | tokens | cache read | cost | advisor | duration`, widths from content, numbers right-aligned, no colors, one `total` row last (sums of every column; `runs` in the total is the number of distinct runs, not the sum of the rows' `runs`, which would double count on phase grains). Formats: tokens `n < 1000` as is, `k` and `M` with one decimal (`412k`, `3.3M`); cost `$` + `toFixed(4)` (the format the hook variables and `SUMMARY.md` use; the plain listing's two decimals would flatten cheap runs); duration `Xh Ym`, `Xm Ys` or `Xs` with no fraction. An empty report renders the header and a zeroed total.

### D5: CLI surface in `src/cli.ts`

```
convoy runs [run-id]
convoy runs --json [--since <n>d|<n>h|YYYY-MM-DD] [--pipeline <name>]
convoy runs stats [--group-by pipeline|model|step|day] [--since …] [--pipeline …] [--json]
```

`CliCommand`'s `runs` variant becomes `{ type: "runs"; mode: "browse"; runID?: string } | { type: "runs"; mode: "json"; filter } | { type: "runs"; mode: "stats"; filter; dimension; json: boolean }`, produced by a `parseRunsArgs(rest)` that mirrors `parseWorktreesArgs` (flag map, known flags, usage error with the three forms). `--since` is validated at parse time so an invalid value fails before any I/O. Dispatch: `browse` → `openRunsBrowser` unchanged; `json`/`stats` → `listRuns()` → `runHistoryRecord` → `filterRunHistory` → (`usageReport`) → render → `process.stdout.write`. `listRuns()` still probes liveness per run before the filter applies; `--since` narrows the output, not the loading (see Risks). The help text's `runs` entry and the examples block list the new forms.

### D6: README

Under the `convoy runs` examples: `convoy runs --json --since 7d | jq 'map({runID, pipeline, tokens: ([.phases[].tokens.total // 0] | add)})'`, `convoy runs stats --since 7d` and `convoy runs stats --pipeline implement --group-by step`, plus one sentence that subscription models record a cost of `0`, so tokens are the figure to compare.

## Risks / Trade-offs

- **`RunEntry` field names become a contract.** Mitigated by exposing a picked subset; a rename inside `RunEntry` would now need a projection change rather than silently changing the output.
- **Liveness probes on every run.** `listRuns()` was written for an interactive list; for a 68-run history the probes cost a few hundred milliseconds. Filtering before probing would require restructuring `listRuns`, which is out of scope; a probe-free loader for the report modes is the follow-up if long histories make it noticeable.
- **Hook rows and goal fragments appear as steps.** The `step` dimension groups by phase name as recorded; `Compact run` and `goal-measure-1-…` rows are phases too (glossary) and an operator can drop them with `jq`. Distinguishing configured steps from auxiliary rows would need the frozen pipeline per run and a second vocabulary; deferred.
- **Overlap with the `hook-run-usage` change (PR #113).** That change sums the in-memory store's phases for post-hooks; this one aggregates `RunEntry` phases across runs. Neither depends on the other; if both land, no line is shared or duplicated.
