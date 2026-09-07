## ADDED Requirements

### Requirement: Work-scoped preparation uses the execution checkout throughout
When launched for selected work, the launcher SHALL resolve configuration, available pipelines, prompt history, specs, relative attachments, and dirty-tree status from that work's validated checkout before constructing the review. It SHALL retain the complete reviewed contract set and the focused contract/source when present, reuse the existing branch and worktree, and reuse the existing feature plan link, association revision, execution revalidation, and durable feature-run records. It SHALL NOT create parallel work identity fields. It SHALL NOT invoke branch naming or create another worktree on this path. Existing dirty-tree choices and execution-time checks SHALL remain authoritative for the actual execution checkout.

#### Scenario: Main and feature configuration differ
- **WHEN** Convoy opens in main but the selected worktree has different pipeline configuration and a spec absent from main
- **THEN** the launcher uses the worktree's configuration and spec, shows its destination in Review, and starts there without another worktree

#### Scenario: Source checkout is dirty
- **WHEN** main has unrelated dirt and a clean feature worktree is selected for execution
- **THEN** preparation and the execution gate evaluate that feature worktree without rejecting it because of main's dirt

#### Scenario: Selected work is dirty
- **WHEN** the selected worktree has uncommitted proposal files
- **THEN** the existing include-dirty choice applies to that worktree and is not bypassed because the caller started in main

### Requirement: Returning from a work launch preserves selection
Cancelling a work-scoped launcher or returning from its run dashboard SHALL return to the originating work or spec view with its selection preserved and state refreshed. Cancelling before acceptance SHALL NOT start a run or create repository effects. Standalone CLI launches SHALL retain their existing headless behavior.

#### Scenario: Launcher is cancelled
- **WHEN** an operator cancels Review for a selected work item
- **THEN** Convoy returns to that selected work or spec with no run started
