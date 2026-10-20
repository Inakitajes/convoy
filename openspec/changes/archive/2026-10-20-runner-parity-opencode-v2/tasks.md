# Tasks

## 1. Establish supported protocols and parity evidence

- [x] 1.1 Inventory every runner-dependent operation, including goal fragments, helpers, authoring, human gates, and dashboards; verify the delivered inventory maps each operation to the design's parity matrix and a spec scenario.
- [x] 1.2 Select tested OpenCode v2 CLI/client and Claude CLI versions using official API/plugin/hook/auth documentation and isolated compatibility fixtures; verify the compatibility record includes startup/auth, prompt admission versus completion, event shapes, model lookup, and tool registration for each mode.
- [x] 1.3 Verify the documented Claude CLI subscription path supports per-invocation hooks, MCP reports/advisors, and permission hosting without `--bare`, blanket `--safe-mode`, token extraction, or API-key substitution; record fixture evidence and, with explicit consent, a bounded real-harness smoke result. Treat inability to meet baseline policy as a blocker requiring review, not an implicit API fallback.
- [x] 1.4 Investigate native Claude advisor and live-attach/handoff facilities against the selected headless transport; verify a delivered evidence table distinguishes native support, supported equivalent, account/version restriction, and missing implementation without claiming print/background modes are interchangeable.
- [x] 1.5 Add version/authentication/parity guidance to the development and models documentation; verify every claimed minimum and advanced exception links to evidence and the baseline release gate is explicit.

## 2. Define neutral ports and compatibility records

- [x] 2.1 Define Convoy-owned execution requests, attachment descriptors, model references, events, outcomes, and runner-qualified sessions plus optional conversation/control ports; verify typecheck and contract tests use no vendor SDK types.
- [x] 2.2 Introduce the adapter registry and runtime/attempt ownership seam around existing dispatch; verify a fake adapter executes through the scheduler and no core context requires `OpencodeClient`.
- [x] 2.3 Extract logical agent instructions and attachment preparation from OpenCode configuration rendering; verify both adapters receive equivalent source context and unsupported attachments cause an explicit error rather than silent omission.
- [x] 2.4 Add versioned runner/auth/model/session/attempt provenance with compatibility readers for old records; verify legacy Claude/OpenCode fixtures remain readable, ambiguous sessions are not guessed, and coordinator PIDs retain their old meanings.
- [x] 2.5 Introduce shared adapter conformance fixtures and dependency-boundary checks; verify vendor imports outside adapter boundaries fail the check and document the ports/ownership responsibilities in the development guide.

## 3. Implement explicit Claude authentication and configuration routing

- [x] 3.1 Add runner defaults, per-step auth overrides, helper/advisor routes, and authoring selection to configuration parsing/serialization; verify round-trip tests preserve existing runner IDs and reject embedded secret values or invalid mode combinations.
- [x] 3.2 Build child-local subscription/API-key environment and settings preparation with effective-auth validation; verify ambient keys, key helpers, OAuth overrides, third-party settings, absent login, and organization-policy conflicts cannot silently change billing or mutate global state.
- [x] 3.3 Preserve supported CLI subscription execution and add explicit API-key CLI execution without introducing an SDK dependency for the baseline; verify both modes through protocol fixtures and that quota/auth failures never trigger cross-mode fallback.
- [x] 3.4 Implement explicit-mode migration errors for ambiguous legacy noninteractive configurations and freeze resolved non-secret auth in plans; verify missing mode and resumed-run cases either preserve verified subscription behavior or request explicit mode selection without inferring API consent.
- [x] 3.5 Add credential redaction and private runtime-secret handling for child diagnostics, local bridges, and server connections; verify keys, passwords, headers, and credential-bearing URLs never enter public metadata, logs, or terminal argv.
- [x] 3.6 Document subscription setup, API-key opt-in, legacy configuration migration, and cost labels with complete examples; verify examples parse and subscription examples require neither an API key nor OpenCode.
- [x] 3.7 Add separately resolved subscription billing policy and consent to every executor/helper/advisor/authoring route; verify allowance-exhaustion with credits enabled, inherited paid features, unknown extra-usage status, and noninteractive launches either satisfy verified included-only controls or require explicit account-policy authorization. Document that subscription login alone is not a no-charge guarantee and that Convoy never changes provider-side spending settings.

## 4. Migrate the OpenCode adapter to released v2

- [x] 4.1 Replace the legacy SDK integration with a pinned released `@opencode/client` inside the adapter; verify dependency install, typecheck, and HTTP fixture tests use v2 routes and reject HTML/incorrect envelopes despite HTTP 200.
- [x] 4.2 Implement authenticated owned-server startup, readiness/version checks, explicit locations, and private reattachment credentials; verify startup cancellation, malformed output, unauthorized responses, client-construction failure, and bounded cleanup preserve existing lifecycle tests.
- [x] 4.3 Translate logical agents/models/policies into v2 runtime configuration without rewriting supported user V1 config; verify concurrent runs retain independent injected settings and do not mutate parent environment or global files.
- [x] 4.4 Implement v2 session creation, prompting, continuation, outcome reconciliation, event decoding, and history backfill; verify accepted prompts are not treated as completed and disconnect/idle/error races cannot fabricate success or replay uncertain prompts.
- [x] 4.5 Port actual Convoy report/advisor tools and mandatory permission integration to the v2 public extension surface; verify registration health is checked before prompting and legacy plugin code is not loaded as if compatible.
- [x] 4.6 Update explicit-server terminal invocation and helper/authoring server ownership without adding a shared-service mode; verify exact-session opening, auth redaction, independent authoring lifetime, and documented v2 installation requirements.

## 5. Establish Claude execution and attributable lifecycle

- [x] 5.1 Replace fixed read-only invocation with reviewed per-attempt CLI settings and tool availability for read-only, verification, and writable modes, gated on mandatory policy enforcement; verify argv/settings fixtures preserve subscription auth and load required Convoy integrations.
- [x] 5.2 Normalize Claude streaming, session initialization, tool activity, terminal results, and errors into the neutral event/outcome contract; verify malformed lines, missing result, startup-hook output, nested messages, and partial streams cannot fabricate completion.
- [x] 5.3 Generalize shared process ownership utilities for Claude children and bridge resources while preserving OpenCode contracts; verify PID reuse, incomplete evidence, independent processes, and concurrent reconciliation are never unsafe kill targets.
- [x] 5.4 Add bounded interrupt/stop/escalation and observation for Claude attempts, including attributable descendant work; verify hanging commands, blocked permissions, repeat abort, cancellation during startup, and unknown descendant state settle within the shared deadline with truthful outcomes.
- [x] 5.5 Separate runtime release, view detachment, explicit cancellation, and finished controller holds; verify active detached executions retain claims, the existing lease timing holds, and independent authoring survives run cleanup.
- [x] 5.6 Document Claude execution modes, customization loading, supported restrictions, and lifecycle limits; verify examples and lifecycle fixtures do not claim an OS sandbox or assume child exit proves all descendant termination.

## 6. Deliver shared permission enforcement and approvals

- [x] 6.1 Extract runner-neutral action/policy evaluation from the current permission gate while retaining hard-denial, verification, and smart-judge semantics; verify the same policy fixtures pass for equivalent Claude and OpenCode actions.
- [x] 6.2 Implement Claude mandatory pre-action hooks plus authenticated MCP ask-level permission hosting, and map OpenCode v2 enforcement to the same decisions; verify native allow rules and Auto-accept cannot bypass hard denials or first-write checkpoints.
- [x] 6.3 Scope permission requests/replies to exact execution identity and generation; verify stale, duplicate, foreign, cancelled, and timed-out replies cannot authorize another attempt and sibling requests remain independently responsive.
- [x] 6.4 Cover indirect mutation through shell, delegated agents, and external tools with conservative enforcement or disabled unsupported paths; verify adversarial read-only and verification tests deny disallowed effects before execution.
- [x] 6.5 Implement startup enforcement-health checks and runtime failure handling; verify unavailable hooks/bridges fail closed without enabling unrestricted bypass or leaving an unbounded approval wait.
- [x] 6.6 Route smart judges through the selected runner/auth/model and update launcher review while keeping its selector cycle/default/flags; verify Claude-only smart approval without OpenCode, explicit-judge compatibility, judge timeout handling, and the modified launcher spec scenarios. Document the safety mappings and failure modes.

## 7. Deliver structured reports and advisor parity

- [x] 7.1 Expose the shared report validator through a scoped Claude MCP tool and the v2 OpenCode tool; verify reports, scores, and structured commit descriptions obey identical schemas and cannot target arbitrary paths or sibling attempts.
- [x] 7.2 Move deliverable completion/correction orchestration to core with both adapters supporting bounded follow-up turns; verify invalid score, malformed replacement, missing report, successful correction, and correction-limit cases against the same fixtures.
- [x] 7.3 Persist accepted report/commit data before acknowledgement and preserve recovery identity; verify crash-after-report/before-commit and duplicate-submission tests do not lose semantic data or duplicate a commit.
- [x] 7.4 Extract bounded normalized consultation context and runner-independent advisor execution; verify Claude subscription-to-subscription consultation without OpenCode/key and both cross-runner directions with explicitly routed dependencies.
- [x] 7.5 Implement mandatory advisor checkpoints via the permission boundary and expose advisor tools in both runners; verify an unconsulted first write is blocked even under native auto-approval, and failed consultation leaves protected work blocked.
- [x] 7.6 Apply advisor call/output/time limits, cancellation, recursion prevention, and separate usage attribution; verify concurrent consultations and cancellation affect only the originating attempt and consume the correct budget once.
- [x] 7.7 Document reports/advisors and mixed-runner route examples; verify every example parses and any use of a native advisor is backed by equivalence tests rather than feature-name matching.

## 8. Route full plans and remove hidden OpenCode dependencies

- [x] 8.1 Replace static brand exclusions with effective capability validation and runner-qualified model discovery/effort mapping; verify Claude write/verify/fan-out selections are accepted when supported and incompatible model/variant choices fail visibly.
- [x] 8.2 Traverse all ordinary steps, goal fragments, advisors, judges, and helper routes in preflight and plan freezing; verify a missing future dependency is reported before any writable phase starts.
- [x] 8.3 Enable Claude model fan-out and mixed parallel nodes through the existing scheduler; verify dependency ordering, per-run/per-runner concurrency bounds, report/session isolation, quota backoff, and protected conflicting-write behavior.
- [x] 8.4 Route branch-name and commit-message helpers through the helper port and remove unconditional OpenCode runtime/tool setup; verify Claude-only preflight, execution, helpers, and finalization with OpenCode absent, plus deterministic run-title regression tests.
- [x] 8.5 Add scoped model override behavior and usable Claude-only pipeline presets/examples without guessing mappings from arbitrary OpenCode providers; verify plan-preview fixtures show all resolved models/auth modes and existing explicit OpenCode selections are unchanged.
- [x] 8.6 Update config editor and CLI/launch review to show capability reasons, helper dependencies, authentication, and API-only feature requirements; verify parse/review/UI tests and document the new fields and non-silent migration behavior.

## 9. Deliver durable runner-neutral observation

- [x] 9.1 Implement versioned normalized event journaling with attempt-qualified identity, sequence cursors, private files, and bounded buffers; verify ordering, duplicate native IDs, partial final records, disk failure, and long-stream memory bounds.
- [x] 9.2 Replace coordinator phase-message no-ops and OpenCode-only dashboard subscriptions with journal/live event delivery; verify production coordinated Claude streaming without an OpenCode server URL and mixed-runner tab attribution.
- [x] 9.3 Implement cursor replay plus live high-water-mark merging and supported runner-history backfill; verify late attachment, reconnect overlap, completed scoring rounds, and stream gaps neither duplicate fragments nor claim nonexistent content.
- [x] 9.4 Support offline captured transcripts and honest legacy placeholders; verify history remains readable without either binary, credentials, model calls, or a live server and incomplete journals show gap markers.
- [x] 9.5 Decouple slow observers from native event intake and permission processing; verify a stalled dashboard cannot block sibling attempts or mandatory approval decisions. Document transcript retention, exposed reasoning, privacy, and incomplete-history behavior.

## 10. Deliver usage controls and exact recovery

- [x] 10.1 Normalize usage semantics and persist cumulative baselines across turns/resume; verify repeated events, nested subagents, advisors, and continued Claude conversations do not double-count, and unavailable fields remain unknown.
- [x] 10.2 Apply core turn/time/tool-loop/token/cost policies to both adapters with supported soft steering and bounded hard cancellation; verify budget trips, quota failures, overshoot disclosure, and refusal of unenforceable requested guarantees.
- [x] 10.3 Reconcile interrupted attempts against runner availability, process identity, accepted reports, and actual Git state before continuation or retry; verify uncertain prompt submission/write outcomes do not trigger automatic duplicate execution.
- [x] 10.4 Preserve auth mode, model route, exact session identity, and completed sibling results on resume; verify missing session, changed checkout, expired credentials, changed version, and legacy ambiguity produce explicit recovery choices rather than retargeting.
- [x] 10.5 Update usage and recovery documentation with subscription-estimate versus API-billing distinctions and concrete retry/resume examples; verify documented behavior against fixtures for both modes and both runners.
- [x] 10.6 Apply the reviewed subscription billing policy to resumed/background/parallel requests and inherited helpers; verify depleted allowance, stale quota snapshots, and unknown billing evidence cannot silently broaden included-only authorization or raise account limits, and disclose estimate-versus-provider-cap limitations.

## 11. Deliver authoring and human-control parity

- [x] 11.1 Route home/worktree conversations, proposal fallback, specs iteration, human gates, and finish-screen iteration through the conversation port; verify Claude-only authoring works without OpenCode and foreground/external presentation uses the selected exact harness session.
- [x] 11.2 Implement supported native attach and explicit quiesced handoff separately from post-exit resume; verify no second writer starts before authority transfer, failed handoff does not claim success, and unavailable native interaction is labeled honestly.
- [x] 11.3 Revalidate checkout continuity, session availability, auth mode, and Git effects on interactive entry/return, including after external shell startup; verify changed credentials, reused/moved paths, missing sessions, and stale binaries cannot silently change execution target or billing.
- [x] 11.4 Preserve terminal restoration, operator-shell behavior, authoring lifetime, and shared writer guards; verify existing conversation/terminal regressions plus Claude-specific failure/interruption cases.
- [x] 11.5 Generalize human-iteration commit provenance and UI language to both harnesses; verify exactly-one authoritative run trailers for normal, recovered, and human-created changes and no empty provenance-only commits. Document verified interaction semantics and advanced exceptions.

## 12. Validate release-wide parity and migration

- [x] 12.1 Run the complete shared conformance matrix for OpenCode v2, Claude subscription, and Claude API-key execution; verify every mandatory cell has passing tests and evidence, and advanced exceptions name exact versions/modes rather than hiding missing implementation.
  - Status: the shared suite runs against the real Claude adapter (`test/runner-conformance.test.ts`) and the engine path is covered for both runners, including a Claude-only `run()` with OpenCode absent (`test/claude-only-run.test.ts`). The API-key cell has no evidence: no API key is available in this environment (`evidence/compatibility.md`).
- [x] 12.2 With explicit operator approval and bounded spend, exercise real Claude subscription-only, Claude API-key-only, OpenCode-only, and mixed full-cycle fixtures including reports/advisor, parallel nodes, approvals, detach/reattach, abort, and recovery; verify disposable checkout outcomes and auth/cost provenance, recording exact commands/results without secrets.
  - Status: `scripts/runner-acceptance.ts` now drives real `run()`s (preflight, attempt, report, finalization, provenance) for Claude-only and OpenCode-only plans behind `CONVOY_ACCEPT=1`. The API-key, mixed, and full paid-cycle fixtures remain deferred pending operator consent to spend.
- [x] 12.3 Run `bun run typecheck`, `bun test`, and `bun run build`, plus compiled CLI smoke checks on supported macOS/Linux targets; verify all pass and bridges/hooks resolve correctly outside the source checkout.
- [x] 12.4 Exercise legacy config/history and migration/rollback fixtures alongside Git, goal, finalization, publication, and conversation regression suites; verify no global credential/config/database rewrites, no lost history, and no replay of uncertain writes.
- [x] 12.5 Audit the final dependency graph, generated artifacts, public logs, and user-facing parity documentation; verify vendor types stay behind adapter boundaries, Claude-only paths never initialize OpenCode, no secrets leak, and all disclosed functionality matches tested behavior before marking the change complete.
