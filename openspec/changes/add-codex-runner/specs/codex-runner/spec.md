# Spec Delta

## Purpose

Run pipeline steps, advisors, helpers and authoring on Codex under Convoy's policy, authentication and provenance, through the common runner contract.

## ADDED Requirements

### Requirement: Codex is a registered runner

Convoy SHALL register a `codex` runner that executes `openai/*` models and maps a model's `#variant` to Codex reasoning effort. Preflight SHALL verify that a supported Codex version is installed and that each Codex route's model and effort are available to the effective account. A plan in which nothing runs on another runner SHALL NOT require OpenCode or Claude.

#### Scenario: A Codex-only plan
- **WHEN** every step, advisor, judge and helper route uses `runner: codex`
- **THEN** preflight, execution, reports, goal loops, helpers and finalization run without OpenCode or Claude installed

#### Scenario: An unsupported Codex version
- **WHEN** the installed `codex` is outside the supported range
- **THEN** preflight refuses the plan with the installed and the supported versions, before any checkout change

#### Scenario: A model the account cannot use
- **WHEN** a Codex step names a model or effort that `model/list` does not offer the effective account
- **THEN** preflight fails naming the model, and no attempt starts

### Requirement: Every Codex action is decided by Convoy's policy

Each Codex attempt SHALL run under `approvalPolicy: untrusted`, with the sandbox matched to its mode (`read-only` for read-only and verify, `workspace-write` for writes). Every command, file change and MCP call SHALL be decided by Convoy's policy and then the run's operator gate. Convoy SHALL answer approvals only with single-action accept or decline. It SHALL NOT grant session-wide or persistent approvals or amend Codex execpolicy or network rules. Read-only and verify attempts SHALL decline every write, whatever the sandbox would allow. Hard denials SHALL hold in every approval mode.

#### Scenario: A read-only step tries to write
- **WHEN** a read-only Codex step proposes a file change
- **THEN** Convoy declines it, and no file changes

#### Scenario: A command reads Convoy's private directory
- **WHEN** a Codex agent runs `cat ~/.convoy/private/<file>` through any shell spelling
- **THEN** Convoy declines it as a hard denial, even with `--yolo`

#### Scenario: An operator MCP tool
- **WHEN** a Codex agent calls a tool from an MCP server that is not Convoy's
- **THEN** the call is declined

#### Scenario: An unknown approval request
- **WHEN** Codex sends a server request Convoy does not recognize
- **THEN** Convoy answers with an error, logs a policy event, and the attempt does not hang

### Requirement: Codex runs isolate Convoy's integration from the operator's Codex setup

Pipeline attempts and helpers SHALL start Codex with the operator's hooks disabled and with Convoy's MCP host declared for that invocation only. They SHALL NOT modify the operator's Codex configuration, credentials, rules or hook trust. Bridge credentials SHALL reach the MCP host only through an owner-only private file, never through argv or the agent's environment. Authoring conversations SHALL open the operator's own Codex session unmodified.

#### Scenario: The operator has Codex hooks
- **WHEN** `~/.codex/hooks.json` defines hooks and a Codex step runs
- **THEN** none of those hooks run during the attempt, and the file is unchanged

#### Scenario: The agent inspects its process environment
- **WHEN** a Codex agent lists processes or prints its environment
- **THEN** the bridge address and token are not visible

### Requirement: Codex reports, scores and advisors use Convoy's services

Codex attempts SHALL submit reports, scores and commit descriptions through Convoy's `write_report` tool, validated like the other runners. Each submission SHALL be bound to the attempt's thread, and a submission from another thread SHALL be rejected. An advised Codex phase SHALL hold its first write for one consultation and deliver the advice to the running turn. A failed consultation SHALL release the hold. An unreachable checkpoint SHALL keep the write blocked.

#### Scenario: First write under an advisor
- **WHEN** an advised Codex step proposes its first file change
- **THEN** the change is held, the advisor is consulted, the advice reaches the agent in the same turn, and later writes proceed without a hold

#### Scenario: A stale thread submits
- **WHEN** a thread from an earlier attempt calls `write_report` after a retry
- **THEN** the submission is rejected, and the current attempt's report is unchanged

### Requirement: Codex authentication and billing are explicit and verified

Subscription mode SHALL use the operator's Codex ChatGPT login, with ambient API keys removed from the child. API-key mode SHALL use only the configured credential reference and SHALL NOT write the operator's Codex credentials. The effective authentication SHALL be verified before preflight and before each attempt, and an attempt SHALL be refused when it differs from the reviewed mode. `included-only` billing SHALL be refused, and an unattended subscription run SHALL require `account-policy`. Provenance SHALL record the mode and the credential reference, never a credential value.

#### Scenario: An ambient key under subscription mode
- **WHEN** `OPENAI_API_KEY` is set and the Codex route uses subscription mode
- **THEN** the key is not passed to Codex, and `account/read` must report the ChatGPT login before the attempt runs

#### Scenario: API-key mode
- **WHEN** `runners.codex.auth` selects an API key by reference
- **THEN** the attempt runs billed to that key, and the operator's `~/.codex/auth.json` is unchanged

### Requirement: Codex sessions are observable, resumable and bounded

Codex attempts SHALL stream their transcript to the coordinator journal, record the thread and the resolved model and effort, support post-exit resume and history reconstruction from the recorded thread, report token usage (subscription values as estimates), and apply the loop guard through in-turn steering and interruption. Cancellation SHALL interrupt the turn and stop the owned child within the bounded grace.

#### Scenario: A late dashboard attach
- **WHEN** a dashboard opens after a Codex phase has started
- **THEN** it reconstructs the transcript from the journal and continues streaming

#### Scenario: The loop guard trips
- **WHEN** a Codex agent repeats the same failing call past the guard's threshold
- **THEN** Convoy steers the turn with the guard's nudge and interrupts it if the pattern continues

#### Scenario: Cancelling an attempt
- **WHEN** the operator cancels a running Codex attempt
- **THEN** the turn is interrupted, the child exits or is killed within the grace, and the attempt settles as interrupted with its thread recorded
