## Context

`runHookCommand` (`src/hooks.ts`) builds the hook environment from a `RunHookContext` the runner assembles at two post-hook call sites: the success path after the summary is written and the failure path in the runner's catch block. The context carries `status`, an optional `score` and an optional `goal` outcome; each optional field becomes a conditional spread into `env`, so a hook sees a variable only when Convoy actually knows the value.

The numbers a hook would want already exist in memory at both call sites. `openRunMetadata` returns a `RunMetadataStore` whose `data.phases` holds, per phase, the executor usage (`cost`, `tokens`, written together by `recalculate` from a `PhaseUsage` accumulator), the advisor aggregate (`advisor.cost`, from `phaseAdvisorEvent`) and `durationMs` (`endedAt - startedAt`, set by `phaseEnded` before its first `await`, so a failed phase already carries it when the failure hooks run). Hook rows are phases too: pre-hooks get a duration, never a cost. The store exposes phases only by name (`snapshot(name)`), and no code path today sums them for a whole run in memory: `convoy runs` (`totalCost` in `src/runs.ts`) and `SUMMARY.md` (`readAdvisorSplit` in `src/advisor-report.ts`) both aggregate from disk, mixing `metadata.json` with attempt logs, and the dashboard sums its own `PhaseState` list.

The vocabulary is already settled by the code: *usage* is cost plus tokens (`ProgressUsage`, `PhaseUsage`, `phaseStepUsage`, `phaseUsageTotal`); the executor's usage and the advisor's are recorded apart and only `convoy runs` adds them up.

## Goals / Non-Goals

**Goals**

- Post-hooks — success and failure — receive the run's aggregated cost, advisor cost, tokens and duration from the in-memory metadata store.
- The aggregate follows the store's facts: nothing recorded means no variable, never a fabricated zero.
- One aggregation, unit-testable without a store, reused by the store.
- The README documents every variable and its format, and shows the `gh pr comment` and budget-guard use cases.

**Non-Goals**

- Pre-hooks (nothing has been recorded when they run).
- Per-step hooks or per-phase variables (there are no per-step hooks).
- Changing how `convoy runs`, the dashboard or `SUMMARY.md` compute or display cost and duration, including the `--resume` duration caveat below.
- Any remote publication by Convoy itself; the hook owns whatever happens with the numbers.

## Decisions

### D1: `sumRunUsage` in `src/usage.ts`, a pure fold over recorded phases

```ts
export type RunUsage = {
  /** Executor plus advisor cost in USD; present when at least one phase recorded either. */
  cost?: number
  /** Advisor cost in USD; present only when the summed advisor spend is above zero. */
  advisorCost?: number
  /** Summed executor tokens; present when at least one phase recorded executor usage. */
  tokens?: ProgressTokens
  /** Sum of the recorded phases' durations; present when at least one phase recorded one. */
  durationMs?: number
}

export function sumRunUsage(phases: Iterable<RunUsagePhase>): RunUsage | undefined
```

`RunUsagePhase` is a structural type — `{ cost?: number; tokens?: ProgressTokens; durationMs?: number; advisor?: { cost: number } }` — so `usage.ts` keeps depending only on `progress.ts` and does not import `PhaseMetadata` (which would close a `usage → metadata → usage` cycle). The fold reuses `emptyTokens`, `addTokens` and `safeCost`. `tokens` is set when any phase has a numeric `cost` (the same marker `totalCost` uses, and the invariant `recalculate` guarantees that tokens travel with it); `cost` when any phase has a numeric executor or advisor cost, so advisor-only spend still yields a total, as in `convoy runs`; `advisorCost` when the advisor sum is above zero; `durationMs` when any phase has one. The function returns `undefined` when none of the groups has data, so callers can spread it like `goal`.

Alternative considered: a store method `phases()` and the fold at the call site. Rejected: it exposes the store's internal record shape for a single consumer.

### D2: `RunMetadataStore.runUsage(): RunUsage | undefined`

The store delegates to `sumRunUsage(Object.values(data.phases))`. No I/O, no cache: `data` is the live record, and the call happens once per post-hook stage. Its name matches the glossary term (run usage) rather than an implementation-flavoured `usageTotals`.

Alternative considered: re-reading `metadata.json` (or attempt logs, as `readAdvisorSplit` does) from `hooks.ts`. Rejected: it adds I/O and a second source of truth inside the process that already holds the data, and the attempt logs would double count phases the metadata has totals for.

### D3: `RunHookContext.usage?: RunUsage` and the environment variables

`hooks.ts` adds the optional field and a `usageEnv(usage)` helper that returns the variables, spread into `env` after `CONVOY_GOAL_*`:

| Variable | Present when | Format |
|---|---|---|
| `CONVOY_RUN_COST` | `usage.cost !== undefined` | `toFixed(4)` |
| `CONVOY_RUN_TOKENS_INPUT/OUTPUT/REASONING/CACHE_READ/CACHE_WRITE/TOTAL` | `usage.tokens !== undefined` | integer |
| `CONVOY_RUN_ADVISOR_COST` | `usage.advisorCost !== undefined` | `toFixed(4)` |
| `CONVOY_RUN_DURATION_MS` | `usage.durationMs !== undefined` | integer (`Math.round`) |

Four fractional digits match the advisor split in `SUMMARY.md`; the dashboard's two are a display concession, and a hook that aggregates runs would lose the cheap ones. No `CONVOY_RUN_EXECUTOR_COST`: two numbers are enough and the third is a subtraction. Formatting lives in `hooks.ts` so `test/hooks.test.ts` pins the textual contract the README documents.

### D4: Both post-hook call sites pass the aggregate

The success and the failure call sites in `src/runner.ts` add `...(usage ? { usage } : {})` with `usage = metadata?.runUsage()`. The failure path uses optional access because the run may fail before `openRunMetadata` returned. The pre-hook call site is untouched. The post-hook row itself is `running` at that moment and carries no duration, so it does not count itself.

### D5: README

The hooks paragraph lists the new variables after `CONVOY_GOAL_*`, states the formats and that the duration is a sum of phase durations, and the goal-mode example gains a sibling: a post-hook that comments cost and duration on the PR with `gh pr comment`, and a one-line `when: always` budget guard using `awk` (a shell `[ -gt ]` cannot compare a decimal), with the note that a failing post-hook fails the run.

## Risks / Trade-offs

- A phase interrupted and resumed keeps its original `startedAt` (`phaseStarted` uses `??=`), so its `durationMs` — and therefore `CONVOY_RUN_DURATION_MS` — includes the time the run sat between the two processes. This is pre-existing `durationMs` behavior shared with `convoy runs` and the dashboard; changing it belongs to a separate change.
- A Claude Code phase reports cost and tokens like an OpenCode one (`src/claude-code.ts`), so the cost group does not go missing on mixed pipelines; a phase whose session never reported usage simply contributes nothing.
- Advisor consultations billed at zero (subscription models) leave `CONVOY_RUN_ADVISOR_COST` unset by design: the variable reports spend, not activity.

## Migration

None. Additive environment variables; no CLI, config, protocol or persisted-state change.
