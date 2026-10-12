import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { launchManagedServer, type ManagedServer } from "../src/managed-server"
import { createOpencodeClient } from "../src/opencode-client"
import { createProcessRecordStore } from "../src/process-records"

/**
 * Real-runtime boundary evidence (change `migrate-opencode-v2`, task 1.3).
 *
 * Boots the operator's real `opencode` on an isolated HOME/XDG/config with a
 * throwaway repo, then exercises the Convoy boundary client against it. This is
 * the "isolated no-model fixture" the design requires: it proves the readiness
 * protocol, the per-boot password capture, HTTP Basic authentication, session
 * creation, the split provider/model inventory and teardown — none of which a
 * mock can establish. It never reads the user's real config or data.
 *
 * The whole suite skips when no `opencode` binary is on PATH so it is safe in
 * environments without the runtime; a full prompt turn is deliberately out of
 * scope (it needs a model, which is the separately-gated acceptance step).
 */

const dirs: string[] = []
const servers: ManagedServer[] = []

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

const opencodeAvailable = Boolean(Bun.which("opencode"))

let root: string
let server: ManagedServer

beforeAll(async () => {
  if (!opencodeAvailable) return
  root = await mkdtemp(join(tmpdir(), "convoy-v2-client-"))
  dirs.push(root)
  const checkout = join(root, "repo")
  await Bun.write(join(checkout, "README.md"), "# repo\n")
  const store = createProcessRecordStore(join(root, "processes"))
  server = await launchManagedServer({
    command: "opencode",
    args: ["serve", "--hostname=127.0.0.1", `--port=${await freePort()}`],
    cwd: checkout,
    env: {
      ...process.env,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      OPENCODE_CONFIG_DIR: join(root, "config"),
    },
    lifetime: "helper",
    label: "v2 boundary fixture",
    timeoutMs: 30_000,
    deps: { store, reconcile: async () => {} },
  })
  servers.push(server)
}, 40_000)

afterAll(async () => {
  for (const managed of servers) await managed.stop().catch(() => {})
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe.if(opencodeAvailable)("Convoy V2 boundary against a real isolated server", () => {
  test("captures the per-boot password and authenticates over HTTP Basic", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(typeof server.password).toBe("string")
    expect(server.password!.length).toBeGreaterThan(0)

    const client = createOpencodeClient({ baseUrl: server.url, password: server.password })
    const created = await client.session.create({ title: "boundary" })
    expect(created.error).toBeUndefined()
    expect(created.data?.id).toMatch(/^ses_/)
  })

  test("an unauthenticated client is rejected", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const created = await client.session.create({ title: "no-auth" })
    expect(created.data).toBeUndefined()
    expect(created.error).toBeDefined()
  })

  test("lists providers and models through the split V2 inventory", async () => {
    const client = createOpencodeClient({ baseUrl: server.url, password: server.password })
    const listed = await client.provider.list()
    expect(listed.error).toBeUndefined()
    expect(Array.isArray(listed.data?.all)).toBe(true)
    expect(Array.isArray(listed.data?.connected)).toBe(true)
  })

  test("creates, resolves and removes a session through the boundary", async () => {
    const client = createOpencodeClient({ baseUrl: server.url, password: server.password })
    const created = await client.session.create({ title: "lifecycle" })
    const id = created.data?.id
    expect(typeof id).toBe("string")

    const got = await client.session.get({ sessionID: id! })
    expect(got.data?.id).toBe(id)

    const messages = await client.session.messages({ sessionID: id! })
    expect(messages.error).toBeUndefined()
    expect(Array.isArray(messages.data)).toBe(true)

    const removed = await client.session.delete({ sessionID: id! })
    expect(removed.error).toBeUndefined()
  })
})
