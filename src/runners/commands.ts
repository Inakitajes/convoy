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
 * closed to read-only with interactive approvals. The permission host forwards
 * an `ask` to the attempt's approval bridge (`approval-bridge.ts`); with no
 * bridge, or when it cannot be reached, the `ask` denies.
 */

import { readFile } from "node:fs/promises"

import { advisorToolDescription, advisorFeedbackToolDescription } from "../advisor-bridge"
import { writeReportInputJsonSchemaFor, writeReportToolDescriptionFor } from "../report-bridge"
import { approvalBridgeProvider, attemptToolsClient, bridgeFileEnv, type CheckpointOutcome } from "./attempt-bridge"
import { decideToolCall, isConvoyMcpTool, preToolUseOutput, toActionRequest, type PreToolUseInput } from "./claude/hook"
import type { McpToolHost } from "./claude/mcp-permission-server"
import { serveMcpPermissionStdio } from "./claude/mcp-stdio"
import { resolvePermission } from "./claude/permission-broker"

import { runnerPolicyEnv, type PolicyConfig } from "./policy"

/**
 * How long a forwarded ask waits for the operator. Like OpenCode's gate, a
 * prompt is held until someone answers rather than rejected because nobody is
 * attached right now; the bound only keeps an abandoned host from living forever.
 */
const operatorWaitMs = 24 * 60 * 60_000

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

/** The first-write checkpoint, asked of the attempt's bridge; fails closed when it cannot be reached. */
export type CheckpointClient = () => Promise<CheckpointOutcome>

/** The checkpoint client for the bridge file the hook was pointed at, if any. */
export function checkpointFromEnv(env: NodeJS.ProcessEnv = process.env): CheckpointClient | undefined {
  const file = env[bridgeFileEnv]
  if (!file) return undefined
  return async () => {
    try {
      const { url, token } = JSON.parse(await readFile(file, "utf8")) as { url?: string; token?: string }
      const response = await fetch(`${url}/checkpoint`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
        timeout: false,
      } as RequestInit)
      const body = (await response.json()) as Partial<CheckpointOutcome> & { message?: unknown }
      if (body.decision === "allow") return { decision: "allow" }
      return { decision: "advise", message: typeof body.message === "string" ? body.message : "the advisor checkpoint did not answer" }
    } catch (error) {
      return { decision: "advise", message: `the advisor checkpoint is unreachable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

/**
 * Evaluates one `PreToolUse` payload, consulting the mandatory first-write
 * checkpoint when the policy requires one: a write is held until the
 * attempt's advisor has been consulted, and the advice rides the denial, as
 * OpenCode's gate does. A checkpoint that cannot be reached keeps it denied.
 */
export async function evaluateHookInputWithCheckpoint(raw: string, policy: PolicyConfig = policyFromEnv(), checkpoint: CheckpointClient | undefined = checkpointFromEnv()): Promise<string> {
  let parsed: PreToolUseInput
  try {
    const value = JSON.parse(raw) as unknown
    parsed = typeof value === "object" && value !== null ? (value as PreToolUseInput) : {}
  } catch {
    parsed = {}
  }
  if (policy.requireAdvisorBeforeWrite && toActionRequest(parsed).intent === "write") {
    // Hard policy first: a denied write is never sent to the advisor.
    const decision = decideToolCall(parsed, policy, { advisorSatisfied: true })
    if (decision.effect === "deny") return preToolUseOutput(decision)
    const gate = checkpoint ? await checkpoint() : { decision: "advise" as const, message: "no advisor checkpoint is reachable for this attempt" }
    if (gate.decision === "advise") return preToolUseOutput({ effect: "deny", reason: gate.message })
    return preToolUseOutput(decision)
  }
  return preToolUseOutput(decideToolCall(parsed, policy))
}

/** `convoy hook`: reads stdin and writes the hook decision. */
export async function runHookCommand(): Promise<void> {
  const raw = await Bun.stdin.text()
  process.stdout.write(await evaluateHookInputWithCheckpoint(raw))
}

/** The attempt's Convoy tools, from the bridge the adapter named in the host's env. */
export function convoyToolHost(env: NodeJS.ProcessEnv = process.env): McpToolHost | undefined {
  const client = attemptToolsClient(env)
  if (!client || client.tools.length === 0) return undefined
  const definitions: McpToolHost["definitions"] = [
    ...(client.tools.includes("report")
      ? [{ name: "write_report", description: writeReportToolDescriptionFor(client.reportScope), inputSchema: writeReportInputJsonSchemaFor(client.reportScope) }]
      : []),
    ...(client.tools.includes("advisor")
      ? [
          { name: "advisor", description: advisorToolDescription, inputSchema: { type: "object", properties: { question: { type: "string" } } } },
          {
            name: "advisor_feedback",
            description: advisorFeedbackToolDescription,
            inputSchema: { type: "object", properties: { outcome: { type: "string", enum: ["adopted", "partially-adopted", "rejected"] }, note: { type: "string" }, callId: { type: "string" } }, required: ["outcome"] },
          },
        ]
      : []),
  ]
  return {
    definitions,
    async call(name, args) {
      const route = name === "write_report" ? "/report" : name === "advisor" ? "/advisor" : "/advisor_feedback"
      const body = name === "write_report" ? { payload: args } : args
      const result = await client.call(route, body)
      if (result.ok === true) return { text: typeof result.text === "string" ? result.text : "done", isError: false }
      return { text: typeof result.error === "string" ? result.error : "Convoy rejected the call", isError: true }
    },
  }
}

/**
 * The host environment named by `--bridge-file <path>`: an owner-only file the
 * adapter staged with the attempt bridge's address and token, for a runner
 * (Codex) whose MCP server configuration the agent could read. Undefined
 * without the flag; an unreadable file serves no tools.
 */
export async function bridgeFileEnvironment(args: readonly string[]): Promise<NodeJS.ProcessEnv | undefined> {
  const index = args.indexOf("--bridge-file")
  if (index === -1) return undefined
  const path = args[index + 1]
  if (!path) return {}
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  } catch {
    return {}
  }
}

/**
 * `convoy mcp`: runs the stdio MCP host. With `--bridge-file` it serves only
 * Convoy's tools, for a runner that asks for approvals in-band; otherwise it
 * is Claude's permission host plus those tools.
 */
export async function runMcpCommand(args: readonly string[] = []): Promise<void> {
  const fromFile = await bridgeFileEnvironment(args)
  if (fromFile) {
    const tools = convoyToolHost(fromFile)
    await serveMcpPermissionStdio(
      { permissionTool: false, ...(tools ? { tools } : {}), resolve: async () => ({ decision: "deny", reason: "this host serves no permission tool" }) },
      { input: Bun.stdin.stream(), write: (line) => process.stdout.write(`${line}\n`) },
    )
    return
  }
  const policy = policyFromEnv()
  const requestApproval = approvalBridgeProvider()
  const tools = convoyToolHost()
  await serveMcpPermissionStdio(
    {
      ...(tools ? { tools } : {}),
      resolve: async (call) => {
        // Convoy's own tools are mediated by the attempt's bridge, which scopes
        // and validates every call; the permission tool never second-guesses them.
        if (isConvoyMcpTool(call.tool_name)) return { decision: "allow", reason: "Convoy tool" }
        // The hook, which runs before every tool call, already held the first
        // write for the advisor checkpoint; the host only arbitrates asks.
        const resolved = await resolvePermission({ call, config: policy, state: { advisorSatisfied: true }, ...(requestApproval ? { requestApproval, timeoutMs: operatorWaitMs } : {}) })
        return { decision: resolved.decision, reason: resolved.reason }
      },
    },
    { input: Bun.stdin.stream(), write: (line) => process.stdout.write(`${line}\n`) },
  )
}
