# Tasks: close-confirmation-and-pr-link

## 1. PR-aware close (feature-close)

- [x] 1.1 Add the PR probe: in `src/feature-close.ts`, during the squash-merge step before composing the message, run `gh pr list --head <branch> --state open --json number,title,url --limit 1` in the main checkout through `execFile` with `allowFailure`; parse the JSON; every failure mode (missing gh, non-zero exit, parse error, empty list) degrades to no detected PR. Verify: unit test in `test/feature-close.test.ts` injecting a run seam asserts a detected PR is parsed and a failing/absent gh degrades without blocking.
- [x] 1.2 Carry the PR on the result: add `pullRequest?: { number: number; title?: string; url: string }` to `CloseResult` and set it on landing dispositions when the probe detected a PR; include it in the result event. Verify: unit test asserts the result event carries the PR on a landed close and omits it on no-change/already-landed.
- [x] 1.3 Apply the `(#N)` reference: pass the detected PR number into `composeCloseMessage`, append ` (#N)` to the subject line of the formatted proposal (subject trimmed so the first line stays within the cap when possible), so review shows exactly what lands and the journal persists it; no re-append after operator edits; `--message` bypasses it. Verify: unit tests in `test/feature-close.test.ts` — composed subject ends with `(#N)`, fallback proposal too, edited message without the reference stays without it, explicit `--message` unchanged.
- [x] 1.4 Disclose the PR: surface the detected PR (number, title, URL) in the interactive checklist (squash-merge row detail or result screen via the existing event/detail mechanism) and in the headless summary without asserting merge. Verify: `test/close-tui.test.ts` shows the disclosure; `test/feature-close-command.test.ts` shows the headless line.

## 2. PR follow-up guidance (feature-close-command, close-tui)

- [x] 2.1 Extend `resolveCloseFollowUps` with the detected PR and emit a `prFallback` entry (`gh pr close <N> --comment "landed in <base> as <sha>"` plus the PR URL) present only when a PR was detected; render it in `formatCloseFollowUps` after the push line. Verify: unit test in `test/feature-close-command.test.ts` builds the command with the landing SHA and omits the entry without a PR.
- [x] 2.2 Surface the fallback in the interactive follow-ups: the notice (or deferred guidance) on the follow-ups screen names the open PR and the deliberate close command. Verify: `test/close-tui.test.ts` renders the notice line when a PR was detected and nothing extra when not.

## 3. Close confirmation in the specs browser (specs-browser)

- [x] 3.1 Add the pending-close state and modal: `SpecsBrowser` stores the would-be close resolution plus display facts (feature display name/id, branch, `view.baseBranch`, active change id) when root `x` (all three current branches) or the Actions menu close dispatch fires; render an overlay modal following the runs-browser retry-confirm pattern naming the feature, branch, base, and the sync → archive → squash-merge sequence. Verify: `test/specs-tui.test.ts` presses `x` and asserts no resolution is emitted and the modal content names the feature/branch/base/sequence.
- [x] 3.2 Modal key handling: `y`/Enter-on-confirm finishes with the stored resolution; `n`/Esc cancels, clearing the state and keeping the selection and level; any other key is ignored while the modal is open. Verify: `test/specs-tui.test.ts` — confirm emits the exact same resolution as before the change, cancel keeps the browser on the same row, and `test/specs-actions-menu.test.ts` covers the menu path.
- [x] 3.3 Update footer hints where they advertise `x close` so the confirm step is visible (e.g. `x close · y/n confirm`), keeping the truncation/marker behavior. Verify: `test/specs-tui.test.ts` hint assertions updated and passing.

## 4. Verification

- [x] 4.1 `bun run typecheck` passes with the new types (`CloseResult.pullRequest`, follow-up entry, browser state). Verify: command exits 0.
- [x] 4.2 Full suite: `bun test` passes, including updated `feature-close`, `feature-close-command`, `close-tui`, `specs-tui`, and `specs-actions-menu` tests. Verify: command exits 0.
