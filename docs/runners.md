# Runners

[Documentation](README.md) · [Convoy](../README.md)

Choose the harness that executes pipeline steps, configure its authentication
and billing, and understand its execution modes, enforcement, reports,
advisors, dashboards, lifecycle limits, and recovery.

- [Choosing a runner](#choosing-a-runner)
- [Models: one spelling, any runner](#models-one-spelling-any-runner)
- [Authentication and billing](#authentication-and-billing)
- [Claude execution modes](#claude-execution-modes)
- [How Convoy integrates with Claude](#how-convoy-integrates-with-claude)
- [How Convoy integrates with Codex](#how-convoy-integrates-with-codex)
- [Reports and advisors](#reports-and-advisors)
- [Routes: judge, helpers, advisors, authoring](#routes-judge-helpers-advisors-authoring)
- [Dashboards and transcripts](#dashboards-and-transcripts)
- [Lifecycle limits](#lifecycle-limits)
- [Usage and billing](#usage-and-billing)
- [Retry and resume](#retry-and-resume)
- [The runner port and its services](#the-runner-port-and-its-services)

## Choosing a runner

Convoy runs each step with the runner named on that step (`runner:`), else the
run-wide `defaults.runner`, else OpenCode.

| Runner | ID | Requires |
|---|---|---|
| OpenCode | `opencode` (default) | A supported OpenCode **V2** on `PATH`. Convoy never installs, updates, or replaces it. |
| Claude | `claude-code` | The locally installed `claude` CLI and its own login (subscription), or an explicitly selected API key. |
| Codex (experimental) | `codex` | The locally installed `codex` CLI (0.160 or later) and its own ChatGPT login (subscription), or an explicitly selected API key. |

Every runner is independently usable. A plan in which nothing runs on
OpenCode — no step, no advisor, no smart judge — never boots, authenticates, or
even needs an OpenCode installation: preflight, execution, reports, quality
loops, human iterations, helpers, and finalization all run on the plan's CLI
runner. Runner selection never changes a pipeline's reports, quality
contracts, Git behavior, or OpenSpec handling.

Two built-in pipelines are Claude-only: `claude-review` (report-only review)
and `claude-full-cycle` (advised implementation, audits, tests, and a scored
goal loop). With `defaults.runner: claude-code`, a step that names no runner
runs on Claude; a step whose model is an OpenCode model then fails validation
with a message to give it a Claude model or `runner: opencode`, rather than a
guessed mapping.

Preflight walks the whole plan — every step, the goal cycle's fragments, each
advisor (on the advisor's own runner), the judge, and the commit writer — and
refuses to start when a runner it needs is not installed, before any workspace
or checkout change exists.

## Models: one spelling, any runner

The runner and the model are independent. A model is always written as its
provider-owned identity, `provider/model[#variant]`, and the runner is chosen
by the `runner` field — so the same model moves between harnesses without
being respelled:

```yaml
version: 1
defaults:
  runner: codex                     # steps that name no runner
  model: openai/gpt-5.5             # applies wherever the step's runner executes it
pipelines:
  example:
    - agent: implementer
      runner: opencode
      model: openai/gpt-5.5         # the same ID, through OpenCode
      advisor: { runner: claude-code, model: anthropic/opus }
    - agent: bug-auditor
      models:                       # a fan-out may mix runners
        - openai/gpt-5.5#high       # the step's own runner (codex)
        - { runner: claude-code, model: anthropic/sonnet }
        - { runner: opencode, model: openai/gpt-5.5 }
```

| Runner | Executes | `#variant` |
|---|---|---|
| `opencode` | any provider OpenCode has credentials for; [gateways](models.md#model-gateways) apply | the provider's variant |
| `claude-code` | `anthropic/*`, plus the CLI aliases `anthropic/opus`, `anthropic/sonnet`, `anthropic/haiku` (a bare `opus` or `claude-*` ID also works) | not supported |
| `codex` | `openai/*` (a bare Codex model ID also works) | reasoning effort: `minimal`, `low`, `medium`, `high`, `xhigh` |

- **Routes.** Every setting that names a model — a step's `model`, each
  `models:` entry, `advisor` (step, agent, or `defaults`), and
  `defaults.autoAcceptJudgeModel` — takes either a model or a route
  `{ runner, model }`. A step's model and fan-out entries inherit the step's
  runner; a step inherits `defaults.runner`, else OpenCode. An advisor or judge
  given as a plain model consults through OpenCode, so existing configs keep
  their meaning; give it a route to consult through a CLI runner.
- **No guessing.** A runner never translates a model it cannot execute: an
  `anthropic/*` model on a Codex step fails validation, naming where the
  runner came from (`defaults.runner`, or the step) and how to fix it. A model
  inherited from `defaults.model` or the agent applies where the runner accepts
  it; a runner that does not keeps its own default.
- **Shorthand.** Where a single string is all there is room for — the CLI's
  `--model`, `--advisor`, `--smart-model`, and older configs — a CLI runner's
  model can be qualified by its runner: `codex/gpt-5.5#high`,
  `claude-code/opus`. `--model codex/<model>` overrides only Codex steps; an
  unqualified `--model` overrides only OpenCode steps, and review names the
  steps it did not reach.

## Authentication and billing

Authentication and billing are independent: a subscription login does not
guarantee included-only usage, and Convoy never changes account spending
settings. Configure each CLI runner once under `runners.<id>.auth`
(`defaults.claudeAuth`, the older spelling for Claude, still reads):

```yaml
version: 1
runners:
  claude-code:
    auth:
      authMode: subscription          # default when unset
      billingPolicy: account-policy   # accept the account's own usage policy
  codex:
    auth:
      authMode: api-key
      credentialRef: CONVOY_OPENAI_KEY  # the variable holding the key, never the key
```

- **Subscription** uses the operator's authenticated CLI (`claude`'s login,
  Codex's ChatGPT login). Convoy never reads credential stores, extracts
  tokens, proxies requests, or automates login. Ambient
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` (Claude) and
  `OPENAI_API_KEY`/`CODEX_API_KEY` (Codex) are removed from every child so they
  cannot silently become the billing source.
- **API key** uses the referenced key only for the child. Claude gets it in its
  environment with ambient OAuth tokens removed; Codex logs it in to an
  owner-only, per-use `CODEX_HOME` under `~/.convoy/private/` (read from stdin,
  never argv) that is discarded afterwards, so the operator's
  `~/.codex/auth.json` is never touched. Metadata records the mode and the
  variable name, never the value.
- **Billing policy.** Neither CLI offers a control that enforces
  included-only usage, so Convoy never claims it: `billingPolicy:
  included-only` is refused at preflight, and every subscription plan is shown
  in review as "account policy — usage credits or paid features may apply".
  Confirming that review is the operator's consent. An **unattended** launch
  (no review: `--no-confirm` or no TTY) must state it in configuration with
  `billingPolicy: account-policy`, or it is refused with that guidance.
- **Effective authentication is verified up front.** Preflight asks each CLI
  what it would actually bill under the exact child overlay — Claude through
  `claude auth status --json`, Codex through its app-server's `account/read`
  (and `model/list`, so a Codex model or effort the account does not offer
  fails here) — and refuses when it is anything but the reviewed source (an
  API key under subscription mode, a key helper, a missing login, a
  third-party provider). Each attempt repeats the check. A configuration with
  no auth for a runner behaves as subscription and is held to the same check;
  it never falls back to an API key.

## Claude execution modes

A step's mode comes from the pipeline: a read-only audit, a verifying step
(`verify: true`), or a writable implementation step. Convoy maps each mode to
CLI tool and permission flags; the same Convoy policy then decides every tool
call.

| Mode | Built-in tools | Permission |
|---|---|---|
| read-only | `Read,Glob,Grep` | `dontAsk` — nothing else runs |
| verify | `Read,Glob,Grep,Bash` | `dontAsk` — only approved verification commands run; writes and delegation are denied |
| write | CLI default tool set | `acceptEdits`, still subject to the run's approval policy |

Claude steps fan out across `models:`, run in `parallel:` groups (alone or
mixed with OpenCode steps), score, verify, and implement under the same
scheduler, writer coordination, and Git boundaries as OpenCode steps.

Hard denials and mandatory advisor checkpoints apply in all three modes and in
every approval mode (`interactive`, `auto`, `smart`). `--yolo` approves only
eligible ask-level requests. Hard denials match every spelling a shell reaches
the same command through — quoting, escapes, grouping, `env`/`command`/`exec`
wrappers, `sh -c` scripts, and `$(…)`/backtick/`<(…)` substitutions. Unknown or
unclassifiable actions, including any MCP tool that is not Convoy's own, are
denied. This is tool-policy enforcement, not an OS sandbox.

## How Convoy integrates with Claude

Convoy loads what it needs **per invocation** and leaves the operator's own
configuration alone; `--bare` and blanket `--safe-mode` are never used.

- `--settings` installs the PreToolUse hook (`convoy hook`), which runs before
  every tool call and decides it with Convoy's policy.
- `--mcp-config` declares Convoy's MCP host (`convoy mcp`): the
  `--permission-prompt-tool` that sends ask-level actions to the run's operator
  gate, plus `write_report`, `advisor`, and `advisor_feedback`.

Each attempt starts one loopback bridge for its approvals, report submissions,
and advisor consultations. Its address and bearer token reach the MCP host
through that server's own `env` in an owner-only config staged under
`~/.convoy/private/`, and reach the hook through a private file the hook
command names — never through Claude's environment or argv, which the agent's
tools can read. The token is registered for redaction. Agents (both runners)
are denied the run's private directory and `~/.convoy/private/` in every shell
spelling, as well as recursive searches of their ancestors.

## How Convoy integrates with Codex

> [!WARNING]
> **Codex support is experimental.** Convoy drives Codex through its
> app-server protocol, which OpenAI labels experimental and may change between
> Codex releases. Convoy refuses Codex releases older than 0.160, and releases
> whose version it cannot read. API-key mode has not been exercised end to end
> with a live key, and an API-key thread cannot be reopened after its attempt.
> Expect rough edges, check the branch before you merge it, and please report
> issues.

Each Codex attempt runs on its own `codex app-server` child, driven over
stdio — never the operator's shared daemon. Enforcement is in-band:

- **Every action is approved by Convoy.** Threads run under
  `approvalPolicy: untrusted`, so Codex asks before every command, file change,
  and MCP call. Convoy answers each request with its policy (the same hard
  denials, protected paths, and verify allowlist as the other runners) and
  then the run's operator gate (auto-accept, smart judge, prompt) — one
  action at a time. It never grants a session-wide approval or amends Codex's
  execpolicy or network rules.
- **The sandbox is defense in depth, not the guarantee.** Read-only and verify
  attempts run in Codex's `read-only` sandbox, writes in `workspace-write`;
  an approved write escapes Codex's sandbox, so a read-only attempt declines
  every write in policy.
- **Reading is inspection.** Codex reads only through its shell, so a command
  that only inspects (`cat`, `sed -n`, `head`, `ls`, `rg`, `grep`,
  `find` without `-exec`, `git diff/log/show/status`) is judged as the reads
  it performs: allowed inside the checkout, the run directory, and the
  attachments — in a read-only phase too, and without prompting — and never
  past a protected path or a hard-denied spelling. A redirection, a
  substitution, or any other program is an execution.
- **Declines are explained.** Codex tells its model only that "the user"
  rejected an action; Convoy steers the reason into the running turn, so the
  agent adapts instead of giving up.
- **The operator's Codex setup stays out.** Hooks, apps, browser and computer
  use are disabled for the child; every MCP server in the operator's config is
  disabled for the thread and only Convoy's own host is declared. Nothing is
  written to the operator's Codex configuration, credentials, rules, or hook
  trust.
- **Convoy's tools.** `write_report`, `advisor`, and `advisor_feedback` come
  from `convoy mcp --bridge-file <path>`: the attempt bridge's address and
  token live in an owner-only file under `~/.convoy/private/`, never in argv
  or the agent's environment, and each call is bound to the attempt.
- **Advisor checkpoint.** An advised phase's first file change is held for
  one consultation; the advice is steered into the turn and the change
  declined, so the agent re-applies it with the advice in hand. Later writes
  proceed; a failed consultation releases the hold.
- **Loop guard.** Unlike Claude's print mode, Codex takes input mid-turn: the
  guard's nudge is steered into the turn and a stop interrupts it.

Codex's matrix: **available** — read-only, write, verify, model fan-out,
parallel, approvals, structured deliverables, the advisor bridge, live
observation (through the journal), post-exit resume (`thread/resume`), usage
reporting (subscription values are estimates), and the loop guard.
**Restricted** — explicit handoff. **Unavailable** — native live attach and
native session history (Convoy's journal is the transcript). Authoring
conversations stay on OpenCode or Claude: Codex assigns a conversation's
thread id itself, so Convoy cannot link one to a worktree. Human gates
iterate with Codex when the run has no OpenCode server, and `[o]` reopens a
finished Codex step with `codex resume <thread>` in a read-only sandbox.
A thread that ran under API-key mode lived in a private Codex home that
Convoy discards after the attempt, so `[o]` refuses it and says why.

## Reports and advisors

Both runners submit the same deliverable contracts through `write_report` —
OpenCode's plugin tool and Claude's MCP tool share one input schema and one
validator:

- A Markdown report, a structured score (dimensions, mustFix, gaps,
  confidence; Convoy derives the number), and an optional structured commit
  description. Convoy — not the agent — chooses the destination and attempt
  identity, so a submission cannot target a sibling attempt or a path.
- A rejected submission is a tool error the agent can correct; the last valid
  candidate is kept. Process exit is never a deliverable: the contract is
  validated after the attempt, with bounded correction.
- For Claude, the final assistant text remains the fallback report when no
  `write_report` call was accepted.

Advisors are chosen independently of the executor. A route
(`advisor: { runner: claude-code, model: anthropic/opus }`, or the shorthand
`claude-code/opus`) consults that CLI runner; a plain model consults through
OpenCode — so any executor can take any runner's advisor (OpenCode boots only
when an advisor or step needs it).

- A consultation is one stateless, tool-less answer over the executor's
  transcript — read from the OpenCode server for an OpenCode executor, or
  recorded by Convoy from a Claude attempt's events — bounded in calls,
  output, and time, with no repository write authority. Usage is attributed
  to the requesting attempt separately from the executor's.
- The **first-write checkpoint** holds an advised phase's first write for one
  consultation and hands the advice back (OpenCode through its permission
  gate, Claude through the PreToolUse hook); later writes proceed, and a
  failed consultation releases the hold so the executor never loses a turn.
  If the checkpoint itself cannot be reached, the write stays blocked.
- Executors can also consult on demand (`advisor`) and record what they did
  with the advice (`advisor_feedback`).

Claude's native `--advisor` is not used: Convoy's consultation route is the one
with the required routing, checkpoint, context bounds, limits, and attribution.

## Routes: judge, helpers, advisors, authoring

A route names a runner and model, with a CLI runner's routes spelled
`<runner>/<model>` (`claude-code/haiku`, `codex/gpt-5.5#low`) and run under
that runner's `runners.<id>.auth`:

```yaml
version: 1
defaults:
  runner: claude-code                    # steps without their own runner
  autoAcceptJudgeModel: claude-code/haiku
  advisorRoute:                          # the default advisor
    runner: claude-code
    model: opus
    authMode: subscription               # api-key reuses claudeAuth.credentialRef
  helperRoutes:
    branchName: { runner: claude-code, model: haiku }
    commitMessage: { runner: claude-code, model: haiku }
  authoring:
    runner: claude-code                  # Iterate, conversations, Propose
```

- **Smart judge**: an explicit judge wins; a plan on one CLI runner otherwise
  judges with that runner's helper model (`claude-code/haiku`,
  `codex/default#low`), or a runner-scoped `--model`, never an OpenCode model
  it could not run. A judge that cannot answer fails closed to the operator
  prompt.
- **Helpers** (branch namer, commit writer for compaction and `close`): an
  explicit `helperRoutes` entry, else an explicit legacy `branchNameModel` /
  `commitMessageModel` (an existing OpenCode selection is never converted),
  else `defaults.runner`, else — for run compaction — the plan's own runner
  when every step runs on one CLI runner. Each falls back to its documented
  deterministic message. Run titles stay deterministic.
- **Authoring**: Claude conversations are exact sessions — a new one starts
  with `--session-id`, an existing one reopens with `--resume` once Claude has
  persisted it for that checkout — under the reviewed auth, with the writer
  claim taken before and released after the foreground client exits. Propose
  uses the project's own `.claude/commands/` proposal command. A linked session
  always reopens on its own harness.
- **Human gates** in a run with no OpenCode server iterate with the plan's CLI
  runner (Claude or Codex).

## Dashboards and transcripts

The coordinator journals every phase's transcript (text, reasoning, tool and
shell markers, activity), attributed to the phase's own runner and attempt, in
the run's private `events/coordinator-events.ndjson`, with a sequence that a
resumed run continues. A dashboard — another process — follows that file for
phases without native live attach (Claude), so their session tabs stream live
and reconstruct after a late attach without an OpenCode server URL; OpenCode
phases keep their native stream, so nothing renders twice. A reopened stopped
run replays the captured Claude transcripts from disk alone, and a hole in the
journal is shown as an explicit "transcript incomplete" line, never hidden.

## Lifecycle limits

Convoy owns the `claude` or `codex app-server` child it starts. Cancelling an
attempt interrupts a Codex turn, then sends SIGTERM, and if the child has not
exited within a bounded grace (5 s) it is killed, so an attempt never hangs on
a child that ignores the request; the attempt settles as interrupted with its
session recorded. Two limits matter:

- **This is tool-policy enforcement, not an OS sandbox.** Convoy restricts what
  tools and commands may run; it does not contain arbitrary code.
- **A child exiting does not prove all descendants stopped.** A CLI and its
  tool subprocesses can create their own process groups; Convoy signals only
  the child it owns.

## Usage and billing

| | OpenCode / API key | Claude or Codex subscription |
|---|---|---|
| Tokens | measured when reported | measured when reported |
| Monetary value | estimate of provider charges, not an invoice | **estimate only**, not a cash charge (Codex reports none) |
| Quota | provider-side; not tracked as a guarantee | not a remaining-balance report |
| Missing data | unknown, never shown as zero | unknown, never shown as zero |

Advisor usage is reported separately from the executor's (`SUMMARY.md`
executor/advisor split).

## Retry and resume

| Goal | Action |
|---|---|
| Continue a failed or interrupted run | `convoy --resume <run-id>` |
| Retry from step 0 with the original prompt | open `convoy runs`, select the run, press `[r]` |
| Re-run only the failed/unfinished phases | open `convoy runs`, select the run, press `[R]` |

`--resume` replays the pipeline frozen in `metadata.json`. Every attempt
records its versioned provenance — runner, Claude authentication mode and
credential reference (never a value), model, exact native session, checkout,
and attempt identity — so recovery and history read what ran instead of
guessing. Convoy never replays an uncertain write and never silently
substitutes another runner, session, or billing mode.

---

## The runner port and its services

Each runner is described once, in `src/runners/descriptors.ts`: its id and
labels, its capability declaration, the models it executes and how a model
maps to its native form, the binary that proves it is installed, how its
agents name the report tool, and whether it authenticates. Routing, config
validation, plan dependencies, preflight, provenance, and prompts read the
descriptor; no core module compares a runner's name
(`test/runner-routing-conformance.test.ts`). Adding a runner means a
descriptor, an adapter under `src/runners/<id>/`, and its entries in the
registration tables (composition, helper inference, session openers).

Every CLI attempt runs through the neutral execution adapter
(`src/runners/contracts.ts`): run/phase/attempt identity, checkout, agent,
model, auth, mode, approvals, policy, attachments, and cancellation in;
normalized events (session, text, reasoning, tool, activity, usage, terminal)
and an outcome out; optional, capability-gated services (approvals,
deliverables, advisor). An OpenCode attempt runs on the run-owned server
through the engine's `executeOpencodeAttempt`, so OpenCode registers only its
capability declaration.

Support is declared once (`src/runners/declarations.ts`) and resolved against
runtime and enforcement evidence (`resolveEffectiveCapabilities`), so preflight
and the running adapter cannot disagree. A plan that requires a service the
runner does not advertise is refused before any writable work.

Claude's matrix: **available** — read-only, write, verify, model fan-out,
parallel, approvals and the advisor bridge (with the hook and permission host),
structured deliverables, live observation (through the journal, not a native
attach), post-exit resume, usage reporting (estimates). **Restricted** —
explicit handoff (no verified quiesced handoff). **Unavailable** — native live
attach, native session history (Convoy's journal is the transcript), and the
loop guard (print mode cannot take a mid-turn nudge).

Where the pieces live: `src/runners/claude/**` (adapter, inference for
helpers, hook, MCP host), `src/runners/codex/**` (app-server client, adapter,
auth, inspection reads, inference, preflight), `src/runners/attempt-bridge.ts`
and `attempt-tools.ts` (the bridge and tools both CLI runners serve),
`src/runners/opencode/**`
(attempt loop, sessions, services), `src/runners/session-*.ts` (the
session-scoped deliverable and advisor services both runners bind), and core
for scheduling, budgets, Git boundaries, retries, and finalization. An adapter
never imports the engine (`test/runner-adapter-direction.test.ts`).

---

[Back to documentation](README.md)
