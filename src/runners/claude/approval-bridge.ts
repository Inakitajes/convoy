/**
 * Claude approval bridge (change `runner-parity-opencode-v2`, task 6.5).
 *
 * Claude's permission host (`convoy mcp`) is a grandchild of the coordinator,
 * so an ask-level decision cannot reach the operator in process. The adapter
 * starts this loopback endpoint per attempt and hands the permission host its
 * URL and a random bearer token through the child environment; the host
 * forwards each `ask` here and the attempt's approval service decides it the
 * way OpenCode's permission gate does.
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

import { registerSecret } from "../redaction"
import { convoySecretsDir } from "../../workspace"
import type { ApprovalProvider, PermissionAsk } from "./permission-broker"

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

/** Starts a loopback bridge that answers each forwarded ask with `decide`. */
export async function startClaudeApprovalBridge(decide: ApprovalProvider): Promise<ClaudeApprovalBridge> {
  const token = randomBytes(32).toString("hex")
  registerSecret(token)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // An operator may take minutes to answer; the permission host bounds the wait.
    idleTimeout: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/approve") return new Response(null, { status: 404 })
      if (!tokenMatches(request.headers.get("authorization"), token)) return new Response(null, { status: 401 })
      const ask = askFrom(await request.json().catch(() => undefined))
      if (!ask) return new Response(null, { status: 400 })
      const approved = await decide(ask).catch(() => false)
      return Response.json({ approved: approved === true })
    },
  })
  return {
    env: { [approvalUrlEnv]: `http://127.0.0.1:${server.port}/approve`, [approvalTokenEnv]: token },
    async close() {
      await server.stop(true)
    },
  }
}

/**
 * Writes an MCP config to an owner-only file under Convoy's private dir, which
 * attempts are denied, and returns its path for `--mcp-config` plus a discard.
 */
export async function stagePrivateMcpConfig(mcpConfig: Record<string, unknown>): Promise<{ path: string; discard(): Promise<void> }> {
  const root = join(convoySecretsDir(), "claude-mcp")
  await mkdir(root, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(root, "attempt-"))
  const path = join(dir, "mcp.json")
  await writeFile(path, JSON.stringify(mcpConfig), { mode: 0o600 })
  return { path, discard: () => rm(dir, { recursive: true, force: true }).catch(() => {}) }
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
