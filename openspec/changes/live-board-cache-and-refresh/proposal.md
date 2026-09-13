## Why

Opening Home recomputes every observation synchronously and blocks the first paint: ~1.6 s for a two-worktree repository, dominated by one `openspec list --json` subprocess per checkout (~650 ms each, spawned even when the checkout has no active changes) and one full run-history read per checkout. Because the load always exceeds the 150 ms transition threshold, every Home open shows the loading screen. Once mounted, the board is a frozen snapshot: nothing refreshes while Home stays open, so worktrees, changes, runs, and writers created in another Convoy window or outside Convoy remain invisible until the operator leaves and returns. The tool feels slow to open and stale to sit in.

## What Changes

- Add a repository-scoped board cache under `~/.convoy`, keyed by the repository's Git common dir, written atomically and read with typed outcomes; a missing, corrupt, unsupported, or unreadable cache is ignored and triggers a fresh load rather than failing.
- Cache-first paint for Home: render the last cached board immediately and always fire a background refresh in parallel. The loading transition becomes the cold/unusable-cache fallback, not the normal path.
- Continuous refresh gated by a cheap fingerprint (Git worktree listing plus per-checkout admin-dir and OpenSpec-dir mtimes): poll roughly every 5 seconds and recompute only the parts whose fingerprint changed, so the steady-state poll is near-free.
- Freshness honesty: cached observations keep their collection time and their `unknown` reasons. Older evidence is shown with its age and never presented as currently verified; a failed refresh leaves the previous evidence marked stale.
- A minimal refresh indicator in the top-right corner while a refresh is in flight, together with the age of the displayed snapshot.
- Selection follows identity, not position: a background refresh keeps the current checkout selected by path/branch, and returning to Home within the same session reopens on the checkout the operator was viewing.
- **BREAKING** (user-visible behavior): Home no longer always opens on the New worktree entry when returning within a session; it restores the previously viewed checkout by identity. The initial launch still opens on New worktree, and no selection starts an agent or action.
- PR facts keep their on-demand cadence: observe when the selection lands on a row or when its detail opens, bounded and cached — never eager per-row polling.
- Performance work that stands on its own: never invoke the OpenSpec CLI for a checkout with no active changes, serve task counts from a freshness-bounded cache keyed to change content, share a single run-history read across a refresh cycle, and observe checkouts with bounded concurrency.

## Capabilities

### New Capabilities
- `live-board-refresh`: the repository-scoped board cache and the continuous, fingerprint-gated background refresh, including freshness/age disclosure, the in-flight indicator, and cache-first read semantics.

### Modified Capabilities
- `home-launcher`: Home paints from cache first (the loading transition is only the cold fallback), keeps the operator's selection by identity across refreshes and on return within a session, shows a discreet freshness/refresh indicator, and refreshes on-demand PR facts on landing/detail.
- `control-board`: the assembly performance contract (no OpenSpec CLI call without active changes, freshness-bounded task counts, one shared run-history read per cycle, bounded-concurrency observation) and cache-aware refresh semantics.

## Impact

- Code: new `src/board-cache.ts` (storage + refresh source) and `src/board-refresh.ts` (fingerprint + scheduler), plus changes to `src/control-board.ts`, `src/task-counts.ts`, `src/checkout-openspec.ts`, `src/worktree-observations.ts`, `src/home-tui.ts`, and the Home session/loop in `src/cli.ts`. `src/repo-store.ts` supplies the atomic/typed storage primitives; `src/session-hints.ts` informs within-session selection continuity.
- New persisted state: a disposable board cache under `~/.convoy/cache/<repo-key>/`, versioned and safely ignorable. No dependency changes.
- Tests: `test/control-board.test.ts`, `test/home-tui.test.ts`, and new coverage for the cache, fingerprint, scheduler, and refresh indicator.
