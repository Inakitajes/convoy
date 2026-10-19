# Codex app-server spike (2026-10-18)

What the installed Codex CLI (`codex-cli 0.163.0`, macOS, ChatGPT login) does when Convoy drives it as a client. This decides the transport and how Convoy's policy is enforced.

Method: a throwaway Bun driver spoke JSON-RPC to `codex app-server` over stdio (`initialize` with `experimentalApi`, `account/read`, `thread/start`, `turn/start`), logged every server request and item, and answered approvals with a fixed decision. It ran against a disposable Git repo, plus a secret file outside it, and a minimal stdio MCP server exposing `write_report`. Three short turns, about 200k tokens in total, on the operator's ChatGPT plan. The protocol schema came from `codex app-server generate-json-schema [--experimental]`.

## Findings

| # | Question | Result | Consequence |
|---|---|---|---|
| 1 | With `approvalPolicy: "untrusted"`, do "safe" commands run without asking? | **No.** `ls`, `cat <secret outside repo>`, `git status` and `echo hi > out.txt` each arrived as `item/commandExecution/requestApproval` before running. Declining returned "rejected by user" to the model. | Every command reaches Convoy's policy and gate. No hook is needed to see commands. |
| 2 | Do file edits (apply_patch) ask? | **Yes**, as `item/fileChange/requestApproval` (params: `itemId`, `threadId`, `turnId`, `reason`, `grantRoot`; no diff). The paths and diff are on the preceding `fileChange` item. | The adapter correlates by `itemId`. Write classification uses the item's changes. |
| 3 | Does a `read-only` sandbox stop an approved write? | **No.** Accepting the `fileChange` approval under `sandbox: read-only` created the file. Approval escalates past the sandbox. | Read-only and verify modes must deny writes in Convoy's policy, as with Claude. The sandbox is defense in depth, not the guarantee. |
| 4 | Commands are wrapped how? | `/bin/zsh -lc '<cmd>'` (the user's login shell). | `bash-policy` already unwraps `sh -c` spellings. The wrapper and login-shell rc side effects must be covered by tests. |
| 5 | Do the operator's Codex hooks fire inside the run? | **Yes** by default: `~/.codex/hooks.json` `permissionRequest` and `stop` hooks ran (`hook/started`/`hook/completed`). With `--disable hooks` none ran. | Runs start the app-server with `--disable hooks`. |
| 6 | Can Convoy inject its own MCP host per invocation? | **Yes**, with `-c mcp_servers.convoy.command=…` and `args=[…]`. The tool call reached the server. | Reuse `convoy mcp` for `write_report`, `advisor` and `advisor_feedback`. |
| 7 | Do MCP tool calls ask? | **Yes**, as `mcpServer/elicitation/request`. The response needs `{ "action": "accept" }`; a malformed one fails the call. | Accept only Convoy's own server. Any other MCP tool is denied, matching the policy that unknown MCP tools are denied. |
| 8 | Can an MCP call be tied to an attempt? | **Yes.** `_meta.x-codex-turn-metadata` carries `thread_id`, `turn_id`, model, effort and sandbox. | The MCP host binds submissions to the attempt's thread, so a stale thread cannot submit. |
| 9 | Auth visibility | `account/read` returns `{ type: "chatgpt", planType }` or the API-key form. | The effective-auth check runs in-protocol, before each attempt. |
| 10 | Usage | `thread/tokenUsage/updated` gives input, cached, output and reasoning tokens per turn and in total. `account/rateLimits/read` exists. | Usage reporting is available. Subscription values are estimates. |
| 11 | Default model | `thread/start` reports the resolved model and effort (`gpt-6.1-sol`, `high`). | Provenance records the resolved model, not just the requested one. |

## Protocol surface relevant to Convoy (not exercised)

- `turn/steer` (`threadId`, `expectedTurnId`, `input`) and `turn/interrupt`: candidates for the loop guard and the advisor checkpoint.
- `thread/resume`, `thread/read`, `thread/turns/list`: post-exit resume and session history.
- `model/list`: model and reasoning-effort validation at preflight.
- `dynamicTools` on `thread/start` and `item/tool/call`: in-band Convoy tools with no MCP process or bridge. **Experimental only** (`experimentalApi`).
- `codex --remote ws://…`: TUI attach to a running app-server, a candidate for native live attach.

## Open questions during implementation

All five are resolved; see `acceptance.md`.

- API-key mode without touching the operator's `~/.codex/auth.json` (`codex login --with-api-key` persists to `CODEX_HOME`). The candidate is an owner-only per-run `CODEX_HOME` under `~/.convoy/private/`.
- Whether operator `mcp_servers` from `config.toml` load in a Convoy run and how to exclude them, for example with `-c mcp_servers={}` before adding Convoy's.
- Whether an approved command under `read-only` or `workspace-write` is still Seatbelt-confined (finding 3 covers only apply_patch).
- Whether a declined write plus `turn/steer` delivers advisor advice reliably for the first-write checkpoint.
- The stability window of the app-server protocol across Codex minors (it is labeled `[experimental]`).
