# Runners

[Documentation](README.md) · [Convoy](../README.md)

Choose the harness that executes pipeline steps, configure its authentication,
and understand its execution modes, customization loading, lifecycle limits,
reports, advisors, cost labels, and recovery.

- [Choosing a runner](#choosing-a-runner)
- [Authentication and billing](#authentication-and-billing)
- [Claude execution modes](#claude-execution-modes)
- [Customization loading](#customization-loading)
- [Supported restrictions](#supported-restrictions)
- [Lifecycle limits](#lifecycle-limits)
- [Reports and advisors](#reports-and-advisors)
- [Mixed-runner routes](#mixed-runner-routes)
- [Usage and billing](#usage-and-billing)
- [Retry and resume](#retry-and-resume)
- [The runner port and its services](#the-runner-port-and-its-services)

> **In progress.** The explicit runner ports and the Claude-parity capabilities
> on this page come from the OpenSpec change `runner-parity-opencode-v2`; the
> release gate is in its `design.md` (D4) and `evidence/compatibility.md`. Until
> the gate passes, the OpenCode path remains the shipped behavior and Claude
> steps stay read-only, as described in [Configuration](configuration.md).

## Choosing a runner

Convoy executes a step with the runner named on that step, defaulting to
OpenCode. Two runners are supported, and either is independently usable:

| Runner | ID | Requires |
|---|---|---|
| OpenCode | `opencode` (default) | A supported OpenCode **V2** on `PATH`. Convoy never installs, updates, or replaces it. |
| Claude | `claude-code` | The locally installed `claude` CLI and its own login (subscription), or an explicitly selected API key. |

A Claude-only plan must run without an OpenCode installation, server,
credentials, or model catalog. Runner selection never changes a pipeline's
reports, quality contracts, Git behavior, or OpenSpec handling.

## Authentication and billing

Authentication and billing are independent: a subscription login does not
guarantee included-only usage, and Convoy never changes account spending
settings. Setup, the API-key opt-in, legacy migration, and cost labels are in
[Models and providers](models.md#runner-authentication-and-billing).

- **Subscription** uses the operator's authenticated `claude` CLI. Convoy never
  reads credential stores, extracts tokens, proxies requests, or automates login.
- **API key** is a separately selected mode that references an environment
  variable by name; the key value is never stored in configuration or metadata.
- **Billing policy** (`included-only` or `account-policy`) is resolved separately
  from the mode and applied to executors, helpers, advisors, and authoring.

## Claude execution modes

A step's mode comes from the pipeline: a read-only audit, a verifying step
(`verify: true`), or a writable implementation step. Convoy maps each mode to
CLI tool and permission flags; the same Convoy policy then decides every tool
call.

| Mode | Tools | Permission |
|---|---|---|
| read-only | `Read,Glob,Grep` | `dontAsk` — no prompt; anything outside the listed tools is denied |
| verify | `Read,Glob,Grep,Bash` | `dontAsk` — only approved verification commands run; writes and delegation are denied |
| write | CLI default tool set | `acceptEdits`, still subject to the run's approval policy |

Hard denials and mandatory advisor checkpoints apply in all three modes and in
every approval mode (`interactive`, `auto`, `smart`). `--yolo` (auto-accept)
approves only eligible ask-level requests; it cannot authorize a hard-denied
action or bypass a first-write checkpoint. Unknown or unclassifiable actions are
denied rather than gaining access by default.

## Customization loading

Convoy loads what it needs **per invocation** rather than relying on (or
disabling) the operator's global configuration:

- `--settings` installs the reviewed pre-action hook that runs before any tool.
- `--mcp-config` declares the loopback MCP servers Convoy owns — the permission
  prompt host and the report/advisor tools.

A `--settings` object is JSON of this shape:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/usr/local/bin/convoy-hook" }
        ]
      }
    ]
  }
}
```

An `--mcp-config` object is JSON of this shape:

```json
{
  "mcpServers": {
    "convoy-permissions": {
      "command": "/usr/local/bin/convoy",
      "args": ["mcp-permission"]
    }
  }
}
```

`--bare` is never used for subscription runs because it does not use
subscription login. Blanket `--safe-mode` is replaced by this scoped loading, so
the required Convoy hooks and MCP servers load while other customization sources
stay controlled. Applicable managed policy is preserved, and reviewed project
guidance (`CLAUDE.md`, `AGENTS.md`, `.convoy/rules.md`) is loaded intentionally.

## Supported restrictions

- Interception paths whose scope cannot be enforced are disabled rather than
  broadened; an unverifiable action is refused.
- Organization-level denials remain effective. Convoy never weakens managed
  policy or rewrites login state to force a mode.
- OpenCode-only selections (for example a global `--model` override) are never
  silently applied to Claude. Claude uses CLI aliases (`opus`, `sonnet`,
  `haiku`), `claude-*` IDs, or `anthropic/claude-*`, plus supported effort.
- A feature verified only for API-key mode is disclosed individually; a
  subscription run is not silently switched to API billing.
- Claude's native `--advisor` and background attach are candidates, not baseline
  behavior; see [Reports and advisors](#reports-and-advisors).

## Lifecycle limits

Convoy owns the `claude` child it starts and stops it within a shared bounded
deadline: it requests native interruption, stops owned children, escalates if
needed, and records the observed outcome. A repeated stop shares one result.

Two limits matter when reasoning about safety:

- **This is tool-policy enforcement, not an OS sandbox.** Convoy restricts what
  tools and commands may run; it does not contain arbitrary code.
- **A child exiting does not prove all descendants stopped.** Claude and its
  MCP/tool subprocesses can create their own process groups. Convoy signals only
  descendants with attributable ownership and retains unresolved evidence
  instead of claiming a confirmed stop. Reconciliation is identity-checked, so a
  reused PID, an incomplete record, or an independent process is never a kill
  target.

## Reports and advisors

Both runners submit the same deliverable contracts:

- A Markdown report, a structured score, and an optional structured commit
  description are validated with identical rules. Convoy — not the agent —
  chooses the authoritative destination and attempt identity, so a submission
  cannot target a sibling attempt or an arbitrary path.
- Process exit or an idle event is not a valid deliverable. Convoy validates the
  contract and asks for a bounded correction when a replacement is malformed,
  keeping the last valid candidate.
- Accepted report/commit metadata is persisted before it is acknowledged, so
  recovery can reconcile without repeating writes or duplicating a commit.

Advisors are chosen independently of the executor:

- Either runner can advise either executor when the route is explicit and its
  dependency and authentication preflight passes.
- A consultation is tool-restricted, uses a bounded normalized snapshot of the
  executor's context, and is bounded in calls, output, and time. It has no
  repository write authority and cannot recursively advise.
- Consultation usage is attributed to the requesting attempt separately from
  executor usage.
- A first-write gate is enforced at the permission boundary. Its kind is
  declared by the runner: `block` denies a protected write until a satisfying
  consultation, `hold` consults once and then permits the write — releasing the
  hold even when the consultation fails, so the executor never loses a turn
  (the OpenCode gate) — and `none` when the phase requires no consultation.

A native Claude advisor (`--advisor`) is used **only** when behavioural
equivalence is demonstrated by tests covering routing, checkpoint enforcement,
context scope, limits, and attribution — never because a similarly named flag
exists. Otherwise Convoy uses its own consultation bridge.

## Mixed-runner routes

Routes are runner-qualified. Advisors, helpers, and authoring can select a
runner and authentication mode independently of the steps they support.

A subscription executor consulting an OpenCode advisor:

```yaml
version: 1
runners:
  claude-code:
    authMode: subscription
    billingPolicy: included-only
    model: sonnet
advisor:
  runner: opencode
  model: anthropic/claude-opus-5
```

An OpenCode executor with a Claude subscription advisor and Claude helper:

```yaml
version: 1
runners:
  claude-code:
    authMode: subscription
    billingPolicy: included-only
advisor:
  runner: claude-code
  authMode: subscription
  model: opus
helpers:
  commitMessage:
    runner: claude-code
    authMode: subscription
    model: haiku
```

Role names mirror the existing helper settings: `branchName`, `commitMessage`,
and `autoAcceptJudge` (the smart auto-accept judge). To reserve API billing for
one step only, override the mode on that step while the credential reference
comes from the runner defaults:

```yaml
version: 1
runners:
  claude-code:
    authMode: subscription
    billingPolicy: included-only
    credentialRef: CONVOY_ANTHROPIC_KEY
pipelines:
  review:
    steps:
      - agent: security
        runner: claude-code
        runnerOptions:
          authMode: api-key
```

An unspecified helper inherits the applicable selected route. A run-wide helper
in a mixed plan whose target is ambiguous requires an explicit selection rather
than a guess. Existing unqualified OpenCode model strings remain OpenCode-only
and are never applied to Claude.

## Usage and billing

Usage and billing are different measurements and are labeled separately:

- **Usage** is measured tokens (input, output, reasoning, cache read/write) and,
  where the harness reports it, a monetary estimate. Convoy attributes usage to
  the attempt, executor, and advisors without double-counting resumed cumulative
  totals. If a reliable delta cannot be derived, the value stays unknown.
- **Billing** is what the provider charges. Convoy never presents an estimate as
  an invoice or a quota balance.

| | OpenCode / API key | Claude subscription |
|---|---|---|
| Tokens | measured when reported | measured when reported |
| Monetary value | estimate of provider charges, not an invoice | **estimate only**, not a cash charge |
| Quota | provider-side; not tracked as a guarantee | not a remaining-balance report |
| Missing data | unknown, never shown as zero | unknown, never shown as zero |

Cost/token budgets disclose their basis (tokens, turns, time, or estimated cost)
and can overshoot an estimate because in-flight requests settle after a check. A
reliable cap is described as bounded headroom, not invoice-perfect enforcement;
if the selected runner cannot measure or enforce a requested guarantee, preflight
refuses it rather than reporting missing consumption as zero.

## Retry and resume

Resuming continues the recorded work; retrying starts new work. Convoy never
replays an uncertain write and never silently substitutes another runner,
session, or billing mode.

| Goal | Action |
|---|---|
| Continue a failed or interrupted run | `convoy --resume <run-id>` |
| Retry from step 0 with the original prompt | open `convoy runs`, select the run, press `[r]` |
| Re-run only the failed/unfinished phases | open `convoy runs`, select the run, press `[R]` |

`--resume` replays the pipeline frozen in the run's `metadata.json`, even if the
configuration changed since. Phases that already wrote their report are restored
with their real duration, cost, and session; an interrupted writable phase whose
work is still in the tree can be committed as that phase after confirmation (or
is re-run when declined, or in a non-interactive context).

Resume revalidates, and reports rather than guesses when it cannot honor them:

- the exact recorded session, runner, model, and authentication mode;
- checkout continuity (no moved or reused path);
- the actual Git effects of the interrupted attempt;
- the harness version and credential validity.

A missing session, a changed checkout, expired credentials, a changed harness
version, or ambiguous legacy provenance produces explicit recovery choices; the
run is not retargeted to a new session or billing mode. A subscription attempt
that hits a quota limit follows the configured retry or failure policy without
switching to API billing, and a resumed subscription run re-checks the billing
policy before its next request.

---

## The runner port and its services

Every runner integrates through one rich, vendor-independent contract
(`src/runners/contracts.ts`). The contract may name Convoy's own concepts —
sessions, phases, approvals, deliverables, advisors, limits — because
"vendor-independent" excludes harness SDKs and protocol objects, not Convoy's
domain. The same contract serves OpenCode, Claude, and any harness added later;
there is no privileged OpenCode-only route.

### What an attempt receives

```
execution.executeAttempt(request, sink, services?)
  request  — run/phase/attempt identity, verified checkout, agent/model/auth/mode,
             approvals mode, attachments, cancellation
  sink     — normalized events: session/text/reasoning/tool/usage/permission/terminal
  services — optional, capability-gated: approvals, deliverables, advisor, loop-guard
```

Optional session facets (history, resume, attach) and an observed runtime
release live beside execution; a runner implements only what it honors.

### Support versus requirement

Support is declared once, by the adapter's own capability declaration, and
resolved against runtime, authentication, and enforcement evidence
(`src/runners/declarations.ts`, `resolveEffectiveCapabilities`). The surface
preflight quotes and the surface the running adapter honors come from the same
declaration, so they cannot disagree.

- **Available** means the guarantee holds — a native *or* bridged implementation
  that preserves the required timing and authority (for example, a checkpoint
  that blocks *before* a write, not a post-hoc consultation).
- **Restricted** means it can be honored only under some conditions (an
  enforcement host, a supported harness version) or not yet at all, with a
  reason and, usually, a remediation.
- **Unavailable** means the runner cannot honor it.

A plan that **requires** a service the runner does not advertise is refused
before any writable work, naming the runner and the service
(`assertServicesSupported`) — never silently dropped. A runner that simply lacks
an unrequired capability still runs through the same path; the difference is
expressed by capability, not by a second kind of runner.

### The optional services

| Service | Contract carries |
|---|---|
| deliverables | the report/score/commit-description kinds, structured commit data, and a rejection that preserves the last accepted artifact |
| advisor | on-demand / first-write / completion triggers, the first-write gate kind (`none`/`hold`/`block`) and its satisfaction, plus separately attributed usage |
| approvals | a normalized request identity with a cancellable, session-scoped decision |
| loop guard | typed observations (call id + arguments, results, steps, usage) and a continue/nudge/stop decision the adapter must apply |

Submission semantics differ per harness while the guarantees do not. OpenCode
submits a report and its optional structured commit metadata in one
`write_report` call, and a scoring agent supplies its dimensions in that same
call — Convoy derives the numeric score — so a raw `{ score }` body or a
separate commit-description artifact is rejected, exactly as the tool boundary
does. A submission is bound to one exact session: after that session's handle is
released (a retry, an abort, or the phase decision), a late submission is
refused as stale rather than accepted into a later attempt.

The loop guard is fed per observation and returns a decision the adapter must
apply. OpenCode supplies the stable call id and effective arguments (so repeated
calls and repeated failures are correlated, not collapsed into one tool name)
and the assistant message id with its cumulative cost (so the delta is counted
once and not double-counted across the advisor's follow-up turn). A step-budget
reset renews only the step allowance; the cost and repetition history are
retained.

An OpenCode permission ask maps to the neutral policy through its native action:
`edit`/`write`/`patch` → write, `bash`/`shell` → execute, `task`/`subagent` →
delegate, `webfetch`/`websearch` → network, `read`/`grep`/`glob`/`list`/`view` →
read, and anything else → other (denied). Hard policy and the advisor checkpoint
are decided before any ask-level decision; an eligible ask is settled by the
interactive/auto/smart decider and is cancellable, so a cancelled ask can never
settle a sibling attempt's request.

Session operations are capability-gated. OpenCode supports `history` (reconstruct
the exact recorded session's transcript from the server, never fabricated),
`resume` (continue that exact session), and `attach` (a live window); each is
present only when the composition supplies the underlying mechanism, so the
facade never claims a control it cannot honor. Claude supports history and
post-exit resume but not a native attach. A session that belongs to another
runner, or a server that cannot return it, is refused rather than guessed at.

Release ownership stays with the adapter. Releasing a runner's runtime reports an
observed outcome — `released` only when the exit was observed, `not-owned` when
it never started one, and `unresolved` (with a reason and retained evidence) when
termination could not be confirmed — so a submitted stop is never reported as
termination. Session-bound service handles (deliverables, advisor) are released
at the phase decision through one common operation; a late submission or
consultation from a released session is refused.

The Claude capability matrix is explicit, so an unsupported requirement is
refused before execution rather than assumed: **available** — read-only, write,
verify, model fan-out, parallel, approvals (only with the enforcement host),
structured deliverables, live observation (streamed to the coordinator, not a
native attach), post-exit resume, usage reporting (estimates). **Restricted** —
explicit handoff (needs a verified quiesced handoff). **Unavailable** — native
live attach, session history (print mode exposes no recorded transcript), and the
advisor bridge (no bridge yet). Loop control is not claimed; the adapter does not
consume a loop service it cannot apply. Claude's approvals are enforced by the
hook + permission host, and its resume continues the exact recorded session with
`--resume`.

### Where the pieces live

- `src/runners/contracts.ts` — the neutral vocabulary (no vendor types).
- `src/runners/declarations.ts` + `src/runners/capabilities.ts` — the
  authoritative declaration and its resolution.
- `src/runners/opencode/**`, `src/runners/claude/**` — the adapters: protocol,
  sessions, plugin/hook/MCP exposure, event decoding, permissions, process
  handling. The OpenCode attempt loop and session/checkpoint runtime live here,
  beside the adapter, not in the engine.
- Core keeps scheduling, budgets, Git boundaries, retries, and finalization.
  Dependencies are one-way: an adapter never imports the engine
  (`src/runner.ts`), which `test/runner-adapter-direction.test.ts` enforces.

> **Status.** Every attempt starts through this contract: the engine prepares one
> neutral attempt context, validates the phase's required services against the
> runner's declared capabilities, and calls the runner's registered attempt. The
> rich OpenCode attempt and the Claude attempt both live in their adapter
> modules, and an attempt receives only neutral inputs — the phase's data, the
> event sink, the abort signal and the services it honors — never the engine's
> report/advisor runtimes, progress target or shutdown handle.

---

[Back to documentation](README.md)
