# runner-authentication Specification

## Purpose
Preserve Claude subscription access while making optional API-key execution, credential boundaries, and billing consequences explicit to operators.

## Requirements

### Requirement: Claude subscription execution remains first class

Convoy SHALL support the operator's authenticated Claude CLI subscription without requiring an API key or extracting subscription credentials. Subscription mode SHALL support the baseline pipeline capabilities in runner-execution, including writable and verification steps, parallel execution, reports, and same-runner advisors. Convoy SHALL use supported public integration surfaces and respect account entitlements.

#### Scenario: Subscription-only full cycle
- **WHEN** the operator has a supported Claude subscription login and no API key
- **THEN** a baseline Claude-only pipeline including an advisor can execute without API-key prompts, OpenCode dependencies, or conversion to API billing

#### Scenario: Login expired
- **WHEN** the selected subscription login is invalid or expires during execution
- **THEN** Convoy reports the authentication failure and preserves recoverable state instead of collecting tokens or falling back to API credentials

### Requirement: API-key execution requires explicit selection

Convoy SHALL offer a separately selectable Claude API-key mode with its billing implications shown before execution. Features proven to require API-key mode SHALL be labeled individually. Selecting a subscription runner SHALL NOT authorize API-key execution for its attempts or helpers; every differently billed route SHALL require explicit configuration and review.

#### Scenario: Operator selects API-key mode
- **WHEN** an operator explicitly selects Claude API-key mode and supplies a valid external credential reference
- **THEN** review identifies API billing and affected steps or helpers, and execution uses that mode without saving the key in the plan

#### Scenario: Subscription quota exhausted
- **WHEN** a subscription attempt hits a quota limit while API credentials are available
- **THEN** the attempt follows the configured retry or failure policy without switching to API billing

### Requirement: Effective credentials match the reviewed mode

Convoy SHALL validate the effective authentication source under the launch environment and settings used for each attempt and interactive reopen. Conflicting inherited API, helper, OAuth, or third-party credentials SHALL be isolated or cause an actionable refusal. Convoy SHALL NOT rewrite global login state or weaken managed organization policies to force a mode.

#### Scenario: Ambient API key with subscription selection
- **WHEN** subscription mode is selected while the parent environment contains an API key
- **THEN** the child uses verified subscription authentication after scoped isolation, or preflight refuses if that cannot be established; it never silently bills the key

#### Scenario: Shell startup reintroduces credentials
- **WHEN** an external interactive pane's shell startup changes credential resolution
- **THEN** Convoy revalidates the effective mode at client launch and refuses an unreviewed billing change while preserving the operator's normal shell and executable resolution

### Requirement: Paid subscription usage requires a separate billing decision

Convoy SHALL distinguish subscription authentication from included-only usage. Subscription credits and paid features SHALL require explicit billing-policy authorization across executors, helpers, advisors, and interactive reopening. Without it, inherited paid features SHALL be disabled or refused. If included-only execution cannot be verified and enforced, Convoy SHALL refuse that guarantee and require an explicit decision, not imply subscription login proves it.

#### Scenario: Included allowance exhausted with credits enabled
- **WHEN** a subscription account can consume paid usage credits after exhausting its allowance
- **THEN** execution proceeds under that account policy only if explicitly authorized; included-only execution requires a verified enforceable restriction or is refused before the potentially paid request

#### Scenario: Inherited paid feature
- **WHEN** a project or user setting enables a paid feature that the reviewed billing policy does not permit
- **THEN** Convoy disables it through supported invocation-local controls or refuses the launch without modifying global account settings

#### Scenario: Extra-usage status unavailable
- **WHEN** the supported interface cannot establish whether subscription execution can incur additional charges
- **THEN** review reports the uncertainty and requires explicit authorization to follow the account's billing policy or cancels the launch; noninteractive execution requires that authorization in configuration

#### Scenario: Operator authorizes account billing policy
- **WHEN** the operator explicitly accepts potential subscription usage-credit charges
- **THEN** Convoy records non-secret billing-policy consent separately from authentication, preserves configured execution bounds, and does not purchase credits, enable extra usage, or raise account spend limits

### Requirement: Authentication provenance contains no secrets

Run metadata and diagnostics SHALL record authentication mode and non-secret source identifiers only. Tokens, keys, authorization headers, full environments, and credential-bearing server URLs SHALL NOT appear in plans, transcripts, lifecycle records, terminal commands, or logs. Bridge and server credentials SHALL be scoped and protected independently of public run history.

#### Scenario: Failed server authentication
- **WHEN** a runner or local bridge rejects credentials
- **THEN** the error identifies the operation and mode without disclosing the password, request authorization, or credential values

### Requirement: Usage reporting distinguishes estimates from billing

Convoy SHALL attribute available tokens and costs to attempts, executors, and helpers without double-counting resumed cumulative totals. Subscription-mode monetary estimates SHALL NOT be presented as an API invoice or subscription quota balance. Missing measurements SHALL remain unknown; configured budget enforcement SHALL disclose its measurement basis and limitations.

#### Scenario: Resumed Claude cumulative usage
- **WHEN** Claude reports a conversation total including earlier attempts
- **THEN** Convoy uses the recorded baseline to attribute the new usage once and labels any monetary value as an estimate where appropriate

#### Scenario: Required budget cannot be measured
- **WHEN** an operator requests a budget guarantee that the selected runner cannot measure or enforce
- **THEN** preflight refuses that guarantee or requires explicit selection of an available bounded policy, rather than reporting missing consumption as zero
