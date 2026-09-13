# run-history-report Specification

## Purpose
Expose the run history — every run Convoy knows about, with the usage each phase recorded — as machine-readable JSON and as a usage report aggregated by pipeline, model, step or day, so an operator or a script can answer "what did this pipeline cost this week", "which step fails most" or "which model consumes the most cache" from `convoy runs` alone, without parsing run workspaces or re-deriving totals Convoy already computes.

## Requirements

### Requirement: `convoy runs --json` prints the run history as JSON

`convoy runs --json` SHALL write the run history to stdout as a JSON array ordered newest first and SHALL never open the runs browser, whether or not stdin and stdout are terminals. Each element SHALL carry only durable facts, under the same field names `convoy runs` uses internally: `runID`, `title`, `pipeline`, `targetDir`, `status`, `statusKind`, `createdAt`, `cost`, `executorCost`, `advisorCost`, `goal`, `finalization`, `feature` and `phases`. Process state — whether the run is live, whether it waits on a gate, its server URL, its workspace path — SHALL NOT be emitted. When no run matches, the output SHALL be an empty array and the exit status zero.

#### Scenario: Two recorded runs

- **WHEN** the history holds a completed `implement` run and a failed `review` run, and `convoy runs --json` is invoked
- **THEN** stdout is a two-element array, the `implement` run first if it is newer, each element carrying `pipeline`, `statusKind`, `cost` and a `phases` array with every recorded phase

#### Scenario: A terminal is attached

- **WHEN** `convoy runs --json` is invoked from an interactive terminal
- **THEN** the JSON is printed and the runs browser never opens

#### Scenario: A live run

- **WHEN** one run's server is still up
- **THEN** its element carries the same durable fields as every other run and no `live`, `waiting` or `serverUrl` key

#### Scenario: Empty history

- **WHEN** the runs directory holds no run
- **THEN** stdout is `[]` and the exit status is zero

### Requirement: Phases carry their recorded usage and nothing invented

Each element of `phases` SHALL carry the phase's `name` and `status`, plus `durationMs`, `startedAt`, `endedAt`, `cost`, `advisorCost`, `tokens` (`input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`, `total`), `model` and `logicalModel` exactly when the run's metadata recorded them. A fact the metadata did not record SHALL be an absent key — never `null`, never zero — and a recorded cost of `0` SHALL be emitted as the fact it is.

#### Scenario: A hook row without usage

- **WHEN** a run's `Compact run` phase was skipped and recorded a duration but no cost, tokens or model
- **THEN** its element carries `name`, `status` and `durationMs` and no `cost`, `tokens` or `model` key

#### Scenario: A subscription model

- **WHEN** a phase ran on a model whose recorded cost is `0` with 1,200,000 tokens
- **THEN** its element carries `cost: 0` and `tokens.total: 1200000`

### Requirement: Runs without a workspace stay in the history

A run whose workspace was deleted but whose run record survives SHALL appear in the JSON with `phases: []`, the `status` and `statusKind` the run record implies and its `finalization` evidence; the keys for facts the record does not hold (`createdAt`, `cost`, `pipeline`) SHALL be absent.

#### Scenario: A compacted run whose workspace was cleaned

- **WHEN** `~/.convoy/run-records/<id>.json` exists with a `producedSha` and `~/.convoy/runs/<id>` does not
- **THEN** the JSON element for `<id>` carries `phases: []`, `statusKind: "completed"` and `finalization.producedSha`, and no `cost` or `createdAt` key

### Requirement: History filters apply to both outputs

`convoy runs --json` and `convoy runs stats` SHALL accept `--since <value>` and `--pipeline <name>`. `--since` SHALL accept a relative window in days (`7d`) or hours (`36h`) and an absolute local date (`YYYY-MM-DD`, midnight); a run SHALL pass when its `createdAt` is at or after the boundary, or — when the run has no `createdAt` — when the timestamp encoded in its run ID is. `--pipeline` SHALL keep only runs whose recorded pipeline name equals the value exactly. Filters SHALL apply before any aggregation.

#### Scenario: A relative window

- **WHEN** the history holds a run created 8 days ago and one created 2 days ago, and `--since 7d` is passed
- **THEN** only the 2-day-old run is included

#### Scenario: A run record without a creation time

- **WHEN** a workspace-less run's ID begins with a timestamp older than the `--since` boundary
- **THEN** it is excluded, and it is included when the timestamp is inside the window

#### Scenario: A pipeline filter before aggregation

- **WHEN** the history holds `implement` and `review` runs and `convoy runs stats --pipeline implement --group-by step` is invoked
- **THEN** every row counts phases of `implement` runs only

### Requirement: `convoy runs stats` prints the usage report

`convoy runs stats` SHALL aggregate the filtered history's phases into one row per value of the `--group-by` dimension — `pipeline` (default), `model`, `step` or `day` — and print the rows as a plain text table on stdout, with or without a terminal, or as a JSON array of raw rows when `--json` is passed. Every row SHALL carry the group key, `runs` (distinct runs contributing to the row), `phases`, `completed`, `failed`, `tokens` (by kind and `total`), `cost` (executor plus advisor), `advisorCost` and `durationMs` (sum of the phases' recorded durations). On the run-grained dimensions `pipeline` and `day`, `completed` and `failed` SHALL count runs by their status kind; on the phase-grained dimensions `model` and `step`, they SHALL count phases by their status. A run without a recorded pipeline name, or a phase without a recorded model, SHALL fall into a `(none)` row. Rows SHALL be ordered by `tokens.total` descending, except `day`, ordered ascending by date. The table SHALL end with a `total` row; the JSON SHALL NOT include one.

#### Scenario: Grouped by pipeline

- **WHEN** the history holds two `implement` runs (one completed, one failed) and one completed `review` run, and `convoy runs stats` is invoked
- **THEN** the `implement` row reads `runs 2`, `completed 1`, `failed 1` with its phases' tokens, cost and duration summed, and the `review` row reads `runs 1`, `completed 1`, `failed 0`

#### Scenario: Grouped by step

- **WHEN** the same history is reported with `--group-by step`
- **THEN** the `implementer` row counts every `implementer` phase across the two `implement` runs, with `completed` and `failed` counting phase statuses and `runs` counting the distinct runs that ran the step

#### Scenario: Grouped by model

- **WHEN** phases on `openai/gpt-5.6-sol#medium` recorded 400,000 and 600,000 cache-read tokens
- **THEN** that model's row carries `tokens.cacheRead: 1000000`

#### Scenario: Grouped by day

- **WHEN** runs were created on two different local dates
- **THEN** the rows are one per `YYYY-MM-DD`, oldest first

#### Scenario: Nothing matches

- **WHEN** the filters exclude every run
- **THEN** the table shows the header and a zeroed `total` row with exit status zero, and `--json` prints `[]`

### Requirement: Table values are compact and JSON values are raw

In the table, token counts SHALL be rendered compactly (`412k`, `3.3M`), costs with a dollar sign and four fractional digits (`$0.0000`), and durations humanized (`4m23s`). With `--json` the same figures SHALL be plain numbers: integer token counts, unrounded costs and integer milliseconds.

#### Scenario: One row both ways

- **WHEN** a row sums 3,289,185 tokens, a cost of 0.1234567 USD and 263,135 ms
- **THEN** the table shows `3.3M`, `$0.1235` and `4m23s`, and `--json` shows `3289185`, `0.1234567` and `263135`

### Requirement: Usage errors are explicit

`convoy runs` SHALL reject, with a usage message that names the accepted forms and a non-zero exit status and before opening anything, a run ID combined with `--json` or `stats`, an unparseable `--since` value, an unknown `--group-by` dimension, a filter or `--group-by` given without `--json` or `stats`, and any unknown flag.

#### Scenario: A run ID with `--json`

- **WHEN** `convoy runs 20260911-190652-lrv2 --json` is invoked
- **THEN** the command fails with the usage message and the browser never opens

#### Scenario: An unknown dimension

- **WHEN** `convoy runs stats --group-by week` is invoked
- **THEN** the command fails naming the accepted dimensions

### Requirement: The browser and the plain listing are unchanged

`convoy runs` and `convoy runs <run-id>` without flags SHALL behave exactly as before: the runs browser on a terminal, the plain listing otherwise.

#### Scenario: Bare invocation without a terminal

- **WHEN** `convoy runs` is invoked with stdout piped
- **THEN** the plain text listing is printed, not JSON
