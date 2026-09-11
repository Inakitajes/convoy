# step-failure-diagnostics Specification

## Purpose
Keep the harness's own classification of a failed session — error name, HTTP status, retryability, provider — visible to the operator and durable in the run record, so a failed step can be understood without reopening the OpenCode session and without Convoy deciding anything on the operator's behalf.

## Requirements

### Requirement: Session errors keep their harness classification

When the harness emits a `session.error` event, Convoy SHALL carry the error's classification through its internal session signal instead of a flattened message: the error `name`, the human-readable `message`, and, when the harness provides them, the HTTP `statusCode`, the `isRetryable` flag, and the `providerID`. The message text derived for activity lines SHALL be identical to the text derived today, so existing log and dashboard output does not change for events that carry only a message.

#### Scenario: A rate-limited provider response

- **WHEN** the harness emits `session.error` with an `APIError` whose data carries `statusCode: 429` and `isRetryable: true`
- **THEN** the session signal exposes `name: "APIError"`, the provider message, `statusCode: 429`, and `isRetryable: true`

#### Scenario: A provider authentication failure

- **WHEN** the harness emits `session.error` with a `ProviderAuthError` for provider `anthropic`
- **THEN** the session signal exposes `name: "ProviderAuthError"`, the message, and `providerID: "anthropic"`, with no status or retryability claimed

#### Scenario: An error without a message

- **WHEN** the harness emits `session.error` with a `MessageOutputLengthError` whose data carries no message
- **THEN** the session signal uses the error name as its message, exactly as the flattened text did before

### Requirement: The failure gate and the attempt log disclose the classification

When an attempt fails because of a classified session error, the failure gate's error text and the attempt warning SHALL append the classification to the message in the form `<message> (HTTP <status>, retryable)` or `<message> (HTTP <status>, not retryable)`. When the harness provided no status, the text SHALL be the message alone, unchanged from today. The gate label "step failed — waiting for your decision" and the gate's choices SHALL NOT change.

#### Scenario: A retryable status reaches the gate

- **WHEN** an attempt fails with a session error carrying `statusCode: 429` and `isRetryable: true`
- **THEN** the gate error and the `attempt N failed:` warning read `<message> (HTTP 429, retryable)`

#### Scenario: An unclassified error reaches the gate

- **WHEN** an attempt fails with an `UnknownError` that carries only a message
- **THEN** the gate error and the warning show the message with nothing appended

### Requirement: Failed phase metadata records the classification

When a phase ends `failed` because of a classified session error, the run's `metadata.json` SHALL record the classification on that phase as `error` with the same fields as the session signal. The failure gate's decision does not change the reason the phase failed: an abort chosen at the gate — or a run-wide shutdown while the gate waits — SHALL keep the failed attempt's classification. A phase that fails for any other reason — a cancelled message, hook failure, deliverable validation — SHALL NOT gain an `error` field, and successful or skipped phases SHALL be unaffected.

#### Scenario: A step fails on a provider error and the operator aborts at the gate

- **WHEN** a step's attempt fails with a `ProviderAuthError` and the operator chooses abort at the failure gate
- **THEN** the run exits as it does today and the failed phase in `metadata.json` carries `error: { name: "ProviderAuthError", message, providerID }`

#### Scenario: An operator cancels the message itself

- **WHEN** the operator aborts the message (Esc) and then chooses abort at the failure gate
- **THEN** the phase is recorded as `failed` without an `error` classification

### Requirement: An aborted message signalled through the harness is a typed cancellation

When the harness delivers `MessageAbortedError` through `session.error`, Convoy SHALL treat it as the same typed cancellation it already recognizes when the prompt call itself returns that error, so an Esc abort is never reported as an ordinary attempt failure.

#### Scenario: Abort arrives as an event

- **WHEN** the operator aborts the message and the harness reports it only through `session.error` with `name: "MessageAbortedError"`
- **THEN** the attempt ends with the typed cancellation and the gate opens as it does for an abort returned by the prompt call

### Requirement: Classification never triggers automatic action

The classification SHALL be informational only. Convoy SHALL NOT retry an attempt, switch models, alter the gate's choices, or change the process exit code based on `statusCode` or `isRetryable`; a failed step still waits for the operator's decision, and a headless run still fails without one.

#### Scenario: A retryable error in an interactive run

- **WHEN** an attempt fails with `isRetryable: true` while a controller is attached
- **THEN** the failure gate opens with the classified text and waits; no retry starts on its own

#### Scenario: A retryable error in a headless run

- **WHEN** an attempt fails with `isRetryable: true` and no controller is attached
- **THEN** the run fails with the same exit code as before, with the classified text in the log and the record
