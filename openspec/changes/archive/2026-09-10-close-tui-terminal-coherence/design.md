## Context

Interactive close runs on an OpenTUI alternate screen whose renderer is diff-based: a render only rewrites cells whose logical content changed, and a full repaint happens only when something forces it (for example `renderer.resume()`). Two independent leaks break that model.

1. `commitAsUser` deliberately runs with `stdin/stdout/stderr` inherited so signing, hooks, and credentials work (`src/git.ts`). The archive step calls it while the close TUI is live and unsuspended (`archiveSelectedChanges`, plus the interrupted-archive reconcile commit), so git's `[ref] subject` plus `rename … (100%)` lines paint straight over the alternate screen. The next renders are diffs and never restore the stomped cells, so the commit-message review that follows shows git output entangled with the reviewed text. Commit `67a19a2` wrapped only the final squash/landing; the archive commit was missed.

2. After a successful close, `runClose` awaits `showNoticeTui(...)` *before* the `finally { tui.destroy() }`. `CloseTui`'s keypress handler is still registered (first) on the shared `renderer.keyInput`, and in `progress` mode it calls `stopPropagation()` for every key. OpenTUI's `InternalKeyHandler` stops dispatching after that (`index-081xws23.js:1891`), so the notice never receives `q`, Escape, Enter, or Ctrl+C and cannot be dismissed — the "close complete" screen is frozen.

## Goals / Non-Goals

**Goals**

- No inherited-terminal git output is ever painted over the live close interface.
- The post-close completion/cancellation notice receives input and can be dismissed.
- Headless close and the existing CLI surface are unchanged.

**Non-Goals**

- Changing the composed message, the landing routing, or the hosted recovery journal.
- Re-designing the shared-session scene/notice framework.
- Fixing the same archive-commit leak for the standalone `convoy worktrees archive` entry point (same helper, separate surface) in this change.

## Decisions

### D1: Suspend around each inherited-terminal commit, not the whole archive step

`archiveSelectedChanges` and `completeInterruptedArchiveCommit` gain an optional `withTerminal` seam and wrap only their `commitAsUser` call with it; `driveClose` passes `progress.withTerminal` down. Suspending only the commit keeps the running spinner visible while the (captured, possibly slow) `openspec archive` subprocess runs, instead of blanking the interface for the whole step.

Alternative considered: wrapping the entire archive step in `driveClose`. Simpler, but it suspends the TUI across `openspec archive` too, losing the live progress row for no benefit.

### D2: Reuse the existing `CloseTui.withTerminal` seam

The close progress type already exposes `withTerminal`, implemented as `renderer.suspend()` … `renderer.resume()` with ticker sync. `resume()` forces a full repaint (`forceFullRepaintRequested`), which is exactly what is needed to clear anything git printed. No new renderer machinery is required; only the archive path is added to the existing call sites.

### D3: Release input ownership before the notice, not inside the notice

`CloseTui.destroy()` is idempotent, removes its keypress/input listeners, and (only when it owns the renderer, i.e. non-shared) destroys the renderer; in the shared-session case it leaves the renderer and the painted tree alone. `runClose` will call `tui.destroy()` before `showNoticeTui(...)` on the success/cancellation path, and keep the `finally` as a safety net. The scene handoff still repaints atomically: the notice's `openScene` closes the close scene, so nothing goes blank.

Alternative considered: make `CloseTui` stop calling `stopPropagation()` in `progress` mode. Rejected: it relies on global listener ordering for every future screen and could leak keys during progress; explicit teardown is the correct lifecycle.

## Risks / Trade-offs

- Calling `destroy()` earlier means the close screen's listeners are gone while the notice renders; the notice fully owns input, which is the intent. The `finally` keeps failure teardown intact.
- If a future inherited-terminal effect is added to close without the `withTerminal` seam, the same corruption returns. The tasks add a regression test so the seam is exercised.

## Migration

None. Behavior-only fix; no persisted state, journal schema, or CLI contract changes.
