## Context

See `proposal.md` for motivation and `specs/opencode-v2-compatibility/spec.md` for the contract. The behavior baseline is Convoy `0.9.2`, upstream HEAD `22b29dd`, not the optional agent redesign discussed during research.

Convoy owns the plan, coordinator/control server, phase/attempt state, gates, reports, budgets and Git effects. OpenCode supplies sessions, model/tool execution and observations. The current integration pins `@opencode-ai/sdk@1.18.4` but launches `opencode` from PATH through `managed-server.ts`; SDK imports and direct client consumers extend beyond `opencode.ts`.

Research used released V2 `2.0.25` contracts. The read-only local check on 2026-10-09 reports `2.0.26`; neither combination has been runtime-validated for Convoy. This difference is evidence that the executable can change independently of the pinned client, not justification to accept all `2.x` versions.

### Context validation

`openspec/` is canonical. Existing `opencode-server-lifecycle`, `goal-subflows`, `run-finalization`, `session-transcripts`, `work-conversations` and `run-launcher-permissions` requirements remain unchanged. The new capability adds the V2 compatibility obligation; it does not redefine those contracts. Reuse their regression assertions rather than duplicating lifecycle/goal implementations. In particular, Git run compaction is not LLM context compaction, an OpenCode agent is not a Convoy step, and the Convoy control service is not the OpenCode API.

Supporting context: `docs/development.md`, `docs/openspec.md`, and the research/context-validation reports under ignored `docs/plans/reports/`. The implementation must rely on this change's artifacts and canonical specs, not require those local reports to be present.

## Goals / Non-Goals

**Goals:**

- Replace the integration boundary while keeping domain policies, public Convoy configuration and workflow outcomes stable.
- Demonstrate effective runtime behavior, especially completion, permissions, reports, advisor settings and cleanup; configuration snapshots alone are insufficient.
- Make compatibility/error/secret handling explicit at the changed boundary with narrowly scoped code in existing modules.

**Non-Goals:**

- No native run-root agent, new subagent roles, persistent advisor, pipeline scheduling handover, YAML/schema redesign or V1/V2 compatibility framework.
- No embedded SDK, new runtime installer, automatic service replacement, provider credential copying or session/database importer.
- No pixel-identical OpenCode V1 terminal: preserve Convoy's existing actions, presentation modes and linked sessions using V2's client, not the external client's visual implementation.
- No silent feature removal, weaker read-only behavior or replacement of existing gates with model-optional advice.

## Decisions

### 1. One external V2 client boundary, not a second orchestration engine

Use compatible, explicitly pinned `@opencode/client` and `@opencode/plugin` packages. Confirm a concrete runtime/client/plugin combination and the published declarations before updating dependencies and the lockfile. Keep small common execution/history/connection helpers in the existing OpenCode boundary where callers need identical behavior; do not introduce a generic backend registry or rewrite the coordinator/runner/goal scheduler.

Alternatives: a dependency bump leaves incompatible contracts; embedded `@opencode/sdk` changes server ownership and attach behavior; dual V1/V2 adapters double the required surface without a present requirement.

### 2. Keep existing process lifetime classes and local binary selection

Continue foreground run/helper servers and independently persistent authoring ownership. Probe the resolved executable's compatibility before model work/mutating hooks; record detected version and bound all startup/cleanup waits. Parse the released readiness/auth protocol, construct authenticated clients and redact password-bearing output before retaining diagnostic tails. Carry connection authentication privately to owned attach/terminal operations, not through generic run metadata or navigation hints.

Do not use shared `Service.ensure/stop` as a replacement for run-owned child handles: ensure can alter a registration/service unrelated to the run. Preserve global/project discovery and OpenCode credential ownership. A separate port/PID does not isolate the database or saved approvals; coexistence tests must protect existing shared data. Test fixtures use isolated config/data and approved test authentication rather than copied user secrets.

### 3. Preserve effective per-run configuration and model intent

Retain Convoy YAML/agent override precedence and approved logical/physical model, provider, variant and routing selections. Use V2-compatible injected configuration without rewriting user files; legacy config shapes can remain only where the released normalizer preserves the required behavior. Check effective models/tools after plugin activation rather than accepting an early incomplete registry snapshot.

Validate the actual CLI bridge for inline config/config-directory discovery and absolute plugin resolution. Generate native V2 shapes only where needed for reliable behavior. Ordered permissions must preserve hard denials and per-role exceptions; do not mechanically append an allow-all rule after denials. V2 lacks the old `doom_loop` action, so Convoy's own observed loop/budget controls remain authoritative.

Per-agent `request` overlays are documented as not yet sent by the V2 runner. Preserve advisor temperature/output caps and routing through effective model/variant settings or a narrowly scoped dispatch hook; test the resulting request. Do not introduce `agent.steps` as a substitute for Convoy counters.

### 4. Model the actual admission-to-result transition

Use the released resource client shapes, not mechanical field renaming. The research baseline establishes:

| Existing V1 assumption | V2 boundary to verify and use |
|---|---|
| SDK factory and `{data,error}` result conventions | `OpenCode.make({baseUrl,headers,fetch})`; resource-specific unwrapping and rejected errors |
| Create with directory and prompt-level model/agent | `session.create({location,agent,model,...})`; stored selection and explicit switching |
| `promptAsync` or blocking `prompt` returns the result | `session.prompt({sessionID,text,files,...})` returns durable inbox admission |
| `session.messages` returns all `{info,parts}` | `message.list({sessionID,...})` paginates typed history |
| `session.abort` and `session.delete` | `session.interrupt({sessionID,resume:false})` and `session.remove` with distinct cancellation/deletion semantics |
| V1 permission field/reply names | `permission.reply({sessionID,requestID,decision,...})`; V2 action/resources/source mapping |
| Directory-scoped event subscription | Server-wide decoded events, explicit session attribution and recovery |
| `provider.list` contains connected provider/model maps | Separate location-scoped provider/model inventories and variants arrays |

The execution transition is `created → admitted → executing/waiting → settled → deliverable validated → gate/commit/release`. An API response, active-map absence or idle marker is not the whole transition. Observe before submission, correlate admission/turn identity, and use idempotent admission/reconciliation after uncertainty. Preserve initial result, completion follow-up and report-reminder anchors; old text must not satisfy a new turn.

The released wait route is experimental: pair observation with durable session/inbox/message state and existing finite deadlines. Signal cancellation of HTTP is not remote cancellation of admitted work. Preserve explicit user abort/exit 130 and existing hook/rollback distinctions; perform bounded remote interruption followed by owned-server cleanup. Do not delete phase history merely to emulate abort.

### 5. Port observations, permissions and budgets together

Adapt event envelopes/discriminants, text/reasoning/tool identity, execution errors and token/cost structures as one boundary. Keep Convoy's existing event fan-out and subscribers; filter attributable sessions, dispatch promptly and reconcile after source failure. Shared V2 streams are live-only and do not reconnect automatically. History and cumulative usage provide recovery anchors; they are not authorization to process unrelated sessions.

Keep permission gates and first-write advice ordering in Convoy. Map shell/edit/subagent actions at the OpenCode boundary without changing Claude conventions. Preserve strict read-only, verify baseline enforcement, tool-less unknown-tool denials and fail-closed judging. Native forms do not justify enabling question flows currently denied by Convoy.

Use per-session cumulative usage as the deduplication anchor, keep advisor separate and preserve existing follow-up resets versus cumulative cost. Translate tiers/cache/reasoning fields without adding cumulative snapshots to already counted deltas. Repeated-call, failure, step and cost fuses must remain observable under V2 names, including applicable nested/delegated work already allowed by the current workflow.

### 6. One small runtime plugin preserves the three controlled tools

Port `write_report`, `advisor` and `advisor_feedback` through a V2 plugin using `Plugin.define`, registered JSON-schema tools, structured results, trusted execute context and cancellation. Keep report/advisor policy and authenticated loopback bridges in their existing Convoy runtimes. The published context includes `sessionID`, agent/message/call identity and `signal`; verify loaded behavior rather than trusting a model-supplied session argument.

Bind plugin source/options immutably to the run, with absolute paths and private artifacts, so reload or concurrent runs cannot replace another run's token/endpoint. Require effective tools before admitting work; do not rely on a generated file's existence or an implicit dependency install succeeding. Dispose owned registrations/resources on release.

Retain fixed report destinations, validation, atomic writes, candidate/sidecar precedence, privacy and tool-only report persistence for read-only phases. Keep session→phase handles through recovery gates and terminal holds, invalidating them only on the existing advance/retry/reset/abort boundaries.

### 7. Keep advisor policy and fresh consultations unchanged

The advisor remains Convoy-governed. Port create/admit/settle/read/cleanup, bounded transcript export and usage extraction; retain on-demand, edit-based first-write and completion triggers, failed-call accounting, feedback correlation, output cap, timeout, reasoning suppression and ordinary-failure degradation. Preserve structural abort/loop failure propagation and same-executor-session follow-ups, including `NO CHANGES`.

Do not move first-write interception to a new tool hook, broaden its shell-write coverage, reuse a persistent advisor or make checkpoints optional native subagent calls in this phase. `generate.text` is not a drop-in replacement: its text-only contract does not prove the current advisor usage/cap/audit behavior. Keep the existing session-based consultation until parity is demonstrated.

### 8. Migrate every auxiliary consumer, not just the main runner

Inventory all SDK imports and direct calls in source, tests and scripts. Update preflight/catalog/routing, judge, branch naming, commit text, proposal/authoring commands, attach/history/backfill, foreground and multiplexer command builders, persistent conversation services and provider-limit display. Keep the Convoy control protocol and terminal-host APIs unchanged.

Use V2's supported explicit-server continuation commands and authentication transport. Resolve the recorded session before invoking flags that can create a missing ID. Reopen exact harness-qualified references; unavailable V1 historical sessions follow existing truthful failure/placeholder contracts. Retain records/checkpoints and do not silently reroute a resumed model or import/delete session databases.

## Risks / Trade-offs

- [Admission mistaken for completion] → turn-specific settlement and deliverable checks for phases, advisor and helpers; test accepted-but-pending/failed cases.
- [Lost or misattributed events disable safety] → verified V2 fixtures, owned-session filtering, stream recovery and pending-state reconciliation.
- [Plugin/config not effective or mutable across runs] → active-tool/config readiness checks and immutable private per-run binding.
- [Authentication leaks or shared-service takeover] → redact before diagnostic retention, private auth transport and reuse existing lifetime ownership; test coexistence.
- [Permissive rule ordering or new tools weaken read-only] → effective-policy tests for direct, custom, MCP and nested calls; retain repository-baseline defenses.
- [Caps, models, usage or quota silently change] → actual request/settings verification, catalog settlement, frozen selections and truthful unavailable telemetry.
- [Native background behavior outlives phase settlement] → attribute existing allowed work and test its existing completion/abort expectations; do not introduce a new topology to hide the issue.
- [Historical session storage is not interoperable] → preserve durable references and existing unavailable-session behavior; no fabricated continuation or automatic database conversion.

## Migration Plan

1. Establish a traceable parity matrix and verified V2 package/runtime contract, then prove Bun imports, owned boot/auth/config/tools and bounded shutdown in an isolated no-model fixture.
2. Migrate a complete execution/report vertical path, followed by events/permissions/budgets and the full advisor path. Keep domain logic and regression assertions, replacing only obsolete protocol fixtures.
3. Complete all helper/catalog/conversation/terminal/history/limits consumers and frozen-record/resume paths. Do not release with a remaining V1-only consumer or an unexplained parity gap.
4. Validate the matrix below plus existing canonical suites, typecheck and build. Runtime fixtures must be independent of mocks that merely imitate V1. Run paid acceptance only with explicit authorization and bounded test scope/cost.
5. Document the tested runtime/client/plugin set and setup/continuation differences. Publish only after separately authorized delivery; this proposal does not authorize publication.

Rollback means restoring the prior Convoy build/dependencies and using an explicitly compatible V1 environment. Do not automatically downgrade the user's OpenCode or point V1 at V2-only config/data. Keep run history and private ownership records intact; a safe data/runtime rollback must be verified before attempting it.

### Parity validation matrix

| Contract area | Existing entry points / assertions to retain | V2 evidence required |
|---|---|---|
| Runtime/lifecycle/auth | `opencode`, `managed-server`, process lifecycle/teardown suites; canonical lifecycle | Version/API gate, protected endpoint, readiness/password redaction, observed owned stop and coexistence |
| Plans/models/context | config/pipeline/agents/attachments/model-routing/preflight suites | Unmodified YAML/overrides, frozen models/variants, effective attachments/settings and settled catalogs |
| Execution/results | runner/hosted-runner/step-runner suites | Admission versus settlement, retries, reminders, failure/timeout/abort and unchanged Claude capabilities |
| Events/transcripts | event-hub/attach/progress suites; canonical session transcripts | Native envelopes, ownership filter, reconnect, pagination and deduplication |
| Permissions/safety | permission/hold/safety-judge/bash-policy/loop-guard suites | All acceptance modes, hard deny, tool-less/read-only/verify, no-controller gates and effective fuses |
| Reports/bridges | report bridge/runtime and held-runner suites | Active plugin tools, trusted identity, fixed atomic destinations, rescue/hold, stale-handle and cross-run rejection |
| Advisor | advisor/runtime/bridge/events/report suites | All checkpoints, transcript/cap/settings, timeout/cancel, budgets, feedback, privacy and `NO CHANGES` |
| Usage/limits | usage/limits/runner/advisor-report suites | Cumulative/delta deduplication, cache/reasoning/cost split, thresholds and truthful unavailable quotas |
| Helpers/authoring/terminals | helper, conversations/service, spin/propose, install, terminal-host/herdr suites | Settled helper results, commands, exact authenticated continuation and restoration/independent lifetime |
| Goals/history/Git | metadata/goal-scheduler/step-commit/finalization suites; canonical contracts | Existing records/checkpoints, measurement isolation, qualified reports, hooks, writer claims and finalization |

The known feasibility checks are acceptance gates, not optional scope or grounds to remove a feature. Patch-version selection and exact supported argv/auth/config transport are resolved by the first contract/runtime gate within this approach, using published declarations and controlled fixtures.

#### Recorded evidence and open blockers (OpenCode 2.0.26, `@opencode/client` 2.0.26)

Verified against the real runtime with a scripted local provider (no paid model), in `test/opencode-v2-runtime.integration.test.ts`:

- Hard deny wins over the ask fallback and allowlist: V2 evaluates the bash map as an ordered ruleset where the last match wins, so `bashPolicy` emits `"*"` first and denials last.
- Allowlisted checks run without asking.
- `write_report` loads as a plugin package directory from the run config's `plugins` list and is offered directly (`codemode: false`).
- The operator's global config and providers still load: Convoy no longer sets `OPENCODE_CONFIG_DIR`, which replaces the global config directory in V2.
- A selected variant reaches the model request, and the catalog lists custom providers and variants as soon as the server is up.
- History carries the session id and tool call ids, and live V2 tool markers deduplicate against history.

Covered by V2 event fixtures in `test/runner-v2-events.test.ts`: loop-guard fuses (identical calls, same-tool failures, steps and cumulative cost).

Prompt admission (task 3.2): Convoy admits every prompt under a client-chosen V2 message id (`@opencode/schema` `Session.Message.ID`). The runtime admits an id once. A lost admission response is reconciled with `session.message.get` before it is reported as a failure, and a blocking helper prompt returns only the assistant reply that follows its own admitted message. Both are verified on the real runtime.

Terminal continuation:

- Session windows connect with `opencode <dir> --server <url>`. The server password is staged in a one-shot owner-only file. A `sh -c` wrapper reads it into `OPENCODE_PASSWORD` and deletes it before the client starts, so it also runs in a non-POSIX interactive shell (Herdr). The password never appears in a command line, `ps` or shell history.
- A re-run of the same command fails clearly instead of connecting without the password. Files whose window never ran are removed when Convoy exits. All of this is verified by running the real command under sh, bash and zsh.
- Standalone windows (stored session, iterate and authoring conversation) pass `--standalone`. This keeps V1's own-server behavior and stays off the user's background service.
- V2's `--session <id>` creates a missing session, so a stored-session window is verified first with `validateAuthoringSession`, the same check authoring conversations use, and refused when the session is gone. The real runtime refuses an unknown id without creating it.

`doom_loop`: V2 still accepts the permission key, but its runtime has no repeated-call detector that raises it. Convoy's loop guard identical-call fuse covers repetition and is verified on V2 event fixtures. Not a blocker.

Open blockers. These keep tasks 5.3 and 9.3 open:

- Agent and advisor temperature: OpenCode 2.0.26 forwards no temperature from configuration. It was probed on the real runtime through agent `temperature`/`options`/`request.body`, the V2 `agents` form, model `options` and a model variant; none reached the provider request. Convoy keeps emitting the setting, and `test.failing` flips when the runtime forwards it. This is an upstream runtime gap; Convoy cannot set it per request.
- No model-backed parity scenarios have been run. Task 9.3 requires explicit approval for paid runs.
