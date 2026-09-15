## 1. Re-derive the open subject on refresh

- [ ] 1.1 In `SpecsBrowser.refresh()` (`src/specs-browser.ts`), after the refreshed view is assigned and the root row re-anchored, add a detail branch: when `this.level === "detail"` and `this.subject` is set, re-derive the subject and rebuild `this.groups` from the refreshed view (change by id + checkout via `groupChangeArtifacts`; spec by confirmed path with its single group). Verify by reading the branch and confirming it runs only at detail level.
- [ ] 1.2 Reload the active group with `await this.loadSelectedGroup()` before the cycle's single `render()`, so no loading/blank frame is painted. Verify with a test asserting the pane still contains the group's content immediately after a refresh settles (no intermediate empty body).
- [ ] 1.3 Clamp `this.selectedGroup` to the re-derived `groups.length` and keep `this.detailScroll` and `this.fullscreen` unchanged across the refresh; do not reset scroll or copy status on a refresh. Verify with a test that refreshes on a non-first tab, scrolled, and in fullscreen, asserting tab, scroll, and fullscreen are retained.

## 2. Handle a subject that the refresh no longer contains

- [ ] 2.1 When the refreshed view no longer contains the open subject, call `this.leaveSubject()` after the identity re-anchor, so the browser returns to the root list with the nearest selectable row selected instead of an empty pane. Verify with a test that removes the subject's artifact source and asserts the root list is shown with a restored selection.
- [ ] 2.2 Confirm the failed-refresh `catch` path still returns before the maps are cleared, so a failed refresh keeps the view and loaded pane content. Verify by reading the catch branch and adding a test that forces `boardSource.refresh()` to reject while in the detail level and asserts the pane content is unchanged.

## 3. Tests

- [ ] 3.1 Add a `test/specs-board.test.ts` (or `test/specs-reader.test.ts`) case: open a change's reading pane, drive one background refresh, and assert the active tab's content is still rendered with no blank body. Verify `bun test test/specs-board.test.ts` passes.
- [ ] 3.2 Add a case: edit an open artifact on disk, run a refresh, and assert the edited text appears in the pane without re-entering the subject. Verify `bun test test/specs-board.test.ts` passes.
- [ ] 3.3 Add a case: open a canonical spec (single group), refresh, and assert its content survives (covering the single-group, no-tab-strip path). Verify `bun test test/specs-board.test.ts` passes.

## 4. Regression sweep

- [ ] 4.1 Run `bun test test/specs-board.test.ts test/specs-reader.test.ts test/specs-tui.test.ts test/specs-actions-menu.test.ts` and confirm the existing root-level refresh, reader, and actions-menu behavior is unchanged.
- [ ] 4.2 Run `bun run typecheck` and confirm it passes.
