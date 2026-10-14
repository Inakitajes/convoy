import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { createWorkspace, isValidRunID, convoyRoot, convoyHome, globalConfigPath, globalAgentsDir, runsRoot, runDir } from "../src/workspace"

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe("isValidRunID", () => {
  test("accepts a valid run ID", () => {
    expect(isValidRunID("20240101-120000-abcd")).toBe(true)
  })

  test("rejects invalid run IDs", () => {
    expect(isValidRunID("")).toBe(false)
    expect(isValidRunID("abc")).toBe(false)
    expect(isValidRunID("20240101-120000-ABCD")).toBe(false) // uppercase
    expect(isValidRunID("20240101-120000-abcde")).toBe(false) // 5 chars
    expect(isValidRunID("2024-120000-abcd")).toBe(false) // wrong format
  })
})

describe("convoyRoot", () => {
  test("returns CONVOY_HOME when set, else homedir", () => {
    const original = process.env.CONVOY_HOME
    delete process.env.CONVOY_HOME
    try {
      const root = convoyRoot()
      expect(root.length).toBeGreaterThan(0)
      expect(root).not.toContain(".convoy")
    } finally {
      restoreEnv("CONVOY_HOME", original)
    }
  })

  test("uses CONVOY_HOME when set", () => {
    const original = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = "/custom/convoy"
    try {
      expect(convoyRoot()).toBe("/custom/convoy")
    } finally {
      restoreEnv("CONVOY_HOME", original)
    }
  })
})

describe("convoyHome", () => {
  test("returns the .convoy subdirectory of convoyRoot", () => {
    const original = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = "/tmp"
    try {
      expect(convoyHome()).toBe("/tmp/.convoy")
    } finally {
      restoreEnv("CONVOY_HOME", original)
    }
  })
})

describe("globalConfigPath", () => {
  test("returns the config.yaml path under convoyHome", () => {
    const home = globalConfigPath()
    expect(home.endsWith("config.yaml")).toBe(true)
    expect(home).toContain(".convoy")
  })
})

describe("globalAgentsDir", () => {
  test("returns the agents directory under convoyHome", () => {
    const dir = globalAgentsDir()
    expect(dir.endsWith("agents")).toBe(true)
    expect(dir).toContain(".convoy")
  })
})

describe("runsRoot", () => {
  test("returns the runs directory under convoyHome", () => {
    const root = runsRoot()
    expect(root.endsWith("runs")).toBe(true)
    expect(root).toContain(".convoy")
  })
})

describe("runDir", () => {
  test("throws for an invalid run ID", () => {
    expect(() => runDir("invalid")).toThrow("invalid run id")
  })
})

describe("workspace permissions", () => {
  test("creates private run directories and prompt files", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(join(tmpdir(), "convoy-private-workspace-"))
    const previousHome = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = root

    try {
      const workspace = await createWorkspace("confidential prompt")
      expect((await stat(workspace.dir)).mode & 0o777).toBe(0o700)
      expect((await stat(join(workspace.dir, "prd.md"))).mode & 0o777).toBe(0o600)
      expect(await readFile(join(workspace.dir, "prd.md"), "utf8")).toBe("confidential prompt")
    } finally {
      restoreEnv("CONVOY_HOME", previousHome)
      await rm(root, { recursive: true, force: true })
    }
  })
})
