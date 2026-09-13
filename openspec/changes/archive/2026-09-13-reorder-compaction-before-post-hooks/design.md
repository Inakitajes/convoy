## Context

See `proposal.md` — Why. The current epilogue and dashboard behavior is spread across a few places that this design has to keep consistent:

- `src/runner.ts` runs `runHooks("post", ...)` and only then the `Compact run` epilogue (`progressPhases`/finalization), and it builds the live phase list with `progressPhases(pipeline, hookSet)` — with hooks.
- Run metadata pre-creates phase entries only for pipeline agent steps (`openRunMetadata`); hook phases are added to `metadata.phases` only when the hook actually runs. So a dashboard that opened earlier cannot know a hook row.
- `src/attach.ts` (`reconstructedPhases`) and `src/attach-runtime.ts` (`LiveAttach.syncPhases`) rebuild phase lists from `progressPhases(pipeline)` **without** the hook set, then append metadata "extras", then force `Compact run` to the terminal position.
- The TUI drops `phaseStarted`/`phaseRestored`/`phaseActivity` for a phase name it has no row for (`findPhase` returns undefined), and `applyReset` deliberately ignores a reset carrying the dashboard's own run id — so the one list that *does* carry hook rows (the runner's `resetPipeline`) is not applied to the already-open dashboard.
- Hook stdout/stderr reaches the live feed via `surfaceHookOutput`, but `recordProgress.phaseActivity` only forwards it; the coordinator's stderr log is deleted with the pending launch dir, so nothing durable remains.
- Compaction's publication probe (`src/finalization/remote.ts`) collapses a thrown `git ls-remote` failure and a real "commit is published" verdict into the same `{ ok: false, reason }` result, so `compact.ts` cannot tell a transient timeout from a terminal safety refusal.

## Goals / Non-Goals

**Goals:**

- Make the run epilogue order observable and correct: compaction, then success post-hooks acting on the compacted result.
- Make every planned hook row visible from run start in every dashboard surface, in execution order, with its outcome and a bounded output tail surviving into history.
- Let a post-hook see whether compaction completed.
- Bound retries of transient compaction failures while keeping every existing safety refusal terminal.

**Non-Goals:**

- No change to compaction eligibility, recovery evidence, journaling, or the no-force-push rule.
- No configurable retry tuning (fixed built-in default) and no retry for non-compaction failures.
- No automatic publication and no change to `convoy publish` semantics.
- No migration or rewrite of existing run metadata.

## Decisions

### Decision: invert the runner epilogue — compaction before success post-hooks

In `run()`, run the finalization attempt, persist its record, and only then call `runHooks("post", ...)` with `status: "success"`. The failure path is unchanged: a failed run never compacts and its failure post-hooks run as today. The `postHooksStarted` guard keeps its meaning (post-hooks run exactly once per run).

- **Chosen:** compaction then success post-hooks. A hook that publishes (`convoy publish` in the `ship` pipeline) then pushes the compacted branch instead of un-compacted history.
- **Consequence to keep explicit:** a fatal success post-hook now fails the run *after* a compacted commit exists. This is acceptable — the commit is recoverable and the finalization record stands — but it is a behavior change and must be documented and tested.
- **Alternative (rejected):** keep hooks first and teach the probe to ignore the hook's own push. That would weaken the publication-safety rule globally to special-case one pipeline, and it cannot distinguish the hook's push from an operator's.

### Decision: persist the canonical planned phase list in run metadata; dashboards render from it

At run open, after `hookSet` is resolved, persist the exact `progressPhases(pipeline, hookSet)` list (name, description, kind, planned model/advisor) once into metadata as an optional `plannedPhases` field, and keep pre-creating step rows as today. `reconstructedPhases` and `LiveAttach.syncPhases` consume `plannedPhases` when present and fall back to today's derivation for legacy runs.

- **Chosen:** one durable, ordered plan. It fixes the whole class of "row unknown when the dashboard opened" (not just hooks), needs no config access at attach time, and makes live, additive, and historical lists identical.
- **Alternative (rejected):** resolve the pipeline's hooks in attach from `~/.convoy/config.yaml`. Attach has no config context, the frozen pipeline deliberately does not carry the hook set, and a config edit mid-run would silently change a historical view.
- **Alternative (rejected):** stop skipping the same-run-id reset in `applyReset`. That reset is sticky and would rebuild the dashboard on every poll, dropping feed and transcripts; the skip exists to prevent exactly that.

### Decision: one canonical display order, ending with post-hook rows

Define the order once — pre-hook rows, pipeline steps, goal invocation groups, `Compact run`, post-hook rows — and use it in `progressPhases`, the persisted plan, `reconstructedPhases`, `LiveAttach.syncPhases`, and the TUI's additive merge. `Compact run` is no longer forced to the terminal position; the last post-hook row (or `Compact run` when there are none) is terminal.

- `src/tui.ts` `syncPhases` appends missing rows in the given order and no longer moves `Compact run` to the end.
- `src/attach.ts` `reconstructedPhases` no longer re-homes `Compact run`, and places planned hook rows explicitly instead of treating them as unordered extras.
- The `Compact run` row keeps its own lifecycle events; only its position relative to post-hook rows changes.

### Decision: persist each hook's outcome and a bounded output tail

At hook completion, write the phase outcome and the last bounded lines of captured stdout and stderr into the run's durable state (reusing the existing `hookFeedLines` bound). `recordProgress` gains an explicit persist path for hook output, and `surfaceHookOutput` keeps feeding the live UI. Persistence is best-effort: a write failure is logged and never changes the hook's exit-status semantics.

- **Chosen:** bounded tail next to the phase record, so history and completion screens show the same thing the live feed did.
- **Alternative (rejected):** retain the coordinator log. It lives under the pending launch dir, which is deleted when the run ends, and it mixes all phases.

### Decision: classification lives in the finalization result, retry in a wrapper

Split the outcome so transient and terminal are distinguishable:

- `verifyNotPublished` returns a discriminated verdict: `unverifiable` (probe threw — timeout/transport/auth lookup), versus `published` / `unknown-object` (definite safety refusals).
- An internal attempt returns `{ record, retryable }`; a public `runFinalizationWithRetry` loops on `retryable` with exponential backoff and re-enters the same reconciliation-first path each attempt. Whatever the runner uses today for a single attempt stays available.
- Retryable: unverifiable remote probes and a bounded git-operation timeout that leaves the transaction reconcilable. Non-retryable: published replacement commits, a dirty tree, missing boundary, evidence-write failure, lease conflict, unrecognized journal, interval verification failures, and net-zero/eligibility outcomes.
- Defaults: three retries after the initial attempt, delay `min(cap, base × 2^attempt)` (base ≈ 2s, cap ≈ 30s) and a bounded total retry window, so a probe timeout cannot multiply into an unbounded stall. Retries are surfaced through `progress.phaseActivity` on the `Compact run` row and in the log.

- **Alternative (rejected):** match the existing reason strings. They are presentation text and would silently drift.
- **Alternative (rejected):** retry every non-completed outcome. That would re-attempt a published-commit block forever and could mask a real safety refusal.

### Decision: expose the finalization outcome to success post-hooks

Pass the persisted finalization record into the success `runHooks` context and publish `CONVOY_FINALIZATION_STATE` plus the produced commit identity when one exists. The existing `CONVOY_GOAL_*` contract is unchanged. This lets a publish hook gate on `completed` without re-deriving state; the `ship` config's gate is user-level and can adopt it as a follow-up.

## Risks / Trade-offs

- **A fatal success post-hook now runs after a compacted commit** → the commit is recoverable (protected refs and manifest), the run is still reported failed with the hook error, and the ordering is documented and covered by a test.
- **Retries can add latency (up to attempts × the 60s probe timeout)** → only transient outcomes retry, attempts are bounded with exponential backoff and a total retry window, and each retry is visible in the feed.
- **`plannedPhases` grows metadata and must stay in sync with the frozen pipeline** → write it once at open from the same list used for the live UI; treat it as optional and fall back to today's derivation when absent or when its pipeline does not match.
- **Changing the terminal-row invariant touches UI and tests** → the order is defined in one helper, existing `Compact run` lifecycle events are untouched, and `test/dashboard-compact-run-row.test.ts` expectations are updated deliberately.
- **Post-hooks that assumed un-compacted history** (for example a branch diff or a manual squash) → this is the intended change; the hook's environment now states the finalization outcome so it can adapt.

## Migration Plan

- Additive optional metadata field; existing runs and schema-v5 readers stay valid and legacy reconstruction keeps working via the fallback.
- The new epilogue order and retry policy apply only to runs started after the change; in-flight runs finish under the old order.
- Rollback is a code revert: no data migration or cleanup is required, because no run history is rewritten by this change.
