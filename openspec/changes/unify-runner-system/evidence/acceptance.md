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

## Blocked (no live claim)

- **Claude live calls** — not run. Spending usage requires explicit authorization
  and account credentials; no `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` was
  available for an api-key cell. Owner-subscription cells are covered by
  `scripts/runner-acceptance.ts` (`CONVOY_ACCEPT=1`) when the operator authorizes
  a bounded run.
- **OpenCode live tool/service parity** — not run. The authorized free model
  (`nan/deepseek-v4-flash`) currently routes to no tool-capable endpoint, so a
  live turn can only exercise protocol/auth/session, not `write_report`, advisor
  or tool use. Enabling `CONVOY_V2_LIVE=1` without such an endpoint would prove
  nothing about service parity.

Neither blocked cell is counted as passed anywhere in this change. The
deterministic fixtures remain the evidence for the contract, the services and the
dispatch.
