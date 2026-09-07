# Feasibility checkpoint — conversation integration (tasks 2.1–2.3)

Executed against the installed OpenCode CLI `1.18.29` with `@opencode-ai/sdk` `1.18.4`
(pinned in `package.json`). Probes: `scripts/feasibility-sessions.ts` (task 2.1) and
`scripts/feasibility-commands.ts` (task 2.3), run with `bun run scripts/…`. All results
below are observed outcomes from those runs; nothing was inferred from source reading
alone. Task 2.2's foreground mechanism is verified against Convoy's own production paths
(details in the 2.2 section).

## 2.1 Public session lifecycle (disposable checkout)

Steps exercised by `scripts/feasibility-sessions.ts`: a disposable git repository with a
registered worktree, one server spawned from each checkout, then create → exact-ID open →
reconnect → history read → cross-checkout lookups → server restart. The v2 SDK's
flattened parameter shapes (`session.get({ sessionID })`, not a `path` object) are
required — a first probe round that passed a `path` object produced misleading server
errors; the corrected probe is the record.

| Step | Outcome |
| --- | --- |
| Server boot | `opencode serve` boots in <1s from any checkout; URL is parsed from stdout. The SDK's `createOpencodeServer` cannot set a cwd, so a per-checkout service spawns the CLI the same way with an explicit `cwd`. |
| `session.create` (SDK) | Works; the `title` is honored (`ses_…` id returned). |
| Exact-ID open | `session.get({ sessionID })` returns the full session (SDK, ok). |
| History read | `session.messages({ sessionID })` works (`[]` for a fresh session). |
| Reconnect | A fresh client against the same URL reads the same session (ok). |
| Repository scoping | Sessions of a worktree and its main checkout resolve to the **same project** and share the session store — OpenCode scopes projects by repository, matching the repository-scoped feature identity model. |
| Restart in the same repository | A new server spawned from a checkout of the same repo resolves the exact prior session id and its messages (SDK ok, raw `GET /session/{id}` 200) — the continuity contract is feasible through public APIs. |
| Prompt without credentials | `session.promptAsync` returns without hanging; a model call was never needed for any checkpoint step. |

Design consequences:

- Durable conversation references (`harness: "opencode"`, `sessionId`) are sufficient for
  exact-session resumption: any server of the same repository can reopen the session.
- A per-checkout server is unnecessary for authoring conversations (same repository = same
  project); the conversation service can reuse one server per repository.

## 2.2 Foreground terminal hosting

Two layers of evidence, both with the installed terminal APIs:

**Production paths** (`src/tui.ts`): the dashboard's lazygit/`git log` subshell and the
publish flow already suspend with depth counting, spawn children with inherited stdio, and
restore in `finally` — normal exit, non-zero exit, and failure restore are exercised in
everyday use.

**Dedicated probe** (`scripts/feasibility-foreground.ts`, run under a real pty via
`script -q /dev/null bun run scripts/feasibility-foreground.ts`; records land in
`feasibility-foreground.log`). The probe uses the real `createCliRenderer` alternate-screen
renderer plus the new `runForegroundChild` host:

| Outcome | Observed |
| --- | --- |
| Renderer up | 80×24 alternate-screen renderer, alive. |
| Normal child exit | exit 0; `suspend`→`resume` ran; renderer alive, not destroyed. |
| Non-zero child exit | exit 7; same restore; renderer alive. |
| Startup failure | child argv does not exist (ENOENT thrown); `resume` still ran (restore is in `finally`); renderer alive. |
| Interruption | SIGINT delivered to the foreground child (the same signal the terminal's Ctrl+C produces) → child exited 130; Convoy's renderer restored afterwards. |
| Resize while the child owns the terminal | pty resized 80×24 → 60×20 from inside the child; after return the renderer reports 60×20 with input alive — the restored UI picks up current dimensions. |

Caveat recorded honestly: the probe's child is a shell, not the full OpenCode TUI, and the
interrupt is the delivered SIGINT signal rather than a human keypress — the final 4.5 wiring
(Iterate/foreground conversation) must re-run this probe with `opencode <dir> --session=<id>`
as the child before the conversation path ships.

## 2.3 Project authoring-command discovery

`scripts/feasibility-commands.ts` against this repository:

- `GET /command` (SDK `command.list` and raw HTTP, both 200) returns the project's
  `.opencode/commands/*.md` set; `opsx-propose` was discovered (`opsx-apply`,
  `opsx-archive`, `opsx-explore`, `opsx-propose`, `opsx-sync`, `opsx-update`).
- Invocation shape (documented from the SDK types, deliberately not executed so no real
  proposal workflow started): `POST /session/{id}/command` with
  `{ command: "opsx-propose", arguments: "<change name or description>" }`.
- No global command installation occurs anywhere in these probes.

## Interactive-client resume path (supports D4)

The installed CLI exposes `opencode <project> --session=<id>` (`--help` confirms the
positional project path and `-s/--session`), and the SDK's `createOpencodeTui` passes
`--project=`/`--session=` with inherited stdio — the public mechanism for "open the exact
linked session in the current terminal and return to Convoy on client exit".
