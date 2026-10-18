# Runner-dependent operation inventory (task 1.1)

Maps every operation that today depends on a specific harness, to the design's
decision that owns it and the delta spec scenario that constrains it. The goal is
to prove nothing is silently dropped when OpenCode stops being the implicit
backend.

Legend: **OC** = OpenCode-coupled today · **CL** = Claude adapter (partial today)
· **core** = should be harness-neutral.

## Execution and orchestration

| Operation | Where today | Target owner | Design | Spec scenario |
|---|---|---|---|---|
| Attempt execution dispatch | `runner.ts` `phaseAttemptRunners` / `executeOpenCodePhaseAttempt` / `executeClaudeCodePhaseAttempt` | core scheduler + adapter `executeAttempt` | D1, D5 | `runner-execution` "Both runners execute the full pipeline step set", "Parallel scheduling is independent of the harness" |
| Session create / prompt admission / continuation | `runner.ts` `promptPhase`, `client.session.*`, `client.v2.session.prompt` | adapter | D1, D2 | `runner-execution` "Attempts preserve exact provenance and recovery identity" |
| Prompt completion reconciliation | `runner.ts` idle/`wait` handling | adapter | D2 | `runner-execution` (recovery identity); `runner-deliverables` "Delivery validation controls phase completion" |
| Cancellation / interrupt / bounded stop | `runner.ts` shutdown, `process-stop.ts` | core policy + adapter mechanism | D11 | `runner-execution` "Execution resources have bounded attributable ownership" |
| Goal fragments / rounds | `runner.ts`, `goal-scheduler.ts` | core | D5 | `runner-execution` "Models and helpers resolve before execution" |
| Model fan-out / parallel review | `runner.ts`, `pipeline.ts` | core scheduler | D5 | `runner-execution` "Parallel scheduling is independent of the harness" |

## Control plane and observation

| Operation | Where today | Target owner | Design | Spec scenario |
|---|---|---|---|---|
| Live phase transcript | `event-hub.ts`, `attach-runtime.ts`, `control-progress.ts` (message no-op) | core journal + adapter events | D6 | `session-transcripts` "The session tab streams a watched phase live" (incl. "Claude messages traverse the coordinator") |
| Late attach / history backfill | `attach.ts`, `attach-runtime.ts` (OpenCode server URL required) | core journal + adapter history | D6 | `session-transcripts` "Sessions not watched from the start are reconstructed from available history" |
| Permission requests / replies | `permissions.ts`, `event-hub.ts` | core policy + adapter interception | D7 | `runner-permissions` all |
| Usage / cost accounting | `usage.ts`, `runner.ts`, `limits.ts` | core semantics + adapter measurement | D9 | `runner-authentication` "Usage reporting distinguishes estimates from billing" |
| Loop guard | `loop-guard.ts` (consumes OpenCode events) | core policy | D9 | `runner-permissions`; `runner-execution` |
| Terminal windows (attach/iterate/stored) | `opencode.ts` `open*Window`, `terminal-host.ts` | adapter conversation port | D10 | `work-conversations` (unchanged); `specs-viewer` "Iterate … selected-harness session" |

## Helpers (must not require OpenCode)

| Operation | Where today | Target owner | Design | Spec scenario |
|---|---|---|---|---|
| Commit-message inference | `commit-message.ts` (`startOpencode`) | helper port | D5 | `runner-execution` "Naming and commit helpers without OpenCode" |
| Branch-name inference | `worktree.ts` (`startOpencode`) | helper port | D5 | same |
| Safety judge (smart approvals) | `safety-judge.ts` (`OpencodeClient`) | helper port + core policy | D5, D7 | `run-launcher-permissions` "Claude-only smart approval", "Explicit judge is unavailable" |
| Model catalog / preflight validation | `model-catalog.ts`, `preflight.ts`, `preflight-validation.ts` | adapter discovery | D4, D5 | `runner-execution` "Models and helpers resolve before execution", "A selected runner is independently usable" |
| Run titles | `run-title.ts` | core (already deterministic) | D5 | `run-title` spec (unchanged); `runner-execution` same-scenario clause |
| Structured reports (`write_report`) | `report-bridge.ts`, `report-runtime.ts`, `report.ts` | core validation + runner bridge | D8 | `runner-deliverables` all |
| Advisor consultation | `advisor.ts`, `advisor-bridge.ts`, `advisor-runtime.ts` | core policy + runner bridge | D8 | `runner-advisors` all |

## Authoring, conversations, lifecycle

| Operation | Where today | Target owner | Design | Spec scenario |
|---|---|---|---|---|
| Authoring / proposal fallback | `propose-service.ts`, `conversations.ts` (`harness: "opencode"`), `conversation-service.ts` | conversation port | D10 | `work-conversations` (unchanged); `specs-viewer` iterate |
| Human gates / human iteration | `human.ts`, `runner.ts` | core + conversation port | D10 | `work-conversations`; `step-commit-messages` "Human iteration is linked" |
| Managed server lifecycle | `opencode.ts`, `managed-server.ts`, `process-records.ts`, `process-stop.ts`, `process-identity.ts` | adapter runtime (OC) + shared utilities | D2, D11 | `opencode-server-lifecycle` (preserved); `runner-execution` "Execution resources …" |
| Run metadata (server block, session ids) | `metadata.ts` (`server`, `sessionID`) | core provenance record | D11 | `runner-execution` "Attempts preserve exact provenance …" |
| Run history / resume | `runs.ts`, `runs-tui.ts`, `metadata.ts` | core | D11 | `runner-execution` recovery scenarios |

## Configuration, agents, permissions rendering

| Operation | Where today | Target owner | Design | Spec scenario |
|---|---|---|---|---|
| Harness config rendering | `agents.ts` (`opencodeConfig`, `Config`) | adapter translation | D1, D2 | `runner-execution` "Models and helpers resolve before execution" |
| Permission policy config | `agents.ts`, `bash-policy.ts`, `config.ts` | core policy + adapter mapping | D7 | `runner-permissions` all |
| Config editor / validation | `config.ts`, `config-tui.ts`, `run-plan.ts` | core + adapter capability surface | D4, D5 | `runner-execution` "Effective capabilities are truthful and actionable" |
| `.opencode` plugin install | `opencode-install.ts`, `report-bridge.ts`, `workspace.ts` (`OPENCODE_CONFIG_DIR`) | adapter (OC) | D2 | `runner-execution` (independence) |

## Claude adapter surface today (partial)

`claude-code.ts`: fixed read-only tool set (`Read,Glob,Grep`, `--safe-mode`,
`dontAsk`), stream-json parsing, `claude --resume` post-exit only, `proc.kill()`
without shared bounded stop. All of this is expanded by tasks in groups 3, 5, 6,
7, 11; the inventory shows it is currently reached only for `runner: claude-code`
agent steps while the run still prepares OpenCode services.

## Notes

- 53 source files reference OpenCode symbols; the table's `core` rows are the
  files that must stop importing vendor types (design D1).
- Deterministic operations (`run-title.ts`) must stay model-free.
- `pipeline.ts` / `config.ts` / `config-tui.ts` enforce current capability
  restrictions that group 8 replaces with effective-capability validation.
