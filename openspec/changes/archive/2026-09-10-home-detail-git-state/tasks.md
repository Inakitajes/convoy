## 1. Detail Git state

- [x] 1.1 Render the observed Git state in `detailLines` — dirt, upstream ahead/behind with the upstream ref, base ahead/behind, and detached — as independent facts that never collapse into one verdict; verify with a home-tui test that opens a worktree detail and asserts both comparisons and the upstream ref
- [x] 1.2 Disclose no-upstream and unknown comparisons honestly (`none` / `unknown (reason)`) instead of zero; verify with home-tui tests
- [x] 1.3 Run `bun test` and `openspec validate home-detail-git-state --strict`; verify both pass
