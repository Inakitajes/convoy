## MODIFIED Requirements

### Requirement: Home presents a unified masthead

Home SHALL show Convoy's identity, the complete build version including prerelease/build metadata, and the normalized project path above the Worktrees list. It SHALL NOT separately append commit or platform information. Compact layouts SHALL preserve project identification and usable worktree navigation without overflowing terminal width. Worktree detail SHALL visibly identify the selected checkout by folder basename, actual branch or detached status, and path, without another persisted display-name record. Human titles SHALL allow whitespace; the vocabulary restriction against Spaces branding SHALL NOT impose whitespace restrictions on titles. Decorative graphics SHALL NOT displace the primary worktree list or its actions. Home SHALL keep its chrome lean without a dedicated footer; actionable labels and relevant shortcuts SHALL remain visible with their worktree-list or auxiliary actions.

#### Scenario: Wide masthead

- **WHEN** Home opens at a wide terminal size
- **THEN** Convoy identity, complete version, and project path appear above the usable Worktrees list

#### Scenario: Commit fragment instead of the full hash

- **WHEN** Home renders a stable or local build version
- **THEN** it includes the complete version string with embedded metadata and no separate parenthetical commit or platform

#### Scenario: Compact masthead

- **WHEN** the terminal is too narrow for the wide layout
- **THEN** project identification and worktree actions remain readable within its width

#### Scenario: Slim chrome in graphics mode

- **WHEN** Home opens in a graphics-capable terminal
- **THEN** compact project/version chrome identifies the repository above the worktree list without reserving a destination-poster region

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

Returning from a conversation, launcher, dashboard, spec reader, or cancelled action SHALL restore the originating verified worktree and local selection and refresh independent Git, spec, publication, and activity observations. Convoy SHALL NOT restore selection merely by list position, change id, branch spelling, or a reused path. On reopening, Convoy SHALL restore a last-selection navigation hint only when its target is verifiable against the live Git registration and current location; otherwise it SHALL show the Worktrees list without starting an agent. Persisted navigation hints SHALL be optional and non-authoritative, with no new work UUID, ownership manifest, domain registry, or mutation authority. Missing or unverifiable selection SHALL fall back to the list with an explanation and SHALL NOT silently choose another execution target or retain a worktree tombstone. Only explicitly leaving Convoy SHALL end the surrounding Home workflow.

#### Scenario: Reopen from another worktree

- **WHEN** an operator restarts Convoy from another checkout of the same repository and a last-selection hint can be verified
- **THEN** the same worktree is selected without changing its execution destination or starting a session

#### Scenario: Last selected checkout disappeared

- **WHEN** the remembered worktree is no longer registered
- **THEN** Home shows the worktree list with an explanation and starts no action on a replacement checkout

#### Scenario: Path is reused

- **WHEN** a remembered path exists but continuity with its former checkout cannot be verified
- **THEN** Home refuses automatic restoration and requires explicit reselection rather than assuming the same incarnation

#### Scenario: No navigation hint is retained

- **WHEN** Convoy reopens without a persisted navigation hint
- **THEN** it opens the current Worktrees list without inventing a work record or starting an agent

## ADDED Requirements

### Requirement: New worktree reviews creation before mutation

New worktree SHALL begin with `What are we building today?` and propose a conventional branch and worktree location from the human description. Before creation, the operator SHALL be able to review and edit the source/base, branch, and destination. Creation SHALL create the reviewed Git worktree without commits, PRs, feature registration, or ownership manifests. Cancelling before confirmation SHALL leave no created worktree. Main SHALL remain directly usable with explicit dirty-tree protections rather than requiring New worktree or spin before authoring or execution.

#### Scenario: Reviewed creation

- **WHEN** an operator enters a description and edits the proposed base and destination before confirming
- **THEN** Convoy creates the reviewed Git worktree and selects it from Git inventory without committing or creating a PR or domain record

#### Scenario: Creation is cancelled

- **WHEN** the operator cancels the creation review
- **THEN** no worktree is created and Home returns to the prior selection

#### Scenario: Work continues on main

- **WHEN** an operator selects main for authoring or execution
- **THEN** Home offers those actions under their normal guards and explicit dirty-tree protections instead of requiring spin

### Requirement: Contextual menus share independent action guards

Home SHALL expose contextual fetch, sync-with-selected-base, push, PR review/composition/creation, squash-to-base, worktree removal, and branch deletion, with close available as an optional composition of operations. Read, archive, and run actions focused on changes SHALL require explicit selection of checkout-local inputs; selecting a worktree SHALL NOT select all contained changes for mutation. All menus and handlers SHALL use shared per-action guards with visible disabled reasons and remediation rather than lifecycle-stage gates. Git dirt, selected-base comparison, upstream comparison, PR number/title/URL/state with known or unknown availability and observation time, and activity SHALL remain independent facts. Standalone push SHALL NOT require GitHub availability or a run. A close confirmation SHALL name source worktree/path/branch, selected base, explicit archive set including an empty set, the whole-branch integration scope, and chosen operations including optional push and cleanup before any mutation.

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
