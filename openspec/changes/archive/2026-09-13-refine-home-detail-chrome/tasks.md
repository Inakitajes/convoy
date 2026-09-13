## 1. Accent checkout zone

- [x] 1.1 In `detailLines()` (`src/home-tui.ts`), render the selected checkout's identity — folder-basename heading, path, branch, and the linked pull request — as one solid accent-filled zone, reusing the `filledLines` helper with `theme.accent`, with the remaining observed facts (writer, dirt, upstream, base, activity, change counts, lock/prunable/inaccessible state) rendered plain beneath it. Verify: a home-tui test captures spans in the detail and asserts the identity/path/branch/PR rows carry the accent background while the other facts stay transparent.
- [x] 1.2 Choose readable foreground colors for the zone so labels, values, and warnings survive on the light accent fill (chip text on the fill; warnings keep a distinguishable color). Verify: capture the foreground channels of the zone's PR warning and assert it is yellow and its label rides the chip text, and render the detail once to eyeball contrast.

## 2. Runs empty line

- [x] 2.1 In `detailLines()`, drop the leading indent from the `no runs recorded for this checkout` line so it sits flush with the section heading. Verify: a home-tui test asserts the rendered line starts at the left edge, and `bun test test/home-tui.test.ts` stays green.

## 3. Linked Specs placement and visibility

- [x] 3.1 In `detailLines()`, render the Linked Specs heading and its change rows immediately after the OpenSpec section and before the git section. Verify: the section-order test asserts `Linked Specs` appears after `OpenSpec` and before `git`.
- [x] 3.2 Move the linked-change entries in `detailEntries()` to the same position — after the OpenSpec actions, before the git actions — so selection order matches render order. Verify: the linked-change navigation test reaches the change row by pressing down from the top and resolves `{ type: "work-change", ... }`.
- [x] 3.3 Gate the section: when the change list was read and is empty (`!changesUnknown && changes.length === 0`) omit the Linked Specs heading and rows entirely; when `changesUnknown` is set, still render the `unknown — <reason>` observation. Verify: the empty-changes test asserts no `Linked Specs` heading renders, and the unreadable-list test asserts it renders with the reason.

## 4. Verification

- [x] 4.1 Run `bun test test/home-tui.test.ts` and `bun run typecheck`; confirm both pass with the updated assertions.
- [ ] 4.2 Open `bun run dev`, enter a checkout's detail, and confirm the accent zone holds only the name, path, branch, and PR (the other facts stay plain), the flush-left Runs empty line, and the OpenSpec → Linked Specs → git order; then open a checkout with no changes and confirm no Linked Specs section renders.
