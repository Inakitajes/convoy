## MODIFIED Requirements

### Requirement: Spin hands the session over via /move
On successful standalone `convoy spin`, Convoy SHALL print the worktree path, branch, moved-change state, and instruction to run OpenCode's `/move` to continue an existing external conversation. Spin SHALL NOT fork, copy, summarize, or relocate that external session itself. When spin is invoked as adoption within Convoy, Convoy SHALL select the stable feature already registered by spin, preserve its complete association and recovery evidence, and offer its managed conversation action without requiring a shell directory switch. This action SHALL NOT claim to have preserved an external conversation unless the operator explicitly relocated or linked that session through a supported mechanism.

#### Scenario: Output tells the operator exactly what to do next
- **WHEN** standalone spin completes
- **THEN** its output names the directory, branch, and moved files and explains the `/move` handoff for continuing the external conversation

#### Scenario: Adoption from the work browser
- **WHEN** the operator adopts a stranded proposal through Convoy and spin succeeds
- **THEN** the feature identity returned by spin is selected without creating a second record and can open a managed conversation in its worktree without a manual `cd`

#### Scenario: External history has not moved
- **WHEN** adoption creates work but an earlier conversation still belongs to the source checkout
- **THEN** Convoy distinguishes opening a new managed conversation from relocating the external conversation and does not claim its history moved
