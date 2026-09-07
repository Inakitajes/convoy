# Design — Fix Compact Run Row Order

## Context

The execution semantics are already correct: `runFinalization` is the run epilogue (`src/runner.ts:886`) and compacts the full verified run interval, including goal fix commits. The defect is confined to the live-follow display path:

- The initial dashboard phase list comes from `resetPipeline` (`src/runner.ts:612` → `progressPhases(pipeline, hookSet)`), which already ends with the pending `Compact run` row.
- When the goal scheduler starts invocations, `LiveAttach.syncPhases` (`src/attach-runtime.ts:91`) sends `[...progressPhases(pipeline), ...goalProgressPhases(...)]` — the compact row *before* the goal rows in the payload.
- The dashboard's `syncPhases` merge (`src/tui.ts:1633`) is append-only: it appends only unknown rows and cannot reorder existing ones. Since the compact row is already known, the payload's ordering of it is moot — the goal rows land after the pending `Compact run` row regardless.

`reconstructedPhases` (`src/attach.ts:92-96`) already moves the row last for initial reconstruction, and `goal-phases.ts` already filters it out of per-fragment rows, so only the live-follow path violates the invariant. `test/attach-follow.test.ts:149,171` currently pins the incorrect payload order.

See `proposal.md` for motivation and `specs/run-finalization/spec.md` for the requirement.

## Goals / Non-Goals

**Goals:**

- The `Compact run` row is always the terminal row of a dashboard's phase list, in every view that grows its list live (controller, observer, mid-cycle attach).
- Preserving all row state (status, sessions, transcripts, usage) across the reordering — the row moves, nothing is rebuilt.
- Aligning the `LiveAttach` payload order with the invariant so the contract and its tests describe one canonical order.

**Non-Goals:**

- Any change to compaction execution, Git operations, ledger/boundary verification, or goal scheduling.
- Changing `progressPhases`, `resetPipeline`'s initial list, `reconstructedPhases`, or `goal-phases` filtering (all already compliant).
- Making `syncPhases` a general reordering engine — the merge stays additive for everything except this one terminal-row invariant.

## Decisions

### D1 — Enforce the invariant in the TUI's `syncPhases`, not only in the payload

After appending additions, the dashboard partitions `this.phases` into "everything except the compact row (current order)" + "the compact row", preserving the row objects. Rationale: the TUI owns `this.phases`, and the compact row was registered by the initial reset before any goal row exists — a payload-ordering fix alone can never move it. The reordering only ever fires on a tick that adds rows; on subsequent syncs the row is already last and the partition is a no-op.

*Alternatives considered:*
- *Reorder only in `LiveAttach.syncPhases`* — insufficient: the row is already known at merge time and is never re-appended, so its position is fixed by the initial reset.
- *Omit the compact row from the initial reset list and add it at epilogue time* — rejected: `test/dashboard-compact-run-row.test.ts` pins that the row is part of every phase list handed to `resetPipeline`/`reconstructedPhases`, and removing it from the initial list would leave dashboards with no epilogue row if the coordinator dies before the epilogue.

### D2 — Also canonicalize the `LiveAttach` payload order

`attach-runtime.ts` emits `[...prefixWithoutCompact, ...goalRows, compactRow]` — i.e., build the same list and move the compact row last, mirroring `reconstructedPhases`' SC-2 closure. Rationale: `ProgressUI.syncPhases` is a contract (`src/progress.ts:381`) that other implementations could honor; sending rows in display order keeps the contract honest and lets the attach-follow tests pin the canonical payload. Both layers enforcing the same invariant is cheap and makes either layer's regression visible in tests.

*Alternative considered:* TUI-only enforcement (single change). Rejected because the payload contract would keep advertising a non-canonical order.

### D3 — Reuse the exported `compactRunRowName`; no new constants or state

`tui.ts` imports `compactRunRowName` from `./runner` (no import cycle exists: `runner.ts` does not import `tui.ts`, and `attach-runtime.ts` already imports both `progressPhases` and `compactRunRowName` consumers' names from there). Matching stays name-based, consistent with how `reconstructedPhases` (`attach.ts:95`) and `goal-phases.ts` (`goal-phases.ts:86`) already identify the row. No new capability flag, no durable state, no metadata change.

### D4 — Preserve focus/selection across the move

Moving the compact row shifts the indexes of rows positioned between it and the end — rows that, on the tick where the move fires, are exactly the freshly appended pending additions, except for the compact row itself. `this.selected` is index-based: if it pointed at the compact row's old index, it is repointed at the row's new (terminal) index; other selections are unaffected because rows before the compact row never shift. `selectedGroup` and interactive-takeover state are keyed by name/group id, not index, and are untouched.

### D5 — Tests pin the invariant at both layers

- `test/attach-follow.test.ts`: the two payload expectations become the canonical order (`[...prefixNames, ...measure0, compactRunRowName]`, then `[...prefixNames, ...measure0, ...improve1, compactRunRowName]`).
- `test/tui.test.ts` (`describe("syncPhases")`): a new case builds a dashboard whose list ends with the compact row, syncs goal rows in the live payload order, and asserts the final row order ends with the compact row; a repeat sync is a no-op; a compact row that already carries terminal state (e.g. completed with a produced SHA) keeps that state and its terminal position.
- `test/dashboard-compact-run-row.test.ts` gains a case asserting `LiveAttach`'s payload closes with the compact row for a goal pipeline (or the attach-follow expectations are deemed sufficient coverage for that layer — implementer's discretion, noted in tasks).

## Risks / Trade-offs

- [Reordering mutates a list other code assumes is append-stable] → The only mutation is the partition move; row objects are referenced, never recreated, so all per-row state (transcripts, sessions, usage) survives. The move fires at most once per run per dashboard (the first goal-row append) because afterwards the row is already terminal.
- [Selection index drift] → Mitigated by D4; the shifted rows on a move tick are freshly appended pending rows that cannot be selected within the same tick.
- [A future row type with "must be terminal" semantics would need the same special case] → Accepted: today exactly one lifecycle row exists; if another appears, the partition helper should generalize to "terminal rows last" then.

## Migration Plan

No durable data, config, or API migration. Land as one commit with tests; rollback is reverting the commit. Display-only, so a revert is safe at any time.

## Open Questions

(none)
