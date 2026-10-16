# Acceptance coverage — `unify-runner-system`

Bounded acceptance evidence, kept separate from the deterministic fixtures. It
records what was actually executed and what remains blocked, so a fixture result
is never presented as a live result and a protocol-only check is never presented
as tool/service parity.

## Executed (deterministic)

| Gate | Command | Result |
|---|---|---|
| Types | `bun run typecheck` | clean |
| Suite | `bun test` | 3937 pass / 4 skip / 0 fail (3941 across 232 files) |
| Build | `bun run build` | `built convoy (darwin-arm64)` |

The 4 skips are the live-gated OpenCode tests (`CONVOY_V2_LIVE=1`), which are not
enabled here (see below).

Newly added coverage for this change (all deterministic, all passing):

- `test/runner-attempt-identity.test.ts` — collision-free attempt identity.
- `test/runner-service-semantics.test.ts` — deliverable rejection/preservation,
  blocking gate, loop nudge/stop, required-service refusal.
- `test/runner-lifecycle-contracts.test.ts` — usage folding, advisor attribution,
  release outcomes, gated session operations, exact session references.
- `test/runner-opencode-deliverables.test.ts`, `runner-opencode-advisor.test.ts`,
  `runner-opencode-loop-guard.test.ts`, `runner-opencode-approvals.test.ts`,
  `runner-opencode-session-controls.test.ts`, `runner-opencode-lifecycle.test.ts`
  — the OpenCode services and facets.
- `test/runner-claude-reconciliation.test.ts` — the Claude capability matrix and
  registered-composition flows.
- `test/runner-attempt-dispatch.test.ts`, `runner-test-harness.test.ts`,
  `runner-adapter-direction.test.ts`, `runner-session-handles.test.ts` — the
  common dispatch, the extensibility fixture and the boundary audit.

## Live acceptance (bounded, explicitly authorized)

Run with `CONVOY_ACCEPT=1 bun run scripts/runner-acceptance.ts` — one tiny Claude
write turn plus one OpenCode turn in a disposable scratch directory. Refuses to
run without the opt-in flag; never part of `bun test`.

| Cell | Command | Result |
|---|---|---|
| Claude (haiku, subscription, enforcement) | `CONVOY_ACCEPT=1 bun run scripts/runner-acceptance.ts` | `status=completed cost=0.0049715`; `hook-fired=true`; wrote `out.txt` = `CLAUDE-ACCEPT` |
| OpenCode (`nan/deepseek-v4-flash`) | same run | `status=completed cost=0.00897575`; session returned |

What this proves: the Claude adapter's mandatory enforcement (PreToolUse hook +
MCP permission host) fires on a real turn, and the attempt completes and writes
the file. The OpenCode cell proves protocol/auth/session only — the free model
has no tool-capable endpoint, so it is **not** evidence of report/advisor/tool
parity. No paid API-key cell was run, and the Claude figure is a subscription
**estimate**, not an invoice line.

## Still not claimed

- **Claude api-key cells** — not run: no `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
  was available.
- **OpenCode tool/service parity (live)** — not run: the authorized free model
  routes to no tool-capable endpoint, so enabling `CONVOY_V2_LIVE=1` would prove
  nothing about `write_report`, the advisor or tool use.

Neither is counted as passed anywhere in this change. The deterministic fixtures
remain the evidence for the contract, the services and the dispatch.
