# Runners

[Documentation](README.md) · [Convoy](../README.md)

Choose the harness that executes pipeline steps, configure its authentication
and billing, and understand its execution modes, enforcement, reports,
advisors, dashboards, lifecycle limits, and recovery.

- [Choosing a runner](#choosing-a-runner)
- [Authentication and billing](#authentication-and-billing)
- [Claude execution modes](#claude-execution-modes)
- [How Convoy integrates with Claude](#how-convoy-integrates-with-claude)
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

Either runner is independently usable. A plan in which nothing runs on
OpenCode — no step, no advisor, no smart judge — never boots, authenticates, or
even needs an OpenCode installation: preflight, execution, reports, quality
loops, human iterations, helpers, and finalization all run on Claude. Runner
selection never changes a pipeline's reports, quality contracts, Git behavior,
or OpenSpec handling.

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

## Authentication and billing

Authentication and billing are independent: a subscription login does not
guarantee included-only usage, and Convoy never changes account spending
settings. Configure Claude once in `defaults.claudeAuth`:

```yaml
version: 1
defaults:
  claudeAuth:
    authMode: subscription          # default when unset
    billingPolicy: account-policy   # accept the account's own usage policy
```

```yaml
version: 1
defaults:
  claudeAuth:
    authMode: api-key
    credentialRef: CONVOY_ANTHROPIC_KEY   # the variable holding the key, never the key
```

- **Subscription** uses the operator's authenticated `claude` CLI. Convoy never
  reads credential stores, extracts tokens, proxies requests, or automates
  login. Ambient `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are removed from
  every Claude child so they cannot silently become the billing source.
- **API key** sets the referenced key only for the child and removes ambient
  OAuth/subscription tokens for it. Metadata records the mode and the variable
  name, never the value.
- **Billing policy.** The Claude CLI offers no control that enforces
  included-only usage, so Convoy never claims it: `billingPolicy:
  included-only` is refused at preflight, and every subscription plan is shown
  in review as "account policy — usage credits or paid features may apply".
  Confirming that review is the operator's consent. An **unattended** launch
  (no review: `--no-confirm` or no TTY) must state it in configuration with
  `billingPolicy: account-policy`, or it is refused with that guidance.
- **Effective authentication is verified up front.** Preflight runs
  `claude auth status --json` under the exact child overlay and refuses when
  Claude would bill anything but the reviewed source (an API key or key helper
  under subscription mode, a missing login, a third-party provider). Each
  attempt repeats the check. A legacy configuration with no `claudeAuth`
  behaves as subscription and is held to the same check; it never falls back
  to an API key.

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

Advisors are chosen independently of the executor. `advisor: claude-code/opus`
consults Claude; any other model string consults through OpenCode — so a
Claude executor can take an OpenCode advisor (OpenCode then boots for it) and
an OpenCode executor a Claude one.

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

A route names a runner and model, with Claude routes spelled
`claude-code/<model>` and run under `defaults.claudeAuth`:

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

- **Smart judge**: an explicit judge wins; a Claude-only plan otherwise judges
  with `claude-code/haiku` (or a Claude-scoped `--model`), never an OpenCode
  model it could not run. A judge that cannot answer fails closed to the
  operator prompt.
- **Helpers** (branch namer, commit writer for compaction and `close`): an
  explicit `helperRoutes` entry, else an explicit legacy `branchNameModel` /
  `commitMessageModel` (an existing OpenCode selection is never converted),
  else `defaults.runner`, else — for run compaction — the plan's own runner
  when it is Claude-only. Each falls back to its documented deterministic
  message. Run titles stay deterministic.
- **Authoring**: Claude conversations are exact sessions — a new one starts
  with `--session-id`, an existing one reopens with `--resume` once Claude has
  persisted it for that checkout — under the reviewed auth, with the writer
  claim taken before and released after the foreground client exits. Propose
  uses the project's own `.claude/commands/` proposal command. A linked session
  always reopens on its own harness.
- **Human gates** in a run with no OpenCode server iterate with Claude.

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

Convoy owns the `claude` child it starts. Cancelling an attempt sends SIGTERM,
and if the child has not exited within a bounded grace (5 s) it is killed, so
an attempt never hangs on a child that ignores the request; the attempt
settles as interrupted with its session recorded. Two limits matter:

- **This is tool-policy enforcement, not an OS sandbox.** Convoy restricts what
  tools and commands may run; it does not contain arbitrary code.
- **A child exiting does not prove all descendants stopped.** Claude and its
  tool subprocesses can create their own process groups; Convoy signals only
  the child it owns.

## Usage and billing

| | OpenCode / API key | Claude subscription |
|---|---|---|
| Tokens | measured when reported | measured when reported |
| Monetary value | estimate of provider charges, not an invoice | **estimate only**, not a cash charge |
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

Every Claude attempt runs through the neutral execution adapter
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
helpers, hook, MCP host, approval/tool bridge), `src/runners/opencode/**`
(attempt loop, sessions, services), `src/runners/session-*.ts` (the
session-scoped deliverable and advisor services both runners bind), and core
for scheduling, budgets, Git boundaries, retries, and finalization. An adapter
never imports the engine (`test/runner-adapter-direction.test.ts`).

---

[Back to documentation](README.md)
