## 1. Pure selection helpers

- [ ] 1.1 Add pure helpers for marking/unmarking a change, selecting all active changes, and producing the confirmed selection in picker-listing order; verify with unit tests covering toggle, select-all, dedupe, and empty selection
- [ ] 1.2 Add unit tests asserting a confirmed multi-selection is ordered by the listing regardless of toggle order; verify `bun test test/change-selection.test.ts` passes

## 2. Launcher change picker (surface A)

- [ ] 2.1 Add `space` to toggle the highlighted row and `a` to select all in the launcher contract picker, keeping the `Manual prompt` row as the explicit no-change gesture; verify with a TUI test that marks two rows and confirms
- [ ] 2.2 Make `enter` confirm the marked set when any row is marked, and otherwise pin the highlighted row (no-change row → manual mode, spec row → that change only); verify the existing single-pick and manual-mode launcher tests still pass
- [ ] 2.3 Render mark state and selection count in the picker detail and footer (replace the `specIndex+1/N+1`-only counter); verify a TUI frame shows the marks and the count
- [ ] 2.4 Update the picker intro and the OpenSpec notice copy so they describe picking one or more (no "pick one" wording); verify the notice tests assert the new copy

## 3. Launcher focus rule (request D)

- [ ] 3.1 Centralize one focus rule — first selected change, else first active change, else the no-change row — across `openPrompt`, the options-step return, and the prompt-editor escape return; verify a TUI test that opens the prompt step in a worktree with active changes lands the highlight on the first active change
- [ ] 3.2 Verify re-entry restores the highlight to the first selected change and the no-change row stays reachable with unit/TUI tests

## 4. Archive picker (surface B)

- [ ] 4.1 Change `showChangePickerTui` to return the ordered batch (`{ kind: "select", changeIds }`) with `space` toggle and `a` select-all; verify `bun test test/change-picker-tui.test.ts` covers selecting several and selecting all
- [ ] 4.2 Make confirming with nothing marked archive nothing and not report success; verify with a picker test
- [ ] 4.3 Pass the confirmed batch from the `src/cli.ts` archive call site to `runWorktreeArchive`; verify the existing archive command tests still pass

## 5. Integration verification

- [ ] 5.1 Verify `bun run typecheck` passes
- [ ] 5.2 Verify the full suite passes with `bun test`, including the launcher, picker, and archive tests updated above
