/**
 * Private per-run server authentication (change `migrate-opencode-v2`, design
 * D2: "Carry connection authentication privately to owned attach/terminal
 * operations, not through generic run metadata or navigation hints").
 *
 * The V2 server's per-boot HTTP Basic password must reach the dashboard's
 * attach path without being written into the run's generic `metadata.json`
 * (which is read for navigation, liveness and history and must stay
 * secret-free). It lives in a separate `0600` file in the run's private dir,
 * which agents cannot read, and is removed when the owned server stops.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { runPrivateDir } from "./workspace"

export type ServerAuth = { url: string; password?: string }

const fileName = "server-auth.json"

export function serverAuthPath(runDir: string): string {
  return join(runPrivateDir(runDir), fileName)
}

/** Writes the private auth record with owner-only permissions. */
export async function writeServerAuth(runDir: string, auth: ServerAuth): Promise<void> {
  await mkdir(runPrivateDir(runDir), { recursive: true, mode: 0o700 })
  await writeFile(serverAuthPath(runDir), JSON.stringify(auth), { mode: 0o600 })
}

/** Reads the private auth record; a missing or malformed file is simply "none". */
export async function readServerAuth(runDir: string): Promise<ServerAuth | undefined> {
  try {
    const parsed = JSON.parse(await readFile(serverAuthPath(runDir), "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.url !== "string") return undefined
    return { url: record.url, ...(typeof record.password === "string" ? { password: record.password } : {}) }
  } catch {
    return undefined
  }
}

/** Removes the private auth record (best effort). */
export async function clearServerAuth(runDir: string): Promise<void> {
  await rm(serverAuthPath(runDir), { force: true }).catch(() => {})
}
