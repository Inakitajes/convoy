# Proposal

## Why

Convoy now runs OpenCode through its in-process engine (`runner.ts` + `src/opencode-client.ts`) and Claude through the neutral adapter (`src/runners/claude/adapter.ts`). Two different integration paths mean richer Convoy features (advisor, structured reports, loop guard, approvals, progress) are OpenCode-shaped and unavailable to any other runner without duplicating the engine. A third harness (e.g. Pi) would today have to reimplement them.

This change unifies the integration on one runner port that can carry Convoy's optional services, so every harness — including OpenCode — is an adapter and feature parity is expressed by capability rather than by which code path a runner happens to use.

## What Changes

- Extend the runner port so an attempt can be given Convoy's optional services (progress UI, approval channel, deliverable/report contract, advisor consultation, loop-guard signals) instead of only prompting and streaming.
- Move OpenCode's feature integration (advisor, reports, loop guard, approvals, progress, event decode) behind its adapter, so the engine drives runners only through the port.
- Keep the owned OpenCode v2 server and the existing lifecycle/ownership guarantees; the port does not change who owns processes.
- Capabilities become authoritative: a runner advertises which optional services it implements, and Convoy validates a plan against them before execution.
- Behaviour for existing OpenCode and Claude pipelines is preserved; the change is about where the integration lives, not about new user-visible workflow.

## Capabilities

### New Capabilities

- `runner-integration`: one runner port that carries Convoy's optional services, with capability-declared support and the engine driving all runners through it.

### Modified Capabilities

<!-- None: existing runner behaviour is preserved; this change relocates integration. -->

## Impact

- `src/runners/contracts.ts` (port shape), `src/runners/compose.ts` (composition), `src/runners/opencode/**` (bridges), `src/runners/claude/**` (service adoption), `src/runner.ts` (engine delegates to the port), and the advisor/report/loop-guard/permission runtimes that move behind the adapter.
- No dependency changes; no user-facing workflow change; the existing test suite is the regression gate at each step.
