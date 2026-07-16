import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"

import { describe, expect, test } from "bun:test"

import { createWorkspace, isValidRunID, runDir, runsRoot } from "../src/workspace"

describe("workspace run IDs", () => {
  test("accepts generated run ID shape", () => {
    expect(isValidRunID("20260519-103045-x7q2")).toBe(true)
  })

  test("rejects traversal and arbitrary names", () => {
    expect(isValidRunID("../20260519-103045-x7q2")).toBe(false)
    expect(isValidRunID("latest")).toBe(false)
    expect(() => runDir("../20260519-103045-x7q2")).toThrow("invalid run id")
  })

  test("resolves run dirs under the convoy runs root", () => {
    const id = "20260519-103045-x7q2"
    const pathFromRoot = relative(runsRoot(), runDir(id))

    expect(pathFromRoot).toBe(id)
    expect(pathFromRoot.startsWith("..")).toBe(false)
    expect(isAbsolute(pathFromRoot)).toBe(false)
  })

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
      if (previousHome === undefined) delete process.env.CONVOY_HOME
      else process.env.CONVOY_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  })
})
