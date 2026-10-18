# Tasks

Planning revision: the six checked entries below record previously completed groundwork, not completion of the expanded contract. No implementation tests were rerun by this planning edit. The `promptPhase` relocation is historical progress only: its engine import cycle must still be removed. The former close-out entries are reopened because final integration, documentation and architecture evidence must follow the actual dispatch migration.

Implement pending work in group order. Each slice must keep `bun run typecheck`, `bun test` and `bun run build` green; the tests/docs named in a task land with that task rather than waiting for close-out.

## 1. Complete the rich common contract and its conformance tests

- [x] 1.1 Add the initial approval, deliverable, advisor and loop-guard service types and optional third parameter to `ExecutionAdapter.executeAttempt`; baseline verification: typecheck and existing adapters/tests compile unchanged.
- [x] 1.2 Add initial capability/service validation helpers in `src/runners/capabilities.ts`; baseline verification: unit tests accept supported services and identify runner plus missing service on refusal.
- [x] 1.3 Add initial service-passing conformance coverage; baseline verification: a test adapter accepts no services or receives a supplied supported service.
- [x] 1.4 Model the required Convoy execution context and collision-free run/phase/attempt identity without passing workspace/UI/shutdown objects or SDK clients; verify type fixtures and parallel-phase tests with identical local attempt numbers.
- [x] 1.5 Complete typed service contracts for report/score/commit metadata, advisor checkpoints/limits, cancellable approvals and actionable loop decisions; verify fake-adapter conformance tests for validation rejection, protected-write blocking, nudge/stop and required-service refusal rather than callback invocation alone.
- [x] 1.6 Complete normalized event/outcome accounting, common cancellation/runtime-release outcomes and capability-gated session facets; verify type/conformance fixtures for cumulative usage, executor/advisor attribution, exact session references, unsupported controls and unresolved cleanup outcomes.
- [x] 1.7 Make adapter declarations plus runtime/auth/enforcement evidence authoritative, remove conflicting brand-based capability tables, and document the rich contract and support/requirement distinction in `docs/runners.md`; verify capability tests cover restricted bridges, native versus bridged semantics and no silent removal of required services.

## 2. Bring rich OpenCode behavior through the common adapter

- [x] 2.1 Finish the real extraction of OpenCode phase/watch/checkpoint helpers, move reusable policy into shared vendor-independent service modules, and remove production adapter imports of `runner.ts`; verify an adapter-to-engine dependency test, existing helper suites and documented ownership boundaries.
- [x] 2.2 Connect the OpenCode report bridge to the common deliverable service, reusing existing validation, candidate precedence and recovery metadata; verify adapter fixtures for reports, scores, structured commit descriptions, invalid resubmission and stale-session rejection, and document the supported submission semantics.
- [x] 2.3 Connect on-demand advisor/feedback, first-write enforcement and completion correction to shared advisor services; verify adapter fixtures for blocked unconsulted writes, bounded consultation, same-session follow-up and separately attributed usage, and document checkpoint timing.
- [x] 2.4 Feed correlated tool arguments/results, model steps and stable usage/cost observations into the shared loop guard and apply continue/nudge/stop decisions; verify adapter fixtures for repeated calls, same-tool failures, soft nudges, hard stops, follow-up deduplication and step-only budget reset, and document guard semantics.
- [x] 2.5 Route OpenCode permission interception through hard policy/checkpoint checks and cancellable interactive/auto/smart decisions; verify deny precedence, ask settlement, cancellation and parallel-attempt isolation fixtures, and document how native requests map to Convoy policy.
- [x] 2.6 Implement the common session facets with the existing OpenCode history/reopen/continuation/control mechanisms; verify exact-session resume, live/backfill merge without duplication, honest unavailable history and capability distinctions, and document supported session controls.
- [x] 2.7 Expose OpenCode runtime release and session-bound service-handle lifetime through the common lifecycle; verify startup abort, bounded repeated stop, preserved human-iteration handles, phase-decision release and independent-service protection with adapter/lifecycle fixtures, and document release ownership.

## 3. Reconcile Claude's groundwork before switching engine dispatch

- [x] 3.1 Add the initial Claude assistant-text deliverable callback for permitted report contracts; baseline verification: adapter tests cover accepted submission and validation rejection. This is not full structured-deliverable parity or engine wiring.
- [x] 3.2 Declare Claude advisor consultation restricted until a bridge can honor its required semantics; baseline verification: capability tests refuse the unsupported advisor service with a reason.
- [x] 3.3 Verify the baseline Claude adapter, invocation, enforcement and lifecycle suites before the rich-contract revision; revalidation against completed composition remains below.
- [x] 3.4 Adapt Claude's supported delivery/approval services to the completed contract, preserving hook/MCP enforcement and contract-specific fallback rules; verify composed-adapter/process fixtures for accepted/rejected/missing required deliverables, deny precedence and fail-closed write/verify behavior, and document supported versus restricted contracts.
- [x] 3.5 Reconcile Claude observations and session/lifecycle facets with effective capabilities: claim loop/checkpoint/live-control support only when the completed guarantees are met, otherwise refuse requirements explicitly; verify shared semantic conformance fixtures and document the resulting capability matrix.
- [x] 3.6 Re-run Claude's adapter, invocation, enforcement and lifecycle suites through registered composition before the engine switch, with fixture-based read-only/write/verify, cancellation and post-exit resume flows; verify the completed common adapter contract without paid live invocations.

## 4. Make the engine use only the registered common integration

- [x] 4.1 Construct run-lifetime composition and replace the special OpenCode/Claude attempt dispatch with common request/service preparation, capability validation and normalized result handling; verify engine fixtures for both runners, required-service refusal before prompt admission and attempt-log compatibility.
- [x] 4.2 Route phase-gate session opening, continuation/control and late transcript reconstruction through registered session facets rather than harness conditionals; verify gate, exact-session resume and transcript suites preserve human decisions, permission isolation and missing-history behavior.
- [x] 4.3 Wire run shutdown and phase/session handle release through common cancellation/lifecycle operations; verify engine-level startup cancellation, parallel abort, terminal-hold cleanup, retry/late-submission isolation and bounded observed or unresolved cleanup outcomes.
- [x] 4.4 Remove superseded `phaseAttemptRunners` implementations, native engine client/result/attachment handling and reverse helper dependencies once their common replacements pass; verify regression and dependency tests reject SDK leakage, adapter-to-engine imports and OpenCode- or Claude-specific engine execution/session paths.
- [x] 4.5 Run a minimal registered test harness through the same engine path, without a new dispatch branch or production harness integration, and update `docs/development.md` with the registration/conformance workflow; verify engine fixtures require only the test adapter and normal registration/declaration metadata.

## 5. Final integration evidence and close-out

- [x] 5.1 Reconcile `docs/runners.md` and `docs/development.md` with the final implementation, removing any premature claim that file relocation completed unification; verify examples parse and every advertised capability maps to a tested common-contract guarantee.
- [x] 5.2 Run final `bun run typecheck`, `bun test` and `bun run build` after the dispatch migration and record exact commands/results; verify all pass with skipped tests identified rather than counted as covered behavior.
- [x] 5.3 Audit the final integration graph and common-engine test harness evidence; verify dependency/conformance tests exclude SDK leakage, adapter-to-engine cycles, privileged OpenCode execution/session paths and capability declarations disconnected from implementation.
- [x] 5.4 Record bounded live acceptance coverage separately from fixture coverage, using `nan/deepseek-v4-flash` for authorized free OpenCode checks and no new Claude/paid live calls without explicit permission; verify results distinguish passed cells from missing credentials/authorization/tool endpoints and do not claim protocol-only checks prove tool/service parity.

## 6. Residual hardening (not required by the shipped behaviour)

These are the two documented transitional seams, tracked so they are not lost. The engine is correct without them; they narrow the migration further.

- [x] 6.1 Cache the run-lifetime composition for the whole run instead of rebuilding it inside `runPhaseAttempt` for each attempt; verify the engine constructs one composition per run and reuses it across phases.
- [x] 6.2 Re-express the OpenCode rich attempt on the neutral request, event sink and services alone, so the engine no longer supplies its own report/advisor runtimes, shutdown handle or progress target in the attempt context; verify the attempt context carries no engine-owned policy object and the full suite stays green.
