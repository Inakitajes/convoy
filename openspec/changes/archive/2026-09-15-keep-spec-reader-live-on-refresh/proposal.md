## Why

The specs browser's background refresh runs on the shared five-second board cadence (change `live-board-cache-and-refresh`). That cycle clears the lazily loaded artifact bodies and rebuilds the root list, but it never reloads the subject open in the reading pane — so an open change or spec collapses to a title row over a blank pane roughly five seconds after it is opened, and stays blank until a tab key (a digit or arrow) happens to reload the group. The reading pane must be re-derived like Home's worktree detail already is, not emptied.

## What Changes

- On every refresh — scheduled or forced — while the detail reading level is open, re-derive the open subject and its artifact groups from the refreshed view, then reload the active group's markdown before painting, so the pane never shows the blank loading frame.
- Preserve the operator's reading context across a refresh: the active tab, the scroll position, and the fullscreen reader state.
- Bring external edits to the open artifact into the pane within the refresh cadence, consistent with the live-refresh intent, rather than freezing the content that was loaded on entry.
- If the open subject no longer exists in the refreshed view (for example it was archived elsewhere), return to the root list with the selection restored by identity — never silently retarget to a different subject.
- Failed refreshes keep the current view and the currently loaded reader content, exactly as they keep the root list today.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `specs-viewer`: the reading pane must survive a background refresh and stay current — a refresh re-derives the open subject and reloads its active group instead of clearing the loaded bodies.

## Impact

- Code: `src/specs-browser.ts` — the refresh cycle, the detail render path, and entry/reload of a subject.
- Tests: `test/specs-board.test.ts` (or `test/specs-reader.test.ts`) gain coverage for a refresh with the reading pane open.
- No new APIs, dependencies, or persisted state; Home's existing re-derive behavior is unchanged.
