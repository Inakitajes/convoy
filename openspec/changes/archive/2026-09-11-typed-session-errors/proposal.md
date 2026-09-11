## Why

When OpenCode reports a `session.error` event, Convoy flattens it to a message string before anything can inspect it: `describeSessionActivity` returns `{ type: "error", error: formatEventError(...) }`, and `formatEventError` keeps only `message` (or `data.message`), discarding the SDK's error `name`, `data.statusCode`, `data.isRetryable`, and `data.providerID`. `watchSession` then finishes the attempt with `new Error(lastSessionError)`. By the time the failure gate shows "step failed — waiting for your decision", the attempt log is written, and `metadata.json` records the phase as `failed`, nobody can tell a retryable `429` from an expired provider credential or a truncated output — the operator opens the OpenCode session to find out, and a headless run leaves no structured trace at all.

The same flattening hides a typed cancellation: `isMessageAbortedError` compares `error.name === "MessageAbortedError"`, but the plain `Error` built from the string never carries that name, so an abort delivered through `session.error` is reported as an ordinary attempt failure instead of a `SessionAbortedError`.

## What Changes

- Carry the SDK error's classification (`name`, `message`, `statusCode`, `isRetryable`, `providerID`) through the session signal as a `SessionErrorSignal`, and finish the attempt with a `SessionError` that preserves it. `formatEventError` keeps returning the exact same string for every other event.
- Disclose the classification where the operator already looks: the failure gate text and the attempt warning read `<message> (HTTP 429, retryable)` when the SDK provides a status, and stay unchanged otherwise.
- Persist the classification as `PhaseMetadata.error` when a phase ends `failed` because of a session error, through an optional `failure` argument on `ProgressUI.phaseFailed` that only `recordProgress` consumes.
- Recognize an aborted message signalled through `session.error` as the existing typed cancellation (`SessionAbortedError`), since the preserved `name` now reaches `isMessageAbortedError`.
- Introduce no automatic action: no retry, no model fallback, no exit-code change. The failure gate keeps waiting for the operator's decision; a headless run still fails the same way, only with a richer message and record.

## Capabilities

### New Capabilities

- `step-failure-diagnostics`: session errors keep their harness classification through the signal, the failure gate, the attempt log, and the persisted phase metadata, without triggering any automatic decision.

### Modified Capabilities

<!-- None: existing gate, retry, and finalization behavior is unchanged. -->

## Impact

- `src/runner.ts` (`SessionSignal` error variant, `describeSessionActivity`, `formatEventError`, `watchSession`, `formatSdkError`, the phase `catch` that reports `phaseFailed`).
- `src/progress.ts` (`SessionErrorSignal` type, optional `failure` on `phaseFailed`).
- `src/metadata.ts` (`PhaseMetadata.error`, `phaseEnded` failure argument, `recordProgress` forwarding).
- Tests under `test/` for the signal, the gate text, and the persisted metadata.
- No CLI surface, control-channel protocol, pipeline configuration, or TUI layout change. `metadata.json` gains one optional field on failed phases.
