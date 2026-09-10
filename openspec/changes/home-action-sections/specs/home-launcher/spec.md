## ADDED Requirements

### Requirement: Worktree detail groups actions by toolchain

Worktree detail SHALL group its actions into four labeled sections in order: Sessions (Open conversation, Open in window), Runs, OpenSpec (Propose a change, Archive change, Close (archive & merge)), and git (the guarded Git/publication operations, ending with worktree removal); the Linked Specs observation SHALL follow the git section. The Runs section SHALL always list a New run action as its first row, rendered whether or not the checkout has recent runs, with the checkout's recent runs listed beneath it; section headings SHALL remain plain headings. Archive change SHALL open an explicit selection of the checkout's active changes and SHALL archive only the chosen change, never by discovery. Every action SHALL keep its shared per-action guard and remain visible with its blocker when disabled.

#### Scenario: Sections render in order

- **WHEN** a worktree detail with recent runs renders
- **THEN** it shows Sessions, Runs, OpenSpec, and git sections in that order, followed by Linked Specs

#### Scenario: New run is present without runs

- **WHEN** the checkout has no recent runs
- **THEN** the Runs section still lists the New run action as its first row

#### Scenario: Archive selects one change

- **WHEN** the operator chooses Archive change
- **THEN** they select one of the checkout's active changes and the guarded archive runs for that change only

#### Scenario: Close is labeled for what it does

- **WHEN** the OpenSpec section renders
- **THEN** close appears as Close (archive & merge)
