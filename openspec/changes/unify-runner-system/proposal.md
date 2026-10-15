# Proposal

## Why

Convoy still has separate engine integration paths for OpenCode and Claude, so rich features remain coupled to a harness instead of being reusable through the runner contract. This change establishes one rich, Convoy-owned harness contract for every runner, with differences expressed by effective capabilities rather than a privileged OpenCode path.

Vendor-neutral does not mean domain-free or a lowest common denominator: the contract can describe Convoy's execution context, sessions, approvals, deliverables, advisor checkpoints, loop limits, and observations without exposing a vendor SDK. Moving OpenCode code to an adapter directory alone does not complete that integration.

## What Changes

- Complete the common contract with typed execution context, normalized events/outcomes, cancellation and runtime release, plus capability-gated session operations and optional Convoy services. Organize these as cohesive interfaces within one integration system, not a thin generic runner beside a rich OpenCode-only runner.
- Preserve rich service semantics: reports, scores and structured commit descriptions; on-demand and checkpoint advisor consultation; policy-controlled approvals; and actionable loop/budget observations. Normalize progress events rather than passing UI implementations through the contract.
- Move OpenCode's protocol, session, plugin/bridge, permission and event integration behind its adapter. Keep reusable policy and validation in shared Convoy services; remove adapter dependencies back into the engine.
- Route both OpenCode and Claude through the registered common contract, including the existing session controls used by phase gates and transcript reconstruction. Preserve owned-process shutdown and independent conversation lifetimes.
- Make effective capabilities authoritative for the installed runtime, authentication and enforcement readiness. Refuse required unsupported behavior before execution; distinguish native and bridged semantics without silently weakening a guarantee.
- Preserve existing pipeline behavior. No new user-facing workflow or real third-harness implementation is required; a registered test harness must demonstrate extensibility without another engine execution path.

## Capabilities

### New Capabilities

- `runner-integration`: one rich, vendor-independent harness contract, with capability-declared support and the engine driving every runner through the same integration path.

### Modified Capabilities

<!-- None: existing permissions, transcripts, conversation, commit-message and server-lifecycle requirements are preserved, not replaced or weakened. -->

## Impact

- `src/runners/contracts.ts` (rich contract), capability resolution and registration/composition, both adapters, shared service implementations, and `src/runner.ts` (common orchestration instead of harness-specific dispatch).
- Advisor/report/loop-guard/permission bridges, phase gates, transcript/session consumers, shutdown composition, conformance tests and runner architecture documentation.
- No external dependency or pipeline syntax changes. The suite remains the regression gate, complemented by engine-path and dependency-direction tests: green behavior tests alone do not prove architectural completion.
