import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"

import { parseAndRun, parseArgs, parseCommand, resolveRunOptions } from "../src/cli"
import { addWorktree } from "../src/git"
import { stepNames } from "../src/pipeline"

const homeDirs: string[] = []
let savedHome: string | undefined

beforeEach(async () => {
  savedHome = process.env.CONVOY_HOME
  const root = await mkdtemp(join(tmpdir(), "convoy-cli-home-"))
  homeDirs.push(root)
  await mkdir(join(root, ".convoy"), { recursive: true })
  process.env.CONVOY_HOME = root
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = savedHome
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
    if (command.type === "help") expect(command.text).toContain("convoy [prompt]")
  })

  test("parses the auth subcommand grammar", async () => {
    expect(await parseCommand(["auth"])).toEqual({ type: "auth", provider: "openrouter", action: "status" })
    expect(await parseCommand(["auth", "status"])).toEqual({ type: "auth", provider: "openrouter", action: "status" })
    expect(await parseCommand(["auth", "openrouter"])).toEqual({ type: "auth", provider: "openrouter", action: "set" })
    expect(await parseCommand(["auth", "openrouter", "--remove"])).toEqual({ type: "auth", provider: "openrouter", action: "remove" })

    await expect(parseCommand(["auth", "anthropic"])).rejects.toThrow("usage: convoy auth")
    await expect(parseCommand(["auth", "openrouter", "--bogus"])).rejects.toThrow("usage: convoy auth")
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

    // human-review is a legacy human step name; referencing it stays valid even when
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

  test("parses human step flags", () => {
    const parsed = parseArgs(["--human-step", "--no-tui", "prompt"])

    expect(parsed.humanReview).toBe(true)
    expect(parsed.tui).toBe(false)
    expect(parseArgs(["--no-human-step", "prompt"]).humanReview).toBe(false)
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
    await expect(parseCommand(["runs", "20260519-103045-x7q2", "extra"])).rejects.toThrow("usage: convoy runs")
  })
})

describe("config precedence", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function projectWithConfig() {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-config-"))
    dirs.push(dir)
    await mkdir(join(dir, ".convoy"), { recursive: true })
    await writeFile(join(dir, "docs.md"), "# notes")
    await writeFile(
      join(dir, ".convoy", "config.yaml"),
      [
        "defaults:",
        "  maxAttempts: 5",
        "  baseRef: develop",
        "  pipeline: quick",
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
      "prompt",
    ])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.maxAttempts).toBe(1)
    expect(command.options.baseRef).toBe("main")
    expect(command.options.pipeline.name).toBe("implement")
  })

  test("an unknown pipeline lists what exists", async () => {
    const dir = await projectWithConfig()
    await expect(parseCommand(["--dir", dir, "--pipeline", "ghost", "prompt"])).rejects.toThrow(
      'unknown pipeline "ghost" (available: implement, implement-lite, quick, refine, review, review-lite, ultra-implement, ultra-refine)',
    )
  })
})

describe("base ref auto-detection", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "convoy-test",
        GIT_AUTHOR_EMAIL: "convoy-test@example.invalid",
        GIT_COMMITTER_NAME: "convoy-test",
        GIT_COMMITTER_EMAIL: "convoy-test@example.invalid",
      },
    })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  async function repoOn(branch: string) {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-base-"))
    dirs.push(dir)
    await git(["init", "-q", "-b", branch], dir)
    await git(["commit", "-q", "--allow-empty", "-m", "init"], dir)
    return dir
  }

  test("auto-detects the base ref when flag and config are absent", async () => {
    const dir = await repoOn("develop")
    const command = await parseCommand(["--dir", dir, "prompt"])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.baseRef).toBe("develop")
  })

  test("falls back to HEAD outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-base-"))
    dirs.push(dir)
    const command = await parseCommand(["--dir", dir, "prompt"])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.baseRef).toBe("HEAD")
  })

  test("worktree runs detect against the original repo, not the worktree", async () => {
    const repo = await repoOn("squad-x")
    const worktree = await mkdtemp(join(tmpdir(), "convoy-cli-base-wt-"))
    await rm(worktree, { recursive: true, force: true })
    dirs.push(worktree)
    await addWorktree(worktree, "agent-branch", "HEAD", repo)

    const parsed = parseArgs(["prompt"])
    parsed.targetDir = worktree
    parsed.baseDetectionDir = repo

    const options = await resolveRunOptions(parsed)
    expect(options.baseRef).toBe("squad-x")
  })
})

describe("init command", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("parses init options without requiring a prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-init-"))
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
    await expect(parseCommand(["init", "extra"])).rejects.toThrow("usage: convoy init")
  })

  test("creates project config without overwriting unless forced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-init-write-"))
    dirs.push(dir)
    const path = join(dir, ".convoy", "config.yaml")

    await parseAndRun(["init", "--dir", dir, "--quiet"])
    expect(await readFile(path, "utf8")).toContain("version: 1")
    expect(await readFile(path, "utf8")).toContain("#   implementer:")
    expect(await readFile(path, "utf8")).toContain("# maxAttempts: 2")
    expect(await readFile(join(dir, ".convoy", "agents", "implementer.md"), "utf8")).toContain("# Implementer")

    await writeFile(path, "version: 1\nattachments:\n  - custom.md\n")
    await writeFile(join(dir, ".convoy", "agents", "implementer.md"), "# Custom Implementer\n")
    await parseAndRun(["init", "--dir", dir, "--quiet"])
    expect(await readFile(path, "utf8")).toContain("custom.md")
    expect(await readFile(join(dir, ".convoy", "agents", "implementer.md"), "utf8")).toContain("# Custom Implementer")

    await parseAndRun(["init", "--dir", dir, "--force", "--quiet"])
    expect(await readFile(path, "utf8")).not.toContain("custom.md")
    expect(await readFile(join(dir, ".convoy", "agents", "implementer.md"), "utf8")).toContain("# Implementer")
  })
})
