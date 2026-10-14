import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { clearServerAuth, readServerAuth, serverAuthPath, writeServerAuth } from "../src/runners/opencode/server-auth"
import { buildV2TerminalCommand, openV2Terminal, shellQuote, stageV2PasswordFile, v2TerminalArgs } from "../src/runners/opencode/terminal"

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-secret-"))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("private server auth record", () => {
  test("round-trips a password in a 0600 file under a 0700 directory", async () => {
    const dir = await tempDir()
    const privateDir = join(dir, "private")
    const path = await writeServerAuth(privateDir, { url: "http://127.0.0.1:4096", password: "s3cr3t-value" })

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(privateDir)).mode & 0o777).toBe(0o700)
    expect(await readServerAuth(privateDir)).toEqual({ url: "http://127.0.0.1:4096", password: "s3cr3t-value" })
  })

  test("a missing or malformed record is simply none", async () => {
    const dir = await tempDir()
    expect(await readServerAuth(dir)).toBeUndefined()
    await writeFile(serverAuthPath(dir), "{ not json")
    expect(await readServerAuth(dir)).toBeUndefined()
    await writeFile(serverAuthPath(dir), JSON.stringify({ password: "no-url" }))
    expect(await readServerAuth(dir)).toBeUndefined()
  })

  test("clear removes the record", async () => {
    const dir = await tempDir()
    await writeServerAuth(dir, { url: "http://x", password: "p" })
    await clearServerAuth(dir)
    expect(await readServerAuth(dir)).toBeUndefined()
  })
})

describe("credential-safe terminal invocation", () => {
  test("never places the password in argv and reads it from the staged file", () => {
    const command = buildV2TerminalCommand({
      directory: "/repo",
      serverUrl: "http://127.0.0.1:4096",
      sessionId: "ses_abc",
      passwordFile: "/run/private/one-shot",
    })
    expect(command).not.toContain("s3cr3t-value")
    expect(command).toContain("/run/private/one-shot")
    expect(command).toContain("--server")
    expect(command).toContain("http://127.0.0.1:4096")
    expect(command).toContain("--session")
    expect(command).toContain("ses_abc")
    expect(command).toContain("rm -f")
  })

  test("standalone stored-session windows stay off the shared server", () => {
    const command = buildV2TerminalCommand({ directory: "/repo", sessionId: "ses_x", standalone: true })
    expect(command).toContain("--standalone")
    expect(command).not.toContain("--server")
    expect(command).toContain("--session")
  })

  test("continue resumes instead of naming a session", () => {
    expect(v2TerminalArgs({ directory: "/repo", serverUrl: "http://s", continue: true })).toEqual([
      "/repo",
      "--server",
      "http://s",
      "--continue",
    ])
  })

  test("shellQuote neutralises embedded quotes", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
  })
})

describe("openV2Terminal (task 4.6)", () => {
  test("opens an exact session with --server/--session and never the password in argv", async () => {
    const dir = await tempDir()
    const privateDir = join(dir, "private")
    const commands: string[] = []
    const password = "s3cr3t-terminal-value"

    await openV2Terminal(
      { directory: "/repo", serverUrl: "http://127.0.0.1:4096", password, sessionId: "ses_abc", privateDir },
      { exec: async (command) => { commands.push(command) } },
    )

    expect(commands).toHaveLength(1)
    const command = commands[0]!
    expect(command).toContain("--server")
    expect(command).toContain("http://127.0.0.1:4096")
    expect(command).toContain("--session")
    expect(command).toContain("ses_abc")
    // The credential is read from a staged file, never placed in argv.
    expect(command).not.toContain(password)
    expect(command).toContain("rm -f")

    const files = await readdir(privateDir)
    expect(files).toHaveLength(1)
    expect((await stat(join(privateDir, files[0]!))).mode & 0o777).toBe(0o600)
    expect((await stat(privateDir)).mode & 0o777).toBe(0o700)
  })

  test("stored/iterate windows use --standalone and stage no password file", async () => {
    const dir = await tempDir()
    const privateDir = join(dir, "private")
    const commands: string[] = []

    await openV2Terminal(
      { directory: "/repo", sessionId: "ses_x", standalone: true, privateDir },
      { exec: async (command) => { commands.push(command) } },
    )

    expect(commands[0]).toContain("--standalone")
    expect(commands[0]).not.toContain("--server")
    expect(commands[0]).toContain("--session")
    // Nothing is staged for a standalone window.
    await expect(readdir(privateDir)).rejects.toThrow()
  })

  test("requires a server password for an exact-session window", async () => {
    const dir = await tempDir()
    await expect(
      openV2Terminal(
        { directory: "/repo", serverUrl: "http://127.0.0.1:4096", sessionId: "ses_abc", privateDir: join(dir, "private") },
        { exec: async () => {} },
      ),
    ).rejects.toThrow(/password is required/)
  })

  test("stages a raw password in a 0600 file", async () => {
    const dir = await tempDir()
    const path = await stageV2PasswordFile(dir, "raw-value", "one-shot")
    expect(await Bun.file(path).text()).toBe("raw-value")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
