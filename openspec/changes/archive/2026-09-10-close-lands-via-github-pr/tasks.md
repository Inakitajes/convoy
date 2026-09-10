## 1. Journal and step types

- [x] 1.1 Extend close-journal/operation-journal step schemas for the hosted steps (`branch-push`, `hosted-merge`, `base-advancement`) with intent payloads (local SHA, remote/ref, PR number) and receipt acknowledgements; verify with unit tests that an unsupported-schema journal still reads as unresolved (contract unchanged for old journals)
- [x] 1.2 Add `landViaGitHub` outcome types and typed close events for the hosted sub-phases (`pushing-branch`, `requesting-merge`, `catching-up-base`) to `close-events.ts`; verify existing event tests still pass and new events type-check

## 2. Hosted landing effect

- [x] 2.1 Implement the branch-push step reusing `pushRefspec` + `assertNonForceRefspec` with the PR's head remote/branch as destination, recording intent and reconciling a pushed SHA by receipt; verify with a test that a second run after a recorded push does not re-push
- [x] 2.2 Implement the hosted-merge step (`gh pr merge <n> --squash --subject --body` with reviewed subject/body, `(#N)` subject) and receipt reconciliation via `gh pr view` state/mergeCommit (`MERGED` = done, `OPEN` = retryable, other = stop); verify with injected effects that an uncertain outcome on retry does not issue a second merge
- [x] 2.3 Implement the base catch-up step (fetch + `git merge --ff-only <mergeCommit>`, already-contained = acknowledged, non-FF = stop with remediation); verify with tests for the three outcomes
- [x] 2.4 Add the "land locally instead" operator choice to the interactive message gate and a `--local-landing` headless flag; verify a declined hosted path runs the unchanged `squashToBase` and leaves the PR untouched

## 3. Close orchestration

- [x] 3.1 Route in `driveClose`: `probeClosePullRequest` result selects hosted vs local landing; wire the new step set into `executeReviewed` after message review; verify the no-PR/unavailable/merged-PR/ambiguous cases all take the local path with the existing disclosure
- [x] 3.2 Disclose the remote steps in review (TUI checklist rows + headless plan text naming push, hosted merge, base fast-forward) before effects; verify with close-tui rendering tests
- [x] 3.3 Narrate progress truthfully: published revision, GitHub's squash commit + PR merged state once observed, skip reason when base already current, blocker + remediation when GitHub rejects the merge; verify summary-line tests cover observed-merge and failure copies

## 4. Recovery

- [x] 4.1 Extend `worktrees recover` reconciliation for hosted steps: crash after push → continue to merge after acceptance without re-push; uncertain hosted merge → reconcile by PR state; verify with journal-recovery tests covering crash-after-push and retry-after-uncertain-merge
- [x] 4.2 Handle contradictory evidence (merged PR with unresolvable merge commit, moved branch, non-FF base) as stop-with-guidance; verify tests assert no guessed effects

## 5. End-to-end verification

- [x] 5.1 Headless: `--message` close with a linked PR pushes, squash-merges via GitHub, and fast-forwards local base; verify with an integration test against fake `gh`/git fixtures and manual run on a scratch repo
- [x] 5.2 Interactive: full TUI close with a linked PR shows the reviewed remote steps, lands via GitHub, and reports the merged PR in the summary; verify with close-tui interaction tests
- [x] 5.3 Run the full suite (`bun test`) and `openspec validate close-lands-via-github-pr --strict`; fix regressions in the local no-PR path (close, push, recovery behavior unchanged)
