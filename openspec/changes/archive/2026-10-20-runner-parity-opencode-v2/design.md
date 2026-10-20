# Design

## Context

See `proposal.md` for motivation and scope. This design is conditional on a cross-cutting architecture and protocol migration, so the schema's condition for creating it applies.

The current seam is `StepRunnerImpl.executeAttempt`, but `PhaseAttemptInput` contains `OpencodeClient`; `claude-code.ts` and shared attachment preparation expose OpenCode `FilePartInput`. `runner.ts` unconditionally prepares OpenCode tools, starts its server, and creates OpenCode permission/advisor services. A Claude-only pipeline is not independent.

The existing Claude adapter spawns the user's CLI with a fixed read-only tool set and `--safe-mode`. Its stdout parser reports progress, but `control-progress.ts` drops phase messages and production dashboards use OpenCode-specific watching/backfill. Removing capability flags alone would neither deliver transcript parity nor safely enable writes.

OpenCode execution uses `@opencode-ai/sdk@1.18.4`'s `/v2` export, primarily its classic `client.session` routes, plus one `client.v2.session.prompt` use. That import suffix is not released OpenCode-v2 compatibility. The released integration is `@opencode/client`; plugins/tools and message/event contracts also change. Earlier exploration overclaimed mandatory configuration conversion: the official migration guide preserves supported V1 config and file definitions, normalizing them in memory. API and plugin integration still require migration.

Other coupling includes helper inference in `commit-message.ts` and `worktree.ts`, `safety-judge.ts`, model discovery, authoring/proposal services, raw session IDs in metadata, and OpenCode terminal commands. Run titles are already deterministic and remain so. Existing OpenCode process ownership and checkout/writer contracts are valuable requirements, not disposable implementation details.

### Evidence and limits

Planning reviewed repository source/specs and these official references on 2026-10-13, or earlier in the same exploration:

- https://opencode.ai/v2/docs/migrate-v1
- https://opencode.ai/v2/docs/build/client
- https://opencode.ai/v2/docs/build/sdk
- https://opencode.ai/v2/docs/api
- https://opencode.ai/v2/docs/config
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/costs
- https://platform.claude.com/docs/en/agent-sdk/overview
- https://platform.claude.com/docs/en/agent-sdk/permissions

Claude's current reference documents CLI MCP permission hosting, hooks, native advisor and background-session attach facilities. These are candidates, not proof of Convoy equivalence or availability in the installed version. `--bg` does not combine with `-p`, and `--bare` does not use subscription login. The existing `--safe-mode` disables customizations, so it cannot simply remain enabled while expecting new hooks/MCP bridges to load. The SDK's third-party subscription-login restrictions mean that CLI subscription execution must not be silently replaced by an SDK transport using extracted OAuth credentials.

No live model calls or new harness sessions are required to create these artifacts. Actual protocol/authentication conformance is an implementation-phase gate using disposable fixtures and explicit operator consent for model calls and API spend.

Claude subscription authentication can still consume paid usage credits, and some paid features use those credits without switching to an API key. Authentication status alone cannot establish included-only billing.

## Goals / Non-Goals

**Goals:**

- Define ports from Convoy behaviors and exercise them with both real adapters, not an OpenCode-shaped universal client.
- Deliver required baseline parity in OpenCode, Claude subscription, and Claude API-key modes. Keep genuine entitlement/version restrictions distinguishable from unfinished work.
- Make a Claude-only installation independent through helper inference, authoring, live dashboards, and finalization, not just the main attempt call.
- Preserve hard restrictions, exact session provenance, bounded ownership, and honest cost/recovery evidence.

**Non-Goals:**

- No third runner implementation, provider-neutral replacement agent loop, plugin marketplace, or speculative universal RPC framework.
- No automatic shared-service adoption, database migration between harnesses, global credential copying, or deletion of legacy run history.
- No claim that tool policy is an OS sandbox, that verification commands have no side effects, or that all harnesses expose identical usage, reasoning, or native UI behavior.

## Decisions

### D1. Own domain contracts in Convoy; keep native protocols inside adapters

Use a small family of ports rather than one interface containing every optional feature:

```text
Convoy core
  plan / scheduler / quality loops / retries / writer claims / Git
  permission policy / report validation / advisor policy / budgets
                         |
  execution + events + model discovery + conversation ports
                         |
       +-----------------+-------------------+
       |                                     |
  OpenCode v2 adapter                  Claude adapter
  owned serve + HTTP                   subscription CLI | API-key CLI
  native v2 tools/events               hooks + MCP + stream-json
       |                                     |
       +-------- shared process/terminal utilities --------+
```

An execution adapter prepares a scoped runtime and starts attempts. An attempt exposes normalized observations, terminal outcome, cancellation, and an opaque runner-qualified session reference. Optional conversation/control interfaces describe exact resume, native attach, and explicit handoff separately. Model discovery/validation uses the selected adapter. A runtime owns protocol clients and bridges internally; no `OpencodeClient`, vendor config, vendor message part, or SDK callback crosses the domain interface.

Neutral input includes run/attempt IDs, verified checkout, instructions, a logical agent definition, attachments, model reference, authentication selection, policy, deliverable contract, and cancellation context. Neutral output distinguishes completion, interruption, error, unavailable observation, and uncertain outcome. Attachments represent files/directories/content with metadata and are translated or staged explicitly; an unsupported attachment cannot be silently dropped.

The composition root registers adapters. Vendor imports belong under adapter boundaries; shared process identity/stop and terminal utilities remain reusable infrastructure. Requiring every `process-*` utility to move into OpenCode or disappear would be the wrong abstraction. Advisor, loop-guard, report, and safety policies stay in core; only native interception and transport live in adapters. Rendering subscribes to events rather than being called directly from each adapter.

**Alternatives rejected:** retaining `OpencodeClient` as a common input; renaming the current interfaces without removing runtime dependencies; one giant interface with no-op methods for unsupported behavior.

### D2. Start with owned OpenCode v2 servers, not a deployment redesign

Use `@opencode/client` against a Convoy-owned v2 server per run, with bounded helpers and independently owned authoring services as today. The adapter owns startup/authentication, version/API checks, explicit session location, agent/model selection, prompt admission, terminal-state reconciliation, event subscriptions, permission replies, tool registration, and terminal invocation.

Validate a pinned CLI/client combination through authenticated server info and typed payloads, not HTTP 200 alone: unknown legacy paths can return HTML. Readiness parsing and credential acquisition must match that combination. Generate or acquire local credentials through the documented supported mechanism, redact them before diagnostic-tail capture, and store any reattachment secret separately from public history with restrictive access. External terminal authentication must not put a password into argv or a printable URL.

Preserve `opencode-server-lifecycle` unchanged: verified ownership, cancellation from startup, bounded observed shutdown/escalation, orphan recovery, and controller-lease behavior. Do not kill an independently owned service. Per-run processes separate injected runtime configuration, but are not claimed to isolate shared databases or global settings. Pass explicit location and avoid concurrent mutation of global config or `process.env`.

Translate Convoy agent/policy definitions into v2-native runtime configuration; supported user V1 configuration continues to load without a mandatory global rewrite. Port only actual Convoy tools/plugins; an installed legacy plugin package alone is not proof that an active plugin needs migration. Require registration of report/advisor enforcement tools before prompting. Distinguish prompt acceptance from agent completion and reconcile history after live-only stream loss.

**Alternatives deferred:** shared background service changes config/lifetime isolation; embedded SDK removes the listener needed by the current native attach path. Embedding does not inherently remove permissions/advisors, contrary to an earlier exploration claim, but it changes attach and distribution concerns unnecessarily here.

### D3. Subscription CLI is a required Claude backend; API-key CLI is a separate explicit mode

Use the operator's supported Claude CLI for the subscription path, with headless streaming and documented per-invocation settings, hooks, and MCP facilities. Keep login in Claude. Do not read credential stores, extract OAuth tokens, proxy subscription requests, automate login, or embed a subscription-authenticated SDK by assumption.

Use the same CLI adapter for the initial API-key mode with explicit credential selection. This avoids two different agent loops and reduces drift. If a particular advanced feature later requires an officially supported Agent SDK API-key transport, it may live inside the Claude adapter only after its necessity and behavior are tested; the baseline does not depend on it. Native `--advisor` and background attach are optional mechanisms subject to D8/D10 equivalence, not immediate replacements for Convoy services.

Authentication preparation builds a child-local environment/settings overlay, validates effective auth under that exact overlay with the supported auth-status interface, and prevents ambient API keys, key helpers, OAuth overrides, or third-party provider settings from selecting a different billing source. Preserve managed policy; refuse configurations that cannot be safely isolated. Do not mutate parent environment or rewrite user settings. No silent subscription-to-key fallback on quota, login failure, missing feature, or resume.

New explicit Claude configurations default to `subscription` unless `api-key` is selected. Legacy runner entries with no mode are resolved during launch review; if effective CLI auth is not a verifiable subscription, require an explicit mode choice rather than inferring permission to spend. Existing noninteractive configurations fail with a migration message until the mode is made explicit. Public run metadata records mode and a non-secret credential source reference, never credential values. External shell launch revalidates after shell initialization, since startup files can reintroduce a conflicting credential.

Resolve a separate subscription `billingPolicy`: `included-only` is the conservative default; explicit `account-policy` acknowledges that the account may charge usage credits or paid features without changing authentication. Included-only is advertised only when supported controls can verify and enforce it for all applicable calls, including helper/background work. If those controls do not exist or status is unknown, block an included-only launch and offer an explicit account-policy decision, not an API-key requirement or a false free-usage guarantee. Account-policy consent is frozen and displayed for executor/helper/advisor routes and checked again on interactive reopen. Disable unreviewed paid features through supported invocation-local controls or refuse them. Convoy never enables account extra usage, buys credits, or raises provider-side spend limits. A snapshot of remaining quota alone is not a spending guarantee, especially with parallel calls.

Do not use `--bare` for subscription runs. Replace the blanket `--safe-mode` strategy with a tested per-invocation configuration that loads required Convoy hooks/MCP while controlling other customization sources. Preserve applicable managed policy and intentionally load the reviewed project guidance. If public CLI mechanisms cannot enforce a baseline guarantee, the release is blocked for that supported combination; dropping subscription or secretly using an SDK/API key is not a remedy.

### D4. Capabilities are resolved descriptions, not static brand booleans

Resolve effective capabilities from adapter implementation, supported binary/protocol features, selected auth, account/model availability, and requested policy. Each capability carries availability, explanation/remediation, and semantics (for example `native-live-attach`, `quiesce-and-resume`, or `post-exit-resume`). Never advertise a feature solely from a docs page or set all old Claude flags to true.

Initial parity acceptance matrix:

| Behavior | OpenCode v2 | Claude subscription | Claude API key |
|---|---|---|---|
| Read-only / writable / controlled verification | Required | Required | Required |
| Serial / parallel / model fan-out / goal fragments | Required | Required | Required |
| Mixed pipelines and cross-runner advisors | Required when dependencies explicitly selected | Same | Same |
| Interactive / auto / smart approvals | Required | Required | Required |
| Report / score / structured commit / correction | Required | Required | Required |
| Same-runner advisor and mandatory first-write gate | Required | Required | Required |
| Live dashboard / late attach / captured offline history | Required | Required | Required |
| Bounded stop / recovery / exact post-exit resume | Required | Required | Required |
| Authoring and helper independence | Required | Required without OpenCode/key | Required without OpenCode |
| Cost/token reporting | Available measurements, labeled semantics | Estimates/unknown; never fabricated quota | Estimates/unknown; not guaranteed invoice |
| Native live TUI attach / seamless takeover | Preserve supported behavior | Validate mechanism; safe handoff if proven, otherwise explicit limitation | Same evidence rule |
| Provider-specific variants / models / beta features | Entitled set | Entitled set | Entitled set; key-only features disclosed |

A missing baseline cell blocks release rather than becoming a generic capability exception. Advanced interaction or account-specific exceptions require exact version/mode evidence, visible UI behavior, and reviewed documentation. A purported API-key-only feature must be demonstrated as such; no function is assigned to that category simply because SDK examples are easier. Required model calls for acceptance are opt-in and budgeted.

### D5. Scheduling and routing remain Convoy responsibilities

Keep the existing scheduler, goal rounds, Git lock, writer claims, retries, and commit boundaries. A node binds a runner/model/auth route and creates an independent attempt. Fan-out expands through the scheduler, not harness-native subagent features. Cap concurrency per run and per runner; a subscription rate limit yields bounded retries/backoff or a visible failure, never a billing change. Existing parallel write semantics must be preserved or explicitly guarded, not broadened by new adapters.

Keep `runner: opencode|claude-code` and existing model strings compatible. Add planned configuration fields at these boundaries: runner defaults under `runners.<id>`, Claude `authMode: subscription|api-key`, optional per-step `runnerOptions.authMode`, runner-qualified `helpers.<role>` routes, explicit `advisor.runner`/`advisor.authMode`, and `authoring.runner`/`authoring.authMode`. API credentials are external references, never YAML values. Validate/review configuration and freeze resolved routes in the run plan; exact syntax is documented before release.

Subscription routes also resolve `billingPolicy: included-only|account-policy` from the same defaults/override hierarchy. Keep it separate from `authMode`, propagate it to inherited helper routes, and require explicit consent where a helper would broaden the reviewed billing policy.

Logical model references contain a runner plus opaque model identifier and optional variant/effort. Only OpenCode interprets provider/model syntax; Claude maps its aliases/full IDs and supported effort. A global model override must specify runner scope for mixed plans. Existing unqualified OpenCode overrides retain OpenCode-only interpretation and must be labeled as such, not silently applied to Claude.

Walk all steps, goal fragments, advisors, judges, and helpers during preflight. Existing explicit OpenCode selections are not silently converted to Claude. Provide reviewed Claude-only presets/config examples with explicit model and helper routes rather than translating an arbitrary OpenRouter pipeline by guesswork. Unspecified helpers inherit the applicable selected route; ambiguous run-wide helpers in mixed plans require selection. Keep deterministic fallback behavior where already documented and keep `run-title.ts` model-free.

### D6. Durable normalized events power every dashboard

Replace direct OpenCode observation in coordinated dashboard paths with a coordinator-owned event read model. Normalize vendor output into run/phase/attempt/session-qualified text fragments, reasoning when exposed, tool activity, permission requests/settlement, usage updates, session state, and terminal outcomes. Retain native IDs internally to deduplicate; assign durable monotonically ordered Convoy event sequence numbers before publication.

Persist events in a versioned append-only per-run journal with bounded in-memory buffers, incremental reads, private file permissions, and explicit truncation/gap markers. Avoid processing slow UI work in the upstream subscription consumer. A lagging dashboard replays by cursor rather than blocking permission handling or other attempts. Critical state/decision persistence failure fails closed; loss of non-critical transcript capture is reported as incomplete, never silently complete. Do not log raw credentials or unrestricted environment dumps. Reasoning visibility follows what the harness exposes.

Subscribe and replay using a high-water mark so replay/live overlap does not duplicate content. Use adapter history backfill on recoverable source gaps and mark unrecoverable gaps. Reconnecting OpenCode SSE is the adapter's responsibility; don't assume the v2 client replays missed events. Historical reading requires neither live harness nor authentication. This specifically repairs `control-progress.ts`'s message no-op and `attach-runtime.ts`'s exclusion of non-native-attach phases. Keep legacy history placeholders when no captured/native history exists.

### D7. Separate safety policy from interception and approval transport

Core evaluates normalized action requests against read-only/verification/writable policy, hard denials, mandatory advisor checkpoints, and interactive/auto/smart handling. Adapters map native tools and permission prompts, retaining the original request for diagnostics and conservative decisions. Unknown or unclassifiable actions do not gain access by default.

Claude uses a documented pre-action hook for mandatory checks and MCP permission hosting for ask-level decisions; hook/bridge health is verified before affected execution. An ordinary permission callback is insufficient because native auto-approval can skip it. Native OpenCode checks and permission events must provide equivalent enforcement. Cover shell, delegated tools, custom tools, and alternative mutation paths; disable paths whose scope cannot be enforced. This is tool-policy enforcement, not a claim of an OS sandbox. Verification allows explicitly approved commands and declared side effects, not arbitrary shell access branded read-only.

Each decision is keyed by run, phase, attempt, session, native request, and generation. A private per-run bridge binds authenticated capabilities to that scope; model-supplied identity/path values are not authority. Timeouts, cancellation, duplicate replies, operator departure, and stale retries cannot unlock another action. Bridge network binding is loopback-only or private local IPC, with bounded request sizes and no secrets in logs. Organization-level denials remain effective. `--yolo` means eligible ask approval, never unrestricted native bypass.

### D8. Reuse core advisors and report validation through runner-specific bridges

Extract consultation context from normalized transcript/history, not `AssistantMessage`/`Part`. An advisor is an explicitly routed tool-restricted helper execution with output, call-count, time, and usage bounds, no writer claim, and no automatic recursive advisor. Expose the service to OpenCode through its v2 tool/plugin mechanism and to Claude through an explicitly configured MCP tool. Core enforces mandatory first-write/checkpoint policy via D7; tool availability alone is not a checkpoint.

Both executors can consult either runner after dependency/auth preflight. Freeze route/model/auth in attempt metadata and retain executor/advisor attribution. Native advisor facilities are acceptable only after tests demonstrate the same routing, checkpoints, context bounds, output limits, and accounting; otherwise use Convoy's bridge. Existence of Claude's `--advisor` does not establish that equivalence.

Reuse `report-runtime.ts`'s validation, fixed output paths, serialization, scoring, and commit sidecars. Report submissions use per-attempt bridge authority and explicit schemas. Claude gains `write_report`-equivalent submission rather than relying exclusively on final prose; retain existing honest fallback for contracts that permit it. Report correction is driven by core through another attempt turn within bounded policy. Native idle/process exit is not phase success until report/Git checks complete. Persist accepted report/commit metadata before advertising acceptance so recovery can reconcile without repeating writes.

### D9. Usage and loop controls have explicit semantics

Normalize token counts, model-reported costs, estimated cost basis, missing fields, and cumulative-versus-delta identity. Snapshot prior cumulative usage when continuing a session, subtract only valid baselines, and avoid double-counting reconnects, resumed totals, nested subagents, and separately billed advisors. If a reliable delta cannot be derived, retain an unknown/incomplete status rather than subtracting arbitrary values or treating them as zero.

Keep loop policy in core: observed repeated tool activity, turns, elapsed time, token/cost budgets, and configured soft/hard reactions. Map soft steering only when the adapter proves its semantics; hard cancellation always uses D11. Budget review states whether limits apply to measured/estimated API cost, tokens, turns, or time. Subscription estimates do not represent cash charges or remaining quota. In-flight requests can overshoot estimated cost thresholds; describe headroom and bounded-stop behavior instead of promising invoice-perfect caps. If required evidence/enforcement is absent, preflight demands an explicit supported policy or refuses.

### D10. Interactive control and authoring are explicit, runner-qualified operations

Separate four operations: Convoy dashboard observation, native live attach, explicit quiesced handoff, and exact post-exit resume. Do not conflate `liveAttach:false` with inability to stream logs. Claude background attach requires investigation because the documented background and print modes are not interchangeable. A safe baseline handoff interrupts/quiesces execution, verifies it no longer writes, persists the session checkpoint, and transfers the existing writer claim before opening the exact session. Returning to automation revalidates auth, checkout, policy, and actual Git changes; where this cannot be verified, offer post-exit resume and report the limitation.

Use the conversation port in plan iteration, proposal fallback, home/worktree conversations, human gates, and finish-screen iteration. Preserve `work-conversations`: harness-qualified exact sessions, verified checkout continuity, independent authoring lifetime, foreground return/terminal cleanup, explicit external presentation, operator-shell startup/executable resolution, and managed-writer coordination. Use a final launch-time auth check after shell startup. Never substitute a latest session or a fresh session while claiming resume. Account/model/auth changes require explicit review. Human iteration commits still come from Convoy with authoritative trailers.

### D11. Cancellation, release, and recovery have distinct ownership semantics

Distinguish cancelling an attempt from releasing a client view/runtime. Adapter runtimes reuse shared owned-process identity/stop utilities. Track native execution, local bridges, owned children, verified process groups where supported, and borrowed/independent resources separately. An owned CLI parent exiting is not automatically evidence that all descendant work stopped; only signal descendants with attributable ownership, and retain unresolved evidence when proof is missing.

Stop sequence: freeze new admission, cancel relevant pending decisions/consultations, request native interruption within a shared deadline, stop owned children, escalate if necessary, and record observed outcome. Repeated stop/abort shares one result. An unresponsive protocol must not consume the entire budget before process cleanup. A detached active run retains coordinator ownership and writer claims. Cleanup of a completed terminal hold follows the existing 15-second controller lease plus one-second detection allowance; controller replacement races remain guarded.

Orphan reconciliation is bounded and identity-based for Claude children as well as OpenCode servers. Do not reinterpret historical coordinator PIDs as child IDs; no name/port-based kill scans. Persist recoverable ownership outside disposable run directories. Independent authoring clients/services and user-managed harness processes are excluded.

Persist a new versioned runner execution record alongside compatibility readers for legacy fields. Session identity is `(runner, native session ID)` plus verified checkout/provenance, not a UUID that replaces worktree identity. New records include non-secret auth mode, protocol version, operation/attempt identity, event cursor, and known terminal/recovery state. On crash, reconcile native availability, ownership, report acceptance, and Git effects before retry. Exactly-once arbitrary tool execution is not promised; uncertain prompts/writes are not automatically resubmitted. Recovery distinguishes exact continuation from explicit fresh retry.

## Risks / Trade-offs

- **[Subscription and API auth precedence differs by settings/version]** → Probe the exact child launch context, isolate credentials locally, retain managed policy, test hostile ambient credentials and external-shell reintroduction, and refuse ambiguity.
- **[CLI/SDK terms or features change]** → Use documented CLI subscription surfaces and no token extraction; record tested versions and mode-specific evidence. If baseline feasibility fails, revise the proposal with the user rather than silently removing subscription support.
- **[Safety hooks can be skipped or never load]** → Startup health checks, mandatory pre-action interception, adversarial policy tests, and refusal on missing enforcement; no prompt-only or unrestricted-bypass substitutions.
- **[Owned OpenCode servers still share disk state]** → Explicit session location, no global config writes, and concurrent-run config/credential tests; don't claim storage isolation.
- **[Native schemas and streams drift]** → Tested version ranges and real protocol fixtures; validate content types and envelopes, terminal outcomes, stream gaps, and registration failures.
- **[Parallel agents can write conflicting changes]** → Keep core writer coordination and Git boundaries; concurrency is not blanket authorization.
- **[MCP/hook round trips can deadlock on a permission or advisor]** → Scope replies, provide separate decision/stream processing, finite deadlines, cancellation propagation, and sibling-isolation tests.
- **[Durable transcripts increase disk/privacy exposure]** → Private journal permissions, bounded buffers, existing run retention policy, no credential-bearing raw dumps, and explicit incomplete-history markers.
- **[Subscription estimates masquerade as monetary spend]** → Preserve estimate provenance, unknowns, baseline deltas, and separate billing mode labels.
- **[Subscription login still permits paid usage credits]** → Resolve billing policy independently, refuse unverifiable included-only guarantees, and require explicit account-policy consent without altering account spend controls.
- **[Near-parity scope hides unfinished features]** → Mandatory matrix cells, shared behavior tests, and evidence-backed advanced exceptions; no percentage claim without the inventory.
- **[Large migration destabilizes established workflows]** → Deliver vertical slices that exercise both adapters, keep legacy readers, and run Git/finalization/conversation regression suites at each boundary.

## Migration Plan

1. During implementation, establish tested OpenCode v2 and Claude CLI versions, verify subscription/API auth precedence and hook/MCP integration in isolated fixtures, and record the capability matrix. Use `--help`/public docs and mocked protocol tests first; ask before live calls with cost or side effects. Baseline failures block rollout.
2. Introduce neutral contracts, compatibility readers, conformance fixtures, and the runner registry. Remove unconditional OpenCode initialization and vendor attachment/session types from core while keeping existing behavior covered.
3. Implement OpenCode v2 owned-server execution and Claude subscription/API execution behind the same contracts. Migrate reports, permission policy/interception, advisors, and helper inference as vertical slices exercised by both runners.
4. Add durable coordinator events, session provenance, parallel/fan-out routing, budget semantics, exact recovery, and frontend capability/auth review. Update authoring and human iteration paths; validate both adapters without the other binary installed.
5. Publish Claude-only, OpenCode, and mixed configuration examples. Keep existing runner IDs and supported model syntax. Explain new explicit authentication selections, OpenCode v2 requirement, report/history compatibility, and advanced interaction limitations. Do not rewrite global user config, credentials, or native databases.
6. Release only after all baseline cells pass automated conformance tests and consented real-harness acceptance. Test supported macOS/Linux targets and compiled Bun packaging. Disclose exact advanced exceptions with version/mode evidence.

Rollback: stop new launches and quiesce Convoy-owned execution through recorded ownership before switching binaries. Preserve run journals, native sessions, reports, and Git history. Old Convoy releases are not assumed to understand new records; new-format runs remain readable by the new release and are not resumed by the old one. Returning to OpenCode v1 for new legacy runs requires an explicit operator installation choice; do not downgrade globally or point v1 at converted native-v2-only config automatically. No rollback rewrites commits or replays uncertain writes.

## Open Questions

- Exact minimum tested CLI/client versions and protocol capability identifiers will come from implementation conformance fixtures, not the moving latest docs.
- Native Claude attach/steering fidelity for the chosen headless transport remains to be measured; the required observation and exact-resume contracts do not depend on claiming seamless native attachment.
- Journal chunk sizes, batching intervals, and diagnostic tail limits need profiling against long parallel runs. They must preserve bounded memory, responsive decisions, and explicit gaps.

No authentication policy, required baseline capability, or ownership decision is deferred by these questions.
