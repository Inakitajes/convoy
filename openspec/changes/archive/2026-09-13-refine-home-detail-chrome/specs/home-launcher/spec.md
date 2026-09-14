## MODIFIED Requirements

### Requirement: Home presents a unified masthead

Home SHALL show Convoy's identity and the complete build version including prerelease/build metadata above the Worktrees list; the project path is implied by the session the operator already sits in and SHALL NOT be repeated in the chrome. It SHALL NOT separately append commit or platform information. Compact layouts SHALL preserve identity, version, and usable worktree navigation without overflowing terminal width. Worktree detail SHALL visibly identify the selected checkout by folder basename, actual branch or detached status, and path, without another persisted display-name record. The selected checkout's identity, path, branch, and linked pull request SHALL render as one distinctly filled zone above its remaining observations and action sections, so the checkout the operator is acting on reads as the working context rather than another plain block. Human titles SHALL allow whitespace; the vocabulary restriction against Spaces branding SHALL NOT impose whitespace restrictions on titles. Decorative graphics SHALL NOT displace the primary worktree list or its actions. Home SHALL keep its chrome lean without a dedicated footer; actionable labels and relevant shortcuts SHALL remain visible with their worktree-list or auxiliary actions.

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

#### Scenario: Checkout identity and branch read as one zone

- **WHEN** a worktree detail renders for the selected checkout
- **THEN** its folder basename, path, branch, and linked PR share one distinctly filled zone, visually separate from the remaining plain facts and the selectable action sections

### Requirement: Worktree detail groups actions by toolchain

Worktree detail SHALL group its actions into four labeled sections in order: Sessions (Open conversation, Open in window), Runs, OpenSpec (Propose a change, Archive change, Close (archive & merge)), and git (the guarded Git/publication operations, ending with worktree removal); the Linked Specs observation SHALL immediately follow the OpenSpec section, before the git section, and SHALL render only when the checkout has linked changes. An unreadable change list SHALL still render the Linked Specs observation as unknown with its reason, because unknown is not none. The Runs section SHALL always list a New run action as its first row, rendered whether or not the checkout has recent runs, with the checkout's recent runs listed beneath it; section headings SHALL remain plain headings. Archive change SHALL open an explicit selection of the checkout's active changes and SHALL archive only the chosen change, never by discovery. Every action SHALL keep its shared per-action guard and remain visible with its blocker when disabled.

#### Scenario: Sections render in order

- **WHEN** a worktree detail with recent runs and linked changes renders
- **THEN** it shows Sessions, Runs, OpenSpec, Linked Specs, and git in that order

#### Scenario: New run is present without runs

- **WHEN** the checkout has no recent runs
- **THEN** the Runs section still lists the New run action as its first row

#### Scenario: Linked Specs is absent without linked changes

- **WHEN** the checkout has no linked changes and its change list was read successfully
- **THEN** the detail omits the Linked Specs section entirely rather than rendering an empty section

#### Scenario: Unreadable change list stays visible

- **WHEN** the checkout's change list cannot be read
- **THEN** the Linked Specs section renders the unknown observation with its reason

#### Scenario: Archive selects one change

- **WHEN** the operator chooses Archive change
- **THEN** they select one of the checkout's active changes and the guarded archive runs for that change only

#### Scenario: Close is labeled for what it does

- **WHEN** the OpenSpec section renders
- **THEN** close appears as Close (archive & merge)
