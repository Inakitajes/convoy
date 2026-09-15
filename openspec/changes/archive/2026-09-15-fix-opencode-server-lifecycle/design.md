## Context

See `proposal.md` for motivation and `specs/opencode-server-lifecycle/spec.md` for the contract. This design is required because shutdown crosses the server launcher, runner, coordinator, control protocol, and runtime state; recovery also introduces process-identity and migration concerns.

### Corroborated evidence and corrections

The baseline audited is `e7061bb` (Convoy 0.9.0). These are source-confirmed mechanisms, not proof of the cause of every historical accumulation:

| Evidence | Finding | Consequence |
| --- | --- | --- |
| `src/runner.ts:125-140` | Repeated requests and the 15-second timer call `process.exit(130)` | Async server release can be skipped entirely |
| `src/runner.ts:1044-1112`, `src/coordinate.ts:366-390` | Signal handlers are removed at entry to the runner's finally; hosted server release happens later, after the coordinator's finish hold | Catchable signals during teardown/hold can bypass owned-child cleanup |
| `src/opencode.ts:142-179,182-215` | Direct boot uses a single SIGTERM; SDK boot returns only URL/client/close | No awaited termination or actual run-child identity |
| Published `@opencode-ai/sdk@1.18.4`, `dist/v2/server.js:69-75`, `dist/process.js:4-13` | SDK close calls `stop`, which calls `proc.kill()` on POSIX | SDK close is not an exit acknowledgement or bounded escalation |
| `src/control-progress.ts:113-121`, `src/control-server.ts:143-153,274-327,382-393` | Controller presence is checked only before entering a finish hold; `/bye` and heartbeat expiry do not resolve it | A parked terminal hold can survive the controller indefinitely |
| `src/metadata.ts:387-397` | `server.pid` is `process.pid`, not the SDK child PID; metadata is cleared before close | Legacy fields cannot authorize orphan-child termination |
| `src/coordinate.ts:89-119` | Pending sweep removes directories for dead owners | No run-child reconciliation, and pending logs are disposable |
| `src/cli.ts:1623-1724` | Proposal fallback boots a server; unknown command discovery returns before `boundedClose`, while successful authoring returns without an explicit ownership transfer | Read-only failure paths need guaranteed close; active authoring needs an independent owner, not an indiscriminate helper stop |

SDK evidence was read from the published [1.18.4 package tarball](https://registry.npmjs.org/@opencode-ai/sdk/-/sdk-1.18.4.tgz), extracted during the preceding investigation, not from installed workspace dependencies. Recheck the same behavior if the pinned version changes during implementation.

The following earlier interpretations must NOT drive implementation:

- A live process adopted by PID 1 is not necessarily abandoned; true zombies have exited and normally do not retain substantial resident memory. Historical server counts and their specific states were not reproduced in this corroboration.
- The ratio of OpenCode `creating instance`/`disposing instance` log messages is not a process leak measurement; internal instances and signal exits do not map one-to-one to those messages.
- Waiting permission/human gates and detached active runs are intentional and recoverable, not candidates for automatic cancellation.
- `ControlProgress.runFinished` currently awaits a resolve-only promise. A hypothetical rejection is a reason for defensive release placement, not an observed production failure.
- Independent authoring service persistence is compatible with `work-conversations`; its stop helper lacking production callers does not prove a leak.
- Earlier ad-hoc probes reported that a local OpenCode binary exited on SIGTERM, and that a shell child could survive it. These are limited observations, not deterministic regression tests. No new OpenCode process or model request is needed to author these artifacts.

## Goals / Non-Goals

**Goals:**

- Make process ownership cover the entire interval from spawn to confirmed exit, including helper callers outside a coordinator.
- Separate best-effort application/session cleanup from compulsory bounded server cleanup.
- Recover provable run/helper orphans at a later managed startup without conflating them with durable services or old metadata.
- Test process behavior with isolated fixture children, without models, credentials, or user process mutation.

**Non-Goals:**

- Automatically stop authoring services on idle, terminal closure, or creator death; add a new public process-management command; or change background run semantics.
- Immediately recover from SIGKILL when no later Convoy process runs. A watchdog/daemon is deliberately not introduced.
- Kill arbitrary descendants or promise complete process-tree containment. MCP/tool subprocesses can create new sessions/process groups; stopping one group cannot guarantee their removal. This change guarantees the owned `serve` child lifecycle, not a universal tool-process reaper.
- Kill unrecorded legacy processes, treat PPID 1 as ownership, shrink OpenCode's database, or change durable run/session history.

## Decisions

### D1. One owned launch primitive, explicit lifetime classes

Introduce a shared managed-server module underneath `startOpencode` and `bootOpencodeServerFrom`. Convoy owns the `node:child_process` handle, uses the existing SDK for clients, and returns an awaitable `close(): Promise<StopOutcome>` plus explicit child identity. Preserve wrapper names if useful for callers, but migrate types, fakes, and every owned-call `finally` to await close.

Each launch must explicitly select `run`, `helper`, or `authoring-service`. Only the first two join the owner shutdown registry and dead-owner reconciliation policy. An injected service URL conveys no shutdown right. Authoring boot failures still clean up their newly spawned child; after successful publication the independent discovery record controls its lifetime.

Classify by execution ownership, not by whether a filename contains "conversation":

| Caller | Lifetime and handoff |
| --- | --- |
| Pipeline server | `run`, owned through coordinator release |
| Provider/model discovery, commit/branch naming | `helper`, stopped on operation success, failure, or timeout |
| Per-call session create/validate/status/command-list queries | `helper`; session creation alone does not start independent execution, and the durable session reference does not extend the helper's lifetime |
| Borrowed authoring service | No close right for the borrower; independent service owner remains authoritative |
| Proposal fallback before command invocation | `helper` for discovery, with unconditional cleanup on early return/error; before starting an authoring command it must be published/transferred to the repository's independent conversation service under its discovery lock, or reuse a service that won that race and close the unused child |

If the proposal fallback cannot safely establish/reuse independent service ownership, refuse command invocation, stop the still-owned helper, and leave ordinary standalone conversation available. Update persisted lifetime and unregister creator-death cleanup as part of the transfer before any command execution; failed/ambiguous publication must not leave a helper record authorizing a later kill of an active authoring service. Successful authoring outlives the view under the existing conversation contract. No automatic transfer is inferred from external clients: attaching to a **run-owned** server is inspection of that run, not an independent lifetime lease; its owner stop/death can close that connection.

Preserve existing launch semantics: loopback binding, allocated port, 30-second readiness timeout, strict readiness-line parsing, supplied config via `OPENCODE_CONFIG_CONTENT`, inherited cwd for SDK-style callers versus explicit checkout for conversation helpers, and current `HERDR_*` stripping behavior of `startOpencode`. Use explicit per-child env rather than widening a global env mutation window. Keep streaming fetch timeout behavior unchanged. Install spawn/error/exit/output listeners before waiting; bound diagnostic stdout/stderr tails while continuing to drain pipes.

Register the live handle synchronously after spawn, capture birth identity, persist ownership before exposing readiness, and clean up if identity capture, record publication, URL parsing, or client construction fails. Handle already-aborted signals and readiness/abort races. No branch may lose its reference to the spawned child.

**Alternative rejected:** wrapping SDK `close()` alone. The pinned factory does not expose the child handle or awaited exit, so it cannot implement the required guarantees. Do not infer PID from a port listener.

### D2. Bounded, shared stop state machine

Use one stop promise and explicit outcomes:

```
starting -> ready -> stopping (SIGTERM) -> stopped
    |                   |
    +-- failure --------+-- grace expired -> forcing (SIGKILL)
                                               |          |
                                            stopped    unresolved
```

Default server grace is 2 seconds, followed by at most 1 second for forced-exit observation. A forced request bypasses the remaining graceful interval and shares the existing promise. Tests inject timers and signal/exit seams. A returned `kill()` boolean is only signal delivery evidence, never successful stop.

For a direct child, attach exit observation before signaling and reap through the child-process API. Already-exited children settle without another signal. Bound waiting for pipe closure separately from child exit: inherited pipes in unrelated surviving descendants must not keep server shutdown open forever. Dispose listeners, drainers, and timers when they no longer serve the state machine. Optional bookkeeping errors must not skip the signal/exit path.

Target the owned child, not the coordinator's process group and not all children by name. No group kill is necessary for the direct-serve guarantee; adding one would create a false claim about descendants that detach themselves.

**Alternative rejected:** SIGTERM-and-return or unconditional SIGKILL. The former never verifies resource release; the latter discards a useful graceful window for normal exits.

An outer operation-timeout race is not sufficient cleanup ownership. In particular, preflight's timeout can return before its discovery coroutine's `finally` settles. Timeout paths must explicitly cancel the operation and await the owned stop outcome without waiting indefinitely for the original request promise. Standalone helper operation deadlines can be followed by at most the 3-second cleanup allowance; helpers running under a coordinator use its remaining global shutdown budget instead. Verify both successful and timeout-return paths rather than only replacing `close()` calls with `await close()`.

### D3. Ownership follows the coordinator through final release

Place the production coordinator's lifecycle/signal scope outside `run()`, spanning initialization through `result.release()`/error teardown. Direct programmatic runs retain equivalent local scope. Helper-only CLI operations use the shared owner registry while a managed helper is present; installing it must not compete with the coordinator's handler or turn normal view detachment into cancellation. Raw-mode UI abort and process SIGINT/SIGTERM/SIGHUP route to the same owner shutdown state. Do not forward parent-terminal SIGHUP into the deliberately detached coordinator.

Concretely, pass the coordinator-owned shutdown context into hosted `run()` and skip its current local `installShutdownSignals`/`dispose` path in that mode. Hosted `run()` may unregister its execution callbacks when complete, but not the owner's process handlers or registry. Direct calls create and dispose a local owner scope; nested helpers register children with the already-active scope rather than installing another handler set. A single incoming process signal must increment exactly one shutdown request counter.

Keep the current 15-second overall graceful shutdown ceiling. Reserve the last 3 seconds for server stop: session cancellation and optional cleanup cannot consume that reserve. A second abort transitions directly to forced server stop, observes for at most 1 second, then exits with the existing abort code. A deadline-triggered force path likewise attempts termination before exit. Repeated signals while forcing are idempotent, not new immediate `process.exit` calls. An unresponsive JS event loop remains outside the guarantee; hard-kill recovery is D5.

Retain hosted release from both result and error paths, but guard it with a coordinator-level `finally`. During terminal hold, a signal resolves only that presentation wait and triggers release. During abort cleanup, failures/hangs in session cancellation, notifiers, permissions, metadata, or leases cannot prevent server termination. Keep bridge shutdown before terminating the server where possible, but do not let bridge or persistence failures bypass termination. Keep abort handling installed until owned stop attempts and bounded final cleanup settle.

Do not make `serverStopped()` or writer-claim release proof of actual death. Confirm child exit before clearing live-server metadata/releasing execution ownership on the ordinary path. If stop remains unresolved, persist the unresolved process record before exiting where possible, and do not erase it while cleaning the workspace. Preserve existing writer-conflict reconciliation rules rather than inventing a claim takeover policy in this change.

**Alternative rejected:** adding an asynchronous `process.on('exit')` handler. Exit handlers cannot await cleanup and cannot handle SIGKILL. The last-resort deadline must invoke the synchronous signaling edge before deciding to exit, not merely queue an async cleanup job.

### D4. Finish holds subscribe to controller lease state

Add a lease-state notification/timer owned by the control server. Refresh, claim, valid `/bye`, and expiry update this state; expiry runs even when no HTTP request arrives. Reuse the existing 15-second timeout and detect expiry within one additional second under normal scheduling. Dispose the timer with the server.

`ControlProgress.runFinished` registers a finish-only waiter against current controller state and rechecks immediately after registration to close the check/subscribe race. Valid departure resolves it immediately. Silent expiry resolves it after checking that no replacement controller currently owns the slot. Expired credentials cannot resurrect their old lease without a new claim; a delayed old `/bye` or timer cannot dismiss a replacement controller. Explicit abort/dismiss remains idempotent. Observer requests neither hold nor dismiss the terminal screen.

This notification does not resolve permission/human queues, abort paused/executing runs, or release writer claims. If no controller is present at terminal-hold entry, preserve immediate release. Connected inspection retains the live run server; once terminal cleanup has started, later viewers use the existing historical/stored-session fallback.

**Alternative rejected:** a blanket no-client TTL for all runs/services. It would cancel legitimate background execution and violate conversation and writer-lifetime contracts.

### D5. Durable transient records and conservative reconciliation

Store private, versioned lifecycle records under `~/.convoy/processes/`, independent of `pending/` and disposable workspaces. These are transient execution evidence, not worktree ownership or a feature registry. Use atomic writes, private directory/file modes, a unique record ID, and a per-record exclusive reconciliation lock. Fields include lifetime, owner identity, child identity, run ID if available, URL when ready, state, and bounded last-stop outcome. Do not store credentials, prompts, full env, or config.

Process identity comprises PID plus kernel-derived birth identity (including a boot discriminator), UID, and expected executable/serve role. Use an injected platform adapter: Linux `/proc` start ticks plus `/proc/sys/kernel/random/boot_id` and process/executable observations; macOS system `libproc` (Bun FFI) for process start seconds/microseconds and executable observations, paired with kernel boot time from `sysctl kern.boottime` as the boot discriminator. The macOS boot discriminator is not supplied by libproc itself. Load platform support lazily and verify standalone builds on both supported OSes. `Date.now()` at record creation or human-formatted `ps lstart` alone is not a birth identity. Unsupported platforms or failed probes return unknown and never become destructive targets. Startup cannot expose a new managed run/helper without publishing its required identity; failure uses the still-owned child handle for bounded cleanup.

Create a provisional record before spawn, update it with child identity immediately after spawn and before readiness, and retain unresolved records on failure. There is an unavoidable interval between OS spawn and durable child identity publication; SIGKILL in that interval may leave an unattributable child. Do not invent a safe automatic kill for that interval. Record/report incomplete evidence and document the limitation rather than introduce a supervisor in this change.

Before a managed run/helper boot, perform a bounded pass over these records (initial defaults: at most 32 inspected records and 5 seconds total). Maintain a fair cursor across passes; do not always revisit only the oldest uncertain records. Check remaining budget before starting a full stop attempt; preserve deferred entries. One failed or inaccessible record must not stop unrelated processing or fail a new launch merely because recovery could not classify an old record.

Under the record's exclusive lock, reread and verify:

1. Version and lifetime are eligible (`run`/`helper`).
2. The original owner incarnation is provably gone, not merely UI-less or slow; a different process at the old owner PID is not that original owner. Permission/probe errors mean uncertain.
3. The target is the recorded child incarnation and expected same-user executable/serve role.
4. Revalidate owner and child immediately before each destructive transition, including forced escalation.

Only then apply the bounded stop algorithm. Independently proven ownership permits terminating a wedged server whose HTTP endpoint does not answer. A responding HTTP endpoint adds diagnostic context but is neither necessary nor sufficient kill authority. Identity mismatch receives no signal; preserve a bounded skipped/mismatch diagnostic. Already-gone children and confirmed stops can have their transient records removed. Locks and cursor updates must themselves be bounded; use fail-closed contention handling, not read-then-unlink reclamation of another live worker's lock.

Normal stop updates outcome before removing records; unresolved records survive later pending/workspace sweeps. A normal success emits a compact lifecycle log line, while uncertain recovery emits a warning with record location and safe inspection guidance. Do not persist a log for every successful short-lived server indefinitely. Existing logs and process records must exclude tokens, full environment, and prompts.

**Alternatives rejected:** kill by PPID/name/port; reinterpret legacy `server.pid`; require healthy HTTP before stopping a proven orphan; add a daemon for immediate owner-death detection. These respectively risk unrelated work, target the wrong PID, miss wedged orphans, or substantially expand deployment scope.

### D6. Backward-compatible metadata and independent authoring boundary

Keep `metadata.server.pid` as the historical coordinator/owner anchor. Add optional explicit child identity/process-record reference for new runs, or link it from the runtime record by run ID; do not change legacy reader semantics. Lifecycle authority comes from the new runtime record, not inferred run completion, a stale lease, or a port scan. History readers ignore missing optional identity fields as before.

The authoring service continues to use its independent discovery record, not creator-death recovery. Adapt its handle types and explicit stop outcome where touched by D1/D2, but do not add automatic eviction or a new CLI stop policy. For newly booted authoring services, retain enough identity to avoid weakening existing guarded-stop intent. Legacy authoring records still support non-destructive discovery; insufficient identity must not authorize a new automatic stop. Publication failure must close the unpublished child rather than leaking it.

**Alternative rejected:** converting all authoring services to creator-owned helpers. That would terminate independent execution merely because a view exits, contrary to `work-conversations`.

### D7. Deterministic regression and subprocess verification

Extend existing tests around `opencode`, `runner`, `runner-hosted`, `coordinate`, `control-server`, `attach-controller`, `coordinated-hold`, and conversation-service boundaries. Unit tests inject process probes, deadlines, clocks, persistence failures, and exit behavior; no test may call real `process.exit` in the test runner.

Subprocess fixtures, invoked only during implementation/verification, exercise real OS boundaries: normal exit, ignored SIGTERM, malformed/no readiness output, failed client construction, abort/readiness race, owner force-exit, and orphan recovery on a subsequent launch. Test children must never load user OpenCode configuration, use model credentials, or match broad user-process scans. Record exact fixture PIDs/birth identities and clean them in test teardown even when assertions fail. Simulate identity mismatches and probe errors without signaling unrelated real processes.

Add a no-client-requests expiry test, valid `/bye` during hold, replacement/observer/stale-controller cases, plus negative tests showing permission/human gates and active runs stay alive. Add repeated helper boot/stop cycles and assert no fixture children/records/listeners remain after confirmed shutdown; memory snapshots alone are not leak assertions.

## Risks / Trade-offs

- **PID reuse and probe/signal races** → Prefer direct child handles while the owner lives; use kernel birth identity and immediate revalidation for recovery. Portable POSIX PID signaling still has a residual TOCTOU window, especially on macOS; do not claim it is an atomic security boundary or use low-resolution identity fallbacks.
- **Platform identity support and compiled Bun builds** → Test Linux and macOS adapters and standalone release paths; unknown observations stay non-destructive. No native third-party addon is introduced.
- **SIGKILL/crash before publication or no future launch** → Recovery is eventual and limited to attributable records; immediate containment needs a future supervisor design.
- **Forced stop can interrupt writes** → Use bounded graceful session/server stop first; never compact or report a successful run merely because shutdown completed; preserve recovery/history evidence.
- **Raw-mode signals, helper timeouts, and owner handlers can overlap** → One owner shutdown state and idempotent stop; regression-test signal scopes rather than installing competing handlers per module.
- **Abandoned finish cleanup removes live inspection availability** → Keep the existing heartbeat lease, preserve connected controllers, and use existing stored-session reopening after release. Active/gated runs remain unaffected.
- **Descendant processes can outlive the server** → Explicitly out of the server-lifecycle guarantee; do not sell direct-child cleanup as complete MCP/LSP/tool containment.
- **Persistent authoring services still consume memory** → Intentional independent lifetime; visibility/explicit idle-stop policy is a separate product decision, not an automatic kill in this fix.
- **Uncertain records can persist** → Bound scanning and diagnostics, ensure fairness, remove proven stopped records, and retain uncertainty rather than deleting kill-safety evidence.

## Migration Plan

1. Implement process identity/record storage and owned launch/stop primitives with isolated tests, leaving existing metadata interpretation intact.
2. Migrate run/helper call sites and the coordinator's whole-lifetime shutdown scope; explicitly classify authoring-service and injected handles.
3. Add finish-only lease notifications and safe startup reconciliation; validate preservation of active/background/gated execution.
4. Document the automatic cleanup boundary, eventual recovery after owner death, legacy/incomplete-record exclusions, and how to inspect PID/PPID/state/birth evidence without broad kill commands.
5. Run targeted and full tests, typechecking, and builds on macOS/Linux before shipping. Optional smoke tests with an installed OpenCode binary require separate implementation-time execution and isolated state, not the user's active servers.

Rollback is code-only: older versions ignore the new private process records and optional metadata. Do not delete unresolved records during rollback; they may be reconciled after re-upgrade. Legacy already-orphaned servers remain manual inspection cases because no trustworthy child identity was recorded at launch.
