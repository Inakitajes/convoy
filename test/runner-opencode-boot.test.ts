import { afterAll, describe, expect, test } from "bun:test"
import { spawn as nodeSpawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { bootOwnedServer, parseBootLine, sanitizeServerEnv, ServerBootError } from "../src/runners/opencode/boot"
import { createV2Client, serverInfo } from "../src/runners/opencode/v2-client"

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-boot-"))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("opencode v2 owned server boot", () => {
  test("parses the readiness URL and the boot password from startup lines", () => {
    expect(parseBootLine("server listening on http://127.0.0.1:4096")).toEqual({ url: "http://127.0.0.1:4096" })
    expect(parseBootLine("server password abc123def456")).toEqual({ password: "abc123def456" })
    expect(parseBootLine("some unrelated log line")).toBeUndefined()
  })

  test("strips credential env vars a spawned server must not inherit", () => {
    const env = sanitizeServerEnv({ PATH: "/bin", OPENCODE_PASSWORD: "x", OPENCODE_SERVER_PASSWORD: "y" })
    expect(env).toEqual({ PATH: "/bin" })
  })

  test("rejects when the child never reports readiness, after bounded cleanup", async () => {
    const dir = await tempDir()
    const spawnSleep = ((_cmd: string, _args: string[], opts: Parameters<typeof nodeSpawn>[2]) =>
      nodeSpawn("sleep", ["5"], opts)) as unknown as NonNullable<NonNullable<Parameters<typeof bootOwnedServer>[0]["deps"]>["spawn"]>
    await expect(
      bootOwnedServer({ cwd: dir, timeoutMs: 300, deps: { spawn: spawnSleep, getFreePort: async () => 4599 } }),
    ).rejects.toBeInstanceOf(ServerBootError)
  })

  test("boots a real server, authenticates a client, and stops within budget", async () => {
    const dir = await tempDir()
    const server = await bootOwnedServer({ cwd: dir })
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(server.password.length).toBeGreaterThan(0)
      const info = await serverInfo(createV2Client({ baseUrl: server.url, password: server.password }))
      expect(info.version.startsWith("2.")).toBe(true)
    } finally {
      const outcome = await server.stop()
      expect(outcome.status).toBe("stopped")
    }
  }, 30_000)
})
