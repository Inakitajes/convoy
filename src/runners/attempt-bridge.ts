/**
 * The attempt bridge (change `runner-parity-opencode-v2`, task 6.5; shared by
 * the CLI runners since `add-codex-runner`).
 *
 * Convoy's MCP host (`convoy mcp`) is a grandchild of the coordinator, so an
 * ask-level decision, a `write_report` submission, or an advisor consultation
 * cannot reach the attempt in process. The adapter starts this loopback
 * endpoint per attempt and hands the host its URL and a random bearer token;
 * the host forwards each call here and the attempt's services decide it the
 * way OpenCode's permission gate and tools do.
 *
 * A caller without the token is refused, and every failure — an unreachable
 * bridge, a bad response, a rejected token — denies. The token reaches the
 * permission host alone: through its MCP server `env`, staged in an owner-only
 * file under Convoy's private dir (`stagePrivateMcpConfig`), never through
 * Claude's own environment or argv, which the agent's tools can read.
 */

import { randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { registerSecret } from "./redaction"
import type { WriteReportScope } from "../report"
import { convoySecretsDir } from "../workspace"

export type PermissionAsk = {
  tool: string
  resource?: string
  reason: string
}

/** Resolves an `ask` to a boolean operator decision. */
export type ApprovalProvider = (ask: PermissionAsk) => Promise<boolean>

export const approvalUrlEnv = "CONVOY_APPROVAL_URL"
export const approvalTokenEnv = "CONVOY_APPROVAL_TOKEN"

export type ClaudeApprovalBridge = {
  /** The variables the permission host reads to reach this bridge. */
  env: Record<string, string>
  close(): Promise<void>
}

function tokenMatches(header: string | null, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`)
  const given = Buffer.from(header ?? "")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function askFrom(body: unknown): PermissionAsk | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const record = body as Record<string, unknown>
  if (typeof record.tool !== "string") return undefined
  return {
    tool: record.tool,
    ...(typeof record.resource === "string" ? { resource: record.resource } : {}),
    reason: typeof record.reason === "string" ? record.reason : "",
  }
}

/** The Convoy tools an attempt's MCP host exposes besides the permission tool. */
export type ConvoyToolName = "report" | "advisor"

/** The base URL of an attempt's tool routes, and which tools it serves. */
export const toolsUrlEnv = "CONVOY_TOOLS_URL"
export const toolsEnv = "CONVOY_TOOLS"
/** The phase scope the host's write_report schema follows (`writable`, `scoring` flags). */
export const reportScopeEnv = "CONVOY_REPORT_SCOPE"
/** The private file the PreToolUse hook reads the bridge address and token from. */
export const bridgeFileEnv = "CONVOY_BRIDGE_FILE"

export type ToolOutcome = { ok: true; text: string } | { ok: false; error: string }
export type CheckpointOutcome = { decision: "allow" } | { decision: "advise"; message: string }

/**
 * What one Claude attempt's bridge serves. Each handler is bound to that
 * attempt's own services, so a tool call can never reach a sibling attempt's
 * report or advisor: the bridge, its token, and its handlers are per attempt.
 */
export type ClaudeAttemptHandlers = {
  /** Ask-level permission decisions (the permission host's `ask`). */
  approve?: ApprovalProvider
  /** A `write_report` submission, validated by the attempt's deliverable service. */
  report?: (payload: unknown) => Promise<ToolOutcome>
  /** The attempt's phase scope, which the host's write_report schema follows. */
  reportScope?: WriteReportScope
  advisor?: {
    consult(question?: string): Promise<ToolOutcome & { callId?: string }>
    feedback(callId: string | undefined, outcome: string, note?: string): Promise<ToolOutcome>
    /** The mandatory first-write checkpoint the hook enforces. */
    checkpoint(): Promise<CheckpointOutcome>
  }
}

export type ClaudeAttemptBridge = ClaudeApprovalBridge & {
  url: string
  token: string
  /** The tools the attempt's MCP host should expose. */
  tools: ConvoyToolName[]
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const body = await request.json().catch(() => undefined)
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined
}

/** Starts a loopback bridge serving one attempt's approvals and Convoy tools. */
export async function startClaudeAttemptBridge(handlers: ClaudeAttemptHandlers): Promise<ClaudeAttemptBridge> {
  const token = randomBytes(32).toString("hex")
  registerSecret(token)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // An operator may take minutes to answer; the permission host bounds the wait.
    idleTimeout: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 404 })
      if (!tokenMatches(request.headers.get("authorization"), token)) return new Response(null, { status: 401 })
      const route = new URL(request.url).pathname
      if (route === "/approve" && handlers.approve) {
        const ask = askFrom(await request.json().catch(() => undefined))
        if (!ask) return new Response(null, { status: 400 })
        const approved = await handlers.approve(ask).catch(() => false)
        return Response.json({ approved: approved === true })
      }
      const body = await jsonBody(request)
      if (!body) return new Response(null, { status: 400 })
      const fail = (error: unknown): ToolOutcome => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
      if (route === "/report" && handlers.report) return Response.json(await handlers.report(body.payload).catch(fail))
      if (route === "/advisor" && handlers.advisor) {
        return Response.json(await handlers.advisor.consult(typeof body.question === "string" ? body.question : undefined).catch(fail))
      }
      if (route === "/advisor_feedback" && handlers.advisor) {
        const callId = typeof body.callId === "string" ? body.callId : undefined
        const note = typeof body.note === "string" ? body.note : undefined
        return Response.json(await handlers.advisor.feedback(callId, typeof body.outcome === "string" ? body.outcome : "", note).catch(fail))
      }
      if (route === "/checkpoint" && handlers.advisor) {
        // A checkpoint that cannot consult keeps the write blocked (spec runner-advisors).
        return Response.json(await handlers.advisor.checkpoint().catch((error: unknown) => ({ decision: "advise", message: `the advisor is unavailable: ${error instanceof Error ? error.message : String(error)}` })))
      }
      return new Response(null, { status: 404 })
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const tools: ConvoyToolName[] = [...(handlers.report ? (["report"] as const) : []), ...(handlers.advisor ? (["advisor"] as const) : [])]
  return {
    url,
    token,
    tools,
    env: {
      ...(handlers.approve ? { [approvalUrlEnv]: `${url}/approve` } : {}),
      [approvalTokenEnv]: token,
      [toolsUrlEnv]: url,
      [toolsEnv]: tools.join(","),
      ...(handlers.report && handlers.reportScope ? { [reportScopeEnv]: reportScopeFlags(handlers.reportScope) } : {}),
    },
    async close() {
      await server.stop(true)
    },
  }
}

/** The runner-neutral names for the attempt bridge. */
export const startAttemptBridge = startClaudeAttemptBridge
export type AttemptHandlers = ClaudeAttemptHandlers
export type AttemptBridge = ClaudeAttemptBridge

function reportScopeFlags(scope: WriteReportScope): string {
  return [...(scope.writable ? ["writable"] : []), ...(scope.scoring ? ["scoring"] : [])].join(",")
}

/** The scope named in `env`; absent (an older or unscoped host) offers every field. */
function reportScopeFrom(env: NodeJS.ProcessEnv): WriteReportScope | undefined {
  const raw = env[reportScopeEnv]
  if (raw === undefined) return undefined
  const flags = raw.split(",")
  return { writable: flags.includes("writable"), scoring: flags.includes("scoring") }
}

/** Calls one of the attempt's tool routes; any failure is a tool error, never a success. */
export function attemptToolsClient(
  env: NodeJS.ProcessEnv = process.env,
): { tools: ConvoyToolName[]; reportScope?: WriteReportScope; call(route: string, body: unknown): Promise<Record<string, unknown>> } | undefined {
  const url = env[toolsUrlEnv]
  const token = env[approvalTokenEnv]
  if (!url || !token) return undefined
  const tools = (env[toolsEnv] ?? "").split(",").filter((tool): tool is ConvoyToolName => tool === "report" || tool === "advisor")
  const reportScope = reportScopeFrom(env)
  return {
    tools,
    ...(reportScope ? { reportScope } : {}),
    async call(route, body) {
      try {
        const response = await fetch(`${url}${route}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          // An advisor consultation can take minutes.
          timeout: false,
        } as RequestInit)
        if (!response.ok) return { ok: false, error: `Convoy's bridge answered ${response.status}` }
        return (await response.json()) as Record<string, unknown>
      } catch (error) {
        return { ok: false, error: `Convoy's bridge is unreachable: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

/**
 * Writes the hook's bridge address to an owner-only file under Convoy's
 * private dir; the hook command names only the file's path.
 */
export async function stagePrivateFile(name: string, contents: string, area = "claude-mcp"): Promise<{ path: string; discard(): Promise<void> }> {
  const root = join(convoySecretsDir(), area)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(root, "attempt-"))
  const path = join(dir, name)
  await writeFile(path, contents, { mode: 0o600 })
  return { path, discard: () => rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

/**
 * Writes an MCP config to an owner-only file under Convoy's private dir, which
 * attempts are denied, and returns its path for `--mcp-config` plus a discard.
 */
export async function stagePrivateMcpConfig(mcpConfig: Record<string, unknown>): Promise<{ path: string; discard(): Promise<void> }> {
  return stagePrivateFile("mcp.json", JSON.stringify(mcpConfig))
}

/** The permission host's approval provider for a bridge named in `env`, if any. */
export function approvalBridgeProvider(env: NodeJS.ProcessEnv = process.env): ApprovalProvider | undefined {
  const url = env[approvalUrlEnv]
  const token = env[approvalTokenEnv]
  if (!url || !token) return undefined
  return async (ask) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(ask),
        // Bun's fetch otherwise gives up on an operator who takes minutes to answer.
        timeout: false,
      } as RequestInit)
      if (!response.ok) return false
      const body = (await response.json()) as { approved?: unknown }
      return body.approved === true
    } catch {
      return false
    }
  }
}
