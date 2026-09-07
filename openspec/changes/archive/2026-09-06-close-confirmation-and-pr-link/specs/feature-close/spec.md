## ADDED Requirements

### Requirement: Close detects and discloses an open pull request for the feature branch

During the squash-merge step, close SHALL probe for an open pull request whose head is the feature branch using the GitHub CLI when it is installed and authenticated. The probe SHALL be tolerant: a missing GitHub CLI, missing authentication, a probe error, or no matching pull request SHALL all degrade to no detected pull request without blocking close, emitting a failure, or asserting anything about hosted merge state. When an open pull request is detected, close SHALL disclose it — its number, title, and URL — in the interactive checklist and the headless summary, without asserting that the pull request is or will be merged. The detected pull request SHALL appear in the follow-up guidance with a deliberate fallback close command naming the pull request and the landing commit, for the case where GitHub does not mark the pull request merged after the push. Close MUST NOT push, merge, or close the pull request itself; every pull-request mutation remains a printed, deliberate operator action.

#### Scenario: Open pull request is detected and disclosed

- **WHEN** the feature branch has an open pull request and the GitHub CLI is available and authenticated
- **THEN** close discloses the pull request number, title, and URL without asserting merge, and the follow-up guidance includes the deliberate fallback close command naming the pull request and the landing commit

#### Scenario: Probe degrades without blocking

- **WHEN** the GitHub CLI is absent, unauthenticated, or the probe fails, and the preflight otherwise passes
- **THEN** close proceeds with no pull-request disclosure and reports no failure

#### Scenario: No pull request mutation is automatic

- **WHEN** close completes with a detected open pull request
- **THEN** close has not pushed, merged, or closed anything on GitHub; only the printed follow-up commands perform those actions when the operator runs them

## MODIFIED Requirements

### Requirement: The squashed commit carries a composed conventional message

The squash-merge commit's message SHALL be composed from the change's proposal, capability names, all feature-exclusive commit subjects, and the aggregate feature change against the captured base, with deterministic fallback when the writer cannot provide a usable proposal. Close SHALL preserve this context across archive and resume so a retry does not degrade into an archive-only description. Regardless of writer output, composed messages SHALL use the single touched capability as scope and omit scope when zero or several capabilities are touched. The subject SHALL be a readable imperative line derived from the change, not the change ID slug; the fallback SHALL use a type-appropriate verb and normalized proposal title. Composed messages SHALL name the change ID in the body. When close detected an open pull request for the feature branch, the composed subject SHALL carry that pull request's number in the `(#N)` reference form GitHub recognizes for squash landings, applied before message review so the operator sees the exact subject that lands; an operator edit that removes the reference SHALL be respected, and close SHALL NOT re-append it. An explicit `--message` SHALL win verbatim and bypass composition, message review, and the pull-request reference.

#### Scenario: Writer proposal lands

- **WHEN** the writer answers for a change touching one capability
- **THEN** the composed subject is readable and imperative, the scope is that capability, and the body names the change ID

#### Scenario: Broad writer proposal loses its scope

- **WHEN** the writer proposes a scope for a change touching several capabilities
- **THEN** close removes the scope while preserving the readable subject and change ID body

#### Scenario: Deterministic fallback without a model

- **WHEN** no writer is available
- **THEN** close derives the branch type, appropriate capability scope, readable imperative subject, and change ID body without preventing message review

#### Scenario: Explicit override wins

- **WHEN** close runs with an explicit message override
- **THEN** that exact message is used without composition or message confirmation

#### Scenario: Resume after archiving

- **WHEN** the operator resumes after archive and a cancelled message review
- **THEN** the writer still receives the preserved proposal and complete feature context rather than only the archive commit

#### Scenario: Detected pull request rides the reviewed subject

- **WHEN** close composes the landing message for a feature branch with an open pull request
- **THEN** the subject shown for review ends with the pull request's `(#N)` reference and the landing commit uses that exact subject

#### Scenario: Operator edit removing the reference is respected

- **WHEN** the operator edits the reviewed message and removes the `(#N)` reference
- **THEN** the landing commit uses the edited message without the reference, and close does not re-append it
