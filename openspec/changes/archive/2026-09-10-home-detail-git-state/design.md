## Context

See `proposal.md` — Why. Home's row fold (`inlineDetailLines`) already composes the observed Git state from `BoardWorktree.dirt`, `.upstream`, and `.baseDivergence`; the detail screen (`detailLines`) renders only `dirt` among those, so the same worktree shows less state once it is opened.

## Goals / Non-Goals

**Goals:**
- The detail screen shows the same independent Git facts as the row, reusing the already-observed values (no new observation calls).

**Non-Goals:**
- No new observation or fetch; the detail never re-queries the board's data layer.
- No change to the row fold's compact wording.

## Decisions

**D1 — Render the existing independent observations, not a new combined verdict.** The detail adds separate `upstream` and `base` fact rows from `worktree.upstream` / `worktree.baseDivergence`. Rationale: the control-board spec requires base and upstream comparisons to stay independent with their refs rather than a single synchronization status; the row's combined string is a compact fold, whereas the detail is the expanded view.

**D2 — Distinguish no-upstream, clean, and unknown.** The `upstream` row renders `none` when the branch has no upstream, the ref plus counts when known, and `unknown (reason)` when the probe failed — mirroring `Observed` semantics. Rationale: the spec forbids reporting no upstream as zero divergence and forbids hiding an unknown as absent.

## Risks / Trade-offs

- [Extra detail rows crowd the facts block] → Each row is one line and renders only when the board observed the fact (`upstream`/`baseDivergence` are optional), matching the existing optional `activity`/`pr`/`lock` rows.
