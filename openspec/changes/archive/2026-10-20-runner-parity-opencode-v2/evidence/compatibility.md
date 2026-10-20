# Runner compatibility record (task 1.2)

Selected and pinned versions, the protocol facts our adapters rely on, and the
evidence status for each. This is the source of truth referenced by the release
gate in `runner-execution` "A selected runner is independently usable".

## Selected versions

| Component | Selected | Rationale |
|---|---|---|
| `@opencode/client` | `2.0.26` (exact) | Released V2 client, pinned so Convoy always speaks the tested protocol. |
| `@opencode/plugin` | `2.0.26` (exact) | V2 plugin API for `write_report` / `advisor` / `advisor_feedback`. |
| `@opencode/schema` | `2.0.26` (exact) | V2 message/session schema types. |
| OpenCode CLI | any `2.x` accepted, **tested `2.0.26`** | The operator's own binary; Convoy never installs/updates it. Locally resolved 2.0.28 at planning time. |
| Claude CLI | **tested `2.1.296`** minimum recorded at implementation | Baseline uses the operator's authenticated CLI (subscription first). |
| Claude Agent SDK | **not a baseline dependency** | Only for an explicitly supported API-key-only feature, after evidence (design D3). |

Convoy never installs, updates, or replaces either runtime, and never mutates
global credentials or configuration.

## Protocol facts by area

| Area | OpenCode V2 fact | Status |
|---|---|---|
| Startup / readiness | `serve` prints a readiness line and a per-boot `server password`. Auth is HTTP Basic `opencode:<password>`. | Established (prior migration branch). Our fixtures must re-confirm against 2.0.26/2.0.28. |
| Credential isolation | A spawned server must not inherit `OPENCODE_PASSWORD`/`OPENCODE_SERVER_PASSWORD`, or it adopts them and skips the printed password line. | Established. |
| Prompt admission vs completion | `session.prompt` admits and schedules; acceptance ≠ completion. Completion is observed via history/`idle`, and `session.wait` can return early. | Established. Adopt message-id reconciliation (never resend). |
| Events | Server-wide `event.subscribe`; `permission.asked` carries `action`/`resources`. SSE does not replay missed events on reconnect. | Established; durable journal (D6) compensates. |
| Model lookup | Provider and model inventories are split; classic `provider.list` is the catalog owning session credentials. | Established; group 4/8 revalidate. |
| Tool / plugin registration | Plugins load from run-scoped plugin dirs; `write_report`/`advisor`/`advisor_feedback` ported to the V2 plugin API. | Established. |
| Permissions semantics | V2 bash rules are last-match-wins; edit/write raise `edit`. | Established; D7 maps mandatory enforcement via a pre-action point. |
| Temperature forwarding | OpenCode 2.0.26 forwards no agent temperature from any config path. | Known upstream gap; record and keep emitting. |
| `doom_loop` | V2 accepts the key but has no detector. | Loop-guard fuse covers repetition. |

## Claude CLI facts

| Area | Fact | Status |
|---|---|---|
| Headless streaming | `claude -p --output-format stream-json --verbose --include-partial-messages`; final `result` message carries text, cost, session id. | Documented. |
| Subscription vs API key | Subscription login works headless; `--bare` does **not** use subscription login. | Documented. |
| Paid usage credits | Subscription auth can still consume paid usage credits / paid features; authentication is not a no-cost guarantee. | Documented; drives the separate billing policy (design D3). |
| Permission hosting | MCP `--permission-prompt-tool` hosts ask-level prompts; `PreToolUse` hooks run before other steps and cannot be skipped by auto-approval. | Documented; group 6 validates. |
| Native advisor / background attach | `--advisor` and `--bg` exist; `--bg` does not combine with `-p`. | Candidate only; requires equivalence evidence (D8/D10). |

## Authorized test model (real-harness acceptance)

Operator authorization recorded for the OpenCode real-runtime path only:

- **OpenCode acceptance model: `nan/deepseek-v4-flash`** (provider `nan`). Use it
  for OpenCode real-runtime acceptance (tasks 1.2/12.2). This is the model the
  adapter fixtures and any OpenCode smoke should drive; do not substitute an
  expensive provider.
  *Limitation observed:* its provider routing answers **404 "No endpoints found
  that support tool use"** when the session's agent enables tools (e.g. `edit`),
  so it verifies protocol, authentication, session, prompt admission, completion
  signalling, and truthful failure — but **not** tool-using steps. Tool-using
  OpenCode acceptance needs either a tool-capable model or an agent config that
  disables tools (config translation lands in task 4.3).
- **Claude acceptance: deferred (design option B).** No Claude real-harness smoke,
  paid or subscription, runs until the Claude adapter exists and the operator
  re-authorizes a bounded spend.

Nothing here authorizes API-key spend on any provider beyond the `nan` provider
above, and no authorization changes global credentials.

## Evidence status

- **Fixture-verified:** OpenCode protocol facts above are documented against a
  real isolated server on a prior migration branch; our change re-establishes
  them under `test/` fixtures owned by this branch (group 4).
- **Documented, not yet fixture-verified on this branch:** Claude protocol facts.
- **Consent-gated (not yet run):** bounded real-harness smoke and any paid model
  calls (tasks 1.3, 1.4, 12.2). Requires explicit operator approval and budget.
- **Release gate:** every mandatory parity-matrix cell in `design.md` D4 must
  have passing automated tests plus consented real-harness acceptance before
  release; advanced exceptions must name exact versions/modes.

## Real acceptance (bounded, 2026-10-15)

Claude CLI `2.1.296`, subscription (claude.ai, Pro). No `ANTHROPIC_API_KEY` in the environment.

Bounded smoke (deliberately minimal spend):

- Command shape: `claude -p "<read note.txt>" --model haiku --settings <PreToolUse hook> --mcp-config <permission host> --permission-prompt-tool mcp__convoy__permission --output-format json`, run in a disposable scratch dir with `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` unset.
- Result: exit 0, `result` = the file contents, `permission_mode` `default`, **subscription** auth (no API key, no token extraction).
- The **`PreToolUse` hook fired** for `tool_name: Read` (proves per-invocation `--settings` load and mandatory interception).
- The **MCP permission host loaded** from `--mcp-config` without error; it was not invoked because the hook allowed the call.
- Cost: **$0.0048**.

Coverage by matrix cell:

| Cell | Status |
|---|---|
| Claude subscription single turn + hook + MCP host | Verified (bounded smoke above) |
| Claude API-key execution | **Not run** — no API key available in this environment |
| OpenCode v2 | Verified via `nan/deepseek-v4-flash` live tests (auth, session, prompt/`idle`, streaming, continuation) |
| Mixed plan (Claude + OpenCode in one group) | Verified at the scheduler/planning level (`test/runner-mixed-parallel.test.ts`); a real mixed full-cycle was not run to bound spend |
| Full-cycle (reports/advisor/parallel/abort/recovery) on real Claude | **Deferred** — cost |

`with explicit consent, a bounded real-harness smoke result` (task 1.3) is satisfied by the subscription smoke. Cells that need an API key or a full paid cycle remain explicitly deferred rather than claimed.

### Adapter-level mixed acceptance (2026-10-15)

`CONVOY_ACCEPT=1 bun run scripts/runner-acceptance.ts` — disposable scratch dir,
`composeRunners` with a real enforcement plan (PreToolUse hook + MCP permission
host), both adapters through the neutral registry:

- **Claude (subscription, `haiku`, write mode):** `completed`, wrote `out.txt`
  with the requested content, `PreToolUse` hook fired, cost **$0.0049**.
- **OpenCode (`nan/deepseek-v4-flash`, write mode):** `completed`.
- Both sessions returned real ids; nothing fabricated.

This exercises the adapters end-to-end (auth, enforcement, tools, session,
outcome) rather than only the CLI in isolation. A real *single-pipeline* mixed
run (Claude + OpenCode steps in one Convoy run) still requires wiring the
composition root into `runner.ts`'s dispatch, which is the remaining step.
