/**
 * Runner enforcement commands (change `runner-parity-opencode-v2`, tasks 6.2/6.5).
 *
 * The app has no in-process hook/MCP endpoint, so the enforcement plan points at
 * these CLI commands:
 *   - `convoy hook` — a `PreToolUse` hook that evaluates Convoy's policy from
 *     stdin and prints the hook decision JSON.
 *   - `convoy mcp` — the stdio MCP permission host that answers Claude's
 *     `--permission-prompt-tool` calls.
 *
 * Both read a reviewed policy from `CONVOY_RUNNER_POLICY` (JSON), which the
 * Claude adapter sets for every attempt. A missing or malformed policy fails
 * closed to read-only with interactive approvals; an `ask` with no operator
 * denies.
 */

import { decideToolCall, preToolUseOutput, type PreToolUseInput } from "./claude/hook"
import { serveMcpPermissionStdio } from "./claude/mcp-stdio"
import { resolvePermission } from "./claude/permission-broker"

import { runnerPolicyEnv, type PolicyConfig } from "./policy"

/** The policy enforced when none was reviewed for the attempt: nothing but reads. */
const failClosedPolicy: PolicyConfig = { mode: "read-only", approvals: "interactive" }

/** The reviewed policy from the environment, or the fail-closed default. */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyConfig {
  const raw = env[runnerPolicyEnv]
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PolicyConfig
      if (parsed && typeof parsed === "object" && typeof parsed.mode === "string" && typeof parsed.approvals === "string") {
        return parsed
      }
    } catch {
      // fall through to the safe default
    }
  }
  return { ...failClosedPolicy }
}

/** Evaluates one `PreToolUse` payload and returns the hook's stdout JSON. */
export function evaluateHookInput(raw: string, policy: PolicyConfig = policyFromEnv()): string {
  let parsed: PreToolUseInput
  try {
    const value = JSON.parse(raw) as unknown
    parsed = typeof value === "object" && value !== null ? (value as PreToolUseInput) : {}
  } catch {
    parsed = {}
  }
  return preToolUseOutput(decideToolCall(parsed, policy))
}

/** `convoy hook`: reads stdin and writes the hook decision. */
export async function runHookCommand(): Promise<void> {
  const raw = await Bun.stdin.text()
  process.stdout.write(evaluateHookInput(raw))
}

/** `convoy mcp`: runs the stdio permission host. */
export async function runMcpCommand(): Promise<void> {
  const policy = policyFromEnv()
  await serveMcpPermissionStdio(
    {
      resolve: async (call) => {
        const resolved = await resolvePermission({ call, config: policy })
        return { decision: resolved.decision, reason: resolved.reason }
      },
    },
    { input: Bun.stdin.stream(), write: (line) => process.stdout.write(`${line}\n`) },
  )
}
