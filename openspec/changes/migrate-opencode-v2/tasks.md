## 1. Establish the parity baseline and compatibility gate

- [ ] 1.1 Inventory all V1 SDK imports, direct API calls, CLI builders, generated tools and existing defaults against HEAD `22b29dd`; verify every consumer and spec requirement is mapped to an owner/test case in the design's parity matrix.
- [ ] 1.2 Select and document a concrete V2 runtime/client/plugin combination using released declarations and isolated Bun import checks; verify the actual tested versions rather than assuming the researched `2.0.25` contract covers the currently installed `2.0.26`.
- [ ] 1.3 Prove foreground startup/auth, run-config discovery, plugin resolution and bounded owned shutdown in an isolated no-model fixture; verify passwords are redacted and no shared service/config/data is changed, recording blockers instead of reducing scope.

## 2. Replace the client and managed connection boundary

- [ ] 2.1 Replace the V1 SDK dependency/types with the confirmed pinned V2 packages and update `bun.lockb`; verify a frozen install, package imports and boundary type checks succeed.
- [ ] 2.2 Add local runtime compatibility validation and version evidence at managed OpenCode entry points; verify missing/V1/unsupported binaries fail before model work or mutating hooks without installing/updating OpenCode.
- [ ] 2.3 Adapt `opencode.ts`/`managed-server.ts` readiness, private authentication, fetch cancellation and connection reuse; verify startup races, failure-after-spawn, diagnostic redaction, existing lifetime classes and observed-stop subprocess tests.

## 3. Migrate phase execution through a valid report

- [ ] 3.1 Map session creation, model/agent/variant selection and text/file/context inputs to the confirmed V2 contract; verify request fixtures preserve target checkout, attachment content, instructions and frozen selections.
- [ ] 3.2 Replace prompt/result handling with admission identity and turn-specific settlement/reconciliation; verify accepted-but-pending, lost response/idempotency, stale output, provider failure, timeout, reminders and explicit abort/exit-130 cases.
- [ ] 3.3 Port a working `write_report` registration and owned run binding through the V2 plugin while retaining the report bridge/runtime; verify effective tool loading, trusted session identity, schema validation, fixed atomic destinations, scoring/commit sidecars and strict read-only report persistence.
- [ ] 3.4 Connect that execution/report path to the existing runner and failure/retry hooks; verify a settled report reaches the existing gate/commit path, while admission or missing setup/report cannot declare success and Claude runner assertions remain unchanged.

## 4. Preserve observation, permissions and execution budgets

- [ ] 4.1 Adapt event envelopes/tool-step-text-reasoning identities and owned-session dispatch; verify versioned V2 fixtures, unrelated-session isolation, startup observation ordering and bounded reconnect/pending-state reconciliation.
- [ ] 4.2 Adapt agent/session permissions and replies without changing policy; verify Interactive/Auto-accept/Smart, hard deny, judge fail-closed, per-session pause, strict read-only/verify and direct/custom/MCP/nested tool-less restrictions.
- [ ] 4.3 Adapt usage/pricing/token fields and loop-guard observations; verify cumulative/delta/reconnect deduplication, executor/advisor split, existing fuse thresholds and follow-up reset-versus-cumulative cost behavior.
- [ ] 4.4 Preserve recovery handles and controller-held gates across the V2 path; verify same-session reopen, updated report continuation, no-controller waits, stale-attempt rejection, retry/reset/abort and terminal-hold lifecycle tests.

## 5. Preserve the full advisor workflow

- [ ] 5.1 Port `advisor` and `advisor_feedback` registration alongside `write_report` with immutable private run binding; verify unchanged inputs/results, authentication, feedback correlation/idempotency, cancellation and concurrent-run token isolation.
- [ ] 5.2 Adapt fresh consultation create/admit/settle/history/cleanup and paginated bounded transcript export; verify text/reasoning/tool/failure inputs, advisor reasoning suppression, empty-result degradation, timeout and run-abort cleanup.
- [ ] 5.3 Preserve effective advisor model aliases, output cap, temperature and routing on the confirmed runtime; verify captured applicable model requests honor those settings without changing executor requests or enabling consultation tools.
- [ ] 5.4 Reconnect on-demand, edit-based first-write and completion triggers to existing advisor policy; verify first-write ordering before auto-accept, failed-call budgets, privacy/usage journal, completion follow-up, `NO CHANGES` and structural error propagation without persistent/native-subagent redesign.

## 6. Migrate catalogs, helpers and provider telemetry

- [ ] 6.1 Adapt model/provider catalogs, plugin settlement and preflight/routing; verify all executor/advisor/goal/judge selections and variants, configured overrides and actionable unsupported-model errors without silent rerouting.
- [ ] 6.2 Migrate safety-judge, naming and commit-text helper execution through the settled V2 result path; verify existing parsing/failure policies, explicit model choices, tool-less behavior and bounded owned-helper cleanup.
- [ ] 6.3 Adapt provider-limit observation using the supported V2 integration; verify the existing display remains functional where data is available and retains truthful unavailable/error behavior with no credential exposure or invented quota.

## 7. Preserve conversations, terminal entry points and transcripts

- [ ] 7.1 Migrate proposal/OpenSpec authoring and command/session consumers; verify settled command behavior, checkout-scoped context, writer coordination and independent service ownership with existing conversation/propose/spin assertions.
- [ ] 7.2 Adapt foreground/external/Herdr/Zellij OpenCode command builders and private authentication transport; verify exact-session existence checks, operator-shell resolution, quoting, terminal restoration and no unintended shared-service startup/replacement.
- [ ] 7.3 Preserve opt-in `/convoy-spin` installation and existing supported user definitions; verify install ownership/foreign-file preservation and V2 command discovery without rewriting unrelated global/project configuration.
- [ ] 7.4 Adapt live attach and paginated transcript/history reconstruction; verify reasoning/text/tool display, live/history deduplication, late/reattach backfill and honest unavailable historical-session placeholders without fabricated continuation.

## 8. Verify unchanged run, goal and Git behavior

- [ ] 8.1 Validate built-in/custom YAML, overrides, hooks, parallel execution and existing frozen metadata under V2; verify config/pipeline/runner regression suites and V1-created record readability without reinterpreting coordinator identity.
- [ ] 8.2 Validate goal measure/improve cycles, qualified reports, measurement isolation and checkpoint resume/retry; verify the canonical goal behavior remains one logical run with existing workspace/server/gates rather than native scheduling.
- [ ] 8.3 Validate writer claims, repository checks, semantic step commits and automatic Git finalization; verify canonical lifecycle/finalization assertions, success/failure/abort hook outcomes and independent-service protection remain unchanged.

## 9. Complete migration acceptance and operational documentation

- [ ] 9.1 Replace remaining V1-shaped tests/scripts with confirmed V2 contract fixtures while retaining domain assertions; verify the consumer inventory has no residual production V1 SDK/API/CLI path and all contract/failure cases are covered.
- [ ] 9.2 Run `bun run typecheck`, relevant/full `bun test` suites and `bun run build` in authorized test environments; verify all results are recorded, with isolated runtime/plugin evidence distinguished from mocked results.
- [ ] 9.3 After explicit approval for model-backed acceptance, run bounded parity scenarios covering report-only/verify, advised first-write/completion, parallel review, human recovery, cancellation and goal/resume; verify every required matrix row has passing evidence or remains an explicit blocker.
- [ ] 9.4 Document the tested runtime/client/plugin set, local-PATH prerequisite, actionable compatibility errors, auth/continuation differences and safe rollback limits; verify documentation does not promise an automatic installer, V1 dual support or unvalidated historical data conversion, and no unresolved parity gap is marked complete.
