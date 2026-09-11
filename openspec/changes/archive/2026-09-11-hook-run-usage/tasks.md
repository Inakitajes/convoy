## 1. Aggregate run usage

- [x] 1.1 In `src/usage.ts`, add `RunUsage`, the structural `RunUsagePhase`, and `sumRunUsage(phases)` folding cost (when any phase has a numeric executor or advisor cost), tokens (when any phase has a numeric executor `cost`), advisor cost (when the sum is above zero) and duration (when any phase has one), returning `undefined` when no group has data. Verification: `test/usage.test.ts` covers mixed phases, phases without usage, a duration-only run, an advisor-bearing run, a zero-cost advisor, NaN-safety, and the `undefined` case.
- [x] 1.2 In `src/metadata.ts`, add `runUsage(): RunUsage | undefined` to `RunMetadataStore`, delegating to `sumRunUsage(Object.values(data.phases))`. Verification: `test/metadata.test.ts` shows `undefined` on a fresh store, totals after `phaseStepUsage`/`phaseUsageTotal`/`phaseAdvisorEvent`/`phaseEnded` across two phases plus a hook row, and a failed phase's duration included.

## 2. Hook environment

- [x] 2.1 In `src/hooks.ts`, add `usage?: RunUsage` to `RunHookContext` and a `usageEnv` helper spread into `env` after `CONVOY_GOAL_*`: `CONVOY_RUN_COST` (four fractional digits) with `CONVOY_RUN_TOKENS_INPUT/OUTPUT/REASONING/CACHE_READ/CACHE_WRITE/TOTAL` (integers), `CONVOY_RUN_ADVISOR_COST` (four fractional digits) and `CONVOY_RUN_DURATION_MS` (integer). Verification: `test/hooks.test.ts` asserts the exact strings for a full aggregate, the duration-only case, the no-advisor case, that an absent `usage` sets none of them, and that pre-hooks never receive them.

## 3. Runner wiring

- [x] 3.1 In `src/runner.ts`, pass `usage: metadata?.runUsage()` (spread conditionally) at both post-hook call sites — the success path and the failure path — leaving the pre-hook call untouched. Verification: a `test/runner-hosted.test.ts` run that fails before any usage sees `CONVOY_RUN_STATUS=failure`, `CONVOY_RUN_COST`/`CONVOY_RUN_TOKENS_TOTAL` unset and `CONVOY_RUN_DURATION_MS` set; the success path is exercised by the headless smoke in 5.3 (a `run()` test cannot fake the `claude` CLI: `Bun.spawn` resolves binaries against the process's original PATH).

## 4. Documentation

- [x] 4.1 In `README.md`, extend the "Hooks are trusted local shell commands" paragraph with the new variables, their formats and the sum-of-phases definition of the duration, and add a post-hook example next to the goal-mode one: `gh pr comment` with cost and duration, plus a one-line `when: always` budget guard using `awk`, noting that a failing post-hook fails the run.

## 5. Verify

- [x] 5.1 `bun run typecheck` and `bun test` pass; coverage stays above the `verify.yml` threshold.
- [x] 5.2 `openspec validate hook-run-usage --strict`.
- [x] 5.3 Headless smoke: a pipeline with a post-hook `env | grep '^CONVOY_RUN_' > "$CONVOY_RUN_DIR/hook-env.txt"` run with `--no-tui` produces cost, token and duration values consistent with the run's `metadata.json` and `convoy runs`.
