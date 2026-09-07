Work in this capability is the existing Feature domain. Home SHALL retain Features terminology and display names, reference `featureId` for selection, and use the shared lifecycle assessment for summaries, blockers, and action eligibility. A focused contract SHALL not replace the feature's complete reviewed contract set.

## MODIFIED Requirements

### Requirement: Home presents a unified masthead
Home SHALL show Convoy's identity, the complete build version including prerelease/build metadata, and the normalized project path above the work list. It SHALL NOT separately append commit or platform information. Compact layouts SHALL preserve project identification and usable work navigation without overflowing terminal width. Work detail SHALL visibly identify the selected work and its checkout or branch. Decorative graphics SHALL NOT displace the primary work list or its actions. Home SHALL keep its chrome lean without a dedicated footer; actionable labels and relevant shortcuts SHALL remain visible with their work-list or auxiliary actions.

#### Scenario: Wide masthead
- **WHEN** Home opens at a wide terminal size
- **THEN** Convoy identity, complete version, and project path appear above the usable work list

#### Scenario: Commit fragment instead of the full hash
- **WHEN** Home renders a stable or local build version
- **THEN** it includes the complete version string with embedded metadata and no separate parenthetical commit or platform

#### Scenario: Compact masthead
- **WHEN** the terminal is too narrow for the wide layout
- **THEN** project identification and work actions remain readable within its width

#### Scenario: Slim chrome in graphics mode
- **WHEN** Home opens in a graphics-capable terminal
- **THEN** compact project/version chrome identifies the repository above the work list without reserving a destination-poster region

#### Scenario: No footer
- **WHEN** Home renders at any terminal width or graphics capability
- **THEN** it uses no dedicated footer or selection counter and exposes relevant shortcuts alongside their actions without displacing the work list

## ADDED Requirements

### Requirement: Home starts with work and its next actions
Interactive zero-argument Convoy SHALL open a repository work list offering New feature. Selecting work SHALL open a detail with distinct conversation/resume, propose/revise, pipeline, specs/runs, and close actions as applicable. Pipelines, canonical specs, global run history, and configuration SHALL remain reachable as auxiliary views. An empty repository work list SHALL still offer New work and auxiliary navigation.

#### Scenario: First work in a repository
- **WHEN** interactive Convoy opens with no existing work or specs
- **THEN** Home offers New feature without requiring an OpenSpec artifact to exist first

#### Scenario: Conversation is distinct from pipeline execution
- **WHEN** work has both a linked conversation and runnable pipelines
- **THEN** detail offers separate resume-conversation and execute-pipeline actions with unambiguous labels

### Requirement: Navigation preserves the selected work
Returning from a conversation, launcher, dashboard, spec reader, or cancelled action SHALL restore the originating work selection and refresh its derived state. Reopening Convoy SHALL restore the last valid work selection for that repository without automatically launching an agent. A missing selection SHALL fall back to the work list with an explanation; it SHALL NOT silently select another execution target. Only explicitly leaving Convoy SHALL end the surrounding Home workflow.

#### Scenario: Reopen from another worktree
- **WHEN** an operator restarts Convoy from another checkout of the same repository
- **THEN** the same last valid work is selected without changing its execution destination or starting a session

#### Scenario: Last selected checkout disappeared
- **WHEN** the remembered work no longer has a valid checkout
- **THEN** Home shows the unavailable association or the work list with an explanation and starts no action on a replacement checkout

## REMOVED Requirements

### Requirement: Active destination is visibly bracketed by diamonds
**Reason**: The primary screen is now a work list and detail rather than a destination selector.
**Migration**: Provide clear selection in the work list and retain auxiliary destinations as navigation actions.

### Requirement: Graphics-capable Home preserves the image experience
**Reason**: A centered destination poster would displace the work-first entry point.
**Migration**: Use the unified project masthead and work list in graphics-capable terminals as well.

### Requirement: Non-graphics Home prioritizes navigation
**Reason**: The centered destination selector is replaced by the same work-first layout across terminals.
**Migration**: Render usable work navigation without requiring graphics support.

### Requirement: Destination description wraps to at most two contextual lines
**Reason**: Home no longer centers a selected destination and its description.
**Migration**: Show work context in its list/detail and keep auxiliary action labels within terminal width.
