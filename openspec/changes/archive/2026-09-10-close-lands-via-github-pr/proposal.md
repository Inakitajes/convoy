## Why

`close` lands a local squash commit on the local base and only *references* a detected pull request, so GitHub never learns the branch merged: linked PRs stay open (as happened with #110), local `main` and `origin/main` grow twin squash commits, and the operator must close the PR by hand. Since close already probes GitHub for the linked PR before landing, the probe's moment is the natural decision point for letting GitHub perform the squash-merge itself.

## What Changes

- When close detects a linked open PR for the branch (existing `gh pr list --head` probe), the landing path switches from local squash-to-base to a hosted landing: push the reviewed branch to its remote, run `gh pr merge <n> --squash` with the reviewed message as `--subject`/`--body`, then fast-forward the local base to GitHub's squash commit.
- The push becomes part of the close transaction for this path only (receipt-based reconciliation on retry, like the existing guarded push); without a linked PR, close is unchanged and push remains a separate follow-up.
- The reviewed message still gates the operation: GitHub composes the squash commit from the accepted subject/body, with the PR number riding the subject as today.
- Fallback semantics: GitHub evidence unavailable → current local squash path, disclosed as today; PR found but not mergeable (conflicts, unmergeable state) → close stops with remediation instead of silently landing a divergent local commit.
- Operator agency: interactive review offers a "Land locally instead" choice and headless close honors `--local-landing` (default: hosted when a linked PR is detected); either runs the unchanged local squash and leaves the PR untouched.
- Recovery extends to the remote steps: a retry reconciles uncertain hosted merges by reading the PR state (`MERGED` = step done), never re-merging or force-pushing.
- Close progress and summary narrate the hosted landing truthfully (which commit GitHub created, PR marked merged), replacing the "not a claim that the PR merged" disclaimer when the merge actually happened.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `worktree-operations`: the squash-integration requirement gains a hosted-PR landing path (push + `gh pr merge --squash` + local base fast-forward) selected by linked-PR evidence; push independence is refined so a transaction-integrated push applies only to that path; PR discovery becomes the routing criterion between local and hosted landing; local landing remains the only path when no linked PR exists, hosting evidence is unavailable, or the operator declines the hosted path.
- `feature-close`: the close orchestration requirement replaces the unconditional "no automatic hosted PR merge" clause with a conditional hosted-landing rule (linked PR + usable GitHub evidence → hosted squash-merge; otherwise local), and the message-review/progress requirement covers hosted-landing disclosure and failure handling.

## Impact

- `src/worktree-commands.ts` (`driveClose`/`runClose`): landing-path selection, hosted-landing effect, notice/summary copy.
- `src/close-hosted.ts` (new): the hosted landing transaction — guarded branch push, `gh pr merge --squash`, local base fast-forward, and receipt-based recovery; `src/pr-merge-state.ts` (new) reads the PR merge state and `src/operation-reconcile.ts` reconciles the hosted steps.
- `src/close-journal.ts` / `src/operation-journal.ts`: remote steps (push, hosted merge, base catch-up) recorded as intent + receipt with idempotent reconciliation.
- `src/close-events.ts` / `src/close-tui.ts` / `src/close-presentation.ts`: new squash sub-phases and PR-merge disclosure.
- Tests: close orchestration, journal recovery with remote steps, TUI presentation.
- No CLI surface break (`--local-landing` is additive): non-PR closes behave as today, and a headless `--message` close lands hosted only when a linked PR is detected.
