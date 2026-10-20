# opencode-v2-compatibility Specification

## Purpose
Run existing Convoy workflows on OpenCode V2 without changing their functional contracts, safety boundaries or operator experience. Define the compatibility and parity guarantees required before replacing the V1 integration.

## Requirements

### Requirement: Runtime compatibility is explicit and non-destructive

Convoy SHALL use the operator's locally resolved OpenCode executable and verify its version/API against the release's documented, tested V2 integration before submitting work or running repository-mutating hooks. Missing, V1 or unsupported runtimes SHALL produce an actionable error identifying the detected runtime and supported target.

#### Scenario: Supported local V2 runtime

- **WHEN** the locally resolved executable belongs to the documented tested V2 compatibility set
- **THEN** the existing Convoy command can proceed using that executable and records the detected runtime version without changing the installation

#### Scenario: Missing or incompatible executable

- **WHEN** the executable is missing, is V1 or has an unsupported version/API
- **THEN** Convoy stops before model work and repository-mutating hooks, reports how to provide a supported runtime and leaves unrelated processes and user configuration unchanged

### Requirement: Runtime incompatibility never changes user setup

Convoy SHALL NOT install, update or replace OpenCode, rewrite user configuration or silently select a different runtime to resolve incompatibility.

#### Scenario: Unsupported runtime leaves local setup intact

- **WHEN** compatibility validation rejects the resolved OpenCode runtime
- **THEN** Convoy reports the incompatibility without changing the installation, runtime selection or user configuration

### Requirement: Existing workflows and configuration retain their meaning

Convoy SHALL preserve existing CLI/TUI commands, flags, pipelines, defaults, custom YAML, config precedence, agent overrides, report-only/verify distinctions, parallel execution, goals, hooks and human gates. Migration SHALL NOT introduce native agent topology changes, new step semantics or a replacement pipeline language. The Claude runner SHALL retain its capabilities and conventions.

#### Scenario: Existing custom pipeline runs on V2

- **WHEN** an operator selects a supported existing custom pipeline and configuration without rewriting its Convoy YAML
- **THEN** Convoy resolves the same steps, models, dependencies, permissions, gates and outputs and executes them through the V2 integration

#### Scenario: Selected model cannot be represented or resolved

- **WHEN** a frozen model, provider, variant or routing selection is not available on the supported V2 runtime
- **THEN** Convoy reports the incompatible selection without substituting a different model or modifying the frozen plan

### Requirement: Frozen execution selections are never silently rerouted

Existing model/provider/variant and routing selections and frozen plans SHALL retain their intent. Convoy SHALL report unsupported selections instead of silently rerouting them or modifying the frozen plan.

#### Scenario: Frozen plan retains its selected models

- **WHEN** an existing frozen plan is resolved for V2 execution
- **THEN** its supported selections retain their intent and unsupported selections produce an actionable error without replacement

### Requirement: Managed V2 servers preserve ownership and authentication boundaries

Convoy SHALL preserve `opencode-server-lifecycle` ownership, lifetime, shutdown, controller-hold and orphan-recovery requirements. Run/helper startup SHALL establish an authenticated V2 connection and effective run-scoped config before exposing readiness. Run cleanup SHALL NOT stop, restart, reconfigure or claim ownership of the user's shared service or an independently owned authoring service.

#### Scenario: Authenticated startup and ordinary release

- **WHEN** Convoy starts a supported V2 run/helper server and later releases its owning operation
- **THEN** authenticated requests use the owned endpoint, lifecycle evidence identifies the actual child and bounded shutdown observes its outcome while independent services remain untouched

#### Scenario: Authentication or readiness fails after spawn

- **WHEN** startup cannot authenticate, parse readiness or establish the connection before its existing deadline
- **THEN** Convoy retains ownership, performs bounded cleanup and reports the failure without exposing passwords, tokens or full configuration in diagnostics

### Requirement: Startup and cleanup diagnostics redact credentials

Startup/cleanup diagnostics SHALL redact server and bridge credentials before retaining output and SHALL NOT expose passwords, tokens or full configuration.

#### Scenario: Readiness credentials do not enter retained diagnostics

- **WHEN** server output contains credentials during successful or failed startup or cleanup
- **THEN** Convoy redacts them before retaining diagnostic output, including error tails

### Requirement: Session inputs preserve phase context and selected execution settings

Each OpenCode phase SHALL retain its target checkout, resolved agent and safety instructions, model/provider/variant intent, context attachments and deliverable contract. File/text inputs and model aliases SHALL preserve their effective meaning. Required temperature, output-cap and routing settings SHALL affect the applicable request, not merely configuration.

#### Scenario: Phase receives attachments and an explicit variant

- **WHEN** an existing phase has project instructions, file attachments and an approved model variant
- **THEN** its V2 execution uses the intended checkout, instructions, attachment content and selected model/variant instead of falling back to session defaults

#### Scenario: Scoped advisor settings

- **WHEN** an advisor consultation has an output cap, temperature or routing override
- **THEN** the effective advisor request honors those settings without changing the executor's requests or enabling tools in the consultation

### Requirement: Conversation continuity and isolation remain unchanged

Follow-ups SHALL retain the intended executor session. Independent phases and advisor consultations SHALL NOT gain inherited conversation context as a side effect of migration.

#### Scenario: Follow-up continuity does not merge independent contexts

- **WHEN** an executor receives a follow-up while another phase or advisor consultation is created
- **THEN** the follow-up uses its intended executor session and the independent execution receives no unintended inherited conversation

### Requirement: Prompt admission is not treated as phase completion

For every phase, follow-up, helper and authoring command, Convoy SHALL distinguish admission from settlement, correlate the intended turn and validate its existing deliverable before advancing, committing or reporting success. Transport retries SHALL NOT duplicate admitted work. Idle or HTTP success alone SHALL NOT certify successful work.

#### Scenario: Prompt accepted while execution is pending

- **WHEN** V2 accepts a phase prompt before its model execution finishes
- **THEN** Convoy keeps the phase pending/running and does not advance, commit or declare success until the relevant execution and deliverable have settled

#### Scenario: Admission response is lost

- **WHEN** a transport failure leaves Convoy uncertain whether its prompt was admitted
- **THEN** recovery reconciles that admission before retrying and does not execute the same intended turn twice

#### Scenario: Helper or phase fails after admission

- **WHEN** admitted work subsequently fails or exceeds its existing timeout
- **THEN** Convoy reports the corresponding failure/timeout, performs bounded owned cleanup and does not return an admission object or stale assistant output as a successful result

### Requirement: Execution failures retain distinct recovery outcomes

Provider failure, timeout, contact loss and user abort SHALL retain their distinct existing outcomes and recovery behavior, including bounded owned cleanup.

#### Scenario: Contact loss is not an explicit user abort

- **WHEN** transport contact is lost without an explicit user abort
- **THEN** Convoy uses its existing contact-loss recovery/outcome rather than reporting successful execution or misclassifying it as user cancellation

### Requirement: Events and transcripts remain attributable and recoverable

Convoy SHALL route V2 observations only to sessions it owns or explicitly follows, preserving live text, reasoning, tool markers, progress and terminal outcomes. Stream loss SHALL trigger bounded recovery/reconciliation without silently disabling observation, permission handling or safety controls.

#### Scenario: Unrelated sessions share an event stream

- **WHEN** the server delivers interleaved events for a Convoy phase and an unrelated session
- **THEN** only the phase's attributable events affect its display, permissions, costs, budgets or outcome

#### Scenario: Stream reconnect and late attach

- **WHEN** the event connection is lost or a dashboard attaches after the phase started
- **THEN** Convoy reconstructs available prior output, reconciles pending state and resumes live observation without duplicate transcript entries or false completion

### Requirement: Transcript reconstruction preserves truthful history

Late attach and reattach SHALL preserve `session-transcripts`, including paginated history reconstruction and live/history deduplication. Missing historical data SHALL retain the existing honest placeholder rather than fabricated transcripts.

#### Scenario: Missing historical messages remain unavailable

- **WHEN** the server cannot supply a historical phase's transcript
- **THEN** Convoy shows the existing honest placeholder without inventing content, while preserving any available live/history data without duplication

### Requirement: Permission and safety policies retain their enforcement

Interactive, Auto-accept and Smart auto-accept SHALL retain their semantics, hard denials, per-session pause behavior and human ownership. Strict read-only phases SHALL retain their tool restrictions; verify phases SHALL retain only existing permitted checks and repository baseline safeguards. V2 action/tool changes SHALL NOT relax existing question/delegation restrictions.

#### Scenario: Hard denial under automatic acceptance

- **WHEN** a V2 tool requests an operation forbidden by Convoy's existing hard-deny policy under Auto-accept or Smart auto-accept
- **THEN** the operation remains denied and cannot be approved by automatic acceptance or a saved approval

#### Scenario: Strict read-only and verify remain distinct

- **WHEN** a strict read-only phase requests mutation, shell execution or forbidden delegation while a verify phase requests an existing allowed check
- **THEN** the read-only operation is denied and the verify check follows its existing shell policy and repository-change validation

#### Scenario: Permission gate has no active controller

- **WHEN** a permission or human decision is waiting and the controlling client leaves
- **THEN** Convoy preserves the pending decision and background/reattach behavior without silently accepting, rejecting or aborting the run

### Requirement: Consultations remain tool-less and judging fails closed

Advisor/judge consultations SHALL remain tool-less, including newly named, custom, MCP and nested tools. Smart-judge failure SHALL NOT grant authorization.

#### Scenario: A judge cannot gain tools or approve its own failure

- **WHEN** V2 exposes extra tools to a judge profile or the judge fails to return a valid decision
- **THEN** the consultation's tool-less restriction remains enforced and failure grants no authorization

### Requirement: Runtime tools preserve report and bridge contracts

Every OpenCode run SHALL have working `write_report`; advised phases SHALL retain `advisor` and `advisor_feedback` with existing inputs/outputs. Registration SHALL be effective before dependent work. Reports SHALL retain fixed destinations, validated Markdown/scoring/commit metadata, serialized atomic writes, candidate precedence and read-only availability without checkout mutation rights.

#### Scenario: Report-only phase persists its result

- **WHEN** a strict read-only phase calls `write_report` with a valid existing report payload
- **THEN** Convoy writes the validated report to that phase's fixed destination without enabling repository edit tools

#### Scenario: Unknown or unauthenticated bridge caller

- **WHEN** a call lacks valid bridge authentication or does not identify a registered session for that run
- **THEN** Convoy applies the existing rejection/degradation policy and neither writes another phase's report nor exposes another run's advisor state

#### Scenario: Required runtime tool is unavailable

- **WHEN** dependent work would start without an active required report/advisor tool
- **THEN** Convoy reports a setup failure rather than running with silently missing functionality

### Requirement: Bridge routing is authenticated and isolated per run

Bridge calls SHALL use trusted execution-session identity, authenticated run-scoped endpoints and existing validation. Concurrent runs SHALL NOT exchange bridge credentials or destinations or expose another run's advisor state.

#### Scenario: Concurrent bridge bindings stay isolated

- **WHEN** multiple runs submit report or advisor bridge calls concurrently
- **THEN** each authenticated, registered session resolves only its own run's destination and advisor state, with no cross-run credential exchange

### Requirement: Advisor policy retains all existing checkpoints and limits

Advised phases SHALL preserve on-demand, first-write and completion behavior. First-write advice SHALL precede automatic acceptance under the same existing trigger coverage. Completion follow-ups and `NO CHANGES` SHALL preserve existing report/work retention.

#### Scenario: First-write consult precedes automatic approval

- **WHEN** an advised phase reaches its first edit covered by the existing checkpoint before having consulted
- **THEN** Convoy performs that consultation before automatic acceptance and preserves the current advice/retry behavior rather than making consultation optional to the model

#### Scenario: Completion advice preserves or updates the report

- **WHEN** a settled phase receives completion advice and the follow-up returns a replacement report or `NO CHANGES`
- **THEN** Convoy validates the replacement or retains the prior valid report according to the existing policy, in the intended executor session

#### Scenario: Consultation fails or is aborted

- **WHEN** a consultation fails ordinarily, times out or is cancelled by run abort
- **THEN** Convoy counts its budget/usage as currently defined, preserves ordinary-failure degradation, honors run cancellation and performs bounded consultation cleanup without granting judge permissions

### Requirement: Advisor consultations retain bounded fresh execution

Advisor consultations SHALL retain explicit bounded executor transcript input, fresh tool-less sessions, bounded timeout and output cap. Advisor reasoning SHALL NOT be returned as advice text.

#### Scenario: A consultation uses bounded input in a fresh session

- **WHEN** an advised phase requests advice
- **THEN** the consultation uses its explicit bounded executor transcript in a fresh tool-less session, honors timeout/output limits and returns no advisor reasoning as advice text

### Requirement: Advisor failures and accounting retain their policy

Failed-call budget accounting, correlated feedback, executor/advisor usage separation, audit privacy and correlated call identity SHALL remain unchanged. Ordinary advisor failure SHALL retain its existing degradation policy; user abort or structural safety failure SHALL NOT be swallowed.

#### Scenario: Failed advice keeps its budget and audit policy

- **WHEN** an advisor call fails or its correlated feedback arrives
- **THEN** Convoy preserves existing failed-call accounting, usage separation, feedback correlation and private audit identity without swallowing abort or structural safety failure

### Requirement: Human recovery keeps the original session and runtime handles

Phase session references, report candidates and advisor state SHALL remain usable through existing human/permission gates and terminal holds. Opening the phase in OpenCode SHALL target its exact session, checkout and authenticated endpoint. Updated reports produced during recovery SHALL be considered by the existing continue action. Advancing, retrying, resetting or aborting SHALL invalidate the previous attempt's handles without changing sibling or independent conversation lifetimes.

#### Scenario: Human edits a held phase report

- **WHEN** an operator opens a held phase's OpenCode session and updates its report before continuing
- **THEN** the same session's report/advisor tools remain available and Convoy evaluates the latest valid candidate rather than a released handle or stale report

#### Scenario: Retry invalidates old attempt calls

- **WHEN** an operator retries or resets a phase and its previous session later submits a report or advice request
- **THEN** the old handle cannot alter the new attempt and the retry follows the existing plan and recovery policy

### Requirement: Usage and execution budgets remain effective

Executor/advisor token/cost and provider-limit displays, repeated-tool/failure/step fuses and configured budgets SHALL retain existing behavior and defaults. Follow-up observation SHALL preserve the existing reset-versus-cumulative budget semantics.

#### Scenario: Cumulative usage and reconnect overlap

- **WHEN** the same usage is observed through live events, a cumulative session snapshot and reconnect reconciliation
- **THEN** Convoy accounts for that usage once and preserves the executor/advisor split and configured cost limits

#### Scenario: Existing execution fuse trips

- **WHEN** a V2 phase reaches an existing repeated-call, consecutive-failure, model-step or cost threshold
- **THEN** Convoy invokes the same existing stop/decision behavior instead of leaving the fuse inactive because event names changed

#### Scenario: Provider-limit data is unavailable

- **WHEN** the V2 provider cannot supply information used by the existing limit display
- **THEN** the display follows its existing unavailable/error behavior without revealing credentials or reporting a fabricated quota

### Requirement: Usage accounting is deduplicated and truthful

V2 cumulative observations and retries SHALL be deduplicated. Attributable auxiliary/delegated work SHALL NOT disappear from existing budget accounting. Missing cost or provider-limit data SHALL be represented as unavailable, not invented measured zero.

#### Scenario: Auxiliary usage and unavailable cost remain distinguishable

- **WHEN** attributable auxiliary work has usage observations but some cost data is missing
- **THEN** Convoy preserves existing accounting without double counting and distinguishes unavailable cost from measured zero

### Requirement: Auxiliary integrations and terminal workflows remain functional

Preflight/catalog selection, safety judging, naming/commit-text generation and proposal/OpenSpec authoring commands SHALL work on the same supported V2 integration, preserving existing model validation and bounded-helper behavior. Provider authentication SHALL remain owned by OpenCode.

#### Scenario: Existing model preflight and helper call

- **WHEN** a pipeline selects executors, advisors, goal models or a safety judge and invokes an existing helper
- **THEN** Convoy validates the effective V2 catalog/variants and returns the helper's settled result with bounded cleanup and existing model-selection semantics

#### Scenario: Conversation opens in a foreground client or multiplexer pane

- **WHEN** an operator opens or resumes an existing linked conversation through a supported presentation mode
- **THEN** the client uses the intended authenticated endpoint, session and operator-shell context while preserving terminal restoration and the conversation's independent lifetime

#### Scenario: Historical linked session cannot be resolved

- **WHEN** V2 cannot resolve a stored historical session reference
- **THEN** Convoy follows the existing unavailable-session behavior, preserves its run/conversation records and does not claim a newly created session is the old one

#### Scenario: Opt-in command installation preserves ownership rules

- **WHEN** an operator explicitly installs the Convoy command for use with V2
- **THEN** Convoy preserves its existing managed-command replacement and foreign-file protection rules, the installed command is discoverable on V2 and unrelated user configuration remains unchanged

### Requirement: Terminal continuation preserves exact conversations

Stored-session reopening, foreground/external presentation and supported multiplexer workflows SHALL preserve exact conversation references, writer coordination and independent authoring lifetimes. Continuation SHALL verify the intended existing session rather than use a V2 flag to silently create a replacement.

#### Scenario: Continuation cannot create a replacement for a missing session

- **WHEN** the intended recorded session is unavailable during foreground or external continuation
- **THEN** Convoy applies its existing unavailable-session behavior and does not silently create a replacement or disturb writer coordination and independent conversations

### Requirement: Opt-in command installation retains file ownership

The `/convoy-spin` command and its existing opt-in installation SHALL work on V2. Managed-command replacement and foreign-file protection rules SHALL remain unchanged, without rewriting unrelated user configuration.

#### Scenario: A foreign command definition is not implicitly replaced

- **WHEN** opt-in command installation encounters a definition not owned by Convoy
- **THEN** existing foreign-file protection and replacement rules apply, with no implicit overwrite or unrelated user-config rewrite

### Requirement: Goals resume and finalization preserve existing contracts

V2 execution SHALL preserve frozen run/attempt metadata, resume/retry checkpoints, qualified goal-fragment reports, isolated measurement context, hooks, writer claims, repository validation, semantic step commits and automatic Git finalization. Goals SHALL remain one logical run on the existing workspace/server lifecycle. Migration SHALL NOT replace Convoy goal scheduling with OpenCode agent decisions.

#### Scenario: Goal run resumes after an interrupted iteration

- **WHEN** an operator resumes a supported existing goal run with durable checkpoints and a frozen plan
- **THEN** Convoy restores the same run/fragment identities and plan, preserves measurement isolation and report destinations and follows existing checkpoint/finalization rules

#### Scenario: Run completion triggers Git finalization

- **WHEN** pipeline execution successfully settles on V2
- **THEN** Convoy applies the existing run-finalization contract; OpenCode context compaction or idle events do not substitute for Git finalization or authorize publication

### Requirement: Migration preserves historical records and Git state

Existing run records SHALL remain readable. Migration SHALL NOT reinterpret historical coordinator identity, move worktrees or mutate Git history.

#### Scenario: Runtime migration does not rewrite historical identity

- **WHEN** Convoy adopts the V2 integration while existing run records and worktrees are present
- **THEN** the records remain readable, coordinator identity retains its meaning and adopting V2 does not itself move worktrees or rewrite Git history

### Requirement: Migration acceptance demonstrates complete behavior parity

Acceptance SHALL include a traceable parity matrix for all existing OpenCode-backed functionality, retained domain regression assertions, V2 request/event/plugin contract coverage and isolated execution evidence against the documented runtime/client/plugin combination. V1-shaped mocks or configuration compilation alone SHALL NOT establish compatibility. Native-agent enhancements SHALL remain outside acceptance criteria.

#### Scenario: Contract mocks pass but a runtime capability fails

- **WHEN** unit/contract tests pass but required startup/auth, plugin loading, settings, permissions, reports, advisor or continuation behavior fails against the supported V2 runtime
- **THEN** the migration remains incomplete and records the failed parity case instead of dropping the feature or declaring success

#### Scenario: All required parity cases have execution evidence

- **WHEN** every required parity case passes with the documented combination and existing canonical regression requirements remain satisfied
- **THEN** the migration can be accepted as phase 1 without requiring or introducing a redesigned native-agent workflow

### Requirement: Parity gaps remain explicit acceptance blockers

Unverified or unsupported current functionality SHALL be recorded as a blocker rather than removed, silently degraded beyond its existing contract or counted as complete.

#### Scenario: A current capability cannot be dropped to pass acceptance

- **WHEN** an existing Convoy capability remains unverified or unsupported on V2
- **THEN** acceptance records the unresolved parity blocker instead of removing the capability, weakening its contract or marking it complete
