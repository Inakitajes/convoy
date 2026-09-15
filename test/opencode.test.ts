import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  runDirAccessConfig,
  shellQuote,
  sessionShellCommand,
  openSessionCommand,
  openOpencodeSessionWindow,
  openInteractiveOpencodeWindow,
  openStoredSessionWindow,
  openIterateOpencodeWindow,
  connectOpencode,
  startOpencode,
  bootOpencodeServerFrom,
} from "../src/opencode"

import type { OpencodeHandle } from "../src/opencode"

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")
const originalTerminal = process.env.CONVOY_TERMINAL
const originalZellij = process.env.ZELLIJ
const originalHerdrEnv = process.env.HERDR_ENV
const originalPath = process.env.PATH
const originalSpawn = Bun.spawn
const originalWhich = Bun.which

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true })
}

type SpawnMock = {
  (...args: unknown[]): unknown
  mock: { calls: Array<[string[], ...unknown[]]> }
  mockRestore(): void
}

type SpawnResult = {
  exitCode?: number
  stderr?: string
  stdout?: string
}

function spawnProc(result: SpawnResult) {
  return {
    exited: Promise.resolve(result.exitCode ?? 0),
    stdout: new ReadableStream({
      start(controller) {
        if (result.stdout) controller.enqueue(Buffer.from(result.stdout))
        controller.close()
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        if (result.stderr) controller.enqueue(Buffer.from(result.stderr))
        controller.close()
      },
    }),
  }
}

function mockSpawnResult(exitCode = 0, stderr = "", stdout = ""): SpawnMock {
  const spawn = spyOn(Bun, "spawn")
  spawn.mockImplementation((() => spawnProc({ exitCode, stderr, stdout })) as unknown as typeof Bun.spawn)
  return spawn as unknown as SpawnMock
}

// Fails only the named binary, so a fallback backend can still succeed in the
// same test — mockSpawnResult(1) would fail the fallback too.
function mockSpawnFailing(binary: string): SpawnMock {
  const spawn = spyOn(Bun, "spawn")
  spawn.mockImplementation(((cmd: string[]) => {
    const failed = cmd[0] === binary
    return spawnProc(failed ? { exitCode: 1, stderr: `${binary}: no active session` } : {})
  }) as unknown as typeof Bun.spawn)
  return spawn as unknown as SpawnMock
}

// Returns the result for each spawn call in order, clamping to the last entry
// for any further calls — a Herdr split answers JSON once, then the rename and
// run that follow are fire-and-forget (or deliberately fail a set number of
// times to exercise the retry loop).
function mockSpawnResults(results: SpawnResult[]): SpawnMock {
  const spawn = spyOn(Bun, "spawn")
  let index = 0
  spawn.mockImplementation((() => {
    const result = results[Math.min(index, results.length - 1)] ?? {}
    index++
    return spawnProc(result)
  }) as unknown as typeof Bun.spawn)
  return spawn as unknown as SpawnMock
}

function spawnedBinaries(mockSpawn: SpawnMock): string[] {
  return mockSpawn.mock.calls.map((call) => call[0]![0]!)
}

const HERDR_SPLIT_JSON = JSON.stringify({ result: { pane: { pane_id: "pane-42" } } })

beforeEach(() => {
  delete process.env.HERDR_ENV
})

afterEach(() => {
  if (originalPlatformDescriptor) Object.defineProperty(process, "platform", originalPlatformDescriptor)
  restoreEnv("CONVOY_TERMINAL", originalTerminal)
  restoreEnv("ZELLIJ", originalZellij)
  restoreEnv("HERDR_ENV", originalHerdrEnv)
  restoreEnv("PATH", originalPath)
  Bun.spawn = originalSpawn
  Bun.which = originalWhich
})

describe("shellQuote", () => {
  test("wraps a simple string in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'")
  })

  test("escapes a single quote inside the string", () => {
    expect(shellQuote("it's fine")).toBe("'it'\\''s fine'")
  })

  test("handles a path with spaces", () => {
    expect(shellQuote("/path/with spaces/file.txt")).toBe("'/path/with spaces/file.txt'")
  })

  test("handles special characters", () => {
    expect(shellQuote("$PATH")).toBe("'$PATH'")
  })

  test("handles empty string", () => {
    expect(shellQuote("")).toBe("''")
  })

  test("handles string with multiple single quotes", () => {
    expect(shellQuote("it's 'really' fine")).toBe("'it'\\''s '\\''really'\\'' fine'")
  })

  test("handles string with only a single quote", () => {
    expect(shellQuote("'")).toBe("''\\'''")
  })

  test("handles unicode characters", () => {
    expect(shellQuote("héllo")).toBe("'héllo'")
  })

  test("handles newline characters", () => {
    expect(shellQuote("line1\nline2")).toBe("'line1\nline2'")
  })

  test("handles string with consecutive single quotes", () => {
    expect(shellQuote("a''b")).toBe("'a'\\'''\\''b'")
  })
})

describe("runDirAccessConfig", () => {
  test("returns a JSON whose external_directory and read allow exactly the run dir glob", () => {
    const parsed = JSON.parse(runDirAccessConfig("/tmp/convoy-run"))
    const permission = (parsed as { permission: Record<string, Record<string, string>> }).permission
    expect(permission.external_directory[join("/tmp/convoy-run", "**")]).toBe("allow")
    expect(permission.read[join("/tmp/convoy-run", "**")]).toBe("allow")
  })

  test("contains no wildcard allow rule", () => {
    const parsed = JSON.parse(runDirAccessConfig("/tmp/convoy-run"))
    const permission = (parsed as { permission: Record<string, Record<string, string>> }).permission
    expect(permission.external_directory).not.toHaveProperty("*")
    expect(permission.read).not.toHaveProperty("*")
    expect(Object.keys(permission.external_directory)).toHaveLength(1)
    expect(Object.keys(permission.read)).toHaveLength(1)
  })

  test("handles a run dir with spaces and quotes", () => {
    const parsed = JSON.parse(runDirAccessConfig("/tmp/convoy runs/it's"))
    expect(parsed).toBeTruthy()
  })

  // Fail closed, not open: "" and "." normalize to "**" (every external
  // directory) and "/" — or anything normalizing to it — to "/**" (the whole
  // filesystem); a degenerate run dir must not silently widen the grant.
  test("throws instead of widening the grant for a degenerate run dir", () => {
    for (const degenerate of ["", ".", "relative/run", "/", "/x/..", "~/convoy-run"]) {
      expect(() => runDirAccessConfig(degenerate)).toThrow(/absolute directory/)
    }
  })
})

describe("sessionShellCommand", () => {
  test("does not launch the command when changing directory fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-session-command-"))
    const marker = join(root, "launched")
    const command = sessionShellCommand(`touch ${shellQuote(marker)}`, join(root, "missing"), "/usr/bin:/bin")

    try {
      expect(command).toContain(" && cd ")
      expect(command).toContain(" && touch ")

      const child = Bun.spawn(["sh", "-c", command], { stdout: "ignore", stderr: "ignore" })
      expect(await child.exited).not.toBe(0)
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("builds a command with PATH and cwd", () => {
    const cmd = sessionShellCommand("opencode /repo", "/repo", "/usr/bin:/bin")
    expect(cmd).toContain("export PATH='/usr/bin:/bin':$PATH")
    expect(cmd).toContain("cd '/repo'")
    expect(cmd).toContain("opencode /repo")
  })

  test("omits PATH export when path is empty string", () => {
    const cmd = sessionShellCommand("opencode /repo", "/repo", "")
    expect(cmd).not.toContain("export PATH")
    expect(cmd).toContain("cd '/repo'")
    expect(cmd).toContain("opencode /repo")
  })

  test("omits cd when cwd is undefined", () => {
    const cmd = sessionShellCommand("opencode /repo", undefined, "")
    expect(cmd).not.toContain("cd ")
    expect(cmd).toBe("opencode /repo")
  })

  test("joins parts with &&", () => {
    const cmd = sessionShellCommand("opencode", "/repo", "/usr/bin")
    expect(cmd).toMatch(/^.+ && .+ && .+$/)
  })

  test("handles path with special characters in cwd", () => {
    const cmd = sessionShellCommand("opencode /repo", "/my repo", "/usr/bin:/bin")
    expect(cmd).toContain("cd '/my repo'")
  })

  test("handles cwd with single quotes", () => {
    const cmd = sessionShellCommand("opencode", "/it's/repo", "/usr/bin")
    expect(cmd).toContain("cd '/it'\\''s/repo'")
  })

  test("omits both PATH and cwd when both missing", () => {
    const cmd = sessionShellCommand("opencode", undefined, "")
    expect(cmd).toBe("opencode")
  })

  test("uses process.env.PATH by default when path not provided", () => {
    const originalPath = process.env.PATH
    process.env.PATH = "/custom/path"
    try {
      const cmd = sessionShellCommand("opencode")
      expect(cmd).toContain("export PATH='/custom/path':$PATH")
    } finally {
      restoreEnv("PATH", originalPath)
    }
  })

  test("includes cwd but no PATH when path is empty", () => {
    const cmd = sessionShellCommand("opencode /repo", "/repo", "")
    expect(cmd).toBe("cd '/repo' && opencode /repo")
  })

  test("preserves the core command as-is", () => {
    const cmd = sessionShellCommand("echo 'hello world'", "/dir", "")
    expect(cmd).toContain("echo 'hello world'")
    expect(cmd).toContain("cd '/dir'")
  })

  test("exports env vars before the cd when env is provided", () => {
    const cmd = sessionShellCommand("opencode /repo", "/repo", "/usr/bin:/bin", { FOO: "bar" })
    expect(cmd).toContain("export FOO='bar'")
    expect(cmd.indexOf("export FOO='bar'")).toBeLessThan(cmd.indexOf("cd '/repo'"))
  })

  test("quotes env values containing single quotes", () => {
    const cmd = sessionShellCommand("opencode /repo", "/repo", "", { FOO: "it's" })
    expect(cmd).toContain("export FOO='it'\\''s'")
  })

  test("quotes env values containing double quotes", () => {
    const cmd = sessionShellCommand("opencode /repo", "/repo", "", { FOO: '{"permission":{}}' })
    expect(cmd).toContain("export FOO='{\"permission\":{}}'")
  })

  // The key is interpolated unquoted into a shell `export` line; a key with
  // shell metacharacters would inject into the typed command.
  test("rejects env keys that are not plain identifiers", () => {
    expect(() => sessionShellCommand("opencode /repo", "/repo", "", { "FOO; touch /tmp/pwned": "x" })).toThrow(
      /invalid environment variable name/,
    )
    expect(() => sessionShellCommand("opencode /repo", "/repo", "", { "FOO=1": "x" })).toThrow(/invalid environment variable name/)
  })

  test("omits env exports when env is undefined", () => {
    const cmd = sessionShellCommand("opencode /repo", "/repo", "/usr/bin:/bin")
    expect(cmd).not.toContain("OPENCODE_CONFIG_CONTENT")
  })
})

describe("openSessionCommand", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")?.value
  const originalTerminal = process.env.CONVOY_TERMINAL

  beforeEach(() => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    restoreEnv("CONVOY_TERMINAL", originalTerminal)
  })

  test("opens in Terminal.app when CONVOY_TERMINAL=terminal", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openSessionCommand("echo hello", "/tmp")
      expect(mockSpawn).toHaveBeenCalledTimes(1)
      const args = mockSpawn.mock.calls[0]![0] as string[]
      expect(args[0]).toBe("osascript")
      expect(args[1]).toBe("-e")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("throws when process.platform is not darwin", async () => {
    setPlatform("linux")
    // A forced window backend never asked for a pane, so the message stays the
    // plain one even when the suite itself runs inside a Zellij session.
    process.env.ZELLIJ = "0"

    try {
      await expect(openSessionCommand("echo hello")).rejects.toThrow("macOS only")
    } finally {
      setPlatform(originalPlatform)
    }
  })

  test("includes cwd in the shell command when provided", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openSessionCommand("opencode /repo --prompt hello", "/my repo")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toMatch(/cd '\/my repo'/)
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("does not include cd when cwd is undefined", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openSessionCommand("opencode /repo")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).not.toMatch(/cd\b/)
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("propagates errors from Bun.spawn", async () => {
    const mockSpawn = mockSpawnResult(1, "command not found")

    try {
      await expect(openSessionCommand("false")).rejects.toThrow("command not found")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("opens a Zellij pane on Linux when running inside Zellij", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => "/usr/bin/zellij") as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openSessionCommand("opencode attach http://127.0.0.1:1234", "/my repo", "opencode session")

      expect(backend).toBe("zellij")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      expect(args.slice(0, 9)).toEqual([
        "zellij",
        "action",
        "new-pane",
        "--name",
        "opencode session",
        "--cwd",
        "/my repo",
        "--",
        "sh",
      ])
      expect(args[9]).toBe("-lc")
      expect(args[10]).toContain("export PATH=")
      expect(args[10]).toContain("opencode attach http://127.0.0.1:1234")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // A pane that vanished on exit would hide a failed launch, and `zellij
  // action` exits 0 as soon as the pane exists — so the pane must hold.
  test("never passes --close-on-exit, so a failed launch stays on screen", async () => {
    setPlatform("linux")
    process.env.CONVOY_TERMINAL = "zellij"
    const mockSpawn = mockSpawnResult()

    try {
      await openSessionCommand("opencode /repo", "/repo", "opencode session")
      expect(mockSpawn.mock.calls[0]![0]).not.toContain("--close-on-exit")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("can force the Zellij backend", async () => {
    setPlatform("linux")
    process.env.CONVOY_TERMINAL = "zellij"
    delete process.env.ZELLIJ
    const mockSpawn = mockSpawnResult()

    try {
      await expect(openSessionCommand("opencode /repo")).resolves.toBe("zellij")
      expect(mockSpawn.mock.calls[0]![0]).toEqual(["zellij", "action", "new-pane", "--", "sh", "-lc", expect.any(String)])
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("propagates errors from a forced Zellij pane", async () => {
    setPlatform("linux")
    process.env.CONVOY_TERMINAL = "zellij"
    const mockSpawn = mockSpawnResult(1, "zellij: no active session")

    try {
      await expect(openSessionCommand("opencode /repo")).rejects.toThrow("no active session")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // The documented escape hatch: an explicit choice beats auto-detection, so a
  // user inside Zellij can still ask for a separate macOS window.
  test("an explicit terminal choice wins over an active Zellij session", async () => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "ghostty"
    process.env.ZELLIJ = "0"
    const mockSpawn = mockSpawnResult()

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).resolves.toBe("ghostty")
      expect(mockSpawn.mock.calls[0]![0]![0]).toBe("open")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // Which window backend takes over depends on whether Ghostty is installed on
  // the machine running the suite; what matters here is that Zellij is skipped
  // and a window still opens, rather than the user losing session opening.
  test("falls back to a macOS window when the zellij binary is missing", async () => {
    setPlatform("darwin")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => null) as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).resolves.not.toBe("zellij")
      expect(spawnedBinaries(mockSpawn)).not.toContain("zellij")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("falls back to a macOS window when an auto-detected pane fails to open", async () => {
    setPlatform("darwin")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = ((name: string) => (name === "zellij" ? "/usr/bin/zellij" : null)) as typeof Bun.which
    const mockSpawn = mockSpawnFailing("zellij")

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).resolves.not.toBe("zellij")
      expect(spawnedBinaries(mockSpawn)[0]).toBe("zellij")
      expect(spawnedBinaries(mockSpawn).length).toBeGreaterThan(1)
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("propagates a failed pane off macOS, where nothing can take over", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => "/usr/bin/zellij") as typeof Bun.which
    const mockSpawn = mockSpawnFailing("zellij")

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).rejects.toThrow("no active session")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("ignores an empty ZELLIJ export rather than treating it as a live session", async () => {
    setPlatform("darwin")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = ""
    Bun.which = (() => "/usr/bin/zellij") as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).resolves.not.toBe("zellij")
      expect(spawnedBinaries(mockSpawn)).not.toContain("zellij")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // "run Convoy inside Zellij" would name the wrong cause for someone who is
  // already inside Zellij and only missing the binary.
  test("names the missing binary off macOS instead of advising Zellij", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => null) as typeof Bun.which

    await expect(openSessionCommand("opencode /repo", "/repo")).rejects.toThrow("couldn't find the zellij binary on PATH")
  })

  test("opens a Herdr pane when HERDR_ENV is set and the binary is present", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = ((name: string) => (name === "herdr" ? "/usr/bin/herdr" : null)) as typeof Bun.which
    const mockSpawn = mockSpawnResult(0, "", HERDR_SPLIT_JSON)

    try {
      const backend = await openSessionCommand("opencode attach http://127.0.0.1:1234", "/my repo", "opencode session")

      expect(backend).toBe("herdr")
      expect(mockSpawn.mock.calls[0]![0]).toEqual([
        "herdr", "pane", "split", "--current", "--direction", "right",
        "--cwd", "/my repo",
        "--env", `PATH=${process.env.PATH}`,
        "--env", "ZDOTDIR=/var/empty",
        "--focus",
      ])
      expect(mockSpawn.mock.calls[1]![0]).toEqual(["herdr", "pane", "rename", "pane-42", "opencode session"])
      expect(mockSpawn.mock.calls[2]![0]).toEqual([
        "herdr", "pane", "wait-output", "pane-42", "--regex", ".", "--timeout", "1500",
      ])
      const runArgs = mockSpawn.mock.calls[3]![0] as string[]
      expect(runArgs).toEqual(["herdr", "pane", "run", "pane-42", "opencode attach http://127.0.0.1:1234"])
      expect(runArgs[4]).not.toContain("export PATH")
      expect(runArgs[4]).not.toContain("cd ")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // `pane run` sends keystrokes, so a multi-kilobyte `export PATH=...` wraps
  // across the pane and never reaches `opencode`. PATH goes on the split.
  test("does not type PATH into a Herdr pane", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    process.env.PATH = `${"/very/long/bin:".repeat(80)}/usr/bin`
    Bun.which = ((name: string) => (name === "herdr" ? "/usr/bin/herdr" : null)) as typeof Bun.which
    const mockSpawn = mockSpawnResult(0, "", HERDR_SPLIT_JSON)

    try {
      await openSessionCommand("opencode attach http://127.0.0.1:1234", "/repo", "opencode session")
      const splitArgs = mockSpawn.mock.calls[0]![0] as string[]
      expect(splitArgs).toContain("--env")
      expect(splitArgs).toContain("ZDOTDIR=/var/empty")
      expect(splitArgs[splitArgs.indexOf("--env") + 1]).toBe(`PATH=${process.env.PATH}`)
      const runCall = mockSpawn.mock.calls.find((call) => (call[0] as string[])[2] === "run")
      expect(runCall?.[0]).toEqual(["herdr", "pane", "run", "pane-42", "opencode attach http://127.0.0.1:1234"])
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("can force the Herdr backend without HERDR_ENV", async () => {
    setPlatform("linux")
    process.env.CONVOY_TERMINAL = "herdr"
    delete process.env.HERDR_ENV
    const mockSpawn = mockSpawnResult(0, "", HERDR_SPLIT_JSON)

    try {
      await expect(openSessionCommand("opencode /repo")).resolves.toBe("herdr")
      // No cwd and no label: the split omits --cwd and no rename is issued.
      expect(mockSpawn.mock.calls[0]![0]).toEqual([
        "herdr", "pane", "split", "--current", "--direction", "right",
        "--env", `PATH=${process.env.PATH}`,
        "--env", "ZDOTDIR=/var/empty",
        "--focus",
      ])
      expect(mockSpawn.mock.calls[1]![0]).toEqual([
        "herdr", "pane", "wait-output", "pane-42", "--regex", ".", "--timeout", "1500",
      ])
      expect(mockSpawn.mock.calls[2]![0]).toEqual(["herdr", "pane", "run", "pane-42", "opencode /repo"])
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("falls back to a macOS window when the herdr binary is missing", async () => {
    setPlatform("darwin")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    process.env.ZELLIJ = "0"
    Bun.which = ((name: string) => (name === "zellij" ? "/usr/bin/zellij" : null)) as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openSessionCommand("opencode /repo", "/repo")
      expect(backend).not.toBe("herdr")
      expect(backend).not.toBe("zellij")
      expect(spawnedBinaries(mockSpawn)).not.toContain("herdr")
      expect(spawnedBinaries(mockSpawn)).not.toContain("zellij")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("falls back to a macOS window when an auto-detected Herdr split fails", async () => {
    setPlatform("darwin")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    process.env.ZELLIJ = "0"
    Bun.which = ((name: string) =>
      name === "herdr" ? "/usr/bin/herdr" : name === "zellij" ? "/usr/bin/zellij" : null) as typeof Bun.which
    const mockSpawn = mockSpawnFailing("herdr")

    try {
      const backend = await openSessionCommand("opencode /repo", "/repo")
      expect(backend).not.toBe("herdr")
      expect(backend).not.toBe("zellij")
      expect(spawnedBinaries(mockSpawn)[0]).toBe("herdr")
      expect(spawnedBinaries(mockSpawn)).not.toContain("zellij")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("propagates a failed Herdr split off macOS, where nothing can take over", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = (() => "/usr/bin/herdr") as typeof Bun.which
    const mockSpawn = mockSpawnFailing("herdr")

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).rejects.toThrow("no active session")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("ignores an empty HERDR_ENV export rather than treating it as a live session", async () => {
    setPlatform("darwin")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = ""
    Bun.which = (() => "/usr/bin/herdr") as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).resolves.not.toBe("herdr")
      expect(spawnedBinaries(mockSpawn)).not.toContain("herdr")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("throws the server message when a Herdr split response carries an error", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = (() => "/usr/bin/herdr") as typeof Bun.which
    const mockSpawn = mockSpawnResult(0, "", JSON.stringify({ error: { message: "no active session" } }))

    try {
      await expect(openSessionCommand("opencode /repo")).rejects.toThrow("no active session")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("throws a clear error when a Herdr split response is not JSON", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = (() => "/usr/bin/herdr") as typeof Bun.which
    const mockSpawn = mockSpawnResult(0, "", "not json at all")

    try {
      await expect(openSessionCommand("opencode /repo")).rejects.toThrow("unparseable output")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("throws a clear error when a Herdr split response lacks a pane id", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = (() => "/usr/bin/herdr") as typeof Bun.which
    const mockSpawn = mockSpawnResult(0, "", JSON.stringify({ result: { pane: {} } }))

    try {
      await expect(openSessionCommand("opencode /repo")).rejects.toThrow("no pane_id")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("prefers Herdr over Zellij when both sessions are detected", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    process.env.ZELLIJ = "0"
    Bun.which = ((name: string) =>
      name === "herdr" ? "/usr/bin/herdr" : name === "zellij" ? "/usr/bin/zellij" : null) as typeof Bun.which
    const mockSpawn = mockSpawnResult(0, "", HERDR_SPLIT_JSON)

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).resolves.toBe("herdr")
      expect(spawnedBinaries(mockSpawn)[0]).toBe("herdr")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("retries pane run on a transient failure, succeeding on the second attempt", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = (() => "/usr/bin/herdr") as typeof Bun.which
    const mockSpawn = mockSpawnResults([
      { stdout: HERDR_SPLIT_JSON },
      {},
      { exitCode: 1, stderr: "herdr: pane not ready" },
      {},
    ])

    try {
      await expect(openSessionCommand("opencode /repo")).resolves.toBe("herdr")
      const runs = mockSpawn.mock.calls
        .map((call) => call[0] as string[])
        .filter((args) => args[0] === "herdr" && args[2] === "run")
      expect(runs).toHaveLength(2)
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("gives up on pane run after three failed attempts", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = (() => "/usr/bin/herdr") as typeof Bun.which
    const mockSpawn = mockSpawnResults([
      { stdout: HERDR_SPLIT_JSON },
      {},
      { exitCode: 1, stderr: "herdr: pane not ready" },
      { exitCode: 1, stderr: "herdr: pane not ready" },
      { exitCode: 1, stderr: "herdr: pane not ready" },
    ])

    try {
      await expect(openSessionCommand("opencode /repo")).rejects.toThrow("pane not ready")
      const runs = mockSpawn.mock.calls
        .map((call) => call[0] as string[])
        .filter((args) => args[0] === "herdr" && args[2] === "run")
      expect(runs).toHaveLength(3)
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("names the missing herdr binary off macOS instead of advising a multiplexer", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = (() => null) as typeof Bun.which

    await expect(openSessionCommand("opencode /repo", "/repo")).rejects.toThrow("couldn't find the herdr binary on PATH")
  })

  test("reports macOS-only when no multiplexer is detected off macOS", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    delete process.env.ZELLIJ
    Bun.which = (() => null) as typeof Bun.which

    await expect(openSessionCommand("opencode /repo", "/repo")).rejects.toThrow("macOS only")
  })

  test("rejects an unknown CONVOY_TERMINAL instead of silently ignoring it", async () => {
    setPlatform("linux")
    process.env.CONVOY_TERMINAL = "kitty"
    process.env.ZELLIJ = "0"

    await expect(openSessionCommand("opencode /repo")).rejects.toThrow("CONVOY_TERMINAL=kitty is not a known backend")
  })

  test("tolerates surrounding whitespace and case in CONVOY_TERMINAL", async () => {
    setPlatform("linux")
    process.env.CONVOY_TERMINAL = "  Zellij  "
    const mockSpawn = mockSpawnResult()

    try {
      await expect(openSessionCommand("opencode /repo")).resolves.toBe("zellij")
    } finally {
      mockSpawn.mockRestore()
    }
  })
})

describe("openOpencodeSessionWindow", () => {
  const originalTerminal = process.env.CONVOY_TERMINAL
  const originalWhich = Bun.which

  beforeEach(() => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    restoreEnv("CONVOY_TERMINAL", originalTerminal)
    Bun.which = originalWhich
  })

  test("returns 'terminal' backend after opening", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openOpencodeSessionWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
        sessionID: "session-abc",
      })
      expect(backend).toBe("terminal")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("shell-quoted osascript contains attach, url, dir, and session", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openOpencodeSessionWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
        sessionID: "sess-1",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toContain("http://127.0.0.1:12345")
      expect(scriptArg).toContain("--dir")
      expect(scriptArg).toContain("--session")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("uses Ghostty when CONVOY_TERMINAL=ghostty", async () => {
    process.env.CONVOY_TERMINAL = "ghostty"
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openOpencodeSessionWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
        sessionID: "sess-1",
      })
      expect(backend).toBe("ghostty")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      expect(args[0]).toBe("open")
      expect(args).toContain("-na")
      expect(args).toContain("Ghostty")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("re-throws error when forced ghostty fails", async () => {
    process.env.CONVOY_TERMINAL = "ghostty"
    const mockSpawn = mockSpawnResult(1, "Ghostty not found")

    try {
      await expect(
        openOpencodeSessionWindow({
          url: "http://127.0.0.1:12345",
          targetDir: "/repo",
          sessionID: "sess-1",
        }),
      ).rejects.toThrow()
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // [o] is documented as opening a pane under Zellij, so the entry point — not
  // just openSessionCommand — has to reach that backend and name its pane.
  test("opens a named Zellij pane when running inside Zellij", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => "/usr/bin/zellij") as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openOpencodeSessionWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
        sessionID: "sess-1",
      })
      expect(backend).toBe("zellij")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      expect(args.slice(0, 5)).toEqual(["zellij", "action", "new-pane", "--name", "opencode session"])
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // [o] is documented as opening a pane under Herdr too, so the entry point —
  // not just openSessionCommand — has to reach that backend and name its pane.
  test("opens a named Herdr pane when running inside Herdr", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = ((name: string) => (name === "herdr" ? "/usr/bin/herdr" : null)) as typeof Bun.which
    const mockSpawn = mockSpawnResult(0, "", HERDR_SPLIT_JSON)

    try {
      const backend = await openOpencodeSessionWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
        sessionID: "sess-1",
      })
      expect(backend).toBe("herdr")
      const splitArgs = mockSpawn.mock.calls[0]![0] as string[]
      expect(splitArgs.slice(0, 6)).toEqual(["herdr", "pane", "split", "--current", "--direction", "right"])
      expect(splitArgs).toContain("--cwd")
      // The pane is named "opencode session", matching the Zellij backend.
      expect(mockSpawn.mock.calls[1]![0]).toEqual(["herdr", "pane", "rename", "pane-42", "opencode session"])
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // Live-attach windows talk to a server that already allows the run dir, so
  // they must not inject the standalone-only OPENCODE_CONFIG_CONTENT export.
  test("does not export OPENCODE_CONFIG_CONTENT", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openOpencodeSessionWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
        sessionID: "sess-1",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).not.toContain("OPENCODE_CONFIG_CONTENT")
    } finally {
      mockSpawn.mockRestore()
    }
  })
})

describe("openInteractiveOpencodeWindow", () => {
  const originalTerminal = process.env.CONVOY_TERMINAL
  const originalWhich = Bun.which

  beforeEach(() => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    restoreEnv("CONVOY_TERMINAL", originalTerminal)
    Bun.which = originalWhich
  })

  test("uses --continue flag instead of --session", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openInteractiveOpencodeWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toContain("--continue")
      expect(scriptArg).not.toContain("--session")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("returns 'terminal' backend", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openInteractiveOpencodeWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
      })
      expect(backend).toBe("terminal")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("does not export OPENCODE_CONFIG_CONTENT", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openInteractiveOpencodeWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).not.toContain("OPENCODE_CONFIG_CONTENT")
    } finally {
      mockSpawn.mockRestore()
    }
  })
})

describe("openStoredSessionWindow", () => {
  const originalTerminal = process.env.CONVOY_TERMINAL
  const originalWhich = Bun.which

  beforeEach(() => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    restoreEnv("CONVOY_TERMINAL", originalTerminal)
    Bun.which = originalWhich
  })

  test("does not include attach or url", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openStoredSessionWindow({
        targetDir: "/repo",
        sessionID: "session-abc",
        runDir: "/tmp/convoy-run",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toContain("--session")
      expect(scriptArg).not.toContain("attach")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("passes the target dir and session ID", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openStoredSessionWindow({
        targetDir: "/repo",
        sessionID: "sess-2",
        runDir: "/tmp/convoy-run",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toMatch(/'\/repo'/)
      expect(scriptArg).toMatch(/'sess-2'/)
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("exports OPENCODE_CONFIG_CONTENT with the run dir glob", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openStoredSessionWindow({
        targetDir: "/repo",
        sessionID: "sess-2",
        runDir: "/tmp/convoy-run",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toContain("export OPENCODE_CONFIG_CONTENT=")
      expect(scriptArg).toContain("/tmp/convoy-run/**")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // [o] must stay prompt-free in every backend, so the stored-session opener
  // needs the same Herdr guarantee as iterate: the config travels as `--env`
  // on the pane split and is never typed into the pane.
  test("passes the env as a Herdr --env pair, not typed into the pane", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = ((name: string) => (name === "herdr" ? "/usr/bin/herdr" : null)) as typeof Bun.which
    const mockSpawn = mockSpawnResult(0, "", HERDR_SPLIT_JSON)

    try {
      await openStoredSessionWindow({
        targetDir: "/repo",
        sessionID: "sess-2",
        runDir: "/tmp/convoy-run",
      })
      const splitArgs = mockSpawn.mock.calls[0]![0] as string[]
      expect(splitArgs).toContain("--env")
      expect(splitArgs).toContain(`OPENCODE_CONFIG_CONTENT=${runDirAccessConfig("/tmp/convoy-run")}`)
      // The `pane run` call's command is the bare core command — the env rides
      // the split as --env and is never typed as a visible export line.
      const runArgs = mockSpawn.mock.calls.find((call) => (call[0] as string[])[2] === "run")![0] as string[]
      expect(runArgs[0]).toBe("herdr")
      expect(runArgs[runArgs.length - 1]).not.toContain("export OPENCODE_CONFIG_CONTENT")
    } finally {
      mockSpawn.mockRestore()
    }
  })
})

describe("openIterateOpencodeWindow", () => {
  const originalTerminal = process.env.CONVOY_TERMINAL
  const originalWhich = Bun.which

  beforeEach(() => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    restoreEnv("CONVOY_TERMINAL", originalTerminal)
    Bun.which = originalWhich
  })

  test("passes --prompt with the given prompt", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openIterateOpencodeWindow({
        targetDir: "/repo",
        prompt: "Fix the bug",
        runDir: "/tmp/convoy-run",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toContain("--prompt")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("includes cwd setup for the target directory", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openIterateOpencodeWindow({
        targetDir: "/my repo",
        prompt: "hello",
        runDir: "/tmp/convoy-run",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toMatch(/cd '\/my repo'/)
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("returns 'terminal' backend", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openIterateOpencodeWindow({
        targetDir: "/repo",
        prompt: "hello",
        runDir: "/tmp/convoy-run",
      })
      expect(backend).toBe("terminal")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("exports OPENCODE_CONFIG_CONTENT with the run dir glob", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openIterateOpencodeWindow({
        targetDir: "/repo",
        prompt: "hello",
        runDir: "/tmp/convoy-run",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toContain("export OPENCODE_CONFIG_CONTENT=")
      expect(scriptArg).toContain("/tmp/convoy-run/**")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // [i] is documented alongside [o] as opening a pane under Zellij.
  test("opens a named Zellij pane when running inside Zellij", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => "/usr/bin/zellij") as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openIterateOpencodeWindow({ targetDir: "/repo", prompt: "hello", runDir: "/tmp/convoy-run" })
      expect(backend).toBe("zellij")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      expect(args.slice(0, 5)).toEqual(["zellij", "action", "new-pane", "--name", "opencode iterate"])
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // The Zellij backend launches `sh -lc <command>`; the config must ride that
  // wrapper as a shell-quoted export, not only the osascript (Terminal) path.
  test("exports OPENCODE_CONFIG_CONTENT in the Zellij pane command", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => "/usr/bin/zellij") as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openIterateOpencodeWindow({ targetDir: "/repo", prompt: "hello", runDir: "/tmp/convoy-run" })
      expect(backend).toBe("zellij")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      expect(args).toContain("sh")
      expect(args).toContain("-lc")
      const command = args[args.length - 1]!
      expect(command).toContain("export OPENCODE_CONFIG_CONTENT=")
      expect(command).toContain("/tmp/convoy-run/**")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // [i] is documented alongside [o] as opening a pane under Herdr.
  test("opens a named Herdr pane when running inside Herdr", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = ((name: string) => (name === "herdr" ? "/usr/bin/herdr" : null)) as typeof Bun.which
    const mockSpawn = mockSpawnResult(0, "", HERDR_SPLIT_JSON)

    try {
      const backend = await openIterateOpencodeWindow({ targetDir: "/repo", prompt: "hello", runDir: "/tmp/convoy-run" })
      expect(backend).toBe("herdr")
      const splitArgs = mockSpawn.mock.calls[0]![0] as string[]
      expect(splitArgs.slice(0, 6)).toEqual(["herdr", "pane", "split", "--current", "--direction", "right"])
      // The pane is named "opencode iterate", matching the Zellij backend.
      expect(mockSpawn.mock.calls[1]![0]).toEqual(["herdr", "pane", "rename", "pane-42", "opencode iterate"])
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // The config travels as `--env` on the pane split; `pane run` must never type
  // it as a visible export line.
  test("passes the env as a Herdr --env pair, not typed into the pane", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.HERDR_ENV = "1"
    Bun.which = ((name: string) => (name === "herdr" ? "/usr/bin/herdr" : null)) as typeof Bun.which
    const mockSpawn = mockSpawnResult(0, "", HERDR_SPLIT_JSON)

    try {
      await openIterateOpencodeWindow({ targetDir: "/repo", prompt: "hello", runDir: "/tmp/convoy-run" })
      const splitArgs = mockSpawn.mock.calls[0]![0] as string[]
      expect(splitArgs).toContain("--env")
      expect(splitArgs).toContain(`OPENCODE_CONFIG_CONTENT=${runDirAccessConfig("/tmp/convoy-run")}`)
      // The `pane run` call's command is the bare core command — the env rides
      // the split as --env and is never typed as a visible export line.
      const runArgs = mockSpawn.mock.calls.find((call) => (call[0] as string[])[2] === "run")![0] as string[]
      expect(runArgs[0]).toBe("herdr")
      expect(runArgs[runArgs.length - 1]).not.toContain("export OPENCODE_CONFIG_CONTENT")
    } finally {
      mockSpawn.mockRestore()
    }
  })
})

describe("connectOpencode", () => {
  test("returns an object that conforms to the OpencodeClient shape", () => {
    const client = connectOpencode("http://127.0.0.1:12345")
    expect(client).toBeTruthy()
    expect(typeof client).toBe("object")
  })

  test("returns a distinct client for each call", () => {
    const a = connectOpencode("http://127.0.0.1:1111")
    const b = connectOpencode("http://127.0.0.1:2222")
    expect(a).not.toBe(b)
  })

  test("handles URL with trailing path", () => {
    const client = connectOpencode("http://127.0.0.1:12345/api/v2")
    expect(client).toBeTruthy()
  })
})

describe("startOpencode", () => {
  test("owns the spawned server and awaits a bounded stop", async () => {
    const client = { session: {} } as unknown as OpencodeHandle["client"]
    let stopped = 0
    let launchOptions: Record<string, unknown> | undefined
    let clientOptions: Record<string, unknown> | undefined

    const handle: OpencodeHandle = await startOpencode({}, undefined, {
      getFreePort: async () => 41234,
      launch: async (options) => {
        launchOptions = options as unknown as Record<string, unknown>
        return {
          url: "http://127.0.0.1:41234",
          pid: 4242,
          stop: async () => {
            stopped++
            return { status: "stopped" as const, via: "graceful" as const }
          },
          forceStop: () => {},
        }
      },
      createClient: (options) => {
        clientOptions = options as unknown as Record<string, unknown>
        return client
      },
    })

    expect(handle.client).toBe(client)
    expect(handle.url).toBe("http://127.0.0.1:41234")
    expect(handle.pid).toBe(4242)
    expect(launchOptions).toMatchObject({ command: "opencode", cwd: process.cwd(), lifetime: "helper" })
    expect(launchOptions?.args).toContain("serve")
    expect(launchOptions?.args).toContain("--hostname=127.0.0.1")
    expect(launchOptions?.args).toContain("--port=41234")
    expect(launchOptions?.env).toMatchObject({ OPENCODE_CONFIG_CONTENT: "{}" })
    expect(clientOptions?.baseUrl).toBe(handle.url)
    expect(typeof clientOptions?.fetch).toBe("function")

    const outcome = await handle.close()
    expect(outcome.status).toBe("stopped")
    expect(stopped).toBe(1)
  })

  test("passes a log level through and strips HERDR_* from the child env only", async () => {
    process.env.HERDR_ENV = "1"
    process.env.HERDR_PANE_ID = "w1:p1"
    const client = { session: {} } as unknown as OpencodeHandle["client"]
    let observed: Record<string, string | undefined> | undefined
    let observedArgs: string[] | undefined

    try {
      const handle = await startOpencode({ logLevel: "warn" } as never, undefined, {
        getFreePort: async () => 1,
        launch: async (options) => {
          observed = { ...options.env }
          observedArgs = options.args
          return {
            url: "http://127.0.0.1:1",
            pid: 1,
            stop: async () => ({ status: "stopped" as const, via: "already-gone" as const }),
            forceStop: () => {},
          }
        },
        createClient: () => client,
      })

      expect(observed).toBeDefined()
      expect(observed).not.toHaveProperty("HERDR_ENV")
      expect(observed).not.toHaveProperty("HERDR_PANE_ID")
      expect(observed?.OPENCODE_CONFIG_CONTENT).toContain("warn")
      expect(observedArgs).toContain("--log-level=warn")
      // The caller's environment is untouched: the strip is per-child now.
      expect(process.env.HERDR_ENV).toBe("1")
      expect(process.env.HERDR_PANE_ID).toBe("w1:p1")
      await handle.close()
    } finally {
      delete process.env.HERDR_ENV
      delete process.env.HERDR_PANE_ID
    }
  })
})

describe("owned-server factory failure and boot", () => {
  test("a client construction failure stops the owned child before surfacing", async () => {
    let stopped = 0
    await expect(
      startOpencode({}, undefined, {
        getFreePort: async () => 1,
        launch: async () => ({
          url: "http://127.0.0.1:1",
          pid: 77,
          stop: async () => {
            stopped++
            return { status: "stopped" as const, via: "graceful" as const }
          },
          forceStop: () => {},
        }),
        createClient: () => {
          throw new Error("bad base url")
        },
      }),
    ).rejects.toThrow(/client construction failed/)
    // The live child is never handed out without a client: it is stopped first.
    expect(stopped).toBe(1)
  })

  test("a client construction failure reports an unresolved cleanup honestly", async () => {
    await expect(
      startOpencode({}, undefined, {
        getFreePort: async () => 1,
        launch: async () => ({
          url: "http://127.0.0.1:1",
          pid: 78,
          stop: async () => ({ status: "unresolved" as const, reason: "exit was not observed" }),
          forceStop: () => {},
        }),
        createClient: () => {
          throw new Error("boom")
        },
      }),
    ).rejects.toThrow(/unresolved — exit was not observed/)
  })

  test("bootOpencodeServerFrom owns a helper rooted at the explicit checkout", async () => {
    let launchOptions: Record<string, unknown> | undefined
    let stopped = 0
    const handle = await bootOpencodeServerFrom("/tmp/some-checkout", 1_234, {
      deps: {
        getFreePort: async () => 4321,
        launch: async (options) => {
          launchOptions = options as unknown as Record<string, unknown>
          return {
            url: "http://127.0.0.1:4321",
            pid: 99,
            stop: async () => {
              stopped++
              return { status: "stopped" as const, via: "graceful" as const }
            },
            forceStop: () => {},
          }
        },
      },
    })
    expect(launchOptions?.cwd).toBe("/tmp/some-checkout")
    expect(launchOptions?.lifetime).toBe("helper")
    expect(launchOptions?.args).toContain("--hostname=127.0.0.1")
    expect(launchOptions?.args).toContain("--port=4321")
    // A bounded per-call boot closes through the same awaitable stop.
    expect(await handle.close()).toEqual({ status: "stopped", via: "graceful" })
    expect(stopped).toBe(1)
  })

  test("an authoring-service boot is explicitly classified and independently persistent", async () => {
    let launchOptions: Record<string, unknown> | undefined
    await bootOpencodeServerFrom("/tmp/checkout", 500, {
      lifetime: "authoring-service",
      deps: {
        getFreePort: async () => 1,
        launch: async (options) => {
          launchOptions = options as unknown as Record<string, unknown>
          return {
            url: "http://127.0.0.1:1",
            pid: 1,
            stop: async () => ({ status: "stopped" as const, via: "already-gone" as const }),
            forceStop: () => {},
          }
        },
      },
    })
    expect(launchOptions?.lifetime).toBe("authoring-service")
  })
})
