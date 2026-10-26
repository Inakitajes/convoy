import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { installSpinCommand, listCommandFiles, spinCommandPath } from "../src/opencode-install"

let commandsDir: string

beforeEach(async () => {
  commandsDir = await mkdtemp(join(tmpdir(), "convoy-opencode-cmds-"))
})

afterEach(async () => {
  await rm(commandsDir, { recursive: true, force: true })
})

describe("installSpinCommand", () => {
  test("writes exactly one file: convoy-spin.md in the commands dir", async () => {
    const install = await installSpinCommand(commandsDir)
    expect(install.updated).toBe(true)
    expect(install.path).toBe(spinCommandPath(commandsDir))
    expect(await listCommandFiles(commandsDir)).toEqual(["convoy-spin.md"])
  })

  test("double install is idempotent: one current file, no rewrite on the second pass", async () => {
    await installSpinCommand(commandsDir)
    const first = await readFile(spinCommandPath(commandsDir), "utf8")
    const second = await installSpinCommand(commandsDir)
    expect(second.updated).toBe(false)
    const after = await readFile(spinCommandPath(commandsDir), "utf8")
    expect(after).toBe(first)
  })

  test("a stale convoy-owned copy (old marker) is refreshed to the current template", async () => {
    await mkdir(commandsDir, { recursive: true })
    await writeFile(spinCommandPath(commandsDir), "<!-- convoy:spin v1 -->\nold body\n", "utf8")
    const install = await installSpinCommand(commandsDir)
    expect(install.updated).toBe(true)
    const body = await readFile(spinCommandPath(commandsDir), "utf8")
    expect(body).toContain("convoy spin")
    expect(body).not.toContain("old body")
  })

  test("an operator-authored convoy-spin.md (no convoy marker) is left untouched (SC-3)", async () => {
    await mkdir(commandsDir, { recursive: true })
    const operatorBody = "# my own /convoy-spin\nrun my thing, not convoy\n"
    await writeFile(spinCommandPath(commandsDir), operatorBody, "utf8")
    const install = await installSpinCommand(commandsDir)
    expect(install.updated).toBe(false)
    expect(install.skipped).toBe(true)
    expect(await readFile(spinCommandPath(commandsDir), "utf8")).toBe(operatorBody)
    // And the directory gained no convoy-owned file.
    expect(await listCommandFiles(commandsDir)).toEqual(["convoy-spin.md"])
  })

  test("foreign command files are byte-identical after install", async () => {
    await mkdir(commandsDir, { recursive: true })
    const foreign = join(commandsDir, "mine.md")
    await writeFile(foreign, "# my own command\n", "utf8")
    await installSpinCommand(commandsDir)
    await installSpinCommand(commandsDir)
    await expect(readFile(foreign, "utf8")).resolves.toBe("# my own command\n")
    expect(await listCommandFiles(commandsDir)).toEqual(["convoy-spin.md", "mine.md"])
  })

  test("the template is a thin wrapper: run convoy spin, relay output, no git work", async () => {
    await installSpinCommand(commandsDir)
    const body = await readFile(spinCommandPath(commandsDir), "utf8")
    expect(body).toContain("convoy spin")
    expect(body).toContain("verbatim")
    expect(body).toContain("--change")
    expect(body).toContain("configured spec tool (OpenSpec or Spec Kit)")
    // It must not teach the agent to do convoy's work itself.
    expect(body).not.toMatch(/git worktree add/)
    expect(body).not.toMatch(/branch name is|derive the branch/i)
  })

  test("creates the commands dir when it does not exist yet", async () => {
    const nested = join(commandsDir, "deep", "commands")
    const install = await installSpinCommand(nested)
    expect(install.updated).toBe(true)
    expect((await stat(nested)).isDirectory()).toBe(true)
  })

  describe("legacy spin.md migration", () => {
    test("a convoy-owned legacy spin.md is removed on install", async () => {
      await mkdir(commandsDir, { recursive: true })
      const legacy = join(commandsDir, "spin.md")
      await writeFile(legacy, "<!-- convoy:spin v1 -->\nthe old name\n", "utf8")
      const install = await installSpinCommand(commandsDir)
      expect(install.updated).toBe(true)
      expect(install.legacyRemoved).toBe(true)
      expect(install.legacyPath).toBe(legacy)
      await expect(stat(legacy)).rejects.toThrow()
      expect(await listCommandFiles(commandsDir)).toEqual(["convoy-spin.md"])
    })

    test("a convoy-owned legacy spin.md is removed even when conv-spin is already current", async () => {
      await installSpinCommand(commandsDir)
      const legacy = join(commandsDir, "spin.md")
      await writeFile(legacy, "<!-- convoy:spin v1 -->\nthe old name\n", "utf8")
      const install = await installSpinCommand(commandsDir)
      expect(install.updated).toBe(false)
      expect(install.legacyRemoved).toBe(true)
      expect(await listCommandFiles(commandsDir)).toEqual(["convoy-spin.md"])
    })

    test("an operator-authored spin.md (no convoy marker) is left alone — the name is no longer convoy's", async () => {
      await mkdir(commandsDir, { recursive: true })
      const legacy = join(commandsDir, "spin.md")
      const operatorBody = "# my own /spin\nrun my thing\n"
      await writeFile(legacy, operatorBody, "utf8")
      const install = await installSpinCommand(commandsDir)
      expect(install.updated).toBe(true)
      expect(install.legacyRemoved).toBeUndefined()
      expect(await readFile(legacy, "utf8")).toBe(operatorBody)
      expect(await listCommandFiles(commandsDir)).toEqual(["convoy-spin.md", "spin.md"])
    })

    test("a skipped install (foreign convoy-spin.md) touches nothing else, legacy included", async () => {
      await mkdir(commandsDir, { recursive: true })
      await writeFile(spinCommandPath(commandsDir), "# operator's /convoy-spin\n", "utf8")
      const legacy = join(commandsDir, "spin.md")
      await writeFile(legacy, "<!-- convoy:spin v1 -->\nthe old name\n", "utf8")
      const install = await installSpinCommand(commandsDir)
      expect(install.skipped).toBe(true)
      expect(install.legacyRemoved).toBeUndefined()
      expect(await listCommandFiles(commandsDir)).toEqual(["convoy-spin.md", "spin.md"])
    })
  })
})
