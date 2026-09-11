## 1. Typed session error signal

- [x] 1.1 In `src/progress.ts`, add and export `SessionErrorSignal` (design D1) and widen `ProgressUI.phaseFailed` to `(name, detail?, failure?: SessionErrorSignal)`. Verification: `bun run typecheck` passes with every existing `phaseFailed` implementation unchanged.
- [x] 1.2 In `src/runner.ts`, add `sessionErrorFromEvent(value: unknown): SessionErrorSignal` (exported for tests), make `formatEventError` return its `message`, and change the `SessionSignal` error variant to carry the signal from `describeSessionActivity`'s `session.error` case. Verification: `test/runner.test.ts` cases for `APIError` 429 retryable, `ProviderAuthError` with `providerID`, `UnknownError`, `MessageOutputLengthError` without message (name as message), and a non-object payload; a snapshot of `formatEventError` output for each payload equals the pre-change string.
- [x] 1.3 In `src/runner.ts`, add `SessionError` (design D2), store the signal in `watchSession`'s `lastSessionError`, keep the `session error: <message>` activity line, and finish with `new SessionError(signal)` at both idle sites. Verification: a `watchSession` test with a fake client yielding `session.error` (429) then `session.idle` rejects with a `SessionError` whose `signal.statusCode`/`signal.isRetryable` match; a Claude Code failure string stays an unclassified `LoggedAttemptError`; a session error named like a runner sentinel never satisfies `isUserAbortError`; a `MessageAbortedError` event yields an error for which `isMessageAbortedError` is true and the attempt boundary throws `SessionAbortedError`.

## 2. Failure gate and attempt log

- [x] 2.1 In `src/runner.ts`, add `describeSessionError` and the `SessionError` branch at the top of `formatSdkError` (design D3). Verification: unit tests — `SessionError` with `statusCode: 429, isRetryable: true` → `"<message> (HTTP 429, retryable)"`; with `isRetryable: false` → `"… not retryable)"`; without `statusCode` → `"<message>"`; a plain `Error` and an SDK-shaped object format as before.
- [x] 2.2 Confirm through the existing attempt-boundary path that `LoggedAttemptError.message`, `gateError`, and the `attempt N failed:` warning carry the classified text without editing those lines. Verification: a runner test that drives one failed attempt with a 429 `SessionError` asserts the `phaseRunning`/warning text and the gate `error` field.

## 3. Persist the classification

- [x] 3.1 In `src/metadata.ts`, add `PhaseMetadata.error?: SessionErrorSignal`, extend `MetadataStore.phaseEnded(name, status, failure?)` to set `error` only when `status === "failed"` and `failure` is given, and forward the third argument from `recordProgress.phaseFailed(name, detail, failure)` (design D4). Verification: `test/metadata.test.ts` — `phaseEnded("build", "failed", signal)` persists `error` in `metadata.json`; `phaseEnded("build", "failed")` leaves the key absent; `recordProgress` forwards `failure` to the store and the wrapped UI; `test/reproduction.test.ts` source assertion updated to the three-argument signature.
- [x] 3.2 In the phase `catch` of `src/runner.ts` (the `progress.phaseFailed(phase.name, formatSdkError(error))` site), pass `sessionErrorOf(error)`, which walks the `cause` chain; the failure gate's abort rethrows `UserAbortError` with the attempt error as `cause`. Verification: runner test asserting `phaseFailed` receives the signal for a `LoggedAttemptError` wrapping a `SessionError`, for an abort answered at the failure gate, and `undefined` for a cancelled message.

## 4. Tests and coverage

- [x] 4.1 Run `bun run typecheck` and `bun test`; all pass. Verification: `bun run test:coverage` stays at or above the threshold enforced by `.github/workflows/verify.yml`.

## 5. Verify

- [x] 5.1 `openspec validate typed-session-errors --strict`.
- [x] 5.2 Headless smoke: run a one-step pipeline with `--no-tui` against a provider with an invalid API key. Verification: the log shows `attempt 1 failed: <message>` with the provider classification, the exit code is unchanged from before this change, and after aborting at the failure gate the run's `metadata.json` carries the classification on the failed phase (an invalid Anthropic key arrives from the SDK as `APIError` with `statusCode: 401, isRetryable: false`).
