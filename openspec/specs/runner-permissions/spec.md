# runner-permissions Specification

## Purpose
Apply Convoy's safety and approval policies consistently across harnesses without confusing provider-specific permission modes with equivalent guarantees.

## Requirements

### Requirement: Execution modes preserve the requested restrictions

Both runners SHALL enforce read-only, verification, and writable policies before protected actions execute. Read-only SHALL disallow repository mutation; verification SHALL permit only the approved checks and their declared effects. Restrictions SHALL cover available mutation paths, including shell, delegated agents, and external tools, or the unsupported paths SHALL be disabled. Prompt instructions alone SHALL NOT count as enforcement.

#### Scenario: Read-only Claude attempts an indirect write
- **WHEN** a read-only Claude step attempts mutation through a shell, subagent, or external tool
- **THEN** the mutation is denied before execution, even if file-edit tools are already disabled

#### Scenario: Verification requires generated output
- **WHEN** a verification command needs a declared output directory
- **THEN** Convoy evaluates that command and output scope under the verification policy without granting arbitrary shell writes

### Requirement: Approval modes do not override hard denials

Interactive, Auto-accept, and Smart auto-accept SHALL apply the same Convoy policy for both runners. Hard denials and mandatory checkpoints SHALL remain effective in all three modes. Auto-accept SHALL approve only eligible ask-level requests; Smart auto-accept SHALL use a reviewed judge route and fail closed when a trustworthy decision is unavailable.

#### Scenario: Auto-accept encounters a deny
- **WHEN** either runner requests a hard-denied action under Auto-accept
- **THEN** Convoy rejects it instead of mapping Auto-accept to unrestricted harness bypass

#### Scenario: Smart judge unavailable
- **WHEN** the configured judge times out or returns an invalid decision
- **THEN** the protected action is not executed and the operator receives the existing fail-closed recovery choice

### Requirement: Pending decisions belong to one execution

Permission requests and replies SHALL be correlated to the exact runner, run, attempt, session, and request. Pending requests SHALL survive dashboard detachment while execution remains valid. Late, duplicate, cancelled, or foreign replies SHALL NOT authorize a different action. Backend permission deadlines SHALL settle truthfully without silently permitting work.

#### Scenario: Two runners ask concurrently
- **WHEN** Claude and OpenCode each await approval in one parallel batch
- **THEN** a reply to one request settles only that request and neither blocks observation or decision handling for the other

#### Scenario: Reply arrives after cancellation
- **WHEN** an approval arrives after its attempt has been cancelled
- **THEN** it is rejected as stale and does not resume the attempt or grant authority to a retry

### Requirement: Mandatory enforcement cannot be bypassed by earlier approvals

Adapters SHALL install mandatory policy checks at an interception point that covers protected actions regardless of native auto-approval rules. If required enforcement hooks or bridges fail to initialize, the adapter SHALL refuse affected execution. User or project settings SHALL NOT silently bypass Convoy's hard restrictions.

#### Scenario: Native allow rule skips a permission callback
- **WHEN** a harness would auto-approve a write before invoking its ordinary approval callback
- **THEN** Convoy's mandatory pre-action check still runs, or that execution mode is rejected as unsupported

### Requirement: Human control transitions preserve writer authority

Convoy SHALL distinguish observation, native live attachment, explicit handoff, and post-exit resume. A handoff SHALL quiesce the prior writer and transfer managed authority before enabling another writer. Returning to automation SHALL revalidate checkout, session, policy, and Git effects. Merely opening a terminal SHALL NOT prove a successful transfer.

#### Scenario: Claude handoff during a write step
- **WHEN** the operator requests human control of a running Claude step
- **THEN** Convoy either performs a verified supported handoff or reports why it cannot; it does not open a second writable process on the same active session
