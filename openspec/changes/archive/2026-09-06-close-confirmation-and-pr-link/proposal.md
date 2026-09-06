# Proposal: close-confirmation-and-pr-link

## Why

Two operator-facing problems in the close flow:

1. When a feature branch has an open pull request, close's local squash landing
   creates a brand-new commit object that GitHub cannot link to the PR (no
   merge ancestry, and GitHub did not perform the merge), so the PR stays open
   forever even after the landing is pushed. The operator has to close it by
   hand on GitHub.
2. In the specs browser, pressing `x` (or selecting Close in the Actions menu)
   starts the whole close sequence — sync, archive, squash-merge — with no
   confirmation. The only existing gate (message review) happens after archive
   has already mutated the worktree. A stray keystroke runs hard-to-revert
   actions.

## What Changes

- Close's squash-merge step becomes PR-aware: before composing the landing
  message it probes for an open PR whose head is the feature branch (via the
  GitHub CLI, tolerant of absence/failure), discloses what it found without
  asserting merge, and adds the PR reference to the composed landing subject so
  GitHub marks the PR merged when the follow-up push lands.
- Close's follow-up guidance gains the PR: when an open PR was detected, the
  follow-up block names the PR (number and URL) and prints the deliberate
  fallback close command for the case where GitHub does not mark it merged.
  No push and no PR mutation ever happen automatically.
- The specs browser requires explicit confirmation before handing off to close:
  `x` in the list and the Actions menu's Close entry open a y/n modal naming the
  feature, its branch, the base, and the sequence that will run; only an
  explicit confirm emits the close resolution.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `feature-close`: an added requirement for open-PR detection/disclosure and
  the guarded PR follow-up; a modified requirement for the composed landing
  message so the detected PR reference rides on the reviewed subject.
- `specs-viewer`: an added requirement that close handoff from the browser is
  confirmed before the close command runs.

## Impact

- `src/feature-close.ts` — PR probe in the squash-merge step, PR reference on
  the composed proposal, PR facts on close events/result for follow-ups.
- `src/feature-close-command.ts` — follow-up resolution and formatting (headless
  block) plus the interactive follow-ups notice; help text.
- `src/close-tui.ts` — follow-ups notice carries the PR line.
- `src/specs-browser.ts` — confirmation state, modal rendering, and key
  handling for `x` and the Actions menu's close entry.
- Tests: `test/feature-close.test.ts`, `test/feature-close-command.test.ts`,
  `test/close-tui.test.ts`, `test/specs-tui.test.ts`,
  `test/specs-actions-menu.test.ts`.
