import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { detectSkillTargets, installSkill, parseSkillArgs, runSkillCommand, skillFiles, skillFileText, skillsDirFor, uninstallSkill } from "../src/skill-install"

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-skill-"))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort()
}

describe("the embedded skill", () => {
  test("embeds every file under skills/convoy, byte for byte", async () => {
    const source = join(import.meta.dir, "..", "skills", "convoy")
    const files = await listFiles(source)
    expect(Object.keys(skillFiles).sort()).toEqual(files)
    for (const file of files) expect(skillFiles[file]).toBe(await readFile(join(source, file), "utf8"))
  })

  test("SKILL.md opens with the frontmatter harnesses read, then the ownership marker", () => {
    const body = skillFiles["SKILL.md"]!
    expect(body).toMatch(/^---\nname: convoy\ndescription: .+\n---\n<!-- convoy:skill -->\n/)
    const description = /^description: (.+)$/m.exec(body)![1]!
    // Claude Code and Codex cap skill descriptions at 1024 characters.
    expect(description.length).toBeLessThanOrEqual(1024)
  })

  test("the skill only teaches commands the CLI has", () => {
    const body = Object.values(skillFiles).join("\n")
    for (const command of ["convoy pipelines show --pipeline-file", "--detach", "convoy runs <run-id> --wait", "approve <request-id>", "convoy skill show references/pipeline-files.md"]) {
      expect(body).toContain(command)
    }
  })

  test("show prints SKILL.md or a named reference", () => {
    expect(skillFileText()).toBe(skillFiles["SKILL.md"]!.endsWith("\n") ? skillFiles["SKILL.md"]! : `${skillFiles["SKILL.md"]!}\n`)
    expect(skillFileText("references/pipeline-files.md")).toContain("# Pipeline files")
    expect(() => skillFileText("nope.md")).toThrow('no skill file "nope.md"')
  })
})

describe("installSkill", () => {
  test("installs, then reports current, then refreshes a stale copy", async () => {
    await withDir(async (skillsDir) => {
      expect((await installSkill("claude", skillsDir)).outcome).toBe("installed")
      expect(await listFiles(join(skillsDir, "convoy"))).toEqual(Object.keys(skillFiles).sort())
      expect((await installSkill("claude", skillsDir)).outcome).toBe("current")

      await writeFile(join(skillsDir, "convoy", "SKILL.md"), "---\nname: convoy\n---\n<!-- convoy:skill -->\nold\n")
      await writeFile(join(skillsDir, "convoy", "references", "retired.md"), "gone")
      expect((await installSkill("claude", skillsDir)).outcome).toBe("updated")
      expect(await readFile(join(skillsDir, "convoy", "SKILL.md"), "utf8")).toBe(skillFiles["SKILL.md"]!)
      // A refresh replaces the directory, so a file the skill stopped shipping goes.
      expect(await listFiles(join(skillsDir, "convoy"))).toEqual(Object.keys(skillFiles).sort())
    })
  })

  test("leaves a convoy skill it didn't write untouched", async () => {
    await withDir(async (skillsDir) => {
      await mkdir(join(skillsDir, "convoy"), { recursive: true })
      await writeFile(join(skillsDir, "convoy", "SKILL.md"), "my own convoy skill")
      expect((await installSkill("codex", skillsDir)).outcome).toBe("skipped")
      expect((await uninstallSkill("codex", skillsDir)).outcome).toBe("skipped")
      expect(await readFile(join(skillsDir, "convoy", "SKILL.md"), "utf8")).toBe("my own convoy skill")
    })
  })

  test("uninstall removes only its own directory", async () => {
    await withDir(async (skillsDir) => {
      expect((await uninstallSkill("opencode", skillsDir)).outcome).toBe("absent")
      await installSkill("opencode", skillsDir)
      await mkdir(join(skillsDir, "other"))
      expect((await uninstallSkill("opencode", skillsDir)).outcome).toBe("removed")
      expect(await readdir(skillsDir)).toEqual(["other"])
    })
  })
})

describe("targets", () => {
  test("each harness's skills directory honors its own environment override", () => {
    expect(skillsDirFor("claude", { CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/skills")
    expect(skillsDirFor("opencode", { XDG_CONFIG_HOME: "/x" })).toBe("/x/opencode/skills")
    expect(skillsDirFor("codex", { CODEX_HOME: "/k" })).toBe("/k/skills")
    expect(skillsDirFor("claude", {})).toMatch(/\/\.claude\/skills$/)
  })

  test("detects harnesses by config directory or binary", async () => {
    const env = { CLAUDE_CONFIG_DIR: "/c", XDG_CONFIG_HOME: "/x", CODEX_HOME: "/k" }
    const found = await detectSkillTargets({ env, exists: async (path) => path === "/c", which: (binary) => (binary === "codex" ? "/bin/codex" : null) })
    expect(found).toEqual(["claude", "codex"])
  })

  test("install with nowhere to go says so and fails", async () => {
    const output: string[] = []
    const code = await runSkillCommand("install", [], (text) => output.push(text), async () => [])
    expect(code).toBe(1)
    expect(output.join("")).toContain("found no Claude Code, OpenCode, or Codex install")
  })
})

describe("parseSkillArgs", () => {
  test("install, uninstall, show, and help", () => {
    expect(parseSkillArgs(["install"])).toEqual({ type: "skill", action: "install", targets: [] })
    expect(parseSkillArgs(["install", "--claude", "--codex", "--claude"])).toEqual({ type: "skill", action: "install", targets: ["claude", "codex"] })
    expect(parseSkillArgs(["uninstall", "--opencode"])).toEqual({ type: "skill", action: "uninstall", targets: ["opencode"] })
    expect(parseSkillArgs(["show"])).toEqual({ type: "skill-show" })
    expect(parseSkillArgs(["show", "references/pipeline-files.md"])).toEqual({ type: "skill-show", file: "references/pipeline-files.md" })
    expect(parseSkillArgs([])).toMatchObject({ type: "help" })
    expect(parseSkillArgs(["install", "--help"])).toMatchObject({ type: "help" })
  })

  test("refuses unknown verbs and harnesses", () => {
    expect(() => parseSkillArgs(["add"])).toThrow('unknown "add"')
    expect(() => parseSkillArgs(["install", "--cursor"])).toThrow("unknown flag: --cursor")
    expect(() => parseSkillArgs(["show", "a", "b"])).toThrow("usage: convoy skill show")
  })
})
