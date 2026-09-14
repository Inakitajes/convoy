## Why

A successful run's epilogue runs success post-hooks first and automatic compaction last, and live dashboards never render hook rows. In the `ship` pipeline the post-hook is `convoy publish`, so the run pushes its branch and opens the PR **before** compaction; compaction then refuses to replace a commit already advertised by a remote, so every successful `ship` run lands un-compacted and squashing it later requires a force-push. Compaction's remote verification also has no retry, so a single transient `git ls-remote` timeout (common in this operator's Git setup) blocks compaction even when a second attempt would succeed. Finally, because hook rows are absent from the live phase list, a hook can execute and open a PR while the dashboard shows no trace that it ran.

## What Changes

- **BREAKING (execution order):** run automatic compaction **before** success post-hooks, so a post-hook acts on the finished, compacted work (e.g. it opens a PR whose branch already carries the single operator-authored commit). Finalization eligibility stays anchored to phase execution and goal settlement; failure hooks keep running only on failure and never after compaction.
- Make hook rows first-class dashboard rows: their rows are planned before execution and are present in the live list, the additive live sync, reconstructed attach views, and historical views. Render order follows execution order — pre-hooks, pipeline steps, goal invocations, `Compact run`, post-hooks — so `Compact run` is no longer the terminal row.
- Persist each hook phase's outcome and a bounded tail of its captured stdout/stderr durably, so a completed run's dashboard and history show that the hook ran and what it did instead of only the live feed.
- Expose the compaction outcome to post-hooks (run status and resulting commit) so a hook can decide what to do when compaction did not complete.
- Add a bounded exponential-backoff retry policy (default three retries) for **transient** compaction failures — remote-probe timeouts, transport failures, and other uncertain verification outcomes — while definite safety refusals (a published replacement commit, a dirty tree, missing boundary/evidence, or an unresolved transaction) are still not retried.

**Non-goals:** no change to what is eligible for compaction, to publication safety, or to the no-force-push guarantee; no automatic publication; no new configuration surface for retry tuning (the policy is a built-in default).

## Capabilities

### New Capabilities

<!-- None: this changes existing run-finalization behavior. -->

### Modified Capabilities

- `run-finalization`: the run epilogue order changes (compaction before success post-hooks), hook rows become planned and durable dashboard rows with their captured output, the compaction outcome is exposed to post-hooks, and automatic compaction gains bounded exponential-backoff retries for transient failures while terminal safety refusals remain non-retryable.

## Impact

- `src/runner.ts`: run the finalization epilogue before success post-hooks; plan/record hook phases up front; pass compaction outcome to post-hook environment; move the terminal-row narration.
- `src/finalization/compact.ts` and `src/finalization/remote.ts`: classify transient versus terminal outcomes and wrap the attempt in a bounded exponential-backoff retry; keep the read-only verification and journal reconciliation semantics.
- `src/hooks.ts`, `src/progress.ts`, `src/metadata.ts`: plan hook rows, persist hook phase outcome plus a bounded stdout/stderr tail, and expose finalization context to hooks.
- `src/attach.ts` (`reconstructedPhases`) and `src/attach-runtime.ts` (`syncPhases`): include hook rows in the canonical order and stop treating `Compact run` as the terminal row.
- `src/tui.ts`: update the phase-list ordering invariant so post-hook rows terminate the list.
- Tests: epilogue-order and finalization-retry coverage in `test/runner-hosted.test.ts` / `test/finalization-*.test.ts`; hook-row reconstruction in `test/attach.test.ts` / `test/attach-follow.test.ts`; hook output persistence in `test/hooks.test.ts`; update `test/dashboard-compact-run-row.test.ts` order expectations.
- `README.md`: the run-finishing section's execution order and the retry behavior.
- `openspec/specs/run-finalization/spec.md`: delta spec in this change.
