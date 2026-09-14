## Context

OpenCode types its `session.error` payload as `ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError` (`@opencode-ai/sdk` 1.18.4, `EventSessionError`). `ApiError.data` carries `statusCode`, `isRetryable`, and the raw response; `ProviderAuthError.data` carries `providerID`. Convoy consumes the event in `describeSessionActivity` (`src/runner.ts`, `case "session.error"`), which returns `{ type: "error", error: formatEventError(properties.error) }` — a `string`. `formatEventError` prefers `message`, then `data.message`, then `name`/`type`, so every field other than the message is gone at the first hop.

Downstream, `watchSession` keeps `lastSessionError: string | undefined`, echoes it as a `session error:` activity line, and finishes the attempt with `new Error(lastSessionError ?? "…without a completed response")` at both idle sites (the event `idle` case and the poll-loop fallback). The attempt boundary then does `if (isMessageAbortedError(result.error)) throw new SessionAbortedError(result.error)` else `throw new LoggedAttemptError(formatSdkError(result.error), { cause: result.error })`. Because the error is a plain `Error`, the abort check never matches for event-delivered aborts. The failure path continues to `writeAttemptLog`, `log.warn([phase] attempt N failed: …)`, `gateError = formatSdkError(error)`, and — after the gate resolves to abort or is `unavailable` headless — the phase `catch` calls `progress.phaseFailed(phase.name, formatSdkError(error))`, where `recordProgress` persists only `phaseEnded(name, "failed")`.

Three places therefore see only a string: the gate, the attempt warning, and `metadata.json`. Everything else (`session.next.step.failed`, `tool.failed`, `retried`) is activity text and is out of scope.

## Goals / Non-Goals

**Goals**

- Preserve the harness classification from the event to the attempt error, the gate text, the attempt warning, and the persisted phase record.
- Keep every existing string identical when the harness supplies no status.
- Fix the event-delivered abort so it becomes the existing `SessionAbortedError`.
- One type for the classification, defined where both `runner.ts` and `metadata.ts` can import it without a new dependency direction.

**Non-Goals**

- Any automatic decision from the classification (retry, model fallback, exit codes) — see the capability's last requirement.
- Typing `session.next.*` payloads (they are not in the SDK's `Event` union at 1.18.4).
- Dashboard layout changes: the TUI keeps rendering `detail` strings.
- Control-channel changes: `ControlProgress.phaseFailed` renders nothing and stays a no-op.

## Decisions

### D1: One `SessionErrorSignal` type, owned by `src/progress.ts`

```ts
export type SessionErrorSignal = {
  name: string
  message: string
  statusCode?: number
  isRetryable?: boolean
  providerID?: string
}
```

It lives next to the other progress payload types because `ProgressUI.phaseFailed` carries it and `metadata.ts` persists it; `runner.ts` already imports from `progress.ts`, `metadata.ts` must not import from `runner.ts`. `PhaseMetadata.error` reuses the type verbatim — no parallel `PhaseFailure` shape to keep in sync.

`sessionErrorFromEvent(value: unknown): SessionErrorSignal` in `runner.ts` extracts `name` (falling back to `type`, then `"UnknownError"`), `message` with today's precedence (`message` → `data.message` → name), and the optional fields only when they are of the expected primitive type. `formatEventError(value)` becomes `sessionErrorFromEvent(value).message`, so the three activity-text call sites keep their output byte for byte.

### D2: `SessionError` preserves the classification across the attempt boundary

`SessionSignal`'s error variant becomes `{ type: "error"; error: SessionErrorSignal }`. `watchSession` stores the signal (`lastSessionError: SessionErrorSignal | undefined`), keeps the `session error: <message>` activity line, and finishes with `new SessionError(signal)` at both idle sites; the "went idle / never started" fallbacks stay plain `Error`s because nothing was classified.

```ts
export class SessionError extends Error {
  constructor(readonly signal: SessionErrorSignal) {
    super(signal.message)
    this.name = "SessionError"
  }
}
```

`name` is pinned to `"SessionError"` and the SDK name lives only in `signal.name`; `isMessageAbortedError` inspects `signal.name` for a `SessionError` and falls back to the raw `name` for an event payload, so the event-delivered abort still turns into `SessionAbortedError`. Pinning `name` matters because the runner recognises its own sentinels by `name` (`isUserAbortError` matches `"UserAbortError"`): a provider that echoed such a name in a session error would otherwise impersonate an operator abort. The classification is not duplicated as fields on the error; `signal` is the single source of truth. `SessionError` deliberately does not extend `LoggedAttemptError`: the attempt boundary (`attemptFailureFor`) wraps it in `LoggedAttemptError` with `cause`, which keeps `writeAttemptLog` and every `instanceof LoggedAttemptError` decision exactly as they are. That wrapper only classifies OpenCode payloads (objects carrying a `name`); a Claude Code failure arrives as a plain string and stays an unclassified attempt failure.

Alternative considered: `name = signal.name` so `isMessageAbortedError` needed no change. Rejected because it lets remote data choose which runner sentinel the error matches.

Alternative considered: attach the signal as `cause` on a plain `Error`. Rejected because every consumer would have to unwrap `cause` to read a status.

### D3: The classification is disclosed by `formatSdkError`

`formatSdkError` gains one branch before the generic `instanceof Error` case:

```ts
if (error instanceof SessionError) return describeSessionError(error)
```

`describeSessionError` returns `message` alone when `statusCode` is undefined, otherwise `` `${message} (HTTP ${statusCode}, ${isRetryable ? "retryable" : "not retryable"})` ``. Because the attempt boundary builds the `LoggedAttemptError` message with `formatSdkError(result.error)`, the gate text (`gateError`), the `attempt N failed:` warning, and the phase `catch` all inherit the classified text through the wrapper's `message` without touching those call sites. The gate label and the `waitingFailure` status string are untouched.

### D4: Persisting through an optional `failure` on `phaseFailed`

`ProgressUI.phaseFailed(name: string, detail?: string, failure?: SessionErrorSignal)`. The parameter is additive: `noopProgress`, the TUI, `ControlProgress`, `trackRunStatus`, and hook/human callers compile unchanged. Only `recordProgress` reads it and calls `store.phaseEnded(name, "failed", failure)`; `MetadataStore.phaseEnded(name, status, failure?)` sets `entry.error = failure` when `status === "failed"` and `failure` is present, and never writes the key otherwise. `PhaseMetadata` gains `error?: SessionErrorSignal`.

The phase `catch` computes the failure with `sessionErrorOf(error)`, which walks the `cause` chain (bounded) for a `SessionError` and stops at a `SessionAbortedError`. Two wrappers sit between the phase `catch` and the signal: the attempt boundary wraps the `SessionError` in a `LoggedAttemptError`, and an abort taken at the failure gate throws `UserAbortError` with that attempt error as `cause` — the gate only decides the failed attempt, it does not change why the phase failed, so the classification survives the operator's decision. A cancelled message (`SessionAbortedError`), hook failures, and deliverable-validation errors never carry a classification — matching the spec's "any other reason" scenario.

Alternative considered: persist from `watchSession` directly through a store handle. Rejected: `watchSession` only sees `ProgressUI`, and the metadata store is deliberately reached through the `recordProgress` decorator.

## Risks / Trade-offs

- `test/reproduction.test.ts` asserts the source text `async phaseFailed(name, detail)` in `metadata.ts`; the assertion moves to the three-argument form. This is a test of a past regression, not behavior; the regression it guards (awaiting the store before forwarding) is preserved.
- Event-delivered aborts change category from `LoggedAttemptError` to `SessionAbortedError`. This is the intended fix; any caller that distinguished the two only did so for prompt-returned aborts and now sees consistent behavior. Called out explicitly in the change description.
- `metadata.json` readers that iterate phase keys see a new optional `error` object on failed phases. `runs`, `SUMMARY.md`, and the browser read named fields and ignore unknown ones.

## Migration

None. No configuration, CLI, or protocol change; existing `metadata.json` files remain valid (the field is optional).
