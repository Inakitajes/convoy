Defaults assumed where the design leaves tuning open: refresh cadence 5 s while Home is displayed, freshness bound 15 s (three missed cycles), cache at `~/.convoy/cache/board/<repo-key>.json`. These are values, not open decisions.

## 1. Board cache storage

- [ ] 1.1 Add `src/board-cache.ts` defining `BoardSnapshot` (schemaVersion, repoKey, commonDir, builtAt, board, per-checkout fingerprints), a repo key derived from the realpath'd Git common dir, and version gating; verify a unit test proves the key is stable across worktrees of one repository and differs between clones
- [ ] 1.2 Implement cache load through `repo-store.readJsonFile` with a validator, mapping `missing`/`corrupt`/`unsupported`/`unreadable` to "no cache"; verify tests cover all four statuses and that none throws
- [ ] 1.3 Implement cache save through `writeJsonFile` (atomic, `0o600`) only when the snapshot changed materially; verify a test proves an unchanged snapshot writes nothing and that a simulated crash mid-write leaves the previous cache intact

## 2. Fingerprint and BoardSource

- [ ] 2.1 Add `src/board-refresh.ts` with a per-checkout fingerprint over the Git worktree listing and the checkout's OpenSpec tree mtimes; verify a test proves an unchanged fingerprint reuses prior changes/tasks and a changed `tasks.md` mtime marks that checkout dirty
- [ ] 2.2 Implement `BoardSource.cached()` (memory → disk → none) and prove it never calls `assembleControlBoard`; verify with an injected spy
- [ ] 2.3 Implement `BoardSource.refresh()` as two tiers — always run the cheap Git/writer probes, gate the OpenSpec readers by fingerprint, and read `listRuns()` once per cycle; verify a spy test shows zero task-query calls and exactly one `listRuns()` call on an unchanged cycle
- [ ] 2.4 Add a refresh-generation guard so a slow older refresh cannot overwrite a newer snapshot; verify an out-of-order completion test keeps the newer board

## 3. Control-board assembly performance

- [ ] 3.1 Skip the OpenSpec task query when a checkout has no active changes in `src/checkout-openspec.ts`; verify a test asserting `openspecTaskCounts` is not called for an empty change set
- [ ] 3.2 Reuse task counts for unchanged change content via the fingerprint; verify a test proves the CLI-backed query is skipped when content is unchanged and re-run when it changes
- [ ] 3.3 Read shared run history once per cycle and thread it into activity observation and detail recent-runs in `src/control-board.ts` / `src/worktree-observations.ts`; verify a test asserting one read for several checkouts
- [ ] 3.4 Observe checkouts with a bounded-concurrency helper instead of the sequential loop; verify a test asserts the configured maximum is never exceeded and every checkout still reports independent facts
- [ ] 3.5 Reuse the detected base ref across a cycle in `src/control-board.ts`; verify a test asserts `detectBaseRef` runs at most once per cycle

## 4. Home cache-first rendering and selection

- [ ] 4.1 Wire `launchHomeTui` to a `BoardSource`, painting the cached board immediately and falling back to the shared loading transition only with no usable cache; verify a test proves a warm open paints without the transition and a cold open uses it
- [ ] 4.2 Give `HomeLauncher` a poll timer (default 5 s) that calls `BoardSource.refresh()` and re-renders, cleared in `finish()`; verify a timer test shows no renders after `finish()` and no timer while a destination is open
- [ ] 4.3 Render the snapshot age and the in-flight refresh indicator right-aligned in the masthead, degrading on narrow widths; verify wide/narrow snapshot tests
- [ ] 4.4 Preserve the selected checkout by realpath across a refresh and fall back to New worktree when it disappears, never selecting a replacement; verify refresh-selection tests
- [ ] 4.5 Re-derive the open detail from the refreshed row and update its recent runs from the cycle's shared read in place; verify a detail-refresh test
- [ ] 4.6 Remember the checkout viewed when a Home session closes and pass it as `initialSelection` on return within the session, with the first launch selecting New worktree; verify navigation-loop tests including the disappeared-checkout fallback

## 5. Freshness and on-demand PR

- [ ] 5.1 Mark evidence older than the freshness bound as stale and disclose a failed refresh while retaining the last snapshot; verify tests for aged and failed-refresh rendering
- [ ] 5.2 Fire PR evidence on landing and on detail open when absent or expired, and never on the background cycle; verify a test asserting no PR call during an idle refresh cycle

## 6. Verification

- [ ] 6.1 Run `bun run typecheck` and `bun test` and confirm they pass
- [ ] 6.2 Run `openspec validate live-board-cache-and-refresh --strict` and confirm the change validates
- [ ] 6.3 Measure and record warm Home open latency, cold open latency, and steady-state poll cost on this repository (2 worktrees) showing the comparison to the current ~1.6 s cold assembly
