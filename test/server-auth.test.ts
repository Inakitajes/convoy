import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { clearServerAuth, readServerAuth, serverAuthPath, writeServerAuth } from "../src/server-auth"

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "convoy-server-auth-"))
}

describe("server auth", () => {
  test("round-trips the url and password with owner-only permissions", async () => {
    const dir = await scratch()
    try {
      await writeServerAuth(dir, { url: "http://127.0.0.1:1", password: "s3cr3t" })
      expect((await stat(serverAuthPath(dir))).mode & 0o777).toBe(0o600)
      expect(await readServerAuth(dir)).toEqual({ url: "http://127.0.0.1:1", password: "s3cr3t" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("omits an absent password rather than inventing one", async () => {
    const dir = await scratch()
    try {
      await writeServerAuth(dir, { url: "http://127.0.0.1:1" })
      expect(await readServerAuth(dir)).toEqual({ url: "http://127.0.0.1:1" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns undefined for a missing or malformed record", async () => {
    const dir = await scratch()
    try {
      expect(await readServerAuth(dir)).toBeUndefined()
      await Bun.write(serverAuthPath(dir), "not json")
      expect(await readServerAuth(dir)).toBeUndefined()
      await Bun.write(serverAuthPath(dir), JSON.stringify({ password: "x" }))
      expect(await readServerAuth(dir)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("clear removes the record and is idempotent", async () => {
    const dir = await scratch()
    try {
      await writeServerAuth(dir, { url: "http://127.0.0.1:1" })
      await clearServerAuth(dir)
      expect(await readServerAuth(dir)).toBeUndefined()
      await clearServerAuth(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
