# codex-runner Specification

## Purpose
Run pipeline steps, advisors, helpers and human iterations on Codex under Convoy's policy, authentication and provenance, through the common runner contract.

## Requirements

### Requirement: Codex is a registered runner

Convoy SHALL register a `codex` runner that executes `openai/*` models and maps a model's `#variant` to Codex reasoning effort. Preflight SHALL verify the following before any checkout change:

- the `codex` CLI is installed, at the minimum supported release or later; a release Codex does not report readably SHALL be refused, and attempts and helpers SHALL check the release again before any thread starts;
- every Codex model and effort the plan names is offered to the effective account.

A plan in which nothing runs on another runner SHALL NOT require OpenCode or Claude.

#### Scenario: A Codex-only plan
- **WHEN** every step and advisor runs on Codex and no judge or commit writer is configured
- **THEN** the judge and helpers run on Codex, and preflight, execution, reports, advisors and finalization run without starting OpenCode

#### Scenario: A missing CLI
- **WHEN** a plan has a Codex step and `codex` is not on PATH
- **THEN** preflight refuses the plan, naming the steps and how to install Codex

#### Scenario: A model the account cannot use
- **WHEN** a Codex step names a model or effort that `model/list` does not offer the account
- **THEN** preflight fails naming the step and the model, and no attempt starts

### Requirement: Every Codex action is decided by Convoy's policy

Each Codex attempt SHALL run under `approvalPolicy: untrusted`. Its sandbox SHALL be `read-only` for read-only and verify attempts and `workspace-write` for writes. Every command, file change and MCP call SHALL be decided by Convoy's policy and then the run's operator gate.

- A command that only inspects SHALL be judged as the reads it performs. Each path SHALL pass the read policy.
- Read-only and verify attempts SHALL decline every write, whatever the sandbox would allow.
- Hard denials and protected paths SHALL hold in every approval mode.
- Convoy SHALL answer approvals only with single-action accept or decline. It SHALL NOT grant session-wide or persistent approvals.
- A declined action's reason SHALL reach the running turn.

#### Scenario: A read-only step reads the checkout
- **WHEN** a read-only Codex step runs `cat math.js` or `rg -n subtract src`
- **THEN** Convoy accepts it without prompting, as a read inside the checkout

#### Scenario: A read-only step tries to write
- **WHEN** a read-only Codex step proposes a file change or `echo hi > a.txt`
- **THEN** Convoy declines it, and no file changes

#### Scenario: A command reaches a protected path
- **WHEN** a Codex agent runs `cat ~/.convoy/private/<file>` or `rg secret ~` through any spelling
- **THEN** Convoy declines it, even with `--yolo`

#### Scenario: An option or expansion hides the path
- **WHEN** a Codex agent runs `cat -n <protected file>`, `cat $SOME_VAR/file`, `git diff --no-index <file> /dev/null` or `git branch -D <branch>`
- **THEN** none of them is accepted as inspection; each is judged as an execution or declined as a read of a protected or outside path

#### Scenario: A declined action is explained
- **WHEN** Convoy declines a Codex command
- **THEN** the policy's reason is steered into the running turn, and Codex's generic "rejected by user" is not the only signal the agent gets

#### Scenario: An operator MCP tool or an unknown request
- **WHEN** Codex asks to call another server's MCP tool, or sends a server request Convoy does not recognize
- **THEN** the call is declined, or answered with an error, and the attempt does not hang

### Requirement: Codex runs isolate Convoy's integration from the operator's Codex setup

Pipeline attempts and helpers SHALL start Codex with the operator's hooks, apps, browser and computer use disabled. Every MCP server in the operator's config SHALL be disabled for the thread, and only Convoy's MCP host SHALL be declared. Convoy SHALL NOT modify the operator's Codex configuration, credentials, rules or hook trust. The bridge address and token SHALL reach Convoy's MCP host only through an owner-only private file, never through argv or the agent's environment.

#### Scenario: The operator has Codex hooks and MCP servers
- **WHEN** `~/.codex` defines hooks and MCP servers and a Codex step runs
- **THEN** none of those hooks run, none of those servers start for the thread, and the operator's files are unchanged

#### Scenario: The operator's MCP servers cannot be read
- **WHEN** `config/read` fails, or the operator declares an MCP server named `convoy`
- **THEN** no thread starts, and the attempt fails with the reason

#### Scenario: The agent inspects its process
- **WHEN** a Codex agent lists processes or prints its environment
- **THEN** the bridge token is not visible

### Requirement: Codex reports, scores and advisors use Convoy's services

Codex attempts SHALL submit reports, scores and commit descriptions through Convoy's `write_report` tool, validated like the other runners. The final agent message SHALL be the fallback report. An advised Codex phase SHALL hold its first file change for one consultation, deliver the advice to the running turn, and decline that change. A failed consultation SHALL release the hold. An unreachable checkpoint SHALL keep the write declined. Advice that cannot be delivered to the turn SHALL keep every write declined until it is delivered.

#### Scenario: First write under an advisor
- **WHEN** an advised Codex step proposes its first file change
- **THEN** the change is declined, the advisor's advice is steered into the turn, and the agent's next change proceeds

#### Scenario: Advice that cannot reach the turn
- **WHEN** the consultation succeeds but its advice cannot be steered into the running turn
- **THEN** the change is declined, and later changes stay declined until the advice is delivered

### Requirement: Codex authentication and billing are explicit and verified

- Subscription mode SHALL use the operator's Codex ChatGPT login, with ambient OpenAI keys removed from the child.
- API-key mode SHALL use only the configured credential reference, logged in to a private per-use Codex home that is discarded afterwards. It SHALL NOT write the operator's Codex credentials.
- The effective account SHALL be verified at preflight and before each attempt, and SHALL match the reviewed mode.
- `included-only` billing SHALL be refused, and an unattended subscription run SHALL require `account-policy`.
- Provenance SHALL record the mode and the credential reference, never a credential value.

#### Scenario: An ambient key under subscription mode
- **WHEN** `OPENAI_API_KEY` is set and the Codex route uses subscription mode
- **THEN** the key is not passed to Codex, and Codex must report the ChatGPT login before the attempt runs

#### Scenario: API-key mode
- **WHEN** `runners.codex.auth` selects an API key by reference
- **THEN** the attempt runs on a private Codex home that holds that key, and the operator's `~/.codex/auth.json` is unchanged

### Requirement: Codex sessions are observable, resumable and bounded

Codex attempts SHALL:

- stream their transcript to the coordinator journal and tee the raw protocol to the run's logs;
- record the thread, model and effort;
- resume an exact recorded thread;
- report token usage, with subscription values as estimates;
- apply the loop guard through in-turn steering and interruption.

Cancellation SHALL interrupt the turn and stop the owned child within the bounded grace.

#### Scenario: The loop guard trips
- **WHEN** the loop guard decides to nudge, then to stop
- **THEN** the nudge is steered into the turn, the turn is interrupted, and the attempt fails with the guard's reason

#### Scenario: Cancelling an attempt
- **WHEN** the operator cancels a running Codex attempt
- **THEN** the turn is interrupted, and the attempt settles as interrupted with its thread recorded

### Requirement: Authoring conversations are refused on Codex with a reason

Convoy SHALL refuse `defaults.authoring.runner: codex`, stating that Codex assigns a conversation's thread id itself. When the run-wide `defaults.runner` is Codex, authoring SHALL fall back to OpenCode. Human-gate iterations in a run without OpenCode SHALL open the operator's interactive Codex under the reviewed authentication. Reopening a Codex thread SHALL be refused, with the reason, when Codex no longer holds it, as for a thread that ran under API-key mode in a discarded private home.

#### Scenario: Codex chosen for authoring
- **WHEN** a config sets `defaults.authoring.runner: codex`
- **THEN** validation fails with the reason
