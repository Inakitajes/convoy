## MODIFIED Requirements

### Requirement: Home presents a unified masthead

Home SHALL show Convoy's identity and the complete build version including prerelease/build metadata above the Worktrees list; the project path is implied by the session the operator already sits in and SHALL NOT be repeated in the chrome. It SHALL NOT separately append commit or platform information. Compact layouts SHALL preserve identity, version, and usable worktree navigation without overflowing terminal width. Worktree detail SHALL visibly identify the selected checkout by folder basename, actual branch or detached status, and path, without another persisted display-name record. Human titles SHALL allow whitespace; the vocabulary restriction against Spaces branding SHALL NOT impose whitespace restrictions on titles. Decorative graphics SHALL NOT displace the primary worktree list or its actions. Home SHALL keep its chrome lean without a dedicated footer; actionable labels and relevant shortcuts SHALL remain visible with their worktree-list or auxiliary actions.

#### Scenario: Wide masthead

- **WHEN** Home opens at a wide terminal size
- **THEN** Convoy identity and the complete version appear above the usable Worktrees list

#### Scenario: Commit fragment instead of the full hash

- **WHEN** Home renders a stable or local build version
- **THEN** it includes the complete version string with embedded metadata and no separate parenthetical commit or platform

#### Scenario: Compact masthead

- **WHEN** the terminal is too narrow for the wide layout
- **THEN** identity, version, and worktree actions remain readable within its width

#### Scenario: Slim chrome in graphics mode

- **WHEN** Home opens in a graphics-capable terminal
- **THEN** compact project/version chrome sits above the worktree list without reserving a destination-poster region

#### Scenario: No footer

- **WHEN** Home renders at any terminal width or graphics capability
- **THEN** it uses no dedicated footer or selection counter and exposes relevant shortcuts alongside their actions without displacing the worktree list

#### Scenario: Titles contain spaces

- **WHEN** the operator describes work as `Improve review navigation`
- **THEN** Home preserves that readable title while using Worktrees, not Spaces, for navigation branding

### Requirement: Home starts with work and its next actions

Interactive zero-argument Convoy SHALL open a Worktrees list derived from the complete current Git inventory and offer New worktree. Main, external, detached, locked, missing-path, and spec-less registered checkouts SHALL remain visible, including those with no runs. Selecting a worktree SHALL open detail with distinct conversation/resume, propose/revise, pipeline, local specs/runs, and contextual Git actions as applicable. Its active changes and tasks SHALL be local children; archived changes SHALL be collapsed or loaded on demand and canonical specs SHALL be local to an explicitly selected checkout. Same-id copies SHALL remain independent, and file presence SHALL NOT confer ownership or automatically select run or archive inputs. Pipelines, checkout-scoped canonical specs, global run history, and configuration SHALL remain reachable as auxiliary views. An empty inventory SHALL still offer New worktree and auxiliary navigation. Home SHALL NOT expose feature registration, adoption, binding, lifecycle summaries, or Completed feature history.

#### Scenario: First work in a repository

- **WHEN** interactive Convoy opens on a repository with only its main checkout and no specs
- **THEN** Home lists main and offers New worktree without requiring an OpenSpec artifact to exist first

#### Scenario: Conversation is distinct from pipeline execution

- **WHEN** a worktree has both an available authoring session reference and runnable pipelines
- **THEN** detail offers separate resume-conversation and execute-pipeline actions with unambiguous labels

#### Scenario: External worktree has no specs

- **WHEN** Git reports an externally created worktree with no specs or runs
- **THEN** Home lists it as an ordinary worktree with its current branch and path and guarded contextual actions without adoption

#### Scenario: Local copies do not collapse

- **WHEN** main and another worktree contain the same active change id
- **THEN** each checkout exposes its own child and facts without merging them into a global row

### Requirement: Navigation preserves the selected work

Returning from a conversation, launcher, dashboard, spec reader, or cancelled action SHALL return to Home with refreshed independent Git, spec, publication, and activity observations. Home SHALL open with its New worktree entry selected rather than restoring a previous worktree selection; persisted last-selection hints SHALL remain optional, non-authoritative diagnostics that never drive automatic selection and SHALL NOT start an agent. Convoy SHALL NOT restore selection by list position, change id, branch spelling, or a reused path. Only explicitly leaving Convoy SHALL end the surrounding Home workflow.

#### Scenario: Reopen from another worktree

- **WHEN** an operator restarts Convoy from another checkout of the same repository
- **THEN** Home opens with the New worktree entry selected and starts no session or action

#### Scenario: Last selected checkout disappeared

- **WHEN** the remembered worktree is no longer registered
- **THEN** Home still opens with the New worktree entry selected, retains no tombstone for the missing checkout, and starts no action on a replacement checkout

#### Scenario: A recorded hint never chooses a target

- **WHEN** a persisted last-selection hint names a worktree, whether still registered or not
- **THEN** nothing is automatically selected, restored, or started from the hint

#### Scenario: No navigation hint is retained

- **WHEN** Convoy reopens without a persisted navigation hint
- **THEN** it opens the current Worktrees list without inventing a work record or starting an agent

## ADDED Requirements

### Requirement: New worktree reviews creation before mutation

New worktree SHALL lead Home with an inline auto-propose form that asks what the operator wants to build (a description placeholder in the spirit of `describe what you are about to work on…`) and proposes a conventional branch and worktree location from the human description. Before creation, the operator SHALL review the proposed name, branch, base, and derived destination; the branch and base SHALL be editable, and the destination — derived from the branch by the location convention — SHALL be shown for review in the accepted proposal rather than being directly editable. A manual refine mode SHALL rebuild the proposal from edited fields. Creation SHALL create the reviewed Git worktree without commits, PRs, feature registration, or ownership manifests, and SHALL report its location for explicit selection afterwards. Cancelling before confirmation SHALL leave no created worktree. Main SHALL remain directly usable with explicit dirty-tree protections rather than requiring New worktree or spin before authoring or execution.

#### Scenario: Reviewed creation

- **WHEN** an operator enters a description and edits the proposed branch or base before confirming
- **THEN** Convoy creates the reviewed Git worktree, reports where to find it, and returns to Home without committing or creating a PR or domain record

#### Scenario: Creation is cancelled

- **WHEN** the operator cancels the creation review
- **THEN** no worktree is created and Home returns to the prior selection

#### Scenario: Work continues on main

- **WHEN** an operator selects main for authoring or execution
- **THEN** Home offers those actions under their normal guards and explicit dirty-tree protections instead of requiring spin

### Requirement: Contextual menus share independent action guards

Home SHALL expose contextual fetch, sync-with-detected-base (explicit bases through the CLI), push, PR review/composition/creation, squash-to-base, worktree removal, and branch deletion, with close available as an optional composition of operations. Read, archive, and run actions focused on changes SHALL require explicit selection of checkout-local inputs; selecting a worktree SHALL NOT select all contained changes for mutation. All menus and handlers SHALL use shared per-action guards with visible disabled reasons and remediation rather than lifecycle-stage gates. Git dirt, base comparison, upstream comparison, PR number/title/URL/state with known or unknown availability, and activity SHALL remain independent facts. Standalone push SHALL NOT require GitHub availability or a run. A close confirmation SHALL name source worktree/path/branch, selected base, explicit archive set including an empty set, the whole-branch integration scope, and chosen operations including optional push and cleanup before any mutation.

#### Scenario: Push without a run or GitHub

- **WHEN** a selected worktree can be pushed but has no runs and PR lookup is unavailable
- **THEN** push remains available under its Git guard while PR actions disclose their separate limitations

#### Scenario: Focus is not an archive set

- **WHEN** a worktree contains multiple active changes and the operator opens close review
- **THEN** review requires an explicit archive selection, permits no archives, and never silently includes inherited changes

#### Scenario: Close is broader than selected artifacts

- **WHEN** the operator reviews close for one selected local change on a branch containing other edits
- **THEN** confirmation names the source and base, warns that squash integrates the whole reviewed branch scope, and identifies optional push and cleanup choices

#### Scenario: Disabled action remains inspectable

- **WHEN** a locked or inaccessible worktree prevents a requested operation
- **THEN** Home shows that operation's shared disabled reason rather than hiding the worktree or assigning it a blocking lifecycle stage
