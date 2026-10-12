/**
 * Script-side V2 fixture: boots an owned `opencode serve` on the isolated
 * environment and returns its URL plus the per-boot password the boundary
 * client authenticates with. Used by the standalone verification/feasibility
 * probes so they run against the same V2 contract the product uses.
 */
import { mkdtemp } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { launchManagedServer } from "../src/managed-server"
import { createProcessRecordStore } from "../src/process-records"

export type ScriptServer = {
  url: string
  password?: string
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("no free port"))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })
}

export async function bootV2Server(cwd: string, port?: number): Promise<ScriptServer> {
  const store = createProcessRecordStore(await mkdtemp(join(tmpdir(), "convoy-script-store-")))
  const server = await launchManagedServer({
    command: "opencode",
    args: ["serve", "--hostname=127.0.0.1", `--port=${port ?? (await freePort())}`],
    cwd,
    env: process.env,
    lifetime: "helper",
    label: "script fixture",
    timeoutMs: 30_000,
    deps: { store, reconcile: async () => {} },
  })
  return {
    url: server.url,
    ...(server.password ? { password: server.password } : {}),
    stop: async () => {
      await server.stop()
    },
  }
}
