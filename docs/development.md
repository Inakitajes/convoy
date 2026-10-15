# Development guide

[Documentation](README.md) · [Convoy](../README.md)

Build Convoy, run checks, and find the main source modules.

- [Development](#development)
- [Structure](#structure)

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

## Structure

```
convoy/
├── src/
│   ├── main.ts          # entrypoint
│   ├── cli.ts           # flag parsing
│   ├── runner.ts        # pipeline orchestration
│   ├── runners/         # harness-neutral runner ports/contracts (see below)
│   ├── opencode.ts      # startup/control via SDK
│   ├── managed-server.ts # owned `opencode serve` child launch + bounded observed stop
│   ├── process-stop.ts  # shared SIGTERM→SIGKILL stop state machine
│   ├── process-identity.ts # kernel birth/UID/executable probes (Linux /proc, macOS libproc)
│   ├── process-records.ts # private lifecycle records under ~/.convoy/processes + reconciliation
│   ├── agents.ts        # prompt loading, agent config, bash policy
│   ├── project-context.ts # automatic .convoy/rules.md, AGENTS.md, CLAUDE.md discovery
│   ├── permissions.ts   # live permission gate for tool calls that fall outside the allowlist
│   ├── safety-judge.ts  # external AI judge for smart auto-accept (tool-less, fail-closed)
│   ├── advisor.ts       # the advisor consultation: tool-less, over the executor's transcript, output-capped
│   ├── advisor-runtime.ts # per-run advisor policy: session→phase, budget, first-write checkpoint
│   ├── advisor-bridge.ts  # loopback endpoint + the custom `advisor` tool the executor calls on demand
│   ├── advisor-report.ts  # executor/advisor token split read back from the attempt logs
│   ├── attachments.ts   # FilePartInput for --file and internal attachments
│   ├── git.ts           # diff, commit, and pre-commit secret scan
│   ├── worktree-commands.ts  # the worktree control center's guarded CLI/TUI operations, incl. close
│   ├── close-journal.ts  # legacy close journal/receipt reading and evidence refs in the git common dir
│   ├── close-tui.ts      # close's full-screen checklist TUI
│   ├── publish.ts        # the deliberate Create pull request action: normal push, then locate/create PR
│   ├── finalization/    # guarded automatic run compaction: interval, lease, refs, executor
│   ├── commit-message.ts # writes the conventional commit message compaction and close propose
│   ├── step-commit.ts    # intermediate convoy(<step>) messages with a Convoy-Run trailer
│   ├── workspace.ts     # run dir, ~/.convoy home (CONVOY_HOME), global config/agents paths
│   ├── runs.ts          # interactive run-history browser (convoy runs)
│   ├── runs-tui.ts      # OpenTUI run-history browser rendering
│   ├── metadata.ts      # per-run metadata.json: frozen pipeline + --resume restore
│   ├── config.ts        # config loader/validation, global+project merge, YAML writer
│   ├── config-tui.ts    # interactive config editor (convoy config)
│   ├── model-catalog.ts # available-model list via OpenCode SDK, models.dev fallback
│   ├── version.ts       # injected version/commit/platform + --version and TUI header formatting
│   ├── update.ts        # GitHub Releases update check + verified atomic self-install
│   └── pipeline.ts      # built-in agents/pipeline and pipeline-spec resolution
├── scripts/             # build.ts: local + multi-target release binary compilation
├── prompts/             # built-in agent prompts and runtime safety guard rails
├── test/                # unit tests for CLI/orchestration
├── .github/workflows/   # release.yml: tag-triggered build, test, and GitHub Release publish
├── package.json
├── tsconfig.json
└── Makefile
```

---

## Runner compatibility and parity

Convoy is migrating from a single implicit OpenCode backend to explicit runner
ports (`src/runners/contracts.ts`) with independent OpenCode and Claude adapters.
The work is tracked in the OpenSpec change `runner-parity-opencode-v2`; its
`evidence/` directory holds the runner inventory and the compatibility record.

Runtime requirements and the current gate:

- **OpenCode** must be a supported V2 on `PATH`; Convoy never installs, updates,
  or replaces it. Exact selected client/plugin/schema versions and the tested CLI
  version are in `openspec/changes/runner-parity-opencode-v2/evidence/compatibility.md`.
- **Claude** baseline uses the operator's authenticated CLI with subscription
  authentication. Subscription authentication is not a no-cost guarantee: usage
  credits and paid features are governed by a separate billing policy. API-key
  execution is an explicit, separately selected mode.

Release gate: no part of the parity matrix in
`openspec/changes/runner-parity-opencode-v2/design.md` (decision D4) ships until
its mandatory cells have passing automated tests plus consented real-harness
acceptance. Advanced exceptions must name exact versions and authentication modes.
Until then, treat Claude parity and the runner ports as **in progress**: the
OpenCode path remains the shipped behavior.

The operator-facing guide is [Runners](runners.md); this section is the
source-facing summary.

### `src/runners/` module map

```
src/runners/
├── contracts.ts        # vendor-free ports: requests, events, outcomes, capabilities, registry
├── registry.ts         # composition root that registers the built-in adapters
├── declarations.ts     # authoritative per-adapter capability declarations
├── capabilities.ts     # effective capability resolution from a declaration + evidence
├── policy.ts           # runner-neutral action policy (read/write/execute/delegate decisions)
├── deliverables.ts     # runner-neutral report/score/commit validator + ledger
├── quality-contract.ts # contract-based validation of a phase's produced artifact
├── advisor-consult.ts  # normalized consultation context + first-write checkpoint
├── advisor-limits.ts   # advisor call/output/time/recursion limits and budget
├── journal.ts          # versioned append-only normalized event journal
├── provenance.ts       # per-attempt runner/auth/session/attempt record + legacy reader
├── usage.ts            # token/cost normalization and cumulative-delta subtraction
├── redaction.ts        # secret registration and log redaction
├── abort.ts            # shared user-abort signal (engine, adapters, entrypoints)
├── errors.ts           # vendor/shape-tolerant error message extraction
├── claude/             # Claude adapter: adapter, auth, effective-auth, mode, settings,
│                       #   hook, enforcement, permission-broker, mcp-permission-server, mcp-stdio
└── opencode/           # OpenCode v2 adapter: adapter, boot, runtime, v2-client, config,
                        #   history, log-events, permission, server-auth, terminal,
                        #   phase (attempt loop), session (watch/checkpoint/event runtime)
```

### Runner ports and ownership responsibilities

- `src/runners/contracts.ts` is Convoy-owned and **vendor-free**: execution
  requests, normalized events, attempt outcomes, runner-qualified sessions,
  described capabilities, and the `RunnerRegistry`. No SDK type may appear here.
- Adapters live under `src/runners/` and are the **only** place a vendor harness
  package may be imported. `test/runner-boundaries.test.ts` enforces this with a
  shrinking burn-down allowlist of the modules that still import one; a new
  off-boundary import fails the suite.
- Dependencies are **one-way**: an adapter never imports the engine
  (`src/runner.ts`). The OpenCode session/watch/checkpoint runtime lives with its
  adapter (`src/runners/opencode/session.ts`) and the engine imports it back, so
  there is no cycle; `test/runner-adapter-direction.test.ts` enforces the
  direction. `ShutdownHandle` is the structural slice of the engine's
  `RunShutdown` the runtime needs, which keeps the engine type out of the adapter.
- `test/helpers/runner-conformance.ts` is the shared conformance suite every
  adapter must pass; real adapters run it from their own tests.
- **Core keeps** scheduling, goal rounds, budgets, retries, Git coordination,
  writer claims, quality loops, report validation, and advisor policy. **Adapters
  own** their protocol client, native event decoding, permission interception,
  and harness process ownership, and translate all of it into the neutral
  vocabulary.

### Adding a harness

A new harness needs no engine change:

1. An adapter under `src/runners/<harness>/` implementing `ExecutionAdapter`
   (capabilities, `executeAttempt`, `cancelAttempt`, optional `release`) plus
   optional `SessionControls` and Convoy services.
2. Its capability declaration in `src/runners/declarations.ts`.
3. Its phase attempt (`PhaseAttemptRunner`) and its registration in
   `src/runners/compose.ts` (`registry.register` and `attemptFor`).
4. Its conformance test: call `runExecutionConformance(id, makeAdapter)` from
   `test/helpers/runner-conformance.ts`.

The engine prepares one neutral `AttemptContext` and resolves the attempt through
`resolveAttempt` (capability validation, then the registered attempt), so core
carries no branch for the harness. See `test/runner-test-harness.test.ts` for a
minimal example.

[Back to documentation](README.md)
