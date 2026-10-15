# Design

## Context

Today there are two integration paths (see `runner-parity-opencode-v2` design for the pieces):

```
engine (src/runner.ts) ──▶ OpenCode via src/opencode-client.ts   (rich: advisor, reports, loop guard, approvals, events)
runner port (src/runners/contracts.ts) ──▶ Claude adapter        (thin: prompt + stream + enforcement)
```

The port is thin (`executeAttempt(request, sink)`), so the rich features live in the engine and are OpenCode-shaped. That is why OpenCode was never moved onto the port and why a third harness would have to duplicate the engine.

## Goals / Non-Goals

**Goals:**

- One integration path: core starts attempts only through the port; harness specifics live in adapters.
- Feature parity expressed by capability: any harness can opt into progress, approvals, deliverables, advisor, and loop signals.
- Preserve every existing behaviour and the owned-process lifecycle.

**Non-Goals:**

- No new user-facing workflow, pipeline syntax, or model routing.
- No change to who owns processes/servers (the adapter still does).
- No requirement that every runner implements every service.

## Decisions

### D1. The port carries optional services

`ExecutionServices`, passed alongside `ExecutionRequest`:

```
type ExecutionServices = {
  progress?: ProgressSink            // session/text/reasoning/tool/usage already emitted; add terminal/usage callbacks
  approvals?: ApprovalChannel        // ask-level decisions for this attempt
  deliverables?: DeliverableContract // report/score/commit-description contract
  advisor?: AdvisorConsult           // on-demand + checkpoint consultation
  loopGuard?: LoopGuardSink          // repeated-call / cost / step observations
}
adapter.executeAttempt(request, sink, services?)
```

A runner implements the subset it can. Core passes only the services the runner advertises. Rejected alternative: keep the engine as the only rich path — rejected because it cannot express a third harness.

### D2. Capabilities are authoritative

`resolveRunnerCapabilities(runner, {version, auth, enforcementReady})` decides which services a runner may receive, and preflight refuses a plan that needs an unimplemented service (naming runner + service). This replaces the current OpenCode-shaped assumptions that a step "has" an advisor because the engine provides one.

### D3. The engine delegates; the adapter owns harness specifics

`runner.ts` keeps scheduling, budgets, git boundaries, writer claims, retries, and finalization. The adapter owns protocol, session lifecycle, event decoding, permission interception, process ownership, and translating services into harness calls. Rejected alternative: move scheduling into adapters — rejected; scheduling is Convoy policy.

### D4. Incremental migration, suite as gate

Order: (1) add the service-carrying port + capability validation with no behaviour change; (2) move OpenCode's report/advisor/loop-guard/approval integration behind its adapter, keeping the engine calling it; (3) point the engine's dispatch at the port for OpenCode; (4) fold Claude onto the same services. Each step must keep the full suite green.

### D5. Ownership stays with the adapter

The port does not take over process/server ownership. OpenCode keeps its owned v2 server and the existing lifecycle guarantees; Claude keeps its owned child and bounded stop.

## Risks / Trade-offs

- **[Large, engine-touching refactor]** → Incremental steps, one runner at a time, full suite as the gate; no step lands red.
- **[Service adapters diverge in meaning]** → One normalized service contract; adapters that cannot honour a service are refused by capability, never silently degraded.
- **[Performance: extra indirection]** → Services are optional and in-process; measure the streaming path before/after.
- **[Two implementations during migration]** → Explicit ordering so the old path is retired as each runner migrates; track it in the change.

## Migration Plan

1. Introduce `ExecutionServices` + capability validation; no behaviour change.
2. Move OpenCode's report/advisor/loop-guard/approval integration behind `runners/opencode/**`, still driven by the engine.
3. Point the engine dispatch at the port for OpenCode; retire the duplicated path.
4. Fold the Claude adapter onto the shared services (advisor/reports where implemented).
5. Remove the now-dead engine-side integration and update docs.

Rollback: each step is independently revertible; the suite is the gate.

## Open Questions

- Which service(s) a third harness realistically needs first (to prioritise) — answer during step 1.
- Whether progress should stay a callback or become the durable journal subscription throughout; decide in step 2.
