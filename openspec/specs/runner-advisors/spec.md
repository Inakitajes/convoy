# runner-advisors Specification

## Purpose
Provide the same policy-driven advisor consultations and execution checkpoints across supported runners, with explicit routing and attributable resource use.

## Requirements

### Requirement: Advisors are selected independently of executors

Convoy SHALL support advisors for Claude and OpenCode executors, using either supported runner for the advisor when explicitly configured. Consultation input SHALL use a normalized, bounded snapshot of relevant execution context. Advisor execution SHALL remain tool-restricted and SHALL NOT gain repository write authority.

#### Scenario: Claude executor with Claude subscription advisor
- **WHEN** a subscription-only Claude step requests its configured Claude advisor
- **THEN** the consultation runs through the supported subscription path without needing OpenCode or an API key

#### Scenario: Cross-runner consultation
- **WHEN** a Claude executor requests an explicitly configured OpenCode advisor
- **THEN** preflight and review disclose both dependencies and billing modes, and consultation output is returned to the correct Claude attempt

### Requirement: Advisor checkpoints are enforced before protected work

Configured mandatory advisor checkpoints SHALL block protected actions until the applicable consultation policy is satisfied. Native auto-approval SHALL NOT bypass them. Consultation failures SHALL preserve the blocked state or produce an explicit failure; a prompt asking the agent to consult SHALL NOT substitute for an enforced checkpoint.

#### Scenario: First write without advice
- **WHEN** a Claude executor with a mandatory first-write consultation requests a write before consultation completes
- **THEN** the action does not execute until Convoy's advisor policy permits it

#### Scenario: Advisor bridge unavailable
- **WHEN** an attempt requires advice but its bridge or advisor fails
- **THEN** protected work remains blocked with an actionable error rather than continuing without advice

### Requirement: Consultation budgets and provenance are separate and bounded

Convoy SHALL attribute consultation events, outcomes, usage, and available cost estimates to the requesting run and attempt, separately from executor use. Call limits, output limits, and consultation deadlines SHALL apply across runners. Advisor calls SHALL count toward applicable run budgets without recursive unbounded consultations or duplicate accounting.

#### Scenario: Parallel consultation cancellation
- **WHEN** one of two consulting executors is cancelled
- **THEN** its pending consultation is cancelled or boundedly released without cancelling the sibling's consultation or charging either result twice

### Requirement: Native advisor facilities require behavioral equivalence

A harness-native advisor feature SHALL satisfy Convoy advisor requirements only if it preserves required routing, checkpoint enforcement, context scope, limits, and attribution. Otherwise Convoy SHALL use its own consultation integration or disclose the unsupported operation rather than treating a similarly named native option as parity.

#### Scenario: Native advisor cannot expose required attribution
- **WHEN** a native advisor option does not provide the evidence required by the configured Convoy policy
- **THEN** Convoy uses the verified consultation route or refuses that configuration instead of hiding advisor consumption inside an unexplained executor total
