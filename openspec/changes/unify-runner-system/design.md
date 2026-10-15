# Design

## Context

See `proposal.md` for motivation and `specs/runner-integration/spec.md` for the required guarantees. The implementation is partway through migration:

```
runner.ts ── harness-specific attempt dispatch
             ├─ OpenCode: opencode/phase.ts ── helpers/runtimes in runner.ts
             └─ Claude: ExecutionAdapter (services not yet wired by the engine)

composeRunners ── registry with both adapters (not yet the common engine path)
```

The initial `ExecutionServices` parameter, capability helpers and Claude service callbacks are useful groundwork. They do not yet carry all existing OpenCode semantics. In particular, a string-only advisor question, a deliverable kind/body and a void loop observation cannot by themselves describe checkpoint policy, structured report metadata or actionable budget decisions.

`promptPhase` was relocated to `src/runners/opencode/phase.ts`, but imports engine helpers from `../../runner`. The resulting cycle and the remaining engine-specific attempt paths are transitional debt, not an accepted final architecture. Existing green tests establish behavior preservation, not completion of the unification.

## Goals / Non-Goals

**Goals:**

- One rich, Convoy-owned integration system for every harness, including OpenCode.
- Express supported semantics with typed requests, services, events, outcomes and capability-gated session controls.
- Keep reusable Convoy policy separate from vendor translation, with no adapter dependency back into the engine.
- Preserve existing behavior, session/handle lifetime, accounting and process ownership while migrating incrementally.

**Non-Goals:**

- No new pipeline syntax, user-facing workflow, model-routing policy or external dependency.
- No requirement that all harnesses have identical capabilities; no forced emulation that weakens a guarantee.
- No new real third-harness integration. A test adapter demonstrates the common path's extensibility.
- No rewrite of the durable event journal, authoring navigation or existing process-ownership system.

## Decisions

### D1. Vendor-independent is not domain-free

The contract in `src/runners/contracts.ts` belongs to Convoy and can be rich in Convoy concepts. Its boundary excludes vendor clients, SDK messages, native callbacks and protocol objects, not workspace identity, phase context, deliverable rules or advisor policy.

One registration composes cohesive facets:

```
core orchestration ── common runner registration
                       ├─ execution: capabilities, executeAttempt, cancelAttempt
                       ├─ lifecycle: close owned runtime, normalized cleanup outcome
                       └─ optional session/conversation operations, capability-gated
                                  │
                       ┌──────────┼──────────┐
                       ▼          ▼          ▼
                    OpenCode    Claude    test harness
```

Execution and lifecycle are required; a runner with no persistent runtime can implement an honest no-op close. Optional facets do not create separate categories of runner. Built-in adapter construction and runner-specific configuration stay in composition, not execution-policy branches in `runner.ts`.

Rejected: a thin generic port beside a rich OpenCode-only contract; a lowest-common-denominator API; one giant interface requiring unsupported methods; or disguising a vendor SDK behind `unknown`/an untyped options bag.

### D2. Context crosses as data; policy crosses as services

Keep `executeAttempt(request, sink, services?)` as the common execution shape, enriching its typed vocabulary where needed. Requests contain the necessary run, phase and attempt identity, verified checkout, agent instructions, model/auth/mode selection, attachments and cancellation. Do not pass an entire mutable workspace, the UI, `RunShutdown` or a native client just to reuse old signatures.

| Existing dependency | Common representation | Implementation ownership |
| --- | --- | --- |
| Workspace/phase | Required execution identity, verified paths and typed contract/configuration data | Core prepares; adapter consumes |
| Progress UI | One normalized event sink for live text, reasoning, tools, usage, session and terminal state | Core maps events to UI and records |
| Report runtime | Deliverable contract plus validated submission, accepted candidate and handle lifecycle | Shared Convoy service; native transport in adapter |
| Advisor runtime | Consultation/checkpoint service, policy and attributed results | Shared policy/budget logic; native enforcement/bridge in adapter |
| Loop guard | Correlated observations and explicit control decisions | Shared guard state; adapter supplies evidence and applies decisions |
| Permissions | Normalized protected action and cancellable ask-level decision | Shared policy; native interception/reply in adapter |
| SDK/session client | No common-contract field | Adapter only |

The existing event sink is the progress interface; do not introduce a second UI callback channel or redesign journal subscriptions in this change. Preserve existing event ordering, transcript identity/deduplication and attempt-log consumers. Common outcomes include the normalized reason and metadata needed for gates, executor/advisor accounting and error handling; the engine must not inspect SDK-shaped errors or finish records.

Attempt identity must distinguish run, phase and attempt, including parallel phases whose local attempt numbers match. Session references remain runner-qualified and opaque. Service closures and pending decisions are scoped to that identity, not only a numeric attempt or a global current session.

### D3. Preserve rich service semantics, not only method names

**Deliverables:** carry the expected report/score contract, rubric data where relevant, and structured commit-description metadata. Reuse existing validation, accepted-candidate precedence, correction feedback, persistence/recovery and stale-handle protection. A plain assistant-text submission is sufficient only for contracts that actually permit it, not a replacement for the structured OpenCode report protocol.

**Advisor:** support on-demand consultation, feedback, configured first-write gating and completion checkpoints. Preserve call/output/time/recursion limits, correction turns and separate advisor usage/events. A first-write checkpoint must be enforced before the action, not approximated by a completion consultation.

**Approvals:** normalize action/tool/resource and request identity, apply non-overridable deny policy and advisor prerequisites, then use the selected interactive/auto/smart decision service for ask-level requests. Pending requests are cancellable and session-scoped; interactive takeover must not pause a sibling's permissions.

**Loop/budget control:** replace the name/detail-only observation shape with typed tool-call identity and effective arguments, success/failure results, model steps and usage/cost updates with stable identity and cumulative/delta semantics. The service returns a discriminated continue, nudge or stop decision with a normalized reason. The adapter applies it through the native prompt/interrupt mechanism; a stop cannot become a successful completion or be swallowed by a watcher catch.

The core retains the existing human budget gate and reset policy. Reuse the guard across continuation/checkpoint turns and step-budget resets: resetting renewable steps must not erase cost or non-renewable guard history. Reuse/extract existing domain implementations rather than building a second independent policy for each harness.

### D4. Effective capabilities have one authoritative meaning

Adapter declarations and resolved runtime/auth/enforcement evidence determine effective capabilities. Common validation consumes those declarations rather than maintaining a second brand-based table that can disagree with the running adapter. Describe available, restricted and unavailable states, reasons and native/bridged semantics.

Separate runner support from the plan's requirements. Check required behavior before starting its attempt; supply only supported optional services after that validation. Filtering services is not permission to drop a required feature. When readiness requires boot-time checks, verify the required plugin/hook/bridge before admitting a prompt and fail closed on health failure.

Do not advertise a service just because the legacy engine implements it or an adapter exposes an unused callback. Conversely, migration must not remove an existing OpenCode feature merely to fit the initial thin contract. Claude advisor support may remain explicitly restricted until it can honor the required checkpoint semantics; this does not create a second runner type.

Rejected: blanket support inferred from a runner name, silent fallback, and claiming live control from post-exit resume or complete loop protection from tool-name-only observations.

### D5. The engine owns orchestration; adapters own translation

`runner.ts` keeps scheduling, budgets/gate decisions, git boundaries, writer claims, retries, report acceptance orchestration and finalization. Shared Convoy service modules own reusable validation and policy state. An adapter owns native protocol, sessions, plugin/hook/MCP exposure, event decoding, permission interception and process handles.

Construct the common composition once for the appropriate run lifetime. Every attempt resolves the registered execution facet and is given the same request/event/service shape. Shutdown uses registered cancellation/lifecycle operations, not an engine-side native-client field. Per-run adapter configuration is assembled at composition; adding another harness may add registration/declaration metadata, not a new engine execution function or brand branch.

Remove `phaseAttemptRunners`' parallel implementations after the common path has parity. Move OpenCode-only helpers out of `runner.ts`; extract genuinely shared helpers to vendor-independent modules. Production adapters must not import `runner.ts` or receive its private functions as a callback bundle. Compatibility re-exports for existing tests are acceptable only if they do not recreate a production reverse dependency.

### D6. Session controls and ownership are part of the same system

Expose the existing supported history/backfill, reopen, continuation and control transitions through common, capability-gated session facets. Preserve exact session and checkout validation, truthful native-attach versus post-exit-resume semantics, and normalized transcript merging. Phase gates invoke those operations without switching on the harness; their human-decision policy remains in core.

The lifecycle facet closes only its owned runtime, using existing bounded stop/escalation, ownership evidence and uncertain-outcome reporting. Startup cancellation cannot lose a spawned child; a submitted abort/signal is not observed termination. Existing independent authoring services and standalone clients remain protected.

An idle prompt is not the end of the phase's service lifetime. Bind report/advisor handles to the created session before they can receive native requests, retain them through supported human iteration and completion correction, and release them idempotently when the phase decision, retry or abort actually ends their authority. Close the run-owned runtime after its existing inspection/terminal-hold obligations, not merely when the first attempt returns.

This preserves, rather than replaces, the contracts in `opencode-server-lifecycle`, `session-transcripts`, `work-conversations`, `run-launcher-permissions` and `step-commit-messages`.

### D7. Incremental migration requires behavioral and architectural evidence

Land the common types and semantic conformance fixtures before switching engine dispatch. Bring the existing rich OpenCode behavior through that contract and reconcile Claude's already-added callbacks and session/lifecycle facets with it. Test both adapters through registered composition before replacing the engine dispatch, then wire their supported services and retire the old paths. Temporary dual paths are allowed only during migration.

Each implementation slice includes its own tests and relevant documentation. Regression gates are `bun run typecheck`, `bun test` and `bun run build`. Also require a registered test-harness engine fixture and boundary tests that reject adapter-to-engine imports, SDK leakage and reintroduced harness-specific engine execution/session paths. A source-file move or green legacy tests alone is insufficient.

Live acceptance is opt-in and bounded. Use `nan/deepseek-v4-flash` for authorized free OpenCode checks; its current lack of tool endpoints cannot prove report/advisor/tool parity. Do not run new Claude or other paid live checks without explicit authorization. Record missing credentials, authorization or model features as blocked/skipped coverage, never as a passing cell; deterministic fixtures still exercise the complete common path.

## Risks / Trade-offs

- **[Rich contract becomes an SDK clone or service locator]** → Use cohesive typed Convoy concepts and minimal data needed for each operation; keep vendor configuration at composition and SDK objects inside adapters.
- **[An advertised capability is weaker than its name]** → Conformance tests check timing, authority, control effects and native/bridged semantics, not callback invocation alone.
- **[Policy is duplicated or hidden behind engine callbacks]** → Extract shared services and enforce dependency direction; no production imports from adapters into `runner.ts`.
- **[Session/service lifetime changes corrupt reports or strand processes]** → Test parallel attempts, gate iteration, stale submissions, startup abort and repeated cleanup through the common path.
- **[Migration appears complete while a legacy route survives]** → Require common engine fixtures, a third test adapter and explicit removal/audit before close-out checkboxes can be marked.

## Migration Plan

1. Retain the completed initial service types/helper tests as groundwork. Complete rich request/service/event/outcome, session and lifecycle contracts, capability semantics and shared conformance tests.
2. Extract OpenCode integration and reusable policies without engine reverse dependencies. Implement and fixture-test every previously supported rich service plus session/lifecycle operations through the registered adapter.
3. Adapt Claude's baseline callbacks to the completed services and session/lifecycle facets. Retain truthful capability restrictions and verify enforcement/lifecycle through registered composition before changing engine dispatch.
4. Switch the engine, phase-gate and transcript integration for both runners to the common composition, supplying their supported services. Preserve handle lifetimes and shutdown behavior, prove a registered test harness uses the same path, then remove superseded execution branches only after parity fixtures pass.
5. Reconcile architecture documentation with the actual implementation, run final integration gates, record permitted live coverage and audit dependency direction and dispatch removal.

Rollback: commit independently verifiable slices and retain the old path only until its replacement passes parity fixtures. Revert a failed dispatch switch rather than keeping a permanent privileged route or weakening required behavior. The previously checked close-out tasks are reopened; no implementation verification is claimed by this planning revision.

## Completion Criteria

- OpenCode and Claude enter the same registered execution contract, with only supported services enabled and required services validated.
- Existing rich OpenCode guarantees survive; unsupported Claude features are explicitly restricted, not silently approximated.
- Core session/shutdown operations use the common facets; no native SDK types, adapter-to-engine cycle or harness-specific engine execution path remains.
- A minimal registered test harness runs through the unmodified common engine path, requiring only its adapter and normal registration/declaration metadata.
- Behavioral suites and architectural boundary/conformance checks both pass; final documentation and acceptance evidence distinguish implemented, restricted and unverified behavior.
