import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { basicAuthHeader, createSession, createV2Client, serverInfo } from "../src/runners/opencode/v2-client"

describe("opencode v2 client boundary", () => {
  test("builds the HTTP Basic header the managed server expects", () => {
    expect(basicAuthHeader("s3cr3t")).toBe(`Basic ${Buffer.from("opencode:s3cr3t").toString("base64")}`)
  })

  test("sends the credential and targets a v2 /api route", async () => {
    let seen: Request | undefined
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = input instanceof Request ? input : new Request(input as string, init)
      return new Response(JSON.stringify({ version: "2.0.26" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch

    const client = createV2Client({ baseUrl: "http://127.0.0.1:9999", password: "pw123456", fetch: fakeFetch })
    const info = await serverInfo(client)

    expect(info.version).toBe("2.0.26")
    expect(seen?.headers.get("authorization")).toBe(basicAuthHeader("pw123456"))
    expect(new URL(seen!.url).pathname).toBe("/api/info")
  })

  test("rejects an HTML envelope even on HTTP 200", async () => {
    const fakeFetch = (async () =>
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof globalThis.fetch

    const client = createV2Client({ baseUrl: "http://127.0.0.1:9999", password: "pw123456", fetch: fakeFetch })
    await expect(serverInfo(client)).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Live runtime (free: server routes only, no model calls)
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = server.port
  server.stop(true)
  if (port === undefined) throw new Error("no free port")
  return port
}

describe("opencode v2 client against a live runtime", () => {
  let proc: ReturnType<typeof Bun.spawn> | undefined
  let url: string | undefined
  let password: string | undefined
  let dir: string | undefined

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "convoy-v2-"))
    const port = await freePort()
    proc = Bun.spawn(["opencode", "serve", "--hostname=127.0.0.1", `--port=${port}`], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_PASSWORD: "", OPENCODE_SERVER_PASSWORD: "" },
    })
    const decoder = new TextDecoder()
    const stream = proc.stdout as ReadableStream<Uint8Array>
    const reader = stream.getReader()
    let buffered = ""
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && (!url || !password)) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }))
      if (done || !value) break
      buffered += decoder.decode(value)
      const u = buffered.match(/server listening on (http:\/\/[^\s]+)/)
      const p = buffered.match(/server password (\S+)/)
      if (u) url = u[1]
      if (p) password = p[1]
    }
  }, 30_000)

  afterAll(async () => {
    proc?.kill()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("authenticates and reports a v2 server", async () => {
    expect(url).toBeDefined()
    expect(password).toBeDefined()
    const client = createV2Client({ baseUrl: url!, password: password! })
    const info = await serverInfo(client)
    expect(info.version.startsWith("2.")).toBe(true)
  })

  test("creates a session at an explicit location", async () => {
    const client = createV2Client({ baseUrl: url!, password: password! })
    const session = await createSession(client, { directory: dir!, title: "convoy boundary test" })
    expect(session.id).toMatch(/^ses/)
  })

  test("rejects an unauthenticated client", async () => {
    const client = createV2Client({ baseUrl: url! })
    await expect(serverInfo(client)).rejects.toBeDefined()
  })
})
