## Why

Home's selected-row fold reports the checkout's combined Git state — uncommitted files, unpushed commits, commits to pull, base divergence, detached HEAD — but opening the worktree detail drops the upstream and base comparisons, so the operator loses the ahead/behind picture exactly when they drill in to act.

## What Changes

- Worktree detail SHALL surface the same independently observed Git state as the row it opened from: working-tree dirt, ahead/behind relative to the branch's upstream (with the upstream ref), ahead/behind relative to the selected base, and detached HEAD.
- These remain independent facts with honest unknown states — never a collapsed synchronization verdict, a lifecycle stage, or a silent zero.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `home-launcher`: the worktree detail surfaces the full observed Git state (dirt, upstream ahead/behind with its ref, base ahead/behind, detached) that the row already reports.

## Impact

- `src/home-tui.ts` (`detailLines`): render upstream and base divergence facts alongside dirt.
- `test/home-tui.test.ts`: cover the detail facts (both comparisons, unknown disclosure, detached).
