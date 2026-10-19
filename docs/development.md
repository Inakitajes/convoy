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
│   ├── runs-command.ts  # convoy runs --json/--wait and approve/deny/abort for scripts and agents
│   ├── pipelines-command.ts # convoy pipelines: the catalog and one pipeline's resolved steps
│   ├── skill-install.ts # convoy skill: installs the embedded agent skill (skills/convoy) per harness
│   ├── runs-tui.ts      # OpenTUI run-history browser rendering
│   ├── metadata.ts      # per-run metadata.json: frozen pipeline + --resume restore
│   ├── config.ts        # config loader/validation, global+project merge, YAML writer
│   ├── config-tui.ts    # config screen: lists config files, opens $EDITOR (convoy config)
│   ├── config-files.ts  # which config files exist, whether they load, the editor command
│   ├── model-catalog.ts # available-model list via OpenCode SDK, models.dev fallback
│   ├── version.ts       # injected version/commit/platform + --version and TUI header formatting
│   ├── update.ts        # GitHub Releases update check + verified atomic self-install
│   └── pipeline.ts      # built-in agents/pipeline and pipeline-spec resolution
├── scripts/             # build.ts: local + multi-target release binary compilation
├── prompts/             # built-in agent prompts and runtime safety guard rails
├── skills/convoy/       # the agent skill (SKILL.md + references), embedded by skill-install.ts
├── test/                # unit tests for CLI/orchestration
├── .github/workflows/   # release.yml: tag-triggered build, test, and GitHub Release publish
├── package.json
├── tsconfig.json
└── Makefile
```

---

## Runner compatibility and parity

Convoy is migrating from a single implicit OpenCode backend to explicit runner
ports (`src/runners/contracts.ts`) with independent OpenCode, Claude, and Codex
adapters, each described once in `src/runners/descriptors.ts`.
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
- **Codex** runs on an owned `codex app-server` (0.160 or later; tested on
  0.163.0). The protocol is labeled experimental upstream, so the adapter
  speaks a small hand-typed subset (`src/runners/codex/protocol.ts`) and reads
  every field defensively; regenerate the reference schema with
  `codex app-server generate-json-schema --experimental --out <dir>` when moving
  the minimum version. Evidence for each enforcement claim is in
  `openspec/changes/archive/2026-10-19-add-codex-runner/evidence/`.

Release gate: the parity matrix in
`openspec/changes/runner-parity-opencode-v2/design.md` (decision D4) ships when
its mandatory cells have passing automated tests plus consented real-harness
acceptance. The automated cells pass; real-harness acceptance is opt-in
(`CONVOY_ACCEPT=1 bun run scripts/runner-acceptance.ts`, which drives real
`run()`s through preflight, attempt, report, and finalization), and the
API-key and full paid-cycle cells are recorded as deferred in
`evidence/compatibility.md` rather than claimed.

The operator-facing guide is [Runners](runners.md); this section is the
source-facing summary.

### `src/runners/` module map

```
src/runners/
├── contracts.ts          # vendor-free ports: requests, events, outcomes, capabilities, registry
├── descriptors.ts        # one descriptor per runner: models, labels, binary, auth, report tool
├── compose.ts            # composition root: registrations, attempts, service binding
├── attempt.ts            # the common attempt context/result + attempt resolution
├── attempt-composition.ts# one composition per run, released at run teardown
├── attempt-sink.ts       # neutral events rendered onto the run's progress target
├── declarations.ts       # authoritative per-runner capability declarations
├── capabilities.ts       # effective capability resolution from a declaration + evidence
├── policy.ts             # runner-neutral action policy (hard denials, roots, shell parsing)
├── phase-policy.ts       # one attempt's reviewed policy (the rules OpenCode's config encodes)
├── session-deliverables.ts / session-advisor.ts  # session-scoped services both runners bind
├── service-runtimes.ts / session-handles.ts      # engine runtimes and their per-session release
├── coordinator-events.ts # durable per-run journal, in-process read model, file follower
├── journal.ts / transcript.ts # append-only event journal and its offline (gap-aware) reader
├── provenance.ts         # per-attempt runner/auth/model/session record + legacy reader
├── billing.ts            # billing decision for a CLI runner's authentication selection
├── helper-inference.ts   # one-shot judge/helper/advisor inference by runner
├── attempt-bridge.ts / attempt-tools.ts # the loopback bridge and Convoy tools CLI runners serve
├── loop-guard-service.ts # the loop guard every runner that can steer or stop binds
├── subcommand.ts         # re-invoking this Convoy as `convoy hook` / `convoy mcp`
├── plan-dependencies.ts  # every runner a whole plan needs, checked at preflight
├── quality-contract.ts   # contract-based validation of a phase's produced artifact
├── redaction.ts / errors.ts / abort.ts / agent-source.ts
├── claude/               # adapter, attempt, inference (helpers/judge/advisor), auth,
│                         #   effective-auth, enforcement(-plan), settings, hook,
│                         #   mcp-permission-server, mcp-stdio, permission-broker
├── codex/                # app-server JSON-RPC client, protocol subset, adapter
│                         #   (approvals, events, checkpoint, loop guard), attempt,
│                         #   auth, inspection (shell reads), inference, preflight
└── opencode/             # registration (capabilities), attempt, phase, session,
                          #   services, loop-guard
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
  direction.
- `test/helpers/runner-conformance.ts` is the shared conformance suite for
  execution adapters; `test/runner-conformance.test.ts` runs it against the
  real Claude adapter. OpenCode attempts run on the run-owned server through
  `executeOpencodeAttempt`, covered by the engine tests.
- **Core keeps** scheduling, goal rounds, budgets, retries, Git coordination,
  writer claims, quality loops, report validation, and advisor policy. **Adapters
  own** their protocol client, native event decoding, permission interception,
  and harness process ownership, and translate all of it into the neutral
  vocabulary.

### Adding a harness

A new harness needs no engine change:

1. An adapter under `src/runners/<harness>/` implementing `ExecutionAdapter`
   (capabilities, `executeAttempt`, `cancelAttempt`, optional `release`), or —
   for a harness whose attempt the engine binds to its own runtime — a
   `CapabilitySource` registration plus its attempt.
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
