## ADDED Requirements

### Requirement: Worktree detail surfaces the observed Git state

Worktree detail SHALL show the same independently observed Git state as the row it opened from: working-tree dirt (or an honest unknown), ahead/behind relative to the branch's configured upstream with the upstream ref identified, ahead/behind relative to the selected base, and detached HEAD. Dirt, the upstream comparison, and the base comparison SHALL remain independent facts — never collapsed into a single synchronization verdict or a lifecycle stage — and an unavailable comparison SHALL be disclosed as unknown with its reason rather than omitted or reported as zero. A branch without an upstream SHALL be reported as having none, distinct from zero divergence.

#### Scenario: Detail shows upstream and base divergence

- **WHEN** a branch is ahead of its upstream and behind its selected base
- **THEN** the detail identifies the upstream ref and shows the upstream and base comparisons independently

#### Scenario: Divergence observation is unavailable

- **WHEN** an upstream or base comparison cannot be computed
- **THEN** the detail reports that comparison as unknown with its reason instead of omitting it or showing zero divergence

#### Scenario: Detached checkout

- **WHEN** the checkout has a detached HEAD
- **THEN** the detail identifies the detached state rather than showing a branch name

#### Scenario: No upstream

- **WHEN** the checkout's branch has no configured upstream
- **THEN** the detail reports no upstream as a distinct condition, not as zero ahead/behind
