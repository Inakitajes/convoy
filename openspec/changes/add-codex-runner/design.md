# Design

## Context

See `proposal.md` and `evidence/app-server-spike.md`. This builds on `generalize-runner-routes`: Codex is a registered descriptor and adapter, with no core branch. The Claude adapter (`src/runners/claude/**`) is the reference for auth, billing, the MCP host and the journal. The OpenCode adapter is the reference for a client-driven, approval-gated protocol.

## Goals / Non-Goals

**Goals:**

- A Codex-only plan runs end to end (steps, goal loop, advisors, judge, helpers, finalization, authoring) without OpenCode or Claude installed.
- Convoy's policy decides every command, edit and tool call, as with the other runners.
- Exact provenance: runner, auth mode, requested and resolved model and effort, thread ID, attempt.

**Non-Goals:**

- Using Codex's own `--worktree`, cloud tasks, `auto_review`/guardian approvals, plugins or apps. Convoy owns checkouts and approvals.
- Mutating the operator's Codex state: `auth.json`, `config.toml`, execpolicy `rules`, hook trust. A Codex-native advisor or review mode.
- An OS-sandbox guarantee. Seatbelt confinement is used, but Convoy's claim stays tool-policy enforcement.

## Decisions

### D1. Transport: an owned `codex app-server` per attempt, over stdio

`codex exec --json` would mirror Claude's print mode and inherit its gaps: no live approval round-trip without hooks, no steer, no in-protocol auth check. The app-server is a JSON-RPC client protocol in which Codex asks before every action (spike findings 1, 2 and 7). Convoy starts `codex app-server --disable hooks -c <convoy overrides>` per attempt as its own child. It never attaches to the operator's shared daemon. The descriptor's probe pins a supported version range, and app-server types are generated (`generate-ts`) at the pinned version and checked in. An unsupported version restricts the runner's capabilities, as OpenCode V2's major-version rule does.

`dynamicTools` would remove the MCP process and the bridge, but it is experimental. v1 uses MCP (D4). `dynamicTools` is a follow-up once it is stable.

### D2. Execution modes

| Convoy mode | `sandbox` | `approvalPolicy` | Policy |
|---|---|---|---|
| read-only | `read-only` | `untrusted` | all writes and non-read commands denied |
| verify | `read-only` | `untrusted` | approved verification commands only; writes denied |
| write | `workspace-write` | `untrusted` | the run's approval policy |

`approvalsReviewer` stays `user` (the client). Convoy answers only `accept` or `decline`, never `acceptForSession`, `acceptWithExecpolicyAmendment` or network-policy amendments, because those persist decisions outside Convoy's policy. Spike finding 3 shows an approved write escapes `read-only`, so policy, not sandbox, is the read-only guarantee.

### D3. Approval translation

- `item/commandExecution/requestApproval`: unwrap the login-shell wrapper (`/bin/zsh -lc '…'`), then run the existing bash policy (hard denials, private-directory denial, verify allowlist), then the operator gate (interactive, auto, smart judge). `--yolo` approves only eligible ask-level requests.
- `item/fileChange/requestApproval`: take the paths and diff from the `fileChange` item with the same `itemId` (seen in `item/started`), then classify and decide as an edit. A request whose item was not seen is declined.
- `mcpServer/elicitation/request`: accept for Convoy's own server. Decline any other server.
- `item/permissions/requestApproval`, `item/tool/requestUserInput`: decline. A run has no interactive user inside the agent.
- Any unknown server request: a JSON-RPC error, plus a logged policy event. The thread is never left waiting.

### D4. Convoy services through `convoy mcp`

The attempt adds `-c mcp_servers.convoy.command/args` pointing at `convoy mcp --bridge-file <private path>`. As with Claude, the bridge address and token live in an owner-only file under `~/.convoy/private/`, never in argv or in the agent's environment. The policy denies the agent that directory. Before adding Convoy's server, Codex config overrides clear operator-defined MCP servers for the run; this is verified in tasks. The MCP host binds each call to the attempt through `_meta.x-codex-turn-metadata.thread_id` (finding 8). A call from another thread is rejected, the same as a stale-session submission.

The first-write checkpoint holds the first `fileChange` approval (or the first command classified as a write) while the advisor is consulted. Convoy then declines the held action and delivers the advice with `turn/steer`. Later writes proceed. If the consultation fails, the hold is released by accepting, so the executor never loses a turn. If the checkpoint cannot be reached, the write stays declined.

### D5. Authentication and billing

- **Subscription (ChatGPT login).** The child inherits the operator's `CODEX_HOME` login. `OPENAI_API_KEY`, `CODEX_API_KEY` and similar ambient keys are removed from the child's environment. `account/read` must report `type: "chatgpt"`, or the attempt is refused.
- **API key.** `runners.codex.auth.credentialRef` names the variable. The key is installed only in an owner-only, per-run `CODEX_HOME` under `~/.convoy/private/`, which never writes the operator's `auth.json`. If the implementation cannot achieve this, the capability stays restricted with that reason, rather than falling back to mutating the operator's login.
- **Billing policy.** This is the same rule as Claude. `included-only` is refused because nothing enforces it, and an unattended subscription run must state `account-policy`. Rate limits from `account/rateLimits/read` are shown for information, never as a guarantee.

### D6. Models

The descriptor accepts `openai/<model>`, maps it to the native `<model>`, and maps `#variant` to `reasoningEffort` (Codex efforts such as `low`, `medium`, `high`, `xhigh`). Preflight validates both against `model/list` under the attempt's auth, so a model the account cannot use fails before any write. A route without a model uses Codex's default. The resolved model and effort reported by `thread/start` are what provenance records.

### D7. Sessions, observation and lifecycle

- Threads are persisted (not `ephemeral`), so a run can resume (`thread/resume`) and a late observer can rebuild history (`thread/read`). They appear in the operator's Codex history with a Convoy `threadSource`. This is disclosed in the docs.
- Events are mapped to normalized events (`item/agentMessage/delta`, reasoning summaries, command and file items, `thread/tokenUsage/updated`, `turn/completed`) and written to the coordinator journal. Dashboards follow the journal, as with Claude.
- The loop guard nudges with `turn/steer` and stops with `turn/interrupt`.
- Cancellation sends `turn/interrupt`, closes stdin, then SIGTERM with the same 5 s grace before kill. The attempt settles as interrupted with the thread recorded.

### D8. Helpers and authoring

Helper inference (judge, branch name, commit text, advisor consultation) runs as an ephemeral thread under `sandbox: read-only`, declining every action, with `outputSchema`-shaped answers where the helper has one. Authoring conversations open the operator's own interactive `codex` (`codex resume <thread>` for a linked session). The operator's hooks and config apply there because it is their session, while the writer claim is taken and released around it.

### Capability declaration

| Capability | Codex |
|---|---|
| read-only, write, verify, model-fanout, parallel | available |
| approvals | available: native approval requests to Convoy's policy and gate; restricted when the version is unsupported |
| structured-deliverables, advisor-bridge | available through `convoy mcp` and the fileChange checkpoint; restricted when enforcement is not ready |
| live-observation | available through the journal; not a native attach |
| session-history, post-exit-resume | available (`thread/read`, `thread/resume`) |
| usage-reporting | available; subscription values are estimates |
| loop-guard | available (`turn/steer`, `turn/interrupt`) |
| native-live-attach | unavailable until `codex --remote` attach is verified |
| explicit-handoff | restricted: requires a verified quiesced handoff |

## Risks / Trade-offs

- **The protocol is labeled experimental.** Pin and probe the version, generate types, keep protocol fixtures recorded from real sessions, and fail closed when the version is unsupported.
- **The login shell wrapper.** `zsh -lc` sources the operator's rc files before each command. Policy sees the wrapped command, not rc side effects. Document this; investigate `shell_environment_policy` or a non-login shell override.
- **Threads in the operator's history.** These are visible but harmless. Ephemeral threads would lose resume, so persistence wins and is disclosed.
- **Token usage on the operator's plan during conformance tests.** Live smoke tests need explicit opt-in, as in `runner-parity-opencode-v2`.
