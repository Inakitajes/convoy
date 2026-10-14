/**
 * Private per-server authentication record (change `runner-parity-opencode-v2`,
 * task 3.5).
 *
 * The v2 server's per-boot HTTP Basic password must reach terminal/attach
 * operations without ever entering generic run metadata, logs, or argv. It lives
 * in a private directory the run owns, in a `0600` file, alongside the server
 * URL. It is removed when the owned server stops.
 *
 * Pure filesystem helper; the caller supplies the private directory so the
 * record's location stays a composition decision.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type ServerAuth = { url: string; password?: string }

const fileName = "server-auth.json"

export function serverAuthPath(privateDir: string): string {
  return join(privateDir, fileName)
}

/** Writes the private auth record with owner-only permissions. */
export async function writeServerAuth(privateDir: string, auth: ServerAuth): Promise<string> {
  const path = serverAuthPath(privateDir)
  await mkdir(privateDir, { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(auth), { mode: 0o600 })
  return path
}

/** Reads the private auth record; a missing or malformed file is simply "none". */
export async function readServerAuth(privateDir: string): Promise<ServerAuth | undefined> {
  try {
    const parsed = JSON.parse(await readFile(serverAuthPath(privateDir), "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.url !== "string") return undefined
    return { url: record.url, ...(typeof record.password === "string" ? { password: record.password } : {}) }
  } catch {
    return undefined
  }
}

/** Removes the private auth record (best effort). */
export async function clearServerAuth(privateDir: string): Promise<void> {
  await rm(serverAuthPath(privateDir), { force: true }).catch(() => {})
}
