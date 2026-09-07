# Fix Compact Run Row Order

## Why

During a live goal cycle the dashboard shows the pending `Compact run` row directly above the `goal-measure-N` / `goal-improve-N` invocation groups, visually implying that compaction runs before the fix cycles. The execution semantics are correct — finalization is the run epilogue and compacts every run commit including fix commits — but the display contradicts the established invariant that the terminal lifecycle row always closes a phase list (`reconstructedPhases` enforces it; the live follow path does not), which misleads operators into thinking fix commits are not compacted.

## What Changes

- The live dashboard's additive phase growth (`LiveAttach.syncPhases`) SHALL emit phase rows in canonical display order with the terminal `Compact run` lifecycle row last — after the pipeline prefix, hooks, and every goal invocation group — instead of before the goal invocation rows.
- The dashboard's `syncPhases` merge SHALL uphold the same invariant on its own row list: after appending missing rows, an already-known `Compact run` row moves to the terminal position rather than staying wherever the initial phase list placed it while goal rows are appended below it.
- The live-follow tests that currently pin the incorrect row order SHALL be updated to pin the canonical order, and the dashboard merge gains a test proving the compact row stays terminal as goal rows arrive mid-run.

No execution, Git, compaction, or pipeline behavior changes. This is a dashboard display-ordering fix only.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `run-finalization`: the terminal `Compact run` lifecycle row's position requirement is strengthened to cover every dashboard view that grows its phase list live (attach/live-follow sync during goal cycles), not only the initial reconstruction — the lifecycle row always closes the phase list, so a pending `Compact run` row can never appear above goal invocation rows.

## Impact

- `src/attach-runtime.ts` — `syncPhases` row payload ordering.
- `src/tui.ts` — `syncPhases` merge enforcing the terminal-row invariant.
- `test/attach-follow.test.ts` — expectations updated from the current `[...prefix, compactRunRowName, ...goalRows]` order to the canonical `[...prefix, ...goalRows, compactRunRowName]` order.
- `test/tui.test.ts` — new `syncPhases` ordering case; possibly `test/dashboard-compact-run-row.test.ts` extended to cover the live-sync path.

No changes to compaction semantics, Git operations, pipeline execution, or durable metadata. Existing reconstructed/historical views already comply and are untouched.
