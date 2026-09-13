## Context

See `proposal.md` and `openspec/changes/live-board-cache-and-refresh/specs/` for motivation and requirements. The current mechanics that shape this design:

- `runHomeNavigationLoop` (`src/cli.ts`) awaits `loadHomeWithTransition` → `assembleControlBoard` → `launchHomeTui` on every Home open; `assembleControlBoard` iterates checkouts sequentially and, per checkout, runs `readCheckoutActiveChanges` (which spawns `openspec list --json`, ~650 ms) plus dirt/divergence/activity/writer probes. `observeExecutionActivity` calls `listRuns()` once per checkout.
- `HomeLauncher` (`src/home-tui.ts`) owns synchronous rendering, an on-landing PR observation, and a per-launcher runs-evidence map; it has no timer and no way to accept fresh data after construction.
- `src/repo-store.ts` already provides atomic, versioned, typed JSON storage (`readJsonFile`/`writeJsonFile`) and is the established home for repo-scoped records; `src/pr-observations.ts` and `src/control-board.ts` already demonstrate bounded, TTL caches.
- `Observed<T>` (`src/worktree-observations.ts`) already carries `collectedAt` per fact, and `unknown` carries a reason — the freshness vocabulary the cache needs already exists.

## Goals / Non-Goals

**Goals:**

- Home paints from last-known data in milliseconds and never blocks on the expensive readers in the normal (warm) case.
- The board stays current within a few seconds of external change, across Convoy windows and outside Convoy, without paying the expensive readers on every tick.
- Freshness is honest: age is visible, stale evidence is never presented as current, and unknown stays unknown.
- Selection follows the operator's viewed checkout by identity, not list position, across refreshes and returns within a session.

**Non-Goals:**

- No shared daemon, socket, or cross-process push: cross-window currency is achieved by polling a repository-scoped cache plus Git/filesystem fingerprints. A push bus is explicitly out of scope for this change.
- No change to what the board observes, its guards, or the destination screens' own loading behavior.
- No eager per-row PR polling and no PR observation on the background cycle.

## Decisions

### D1 — Cache lives under `~/.convoy`, keyed by the repository's common dir

Store one JSON document per repository at `~/.convoy/cache/board/<key>.json`, where `<key>` is a stable hash of the realpath'd Git common dir. **Why**: the user chose a global cache; it keeps the repository's `.git` untouched, survives restarts, and is shared by every worktree and every Convoy window of the repository. Keying by common dir (not by cwd) means all worktrees and windows of one repository share one cache while distinct clones stay separate.

**Alternatives considered**: `<git-common-dir>/convoy/` (matches `writer-claims`, but writes into `.git`); in-process memory only (cannot serve a fresh cold start and cannot be seen by another window); `~/.convoy/runs` adjacency (wrong scope — runs are not repo-scoped).

### D2 — The cache stores the serialized board with per-checkout fingerprints

The document holds `schemaVersion`, `repoKey`, `commonDir`, `builtAt`, the `ControlBoard` (rows and their `Observed` facts, including `collectedAt` and unknown reasons), and a per-checkout fingerprint map. PR facts are excluded (they stay on-demand). Reads use `repo-store.readJsonFile`; `missing`/`corrupt`/`unsupported`/`unreadable` all mean "no cache" and trigger a cold load. Writes use `writeJsonFile` (atomic temp+rename) and happen only when the snapshot changed materially.

**Why**: reusing the existing typed store keeps the "unknown is not none" discipline and makes cache invalidation a non-event. **Alternative**: a bespoke format — rejected, it would re-implement atomicity and version gating.

### D3 — A `BoardSource` owns cache + refresh; a launcher-owned timer drives cadence

Introduce `src/board-cache.ts` (document shape, repo key, load/save) and `src/board-refresh.ts` (fingerprint + `BoardSource`). `BoardSource` is created once per Home session and holds the hot snapshot; it exposes `cached()` (memory → disk → none) and `refresh()` (fingerprint compare, assemble only what changed, save on material change). `HomeLauncher` receives the source and runs its own poll timer, calling `refresh()` and re-rendering.

**Why**: the session-scoped source makes returning to Home instant and lets the cache survive across opens; the launcher-owned timer ties polling to visibility so nothing refreshes while a destination owns the screen, and it is cleared in the existing `finish()` path alongside `caretTimer`/`proposeTimer`. **Alternative**: timer inside the source — leaks past Home and refreshes invisibly.

### D4 — Refresh is two-tiered: cheap probes always, expensive readers fingerprint-gated

Each cycle:

- **Always (cheap, bounded concurrency)**: `git worktree list --porcelain -z` for the inventory; per accessible checkout `git status` (dirt), `git rev-list` (base/upstream divergence), and the writer-claim file read. These are ~10–50 ms each and are the "live" tier.
- **Gated by fingerprint**: the OpenSpec artifact read and task counts. The fingerprint is the checkout's `openspec/` tree mtimes plus the change directories'; when unchanged, the previous changes/tasks (and their `collectedAt`) are reused instead of spawning `openspec list --json`.
- **Once per cycle**: `listRuns()` is read one time for the whole board and shared by activity observation and the open detail's recent runs.

**Why**: this targets the measured dominant cost (the CLI) while keeping dirt/branch facts live. **Alternative**: gate everything behind one coarse fingerprint — would freeze dirt/divergence behind unrelated edits and feel stale.

### D5 — Assembly avoids work for absent inputs and parallelizes checkouts

Independently of caching: `readCheckoutActiveChanges` skips the task query when there are no active changes (currently it always spawns the CLI); the sequential per-checkout loop becomes a bounded-concurrency map (small internal helper, no new dependency); `detectBaseRef` and hosting resolution reuse the session cache. These land even where the cache misses, so a cold load is materially faster.

### D6 — Staleness is a rendered fact, not a hidden assumption

The snapshot carries `builtAt` and each fact its `collectedAt`. Home renders a discreet age in the top-right of the masthead (right-aligned via `padBetween`, degrading on narrow widths). Evidence older than a freshness bound (nominally three missed cycles) is marked stale; a failed refresh keeps the last snapshot with its age and discloses the failure. Guard revalidation before mutation is unchanged, so stale display never grants mutation.

### D7 — Selection continuity is in-memory and identity-keyed

`launchHomeTui` gains an `initialSelection` of `{ path, branch }` and the navigation loop remembers the checkout selected when a Home session closes; the first launch passes none and therefore selects New worktree. On each refresh, `HomeLauncher` captures the selected row's identity, rebuilds rows, and re-selects by realpath (falling back to New worktree if it disappeared) — never by index or change id. Persisted `session-hints.ts` records stay non-authoritative.

**Alternative**: reuse the persisted last-selection hint — rejected because the chosen scope is same-session only, and the existing requirement keeps hints away from selection.

### D8 — PR and runs evidence keep their on-demand rhythm

PR evidence fires on landing and, if absent or expired, when a detail opens (shared `PrCache`, 30 s TTL); the background cycle never queries PR. When a detail is open, its recent runs come from the cycle's single shared `listRuns()` read and update in place. This satisfies "refresh PR only when I land on it or open the detail".

## Risks / Trade-offs

- **Many checkouts × gated readers** → bounded concurrency plus fingerprint gating caps subprocess fan-out; per-cycle run history is read once.
- **File mtime granularity can miss rapid edits within the same millisecond** → task-content changes are additionally keyed by the change directory's fingerprint (name+mtime+size); a missed change is corrected on the next cycle at worst.
- **Stale cache presented as truth** → age is always rendered, stale is marked, failed refresh is disclosed, and mutating guards revalidate.
- **Cache write churn** → atomic writes only on material change; failures never overwrite the last good snapshot.
- **Concurrent writers across windows** → atomic rename with last-writer-wins is acceptable for a disposable cache; `unsupported`/`corrupt` is ignored, not repaired.
- **Timer leaks** → the timer lives in `HomeLauncher` and is cleared in `finish()`; the source never schedules.
- **Selection identity collisions (same branch, same-id copies)** → match by realpath of the checkout, and never by change id.

## Migration Plan

Additive and self-healing: with no cache, Home behaves as today (cold load, transition) and writes the cache after the first successful refresh. Deleting `~/.convoy/cache/board/` is always safe. Rollback is removing the source wiring; the stale files are inert.

## Open Questions

- Final refresh cadence default (5 s versus 10 s) and whether to back off when the terminal has been idle for a long time — both are tuning values that do not change the specs or the approach.
- Exact freshness bound for the "stale" marking (proposed: three missed cycles).
- Whether the age is shown as text (`as of 4s`) or a compact glyph plus tooltip-style text; the spec requires age exposure, not a specific rendering.
