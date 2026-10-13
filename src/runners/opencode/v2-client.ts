/**
 * Convoy-owned OpenCode v2 client boundary (change `runner-parity-opencode-v2`,
 * tasks 4.1/4.2).
 *
 * The only module that imports `@opencode/client`. The rest of Convoy talks to
 * the neutral runner contracts; this boundary maps Convoy's needs onto the
 * released v2 contract and carries the managed server's per-boot credential.
 *
 * The v2 server is HTTP Basic `opencode:<password>`; an unauthenticated request
 * gets 401 and an unknown path can answer with the web app's HTML, so every
 * helper validates the payload shape rather than trusting a 200.
 */

import { OpenCode } from "@opencode/client"

import type { ServerInfo } from "@opencode/client"

export type OpencodeV2Client = ReturnType<typeof OpenCode.make>

/** The HTTP Basic header for a managed server's per-boot password. */
export function basicAuthHeader(password: string, username = "opencode"): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
}

export type CreateV2ClientInput = {
  baseUrl: string
  /** Per-boot server password; omit only for a deliberately unauthenticated probe. */
  password?: string
  fetch?: typeof globalThis.fetch
}

export function createV2Client(input: CreateV2ClientInput): OpencodeV2Client {
  const headers: Record<string, string> = {}
  if (input.password !== undefined && input.password.length > 0) {
    headers.authorization = basicAuthHeader(input.password)
  }
  return OpenCode.make({
    baseUrl: input.baseUrl,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  })
}

function isServerInfo(value: unknown): value is ServerInfo {
  return typeof value === "object" && value !== null && typeof (value as { version?: unknown }).version === "string"
}

/**
 * Returns the server's info, rejecting a payload that is not the expected object
 * (an HTML error page or a wrong envelope must never be read as success).
 */
export async function serverInfo(client: OpencodeV2Client): Promise<ServerInfo> {
  const info: unknown = await client.server.info()
  if (!isServerInfo(info)) {
    throw new Error("opencode v2 server returned an unexpected server info payload")
  }
  return info
}

/** Creates a session at an explicit location, validating the returned id. */
export async function createSession(
  client: OpencodeV2Client,
  input: { directory: string; title?: string },
): Promise<{ id: string; directory?: string }> {
  const session = await client.session.create({
    location: { directory: input.directory },
    ...(input.title ? { title: input.title } : {}),
  })
  if (!session || typeof session !== "object" || typeof (session as { id?: unknown }).id !== "string") {
    throw new Error("opencode v2 server returned an unexpected session payload")
  }
  return session as { id: string; directory?: string }
}
