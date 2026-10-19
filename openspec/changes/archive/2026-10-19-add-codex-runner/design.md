# Design

## Context

See `proposal.md` and `evidence/`. This builds on `generalize-runner-routes`: Codex is one descriptor (`src/runners/descriptors.ts`), one capability declaration, an adapter under `src/runners/codex/`, and entries in the registration tables. No core branch is involved. The Claude adapter is the reference for auth, billing, the MCP host and the journal. The OpenCode adapter is the reference for a client-driven, approval-gated protocol.

## Goals / Non-Goals

**Goals:**

- A Codex-only plan runs end to end without OpenCode or Claude installed: steps, the goal loop, advisors, the judge, helpers, finalization and human iterations.
- Convoy's policy decides every command, edit and tool call, as with the other runners.
- Exact provenance: runner, auth mode, model and effort, thread id, attempt.

**Non-Goals:**

- Using Codex's own `--worktree`, cloud tasks, `auto_review`/guardian approvals, plugins, apps, browser or computer use. Convoy owns checkouts and approvals.
- Mutating the operator's Codex state: `auth.json`, `config.toml`, execpolicy rules, hook trust.
- Authoring conversations on Codex (Iterate, Propose, worktree conversations). Codex assigns a thread's id itself, so Convoy cannot link a conversation to a worktree before it exists. `defaults.authoring.runner: codex` is refused with that reason.
- An OS-sandbox guarantee. Codex's Seatbelt sandbox is used, but Convoy's claim stays tool-policy enforcement.

## Decisions

### D1. Transport: an owned `codex app-server` per attempt, over stdio

`codex exec --json` would mirror Claude's print mode and inherit its gaps: no live approval round-trip, no steer, no in-protocol auth check. The app-server is a JSON-RPC client protocol in which Codex asks before every action (`evidence/app-server-spike.md`, findings 1, 2 and 7).

- **Process.** Convoy starts `codex app-server --disable hooks --disable apps --disable browser_use --disable browser_use_external --disable computer_use` per attempt as its own child. It never attaches to the operator's shared daemon.
- **Protocol types.** The protocol is labeled experimental, so the adapter speaks a small hand-typed subset (`protocol.ts`) and reads every field defensively. Generated bindings for the whole surface were rejected, because they would churn with every Codex release.
- **Version gate.** Preflight, every attempt and every helper read the release from their app-server's `initialize` user agent (`<originator>/<version>`). They refuse a release older than 0.160 with an update hint, and a release they cannot read is refused rather than taken as current.

`dynamicTools` would remove the MCP process and the bridge, but it is experimental. MCP is used instead (D4).

### D2. Execution modes

| Convoy mode | `sandbox` | `approvalPolicy` | Policy |
|---|---|---|---|
| read-only | `read-only` | `untrusted` | inspection reads only; writes and other commands declined |
| verify | `read-only` | `untrusted` | inspection reads and approved verification commands; writes declined |
| write | `workspace-write` | `untrusted` | the run's approval policy |

`approvalsReviewer` stays `user` (the client). Convoy answers only `accept` or `decline`. It never answers `acceptForSession`, an execpolicy amendment or a network amendment, because those would persist decisions outside Convoy's policy. An approved write escapes the `read-only` sandbox (finding 3), so policy, not the sandbox, is the read-only guarantee.

### D3. Approval translation

- **`item/commandExecution/requestApproval`.** Unwrap the login-shell wrapper (`/bin/zsh -lc '…'`), then:
  - A command that only inspects (`inspection.ts`: `cat`, `sed -n …p`, `head`, `tail`, `ls`, `rg`, `grep`, `find` without `-exec`/`-delete`, `wc`, `git diff/log/show/status`, with no redirection, substitution or writer option) is judged as the reads it performs. Each path passes the read policy, with a recursive search treated as a tree read.
  - The reading fails closed. Each program declares only the options it knows take a non-path value (a numeric one only when the next word is a number), so every other word, including an option the classifier does not know, is judged as a path. A word the shell would still change (a variable other than a leading `$HOME`, a brace, `~user`) or a command run after assignments or wrappers is an execution. A glob is judged as the tree below its fixed prefix, and the parent too when a segment could match `..`. Git is limited to reads inside the checkout: every path or revision word is judged as a path, `--no-index`, `--ext-diff`, `--output`, `grep -O` and global options other than `-C`/`--no-pager` are executions, and `git branch` only lists.
  - Anything else is an execution, judged by the existing bash policy (hard denials, protected paths, verify allowlist) and then the operator gate.
- **Why inspection is a read.** Codex has no file-read tool. The first live run showed a read-only Codex auditor could read nothing (`evidence/acceptance.md`), and every `cat` in an interactive run would otherwise prompt the operator.
- **`item/fileChange/requestApproval`.** Take the paths from the `fileChange` item with the same `itemId` (seen in `item/started`), then judge each path as a write. A request whose item was never seen is declined.
- **`mcpServer/elicitation/request`.** Accept for Convoy's own server; decline any other.
- **`item/tool/requestUserInput`.** Answer with no answers.
- **Legacy `applyPatchApproval` / `execCommandApproval`.** Deny.
- **Anything else, including `item/permissions/requestApproval`.** A JSON-RPC error, so the thread never waits.
- **Declines are explained.** Codex tells its model only that "the user" rejected the action, and in the live run the agent gave up. Convoy therefore steers the policy's reason into the running turn (`turn/steer`), and the agent adapts.

### D4. Convoy's services through `convoy mcp`

`thread/start` takes per-thread config overrides (verified, `evidence/acceptance.md`). Each attempt's config:

- disables every MCP server the operator's config declares (read with `config/read`). When that list cannot be read, the attempt or helper starts no thread, and an operator server named `convoy` refuses an attempt that declares Convoy's host, since its settings would merge into the host's;
- declares Convoy's host as `convoy mcp --bridge-file <path>`, with a long tool timeout for advisor consultations.

`mcp_servers={}` cannot clear the operator's table, because overrides deep-merge, so each server is disabled by name.

The bridge file is owner-only under `~/.convoy/private/codex-mcp/`. It holds the attempt bridge's address and token, which therefore never appear in argv or the agent's environment. With `--bridge-file`, the host serves only `write_report`, `advisor` and `advisor_feedback`, with no permission tool, because Codex asks for approvals in-band. Submissions are bound to the attempt through its session-scoped services.

The first-write checkpoint works as follows:

1. The first file change of an advised phase is held while the advisor is consulted.
2. The advice is steered into the turn and the change is declined, so the agent re-applies it with the advice in hand.
3. Later writes proceed. A failed consultation releases the hold. If the checkpoint is unreachable, the write stays declined. Advice that could not be steered into the turn is kept, and every write is declined until it is delivered.

### D5. Authentication and billing

- **Subscription (ChatGPT login).** The child uses the operator's Codex login, with `OPENAI_API_KEY` and `CODEX_API_KEY` removed. `account/read` must report `type: "chatgpt"`, or the attempt is refused.
- **API key.** `runners.codex.auth.credentialRef` names the variable. The key is logged in to an owner-only, per-use `CODEX_HOME` under `~/.convoy/private/codex-home/` with `codex login --with-api-key`, reading from stdin. The home is discarded afterwards. The operator's `auth.json` is never written, and `account/read` must report `apiKey`. This has been exercised only with a scripted login, not a live key; see `evidence/acceptance.md`.
- **Billing policy.** This is the same rule as Claude: `included-only` is refused, and an unattended subscription run must state `account-policy`.

### D6. Models

The descriptor accepts `openai/<model>` (or a bare Codex model id) and maps `#variant` to reasoning effort. Preflight lists the account's models with `model/list` and refuses a model or effort it does not offer. A step with no model uses Codex's default. Helpers default to `codex/default#low`: Codex's default model at low effort.

### D7. Sessions, observation and lifecycle

- Threads are persisted, so a run can resume an exact thread with `thread/resume`. They appear in the operator's Codex history under `serviceName: "convoy"`.
- Events are mapped to normalized events and written to the coordinator journal:
  - agent-message deltas;
  - reasoning summaries;
  - command, edit and tool markers with activity;
  - token usage (OpenAI counts cached input inside input and reasoning inside output, and both are split out).
- The raw protocol is teed to `logs/<step>.<attempt>.codex.jsonl`.
- Session history is not reconstructed from Codex: the journal is the transcript, as for Claude.
- The loop guard nudges with `turn/steer` and stops with `turn/interrupt`.
- Cancellation interrupts the turn, then ends the child with SIGTERM and the 5 s grace before kill.

### D8. Helpers, human gates and `[o]`

- **Helper inference** (judge, branch name, commit text, advisor consultation) runs an ephemeral thread under `sandbox: read-only`, with the operator's MCP servers disabled. Every write is declined. A read-only helper may run inspection commands, limited to its checkout and never Convoy's private directory.
- **Human gates** in a run without OpenCode iterate in the operator's own interactive Codex, under the reviewed authentication.
- **`[o]`** reopens a finished step with `codex resume <thread> --sandbox read-only --ask-for-approval on-request`.

### Capability declaration

| Capability | Codex |
|---|---|
| read-only, write, verify, model-fanout, parallel | available |
| approvals | available: every action reaches Convoy's policy and gate |
| structured-deliverables, advisor-bridge | available through `convoy mcp` and the checkpoint; the advisor bridge is restricted without the MCP host |
| live-observation | available through the journal; not a native attach |
| post-exit-resume | available (`thread/resume`) |
| usage-reporting | available; subscription values are estimates |
| loop-guard | available (`turn/steer`, `turn/interrupt`) |
| session-history, native-live-attach | unavailable |
| explicit-handoff | restricted: requires a verified quiesced handoff |

## Risks / Trade-offs

- **The protocol is labeled experimental.** Mitigations: a minimum-version gate, defensive reads of a small typed subset, a recorded live session in `evidence/`, and scripted-server tests for every request Convoy answers.
- **Inspection is an allowlist over shell syntax.** It accepts only known readers with no redirection, substitution or writer option, and each path still passes the read policy. Anything it does not recognize is an execution, so a gap fails closed into an approval, not open into a read.
- **The login shell wrapper.** `zsh -lc` sources the operator's rc files before each command. Policy sees the wrapped script, not rc side effects.
- **Threads appear in the operator's Codex history.** This is visible but harmless. Ephemeral threads would lose resume.
