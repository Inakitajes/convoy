## Why

Convoy has code-confirmed paths that bypass shutdown of its OpenCode servers or retain a completed run after its controller disappears; the current close primitive sends a signal without confirming termination. Operators report accumulating memory-consuming `opencode serve` processes, so Convoy needs verifiable lifecycle ownership and safe recovery, without claiming that these mechanisms explain every historical report or confusing live orphans with OS zombies.

## What Changes

- Give run-owned and short-lived helper servers a shared, awaitable, idempotent stop operation with bounded SIGTERM grace, SIGKILL escalation, and an observed termination outcome; handle failed and interrupted startup as part of the same lifetime.
- Close proposal-discovery fallback helpers on all exits, and require an explicit transfer to independent service ownership before invoking an authoring command so recovery cannot mistake active authoring for an abandoned helper.
- Keep shutdown ownership and signal handling in effect through the coordinator's terminal hold and final release. Repeated aborts and the shutdown deadline force-stop owned servers before exiting rather than abandoning cleanup immediately.
- Release a completed/failed run's terminal hold when its controller explicitly leaves or its existing heartbeat lease expires. Do not apply this rule to active runs, permission gates, human gates, or authoring execution.
- Record the actual server process identity separately from the coordinator identity, outside disposable run workspaces. Reconcile attributable run/helper orphans during subsequent managed-server startup with bounded work, strict identity checks, and diagnostics for anything uncertain.
- Preserve lifecycle evidence until termination is observed; retain compatibility with existing run metadata and treat legacy records without child identity as ineligible for automatic killing.
- Preserve standalone OpenCode windows, independently persistent authoring services, and deliberate background execution. Do not add a global `pkill`, a general process-tree janitor, or an automatic authoring-service idle eviction policy.

## Capabilities

### New Capabilities

- `opencode-server-lifecycle`: Ownership, bounded shutdown, terminal-hold release, and fail-closed orphan recovery for Convoy-managed OpenCode servers, with explicit exclusions for independent lifetimes.

### Modified Capabilities

None. Existing `work-conversations` lifetime independence, `session-transcripts` historical fallback, and run-finalization/history contracts remain unchanged; the new capability adds process-lifecycle guarantees around them.

## Impact

- Server launch and client construction in `src/opencode.ts`; run shutdown/release in `src/runner.ts` and `src/coordinate.ts`; controller lease/finish-hold handling in `src/control-server.ts`, `src/control-progress.ts`, and `src/attach.ts`.
- Short-lived callers in preflight, model catalog, commit-message generation, branch naming, and conversation adapters must await cleanup. Authoring discovery must explicitly retain its independent lifetime rather than inherit run-owned recovery policy.
- Additive runtime process records and lifecycle diagnostics under Convoy's user-state directory; existing coordinator PID semantics in run metadata remain backward compatible.
- SDK clients remain in use, but the pinned SDK's server factory lacks the process handle and confirmed-stop contract needed here. Launching must be owned by Convoy while preserving config, environment filtering, cwd, URL parsing, and boot-abort behavior.
- Regression and subprocess integration tests on macOS and Linux, plus lifecycle and recovery documentation. No new external daemon or dependency is planned; no application code is changed by this proposal.
