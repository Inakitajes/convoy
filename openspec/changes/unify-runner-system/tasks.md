# Tasks

## 1. Port carries optional services (no behaviour change)

- [ ] 1.1 Add `ExecutionServices` (progress, approvals, deliverables, advisor, loopGuard) to `src/runners/contracts.ts` and an optional third parameter to `ExecutionAdapter.executeAttempt`; verify typecheck and that existing adapters/tests compile unchanged.
- [ ] 1.2 Add capability validation that refuses a plan requiring an unimplemented service, naming runner+service, in `src/runners/capabilities.ts`; verify unit tests for accept/refuse cases.
- [ ] 1.3 Add a conformance test that a runner implementing no services runs with none, and one implementing a service receives it; verify the shared conformance suite passes.

## 2. Move OpenCode integration behind its adapter

- [ ] 2.1 Implement the deliverables service in `src/runners/opencode/**` (reusing the existing report runtime/bridge) and verify report/score/commit flows through the adapter in a fixture test.
- [ ] 2.2 Implement the advisor service in the OpenCode adapter (on-demand + first-write checkpoint) and verify the checkpoint blocks an unconsulted write.
- [ ] 2.3 Implement the loop-guard sink in the OpenCode adapter and verify repeated-call and cost observations reach the guard.
- [ ] 2.4 Route approvals through the adapter's existing permission interception and verify ask-level decisions settle per policy.
- [ ] 2.5 Keep the engine driving it: wire `runner.ts` to pass services to the OpenCode adapter while its dispatch still comes from the engine; verify the full suite stays green.

## 3. Point the engine at the port for OpenCode

- [ ] 3.1 Replace the OpenCode attempt path in `runner.ts` with the registered adapter through `composeRunners`; verify reports/advisor/loop-guard/approvals/live transcripts/resume still pass their suites.
- [ ] 3.2 Retire the duplicated engine-side OpenCode integration and verify no dead code remains and the suite is green.
- [ ] 3.3 Verify ownership/lifecycle: bounded stop, no orphan leak, cancellation during startup — existing lifecycle suites pass unchanged.

## 4. Fold Claude onto the shared services

- [ ] 4.1 Implement the deliverables service for Claude where the contract permits and verify report validation parity.
- [ ] 4.2 Implement the advisor service for Claude (own bridge, not a native flag) or refuse it by capability with a clear reason; verify behaviour.
- [ ] 4.3 Verify Claude still passes its adapter, invocation, enforcement, and lifecycle suites.

## 5. Close out

- [ ] 5.1 Update `docs/runners.md`/`docs/development.md` to describe the single port and service capabilities; verify examples parse.
- [ ] 5.2 Run `bun run typecheck`, `bun test`, and `bun run build`; verify all green and the acceptance script still completes a bounded mixed run.
- [ ] 5.3 Audit that no harness-specific branch remains in core and that vendor types stay behind adapter boundaries; verify the dependency-boundary test passes.
