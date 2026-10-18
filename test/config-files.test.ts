import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"

import { createConfigFile, editorArgv, featureStates, listConfigFiles, setProjectFeature, withFeature } from "../src/config-files"
import { ConfigScreen } from "../src/config-tui"
import { TuiSession } from "../src/tui-session"

import type { KeyEvent } from "@opentui/core"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

let home: string
let repo: string
let savedHome: string | undefined
beforeEach(async () => {
  savedHome = process.env.CONVOY_HOME
  home = await scratch("convoy-config-files-home-")
  repo = await scratch("convoy-config-files-repo-")
  process.env.CONVOY_HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = savedHome
})

function key(name: string): KeyEvent {
  return { name, ctrl: false, meta: false, shift: false, option: false, sequence: name, number: false, raw: name, eventType: "keypress", source: "raw", preventDefault() {}, stopPropagation() {} } as unknown as KeyEvent
}

describe("config files", () => {
  test("lists each scope's config, present or not, with load errors, then its agent prompts", async () => {
    await mkdir(join(home, ".convoy", "agents"), { recursive: true })
    await writeFile(join(home, ".convoy", "config.yaml"), "defaults:\n  prdHistory: maybe\n")
    await writeFile(join(home, ".convoy", "agents", "implementer.md"), "# mine\n")
    await mkdir(join(repo, ".convoy"), { recursive: true })
    await writeFile(join(repo, ".convoy", "config.yml"), "features:\n  specs: false\n")

    const entries = await listConfigFiles(repo)
    expect(entries.map((entry) => [entry.scope, entry.kind, entry.name, entry.exists])).toEqual([
      ["global", "config", "config", true],
      ["global", "agent", "implementer", true],
      ["project", "config", "config", true],
    ])
    expect(entries[0]!.error).toContain("prdHistory")
    // The project's config.yml is the file that loads, not a default name.
    expect(entries[2]).toMatchObject({ path: join(repo, ".convoy", "config.yml") })
    expect(entries[2]!.error).toBeUndefined()
  })

  test("a missing config is listed at its default path and created from the init template", async () => {
    const [, project] = await listConfigFiles(repo)
    expect(project).toMatchObject({ scope: "project", exists: false, path: join(repo, ".convoy", "config.yaml") })
    await createConfigFile(project!, repo)
    expect(await readFile(join(repo, ".convoy", "config.yaml"), "utf8")).toContain("# features:")
    expect((await listConfigFiles(repo))[1]).toMatchObject({ exists: true })
  })

  test("listing never rewrites a global config the loader would migrate", async () => {
    await mkdir(join(home, ".convoy"), { recursive: true })
    const body = "pipelines:\n  MyFlow:\n    steps:\n      - implementer\n"
    await writeFile(join(home, ".convoy", "config.yaml"), body)
    await listConfigFiles(repo)
    expect(await readFile(join(home, ".convoy", "config.yaml"), "utf8")).toBe(body)
  })

  test("the editor is $VISUAL, then $EDITOR with its arguments, then nano, vim, or vi", () => {
    const none = () => null
    expect(editorArgv("/f", { VISUAL: "code -w", EDITOR: "vim" }, none)).toEqual(["code", "-w", "/f"])
    expect(editorArgv("/f", { EDITOR: " hx " }, none)).toEqual(["hx", "/f"])
    expect(editorArgv("/f", {}, (bin) => (bin === "vim" ? "/usr/bin/vim" : null))).toEqual(["vim", "/f"])
    expect(() => editorArgv("/f", {}, none)).toThrow(/set \$EDITOR/)
  })
})

describe("config screen", () => {
  test("enter creates a missing config, opens it in the editor, and reports a file that no longer loads", async () => {
    const testRenderer = await createTestRenderer({ width: 120, height: 30, exitOnCtrlC: false })
    const session = new TuiSession(testRenderer.renderer)
    const savedEditor = process.env.EDITOR
    process.env.EDITOR = "fake-editor"
    try {
      const calls: string[][] = []
      const screen = new ConfigScreen(testRenderer.renderer, repo, await listConfigFiles(repo), session.openScene("convoy-config-scene"), {
        runEditor: async ({ argv }) => {
          calls.push([...argv])
          await writeFile(argv[1]!, "features:\n  specs: sometimes\n")
          return 0
        },
      })
      await Bun.sleep(30)
      await testRenderer.renderOnce()
      let frame = testRenderer.captureCharFrame()
      expect(frame).toContain("GLOBAL")
      expect(frame).toContain("not created")
      // The switches lead; the project config is the fourth row.
      for (let i = 0; i < 3; i++) testRenderer.renderer.keyInput.emit("keypress", key("down"))
      await testRenderer.renderOnce()
      expect(testRenderer.captureCharFrame()).toContain("create and edit")
      testRenderer.renderer.keyInput.emit("keypress", key("return"))
      for (let i = 0; i < 50 && calls.length === 0; i++) await Bun.sleep(10)
      await Bun.sleep(50)
      await testRenderer.renderOnce()
      expect(calls).toEqual([["fake-editor", join(repo, ".convoy", "config.yaml")]])
      frame = testRenderer.captureCharFrame()
      expect(frame).toContain("doesn't load")
      expect(frame).toContain("features.specs")

      testRenderer.renderer.keyInput.emit("keypress", key("q"))
      await screen.result
    } finally {
      if (savedEditor === undefined) delete process.env.EDITOR
      else process.env.EDITOR = savedEditor
      session.destroy()
    }
  })
})

describe("feature switches", () => {
  test("each switch reports its value and the file that decided it", async () => {
    expect(await featureStates(repo)).toEqual([
      { key: "worktrees", enabled: true, source: "default" },
      { key: "specs", enabled: true, source: "default" },
    ])
    await mkdir(join(home, ".convoy"), { recursive: true })
    await writeFile(join(home, ".convoy", "config.yaml"), "features:\n  worktrees: false\n  specs: false\n")
    await mkdir(join(repo, ".convoy"), { recursive: true })
    await writeFile(join(repo, ".convoy", "config.yaml"), "features:\n  specs: true\n")
    expect(await featureStates(repo)).toEqual([
      { key: "worktrees", enabled: false, source: "global" },
      { key: "specs", enabled: true, source: "project" },
    ])
  })

  test("setting a switch edits only its line and keeps the file's comments", () => {
    const body = "# my notes\ndefaults:\n  prdHistory: true\n\nfeatures:\n  # keep this\n  specs: true\n\n# trailing comment\n"
    expect(withFeature(body, "specs", false)).toBe("# my notes\ndefaults:\n  prdHistory: true\n\nfeatures:\n  # keep this\n  specs: false\n\n# trailing comment\n")
    expect(withFeature(body, "worktrees", false)).toBe("# my notes\ndefaults:\n  prdHistory: true\n\nfeatures:\n  # keep this\n  specs: true\n  worktrees: false\n\n# trailing comment\n")
    // No block yet: appended at the end, after the template's commented example.
    expect(withFeature("# features:\n#   specs: true\n", "specs", false)).toBe("# features:\n#   specs: true\n\nfeatures:\n  specs: false\n")
    expect(() => withFeature("features: { specs: true }\n", "specs", false)).toThrow(/inline/)
  })

  test("a missing project config starts from the template, and a broken one is never rewritten", async () => {
    const path = await setProjectFeature(repo, "worktrees", false)
    const written = await readFile(path, "utf8")
    expect(written).toContain("# Convoy configuration.")
    expect(written.trimEnd().endsWith("features:\n  worktrees: false")).toBeTrue()
    expect((await featureStates(repo))[0]).toEqual({ key: "worktrees", enabled: false, source: "project" })

    await writeFile(path, "defaults:\n  prdHistory: maybe\n")
    await expect(setProjectFeature(repo, "specs", false)).rejects.toThrow(/fix .* first/)
    expect(await readFile(path, "utf8")).toBe("defaults:\n  prdHistory: maybe\n")
  })

  test("space toggles a switch from the config screen and saves it in the project", async () => {
    const testRenderer = await createTestRenderer({ width: 120, height: 30, exitOnCtrlC: false })
    const session = new TuiSession(testRenderer.renderer)
    try {
      const screen = new ConfigScreen(testRenderer.renderer, repo, [], session.openScene("convoy-config-scene"), { runEditor: async () => 0 })
      await Bun.sleep(30)
      await testRenderer.renderOnce()
      let frame = testRenderer.captureCharFrame()
      expect(frame).toContain("FEATURES")
      expect(frame).toMatch(/Worktrees\s+● on\s+default/)
      expect(frame).toContain("space toggle")

      testRenderer.renderer.keyInput.emit("keypress", key("down"))
      testRenderer.renderer.keyInput.emit("keypress", key("space"))
      await Bun.sleep(50)
      await testRenderer.renderOnce()
      frame = testRenderer.captureCharFrame()
      expect(frame).toMatch(/Specs\s+○ off\s+set in this project/)
      expect(frame).toContain("Specs off · saved in .convoy/config.yaml")
      expect((await featureStates(repo))[1]).toEqual({ key: "specs", enabled: false, source: "project" })

      testRenderer.renderer.keyInput.emit("keypress", key("q"))
      await screen.result
    } finally {
      session.destroy()
    }
  })
})

