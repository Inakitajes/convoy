# Proposal

## Why

Convoy's runner boundary still exposes OpenCode clients, events, configuration, and helper services, while its Claude adapter is intentionally restricted to read-only execution. Migrating to the released OpenCode v2 API is an opportunity to establish genuine multi-harness orchestration and make OpenCode and Claude first-class runners without sacrificing Claude subscription access.

## What Changes

- Introduce Convoy-owned execution, event, session, policy, deliverable, and consultation contracts; keep scheduling, Git coordination, retries, quality loops, and budgets in Convoy.
- Migrate OpenCode to the released `@opencode/client` API and v2 tool/plugin contracts, initially retaining owned per-run servers and existing lifecycle guarantees. **BREAKING:** new OpenCode executions require a tested v2 CLI; v1 execution is not maintained. Historical records remain readable.
- Expand Claude beyond read-only: writable and verification steps, model fan-out, parallel/mixed pipelines, approvals, structured reports, advisors, budgets, recovery, and authoring workflows.
- Preserve authenticated Claude CLI subscription execution as mandatory. Add explicit optional API-key execution; capabilities are resolved by runner, installed version, authentication mode, and policy. Never silently switch authentication, runner, or billing mode.
- **BREAKING:** legacy Claude configurations relying on implicit API credentials must select API-key mode explicitly; ambiguous noninteractive launches fail with migration guidance rather than infer billing consent.
- Separate authentication from paid-usage policy: subscription usage credits and inherited paid features must be disclosed and explicitly authorized; unverifiable included-only guarantees fail closed without forcing an API key.
- Make production dashboards and historical transcripts consume runner-neutral durable events rather than requiring an OpenCode server. Distinguish live observation, native attach, safe handoff, and exact-session resume.
- Route optional inference helpers and permission judges explicitly; a Claude-only installation must not require OpenCode. Keep deterministic run titles deterministic.
- Establish a tested parity matrix. Missing implementations are not inherent harness limitations; advanced interaction exceptions require evidence and review.

## Capabilities

### New Capabilities

- `runner-execution`: Independent adapters, full pipeline execution, capability negotiation, model/helper routing, lifecycle ownership, and runner-qualified recovery.
- `runner-authentication`: Subscription-first Claude access, explicit API-key mode, secret isolation, cost disclosure, and stable authentication selection.
- `runner-permissions`: Harness-independent permission policy and enforcement of read-only, verification, writable, and interactive control boundaries.
- `runner-advisors`: Runner-independent consultations, mandatory checkpoints, cross-runner advisors, and attributed consultation budgets.
- `runner-deliverables`: Equal report, structured-score, and commit-description submission and correction for both runners.

### Modified Capabilities

- `session-transcripts`: Live and reconstructed transcripts for all runners, including durable offline history without invented content.
- `specs-viewer`: Explicitly support either harness for plan iteration while preserving target and writer safeguards.
- `step-commit-messages`: Cover human iterations through either supported harness in authoritative run provenance.
- `run-launcher-permissions`: Resolve smart judges through runner-aware configuration without changing permission-selector semantics.

## Impact

Affects runner orchestration, Claude execution, OpenCode client/config/plugin integration, helper inference, model discovery, permission/advisor/report bridges, process lifecycle, metadata, coordinator event transport, dashboards, CLI/config editor, and conversation/terminal entrypoints. Adds a released v2 client dependency and a Claude CLI bridge; an Agent SDK dependency is optional and confined to an explicitly supported API-key mode. Requires shared adapter conformance tests, authentication-mode tests, lifecycle fault tests, coordinated-dashboard tests, and opt-in real-harness acceptance evidence.

## Non-goals

- Implementing a Pi adapter, third-party adapter marketplace, or a new agent loop.
- A shared OpenCode service or embedded-host deployment in this first migration.
- Universal access to models outside a harness/account's entitlement, or identical token streams and pricing semantics.
- Replacing Convoy's worktree, Git, writer-coordination, publication, or OpenSpec ownership rules with harness equivalents.
- Rewriting user-global authentication/configuration or requiring API billing for ordinary Claude subscription execution.

## Also carried on this branch

Two changes outside this proposal's capabilities ride the same branch and are recorded here rather than left implicit:

- The `review` pipeline's second scorer moved from Grok 4.6 to Kimi K3 (`08a3d50`): Grok's context could not hold a large branch's review prompt.
- Herdr pane state is released reliably and force-released on shutdown (`0f3e3c9`).
