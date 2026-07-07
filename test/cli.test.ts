import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"

import { parseAndRun, parseArgs, parseCommand } from "../src/cli"
import { stepNames } from "../src/pipeline"

const homeDirs: string[] = []
let savedHome: string | undefined

beforeEach(async () => {
  savedHome = process.env.ARCHER_HOME
  const root = await mkdtemp(join(tmpdir(), "archer-cli-home-"))
  homeDirs.push(root)
  await mkdir(join(root, ".archer"), { recursive: true })
  process.env.ARCHER_HOME = root
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.ARCHER_HOME
  else process.env.ARCHER_HOME = savedHome
})

afterAll(async () => {
  await Promise.all(homeDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("cli parsing", () => {
  test("parses pipeline flags without side effects", () => {
    const parsed = parseArgs([
      "--only",
      "implementer,tests",
      "--skip=design",
      "--file",
      "lib/onboarding",
      "--include-dirty",
      "add",
      "onboarding",
    ])

    expect(parsed.onlySteps).toEqual(["implementer", "tests"])
    expect(parsed.skipSteps).toEqual(["design"])
    expect(parsed.files).toEqual(["lib/onboarding"])
    expect(parsed.includeDirty).toBe(true)
    expect(parsed.prompt).toBe("add onboarding")
  })

  test("returns help as a command", async () => {
    const command = await parseCommand(["--help"])

    expect(command.type).toBe("help")
    if (command.type === "help") expect(command.text).toContain("archer [prompt]")
  })

  test("requires prompt unless resuming", async () => {
    await expect(parseCommand([])).rejects.toThrow("need a prompt")

    const command = await parseCommand(["--resume", "20260519-103045-x7q2"])
    expect(command.type).toBe("run")
    if (command.type === "run") expect(command.options.resumeRunID).toBe("20260519-103045-x7q2")
  })

  test("rejects invalid max attempts", () => {
    expect(() => parseArgs(["--max-attempts", "0", "prompt"])).toThrow("--max-attempts")
  })

  test("rejects unknown step names against the resolved pipeline", async () => {
    await expect(parseCommand(["--only", "secuirty", "prompt"])).rejects.toThrow('unknown step "secuirty"')
    await expect(parseCommand(["--skip", "desing", "prompt"])).rejects.toThrow('unknown step "desing"')

    // human-review is a real step now; referencing it stays valid even when
    // the gate was dropped from the pipeline (non-interactive runs).
    const command = await parseCommand(["--skip", "human-review", "prompt"])
    expect(command.type).toBe("run")
  })

  test("rejects a flag where a value is expected", () => {
    expect(() => parseArgs(["--prompt-file", "--only"])).toThrow("--prompt-file requires a value")
  })

  test("rejects conflicting prompt sources", async () => {
    await expect(parseCommand(["--prompt-file", "prd.md", "inline prompt"])).rejects.toThrow("not both")
    await expect(parseCommand(["--resume", "20260519-103045-x7q2", "new prompt"])).rejects.toThrow("--resume")
  })

  test("parses human review flags", () => {
    const parsed = parseArgs([
      "--human-review",
      "--no-tui",
      "--emulator",
      "Pixel_8",
      "--app-run-command",
      "flutter run -d emulator-5554",
      "--interactive-model",
      "openai/gpt-5.5-pro",
      "--interactive-variant",
      "xhigh",
      "prompt",
    ])

    expect(parsed.humanReview).toBe(true)
    expect(parsed.tui).toBe(false)
    expect(parsed.emulatorID).toBe("Pixel_8")
    expect(parsed.appRunCommand).toBe("flutter run -d emulator-5554")
    expect(parsed.interactiveModel).toBe("openai/gpt-5.5-pro")
    expect(parsed.interactiveVariant).toBe("xhigh")
  })

  test("does not configure a Flutter app command by default", async () => {
    const command = await parseCommand(["prompt"])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.appRunCommand).toBe("")
    expect(command.options.emulatorID).toBe("")
  })

  test("yolo is opt-in", async () => {
    const plain = await parseCommand(["prompt"])
    if (plain.type === "run") expect(plain.options.yolo).toBe(false)

    const yolo = await parseCommand(["--yolo", "prompt"])
    if (yolo.type === "run") expect(yolo.options.yolo).toBe(true)
  })

  test("smart auto-accept is opt-in and resolves a judge model", async () => {
    const plain = await parseCommand(["prompt"])
    // Unset, the judge model still resolves (falls back to the run's model).
    if (plain.type === "run") {
      expect(plain.options.smart).toBe(false)
      expect(plain.options.smartJudgeModel.length).toBeGreaterThan(0)
    }

    const smart = await parseCommand(["--smart", "--smart-model", "anthropic/claude-haiku-4-5", "prompt"])
    if (smart.type === "run") {
      expect(smart.options.smart).toBe(true)
      expect(smart.options.smartJudgeModel).toBe("anthropic/claude-haiku-4-5")
    }
  })

  test("parses the runs subcommand", async () => {
    const bare = await parseCommand(["runs"])
    expect(bare.type).toBe("runs")
    if (bare.type === "runs") expect(bare.runID).toBeUndefined()

    const withID = await parseCommand(["runs", "20260519-103045-x7q2"])
    expect(withID.type).toBe("runs")
    if (withID.type === "runs") expect(withID.runID).toBe("20260519-103045-x7q2")
  })

  test("rejects bad runs subcommand arguments", async () => {
    await expect(parseCommand(["runs", "latest"])).rejects.toThrow("invalid run id")
    await expect(parseCommand(["runs", "20260519-103045-x7q2", "extra"])).rejects.toThrow("usage: archer runs")
  })
})

describe("config precedence", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function projectWithConfig() {
    const dir = await mkdtemp(join(tmpdir(), "archer-cli-config-"))
    dirs.push(dir)
    await mkdir(join(dir, ".archer"), { recursive: true })
    await writeFile(join(dir, "docs.md"), "# notes")
    await writeFile(
      join(dir, ".archer", "config.yaml"),
      [
        "defaults:",
        "  maxAttempts: 5",
        "  baseRef: develop",
        "  pipeline: quick",
        "  appRunCommand: flutter run",
        "pipelines:",
        "  quick:",
        "    steps:",
        "      - implementer",
        "      - tests",
        "attachments:",
        "  - docs.md",
      ].join("\n"),
    )
    return dir
  }

  test("config defaults apply when flags are absent", async () => {
    const dir = await projectWithConfig()
    const command = await parseCommand(["--dir", dir, "prompt"])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.maxAttempts).toBe(5)
    expect(command.options.baseRef).toBe("develop")
    expect(command.options.appRunCommand).toBe("flutter run")
    expect(command.options.pipeline.name).toBe("quick")
    expect(stepNames(command.options.pipeline)).toEqual(["implementer", "tests"])
    expect(command.options.files).toEqual(["docs.md"])
  })

  test("CLI flags always win over config defaults", async () => {
    const dir = await projectWithConfig()
    const command = await parseCommand([
      "--dir",
      dir,
      "--max-attempts",
      "1",
      "--base",
      "main",
      "--pipeline",
      "implement",
      "--no-app-run",
      "prompt",
    ])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.maxAttempts).toBe(1)
    expect(command.options.baseRef).toBe("main")
    expect(command.options.appRunCommand).toBe("")
    expect(command.options.pipeline.name).toBe("implement")
  })

  test("an unknown pipeline lists what exists", async () => {
    const dir = await projectWithConfig()
    await expect(parseCommand(["--dir", dir, "--pipeline", "ghost", "prompt"])).rejects.toThrow(
      'unknown pipeline "ghost" (available: implement, quick, refine, review, ultra-implement, ultra-refine)',
    )
  })
})

describe("init command", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("parses init options without requiring a prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-cli-init-"))
    dirs.push(dir)

    const local = await parseCommand(["init", "--dir", dir, "--force", "--quiet"])
    expect(local.type).toBe("init")
    if (local.type === "init") {
      expect(local.options).toMatchObject({ targetDir: dir, global: false, force: true, quiet: true })
    }

    const global = await parseCommand(["init", "--global", "--force"])
    expect(global.type).toBe("init")
    if (global.type === "init") expect(global.options).toMatchObject({ global: true, force: true })
  })

  test("rejects incompatible init options", async () => {
    await expect(parseCommand(["init", "--global", "--dir", "."])).rejects.toThrow("either --global or --dir")
    await expect(parseCommand(["init", "extra"])).rejects.toThrow("usage: archer init")
  })

  test("creates project config without overwriting unless forced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-cli-init-write-"))
    dirs.push(dir)
    const path = join(dir, ".archer", "config.yaml")

    await parseAndRun(["init", "--dir", dir, "--quiet"])
    expect(await readFile(path, "utf8")).toContain("version: 1")
    expect(await readFile(path, "utf8")).toContain("#   implementer:")
    expect(await readFile(path, "utf8")).toContain("# maxAttempts: 2")
    expect(await readFile(join(dir, ".archer", "agents", "implementer.md"), "utf8")).toContain("# Implementer")

    await writeFile(path, "version: 1\nattachments:\n  - custom.md\n")
    await writeFile(join(dir, ".archer", "agents", "implementer.md"), "# Custom Implementer\n")
    await parseAndRun(["init", "--dir", dir, "--quiet"])
    expect(await readFile(path, "utf8")).toContain("custom.md")
    expect(await readFile(join(dir, ".archer", "agents", "implementer.md"), "utf8")).toContain("# Custom Implementer")

    await parseAndRun(["init", "--dir", dir, "--force", "--quiet"])
    expect(await readFile(path, "utf8")).not.toContain("custom.md")
    expect(await readFile(join(dir, ".archer", "agents", "implementer.md"), "utf8")).toContain("# Implementer")
  })
})
