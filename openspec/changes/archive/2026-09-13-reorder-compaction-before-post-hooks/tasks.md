## 1. Canonical phase plan and epilogue order

- [x] 1.1 Persist the canonical `progressPhases(pipeline, hookSet)` list once at run open as an optional `plannedPhases` run-metadata field (name, description, kind, planned model/advisor); verify a newly started run's `metadata.json` carries the hook rows and a legacy record without the field still loads in the metadata tests.
- [x] 1.2 Introduce one canonical-order helper that lays out pre-hook rows, pipeline steps, goal invocation groups, `Compact run`, then post-hook rows, and use it from `progressPhases`; verify a unit test asserts post-hook rows follow `Compact run` and that a pipeline without post-hooks still ends with `Compact run`.
- [x] 1.3 Reorder the success epilogue in `run()` so the finalization attempt and its persisted record complete before `runHooks("post", ..., { status: "success" })`, leaving the failure path untouched; verify a hosted runner test where a success post-hook records that compaction already completed.
- [x] 1.4 Keep failure post-hooks compaction-free and exactly-once through the existing `postHooksStarted` guard; verify a failing-run test asserts no finalization record and that the failure hook ran.

## 2. Dashboard hook-row visibility

- [x] 2.1 Make `reconstructedPhases` render from `plannedPhases` when present (stored order, no forced terminal `Compact run`) and keep today's derivation as the legacy fallback; verify `test/attach.test.ts` asserts hook rows appear in execution order.
- [x] 2.2 Make `LiveAttach.syncPhases` merge the same canonical rows from `plannedPhases`; verify `test/attach-follow.test.ts` records hook rows in the synced list before they run.
- [x] 2.3 Update `TUI.syncPhases` to append missing rows in the given order and stop relocating `Compact run` to the terminal position; verify `test/tui.test.ts` keeps a post-hook row after the lifecycle row.
- [x] 2.4 Ensure hook lifecycle and activity events resolve to the planned rows instead of being dropped; verify a regression test drives `phaseStarted`/`phaseActivity`/`phaseCompleted` for a hook row and observes its state.

## 3. Durable hook outcome and output

- [x] 3.1 Persist each hook phase's terminal status, duration, and a bounded stdout/stderr tail into run metadata when the hook finishes, reusing the existing output-line bound; verify `test/hooks.test.ts` asserts the stored tail keeps the most recent bounded lines.
- [x] 3.2 Keep persistence best-effort so a storage failure never changes the hook's exit status; verify a failing-store test asserts the hook result stands and the failure is disclosed.
- [x] 3.3 Surface the stored outcome and output on the completion screen and in historical reconstruction; verify reopening a completed run shows the post-hook row completed with its retained output tail.

## 4. Finalization retries with bounded exponential backoff

- [x] 4.1 Discriminate the publication verdict in `src/finalization/remote.ts` (`unverifiable` versus `published`/`unknown-object`) and map each kind in `src/finalization/compact.ts`; verify finalization tests cover each verdict.
- [x] 4.2 Carry a `retryable` flag on the internal finalization attempt and add a `runFinalizationWithRetry` wrapper with three retries after the initial attempt, exponential backoff (base ≈ 2s, cap ≈ 30s) and a bounded total window; verify injected-transient unit tests assert attempt counts and delays and that terminal refusals are attempted once.
- [x] 4.3 Reconcile the durable transaction journal at the start of every retry without duplicating or discarding work; verify a test that stops mid-transaction and retries asserts reconciliation before mutation.
- [x] 4.4 Surface retry attempts and waits on the `Compact run` row and in the log; verify run output names at least one retry.
- [x] 4.5 Run the finalization epilogue through the retry wrapper in `run()`; verify a hosted runner test whose probe fails once then succeeds compacts without operator action.

## 5. Post-hook compaction context

- [x] 5.1 Pass the persisted finalization record into the success post-hook context and expose the finalization state plus the produced commit identity when one exists; verify `test/hooks.test.ts` asserts the variables for completed and blocked outcomes.
- [x] 5.2 Document the new hook context in `README.md` and note that a publish hook can gate on it; verify the README names the exposed context.

## 6. Verification

- [x] 6.1 Run `bun run typecheck`; verify it exits clean.
- [x] 6.2 Run `bun test`; verify the full suite is green.
- [x] 6.3 Update `test/dashboard-compact-run-row.test.ts` for the new order; verify no test still asserts `Compact run` is terminal when post-hooks exist.
- [x] 6.4 Update the README run-finishing section for the epilogue order and retry behavior; verify the section describes compaction preceding the success hooks.
