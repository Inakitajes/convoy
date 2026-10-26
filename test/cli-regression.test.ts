import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"

import { parseAndRun, parseArgs, parseCommand, resolveRunOptions, runRootLauncherLoop } from "../src/cli"
import { addWorktree } from "../src/git"
import { stepNames } from "../src/pipeline"
import type { RunMetadata } from "../src/metadata"
import type { AgentStep } from "../src/types"

const dirs: string[] = []
let savedHome: string | undefined

beforeEach(async () => {
  savedHome = process.env.CONVOY_HOME
  const root = await mkdtemp(join(tmpdir(), "convoy-cli-regression-home-"))
  dirs.push(root)
  await mkdir(join(root, ".convoy"), { recursive: true })
  process.env.CONVOY_HOME = root
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = savedHome
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function projectWithQuickPipeline(): Promise<string> {
  const dir = await tempDir("convoy-cli-regression-project-")
  await mkdir(join(dir, ".convoy"), { recursive: true })
  await writeFile(join(dir, "docs.md"), "# notes")
  await writeFile(
    join(dir, ".convoy", "config.yaml"),
    [
      "version: 1",
      "defaults:",
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

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
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

async function repoOn(branch: string): Promise<string> {
  const dir = await tempDir("convoy-cli-regression-repo-")
  await git(["init", "-q", "-b", branch], dir)
  await git(["commit", "-q", "--allow-empty", "-m", "init"], dir)
  return dir
}

describe("CLI semantic regression coverage", () => {
  test("Spec Kit plans freeze only active selected features and their complete contract", async () => {
    const dir = await projectWithQuickPipeline()
    await writeFile(join(dir, ".convoy", "config.yaml"), "features:\n  specs: speckit\n")
    for (const id of ["001-login", "002-search", "000-setup"]) {
      await mkdir(join(dir, "specs", id, "contracts"), { recursive: true })
      await writeFile(join(dir, "specs", id, "spec.md"), `# Feature Specification: ${id}\n`)
      await writeFile(join(dir, "specs", id, "tasks.md"), id === "000-setup" ? "- [x] T001 Done\n" : "- [ ] T001 Work\n")
    }
    await writeFile(join(dir, "specs", "001-login", "contracts", "api.md"), "# API\n")
    await mkdir(join(dir, ".specify", "memory"), { recursive: true })
    await writeFile(join(dir, ".specify", "memory", "constitution.md"), "# Constitution\n")
    await mkdir(join(dir, "openspec", "changes", "other"), { recursive: true })
    await writeFile(join(dir, "openspec", "changes", "other", "proposal.md"), "# Other tool\n")

    const command = await parseCommand(["--dir", dir, "--change", "002-search", "--change", "001-login", "-p", "review", "--plan"])
    if (command.type !== "run") throw new Error("expected run")
    expect(command.options.prompt).toBe("Review the attached Spec Kit feature.")
    expect(command.options.plan?.specs).toMatchObject({ tool: "speckit", changeIds: ["002-search", "001-login"] })
    const files = command.options.plan?.specs?.specFiles ?? []
    expect(files[0]).toBe(".specify/memory/constitution.md")
    expect(files).toContain("specs/001-login/contracts/api.md")
    expect(files.indexOf("specs/002-search/spec.md")).toBeLessThan(files.indexOf("specs/001-login/spec.md"))
    expect(files.some((file) => file.startsWith("openspec/") || file.includes("000-setup"))).toBe(false)
    await expect(parseCommand(["--dir", dir, "--change", "000-setup", "-p", "review"])).rejects.toThrow(/active.*Spec Kit feature|active change/)
    await expect(parseCommand(["--dir", dir, "--change", "other", "-p", "review"])).rejects.toThrow(/specs\//)
  })

  test("an absent configured layout never reads the other tool and invalid config is not ignored", async () => {
    const dir = await projectWithQuickPipeline()
    await mkdir(join(dir, "openspec", "changes", "other"), { recursive: true })
    await writeFile(join(dir, "openspec", "changes", "other", "proposal.md"), "# Other tool\n")
    await writeFile(join(dir, ".convoy", "config.yaml"), "features:\n  specs: speckit\n")
    const manual = await parseCommand(["--dir", dir, "--manual", "-p", "review"])
    if (manual.type !== "run") throw new Error("expected run")
    expect(manual.options.plan?.specs?.changeIds ?? []).toEqual([])
    await expect(parseCommand(["--dir", dir, "--change", "other", "-p", "review"])).rejects.toThrow(/specs\//)
    await writeFile(join(dir, ".convoy", "config.yaml"), "features:\n  specs: true\n")
    await expect(parseCommand(["--dir", dir, "--manual", "-p", "review"])).rejects.toThrow(/features.specs.*openspec.*speckit.*false/)
  })

  test("the real CLI plans and lists a Spec Kit checkout without the specify CLI", async () => {
    const dir = await repoOn("main")
    await mkdir(join(dir, ".convoy"), { recursive: true })
    await writeFile(join(dir, ".convoy", "config.yaml"), "features:\n  specs: speckit\n")
    await mkdir(join(dir, "specs", "001-x", "contracts"), { recursive: true })
    await mkdir(join(dir, "specs", "000-completed"), { recursive: true })
    await mkdir(join(dir, ".specify", "memory"), { recursive: true })
    await writeFile(join(dir, ".specify", "memory", "constitution.md"), "# Constitution\n")
    await writeFile(join(dir, "specs", "001-x", "spec.md"), "# Feature Specification: Export records\n\n**Input**: User description: \"Export records as CSV\"\n")
    await writeFile(join(dir, "specs", "001-x", "plan.md"), "# Plan\n")
    await writeFile(join(dir, "specs", "001-x", "tasks.md"), "- [ ] T001 [P] [US1] Export\n")
    await writeFile(join(dir, "specs", "001-x", "contracts", "api.md"), "# Contract\n")
    await writeFile(join(dir, "specs", "000-completed", "spec.md"), "# Feature Specification: Setup\n")
    await writeFile(join(dir, "specs", "000-completed", "tasks.md"), "- [x] T001 Setup\n")
    const main = join(import.meta.dir, "..", "src", "main.ts")
    const invoke = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, main, ...args], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { stdout, stderr, code }
    }
    const plan = await invoke(["--change", "001-x", "-p", "review", "--plan"])
    expect(plan.code).toBe(0)
    expect(plan.stdout).toContain("Spec Kit feature: 001-x")
    expect(plan.stdout).toContain("5 spec files")
    const listing = await invoke(["specs"])
    expect(listing.code).toBe(0)
    expect(listing.stdout).toContain("Export records")
    expect(listing.stdout).toContain("001-x")
    expect(listing.stdout.toLowerCase()).toContain("completed")
    expect(listing.stdout).not.toContain("\u001b[")
  })

  test("resume retains the frozen spec tool and bundle after project config switches", async () => {
    const dir = await projectWithQuickPipeline()
    const initial = await parseCommand(["--dir", dir, "--manual", "-p", "review"])
    if (initial.type !== "run") throw new Error("expected run")
    const specs = { tool: "speckit" as const, changeIds: ["001-login"], specFiles: ["specs/001-login/spec.md"] }
    const runID = "20260519-103045-spek"
    const runDir = join(process.env.CONVOY_HOME!, ".convoy", "runs", runID)
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, "metadata.json"), JSON.stringify({ schemaVersion: 3, runID, targetDir: dir, createdAt: 0, updatedAt: 0, control: { state: "running" }, phases: {}, pipeline: initial.options.pipeline, specs }))
    await writeFile(join(runDir, "prd.md"), "Review the attached Spec Kit feature.")
    await writeFile(join(dir, ".convoy", "config.yaml"), "features:\n  specs: false\n")
    const resumed = await parseCommand(["--dir", dir, "--resume", runID])
    if (resumed.type !== "run") throw new Error("expected run")
    expect(resumed.options.plan?.specs).toEqual(specs)
  })

  test("resolves base, pipeline, and attachments through config and CLI precedence", async () => {
    const dir = await projectWithQuickPipeline()

    const configured = await parseCommand(["--dir", dir, "prompt"])
    expect(configured.type).toBe("run")
    if (configured.type !== "run") return
    expect(configured.options.baseRef).toBe("develop")
    expect(configured.options.pipeline.name).toBe("quick")
    expect(stepNames(configured.options.pipeline)).toEqual(["implementer", "tests"])
    expect(configured.options.files).toEqual(["docs.md"])

    const overridden = await parseCommand([
      "--dir",
      dir,
      "--base",
      "main",
      "--pipeline",
      "implement",
      "--file",
      "cli.md",
      "prompt",
    ])
    expect(overridden.type).toBe("run")
    if (overridden.type !== "run") return
    expect(overridden.options.baseRef).toBe("main")
    expect(overridden.options.pipeline.name).toBe("implement")
    expect(overridden.options.files).toEqual(["docs.md", "cli.md"])
  })

  test("preserves notification tri-state through command resolution", async () => {
    const dir = await tempDir("convoy-cli-regression-notify-")
    await mkdir(join(dir, ".convoy"), { recursive: true })
    await writeFile(join(dir, ".convoy", "config.yaml"), "notifications:\n  enabled: false\n")

    const defaulted = await parseCommand(["--dir", dir, "prompt"])
    const enabled = await parseCommand(["--dir", dir, "--notify", "prompt"])
    const disabled = await parseCommand(["--dir", dir, "--no-notify", "prompt"])

    if (defaulted.type !== "run" || enabled.type !== "run" || disabled.type !== "run") {
      throw new Error("expected run commands")
    }
    expect(defaulted.options.notify).toBeUndefined()
    expect(enabled.options.notify).toBe(true)
    expect(disabled.options.notify).toBe(false)
    expect(defaulted.options.notifications).toEqual({ enabled: false })
  })

  test("lets the last advisor flag win after option resolution", async () => {
    const dir = await tempDir("convoy-cli-regression-advisor-")
    const model = "anthropic/claude-opus-5"

    const disabled = await parseCommand(["--dir", dir, "--advisor", model, "--no-advisor", "prompt"])
    const enabled = await parseCommand(["--dir", dir, "--no-advisor", "--advisor", model, "prompt"])

    if (disabled.type !== "run" || enabled.type !== "run") throw new Error("expected run commands")
    expect(disabled.options).toMatchObject({ advisorDisabled: true, advisorOverride: "" })
    expect(enabled.options).toMatchObject({ advisorDisabled: false, advisorOverride: model })
  })

  test("resolves human-step aliases and smart/yolo flags", async () => {
    const dir = await tempDir("convoy-cli-regression-flags-")

    const human = await parseCommand(["--dir", dir, "--human-step", "prompt"])
    const automated = await parseCommand(["--dir", dir, "--no-human-step", "prompt"])
    const plain = await parseCommand(["--dir", dir, "prompt"])
    const optedIn = await parseCommand([
      "--dir",
      dir,
      "--smart",
      "--smart-model",
      "anthropic/claude-haiku-4-5",
      "--yolo",
      "prompt",
    ])

    if (human.type !== "run" || automated.type !== "run" || plain.type !== "run" || optedIn.type !== "run") {
      throw new Error("expected run commands")
    }
    expect(human.options.humanReview).toBe(true)
    expect(automated.options.humanReview).toBe(false)
    expect(plain.options).toMatchObject({ smart: false, yolo: false })
    expect(plain.options.smartJudgeModel.length).toBeGreaterThan(0)
    expect(optedIn.options).toMatchObject({
      smart: true,
      smartJudgeModel: "anthropic/claude-haiku-4-5",
      yolo: true,
    })
  })

  test("a resumed run ignores an explicit worktree request", async () => {
    const parsed = parseArgs(["--resume", "20260519-103045-x7q2", "--worktree"])

    expect((await resolveRunOptions(parsed)).worktree).toBe(false)
  })

  test("gateway precedence is CLI, project, then global", async () => {
    const dir = await projectWithQuickPipeline()
    await writeFile(join(process.env.CONVOY_HOME!, ".convoy", "config.yaml"), "modelRouting:\n  gateway: openrouter\n")

    const global = await parseCommand(["--dir", dir, "prompt"])
    expect(global.type).toBe("run")
    if (global.type !== "run") return
    expect(global.options.gateway).toBe("openrouter")
    expect(global.options.plan?.modelRouting.gateway).toBe("openrouter")

    await writeFile(join(dir, ".convoy", "config.yaml"), "modelRouting:\n  gateway: configured\n")
    const project = await parseCommand(["--dir", dir, "prompt"])
    expect(project.type).toBe("run")
    if (project.type !== "run") return
    expect(project.options.gateway).toBe("configured")
    expect(project.options.plan?.modelRouting.gateway).toBe("configured")

    const cli = await parseCommand(["--dir", dir, "--gateway", "vercel", "prompt"])
    expect(cli.type).toBe("run")
    if (cli.type !== "run") return
    expect(cli.options.gateway).toBe("vercel")
    expect(cli.options.gatewayExplicit).toBe(true)
    expect(cli.options.plan?.modelRouting.gateway).toBe("vercel")
  })

  test("--gateway nitro routes the resolved plan through OpenRouter Nitro", async () => {
    const dir = await projectWithQuickPipeline()

    const nitro = await parseCommand(["--dir", dir, "--gateway", "nitro", "prompt"])
    expect(nitro.type).toBe("run")
    if (nitro.type !== "run") return
    expect(nitro.options.gateway).toBe("nitro")
    expect(nitro.options.plan?.modelRouting.gateway).toBe("nitro")

    const routed = (nitro.options.plan?.pipeline.steps ?? []).filter(
      (step): step is AgentStep => step.type === "agent" && Boolean(step.resolvedModel),
    )
    expect(routed.length).toBeGreaterThan(0)
    for (const step of routed) {
      expect(step.resolvedModel?.providerID).toBe("openrouter")
      // Throughput routing is injected provider options, so the target is the
      // plain OpenRouter id — never a `:nitro`-suffixed one.
      expect(step.resolvedModel?.target.includes(":nitro")).toBe(false)
    }
  })

  test("resume restores the frozen pipeline, prompt, and routing metadata", async () => {
    const dir = await projectWithQuickPipeline()
    const initial = await parseCommand(["--dir", dir, "prompt"])
    if (initial.type !== "run") throw new Error(`expected run, got ${initial.type}`)

    const runID = "20260519-103045-x7q2"
    const runDir = join(process.env.CONVOY_HOME!, ".convoy", "runs", runID)
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, "metadata.json"),
      JSON.stringify({
        schemaVersion: 3,
        runID,
        targetDir: dir,
        createdAt: 0,
        updatedAt: 0,
        control: { state: "running" },
        phases: {},
        pipeline: initial.options.pipeline,
        modelRouting: { gateway: "openrouter" },
      }),
    )
    await writeFile(join(runDir, "prd.md"), "original prompt")
    await writeFile(join(dir, ".convoy", "config.yaml"), "version: 1\ndefaults:\n  pipeline: implement\n")

    const resumed = await parseCommand(["--dir", dir, "--resume", runID, "--worktree"])
    expect(resumed.type).toBe("run")
    if (resumed.type !== "run") return
    expect(resumed.options.prompt).toBe("original prompt")
    expect(resumed.options.pipeline.name).toBe("quick")
    expect(stepNames(resumed.options.pipeline)).toEqual(["implementer", "tests"])
    expect(resumed.options.gateway).toBe("openrouter")
    expect(resumed.options.plan?.prompt.source).toBe("resume")
    expect(resumed.options.worktree).toBe(false)
  })

  test("resume of a legacy schema-v3 goal-fix record is refused before any plan is built", async () => {
    // The retired goal-fix child-run host recorded schema-v3 metadata with a
    // plain "goal-fix" pipeline (no terminal goal step). Replaying it as a
    // resume would start an unbriefed improvement flow; the guard must refuse
    // before buildReviewedPlan can construct a runnable plan. If the guard is
    // removed, parseCommand resolves a runnable plan and this test fails.
    const dir = await projectWithQuickPipeline()
    const runID = "20260519-103145-x7q3"
    const runDir = join(process.env.CONVOY_HOME!, ".convoy", "runs", runID)
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, "metadata.json"),
      JSON.stringify({
        schemaVersion: 3,
        runID,
        targetDir: dir,
        createdAt: 0,
        updatedAt: 0,
        control: { state: "running" },
        phases: { fix: { status: "completed" } },
        pipeline: {
          name: "goal-fix",
          steps: [
            { type: "agent", name: "fix", stepName: "fix", agentName: "goal-fixer", description: "Fix", model: "m", inputFiles: [], inputDiff: true, reportPath: "reports/fix.md", groupId: "g1" },
            { type: "agent", name: "score-report", stepName: "score-report", agentName: "quality-score-report", description: "Consensus", model: "m", inputFiles: [], inputDiff: true, reportPath: "reports/score-report.md", groupId: "g2", readOnly: true },
          ],
        },
      }),
    )
    await writeFile(join(runDir, "prd.md"), "legacy goal-fix prompt")

    await expect(parseCommand(["--dir", dir, "--resume", runID])).rejects.toThrow(/legacy goal-fix/)
  })

  test("the resumed-run guard also refuses a retry of a legacy goal-fix record", async () => {
    // `retryOptions` runs the same `assertResumableRun` guard before rebuilding
    // a plan: a retry of a legacy record would run an unbriefed fix pipeline
    // from step zero. Exercise the shared guard under retry semantics.
    const { assertResumableRun } = await import("../src/cli")
    const legacy: RunMetadata = {
      schemaVersion: 3,
      runID: "20260519-103245-x7q4",
      targetDir: "/tmp/repo",
      createdAt: 0,
      updatedAt: 0,
      control: { state: "running" },
      phases: {},
      pipeline: { name: "goal-fix", steps: [] },
    }
    expect(() => assertResumableRun(legacy, legacy.runID, { retry: true })).toThrow(/legacy goal-fix|unbriefed/)
    expect(() => assertResumableRun(legacy, legacy.runID)).toThrow(/legacy goal-fix|unbriefed/)
    // Non-goal-fix records stay continuable.
    expect(() => assertResumableRun({ ...legacy, pipeline: { name: "ship", steps: [] } }, legacy.runID)).not.toThrow()
  })

  test("validates step filters against the resolved pipeline", async () => {
    // The convoy repo is itself an OpenSpec repo, so resolving against the
    // cwd would require an active change under openspec/changes/ — a state
    // main legitimately lacks right after a close archives everything. A bare
    // temp dir keeps these assertions about pipeline resolution alone.
    const dir = await tempDir("convoy-cli-regression-steps-")
    await expect(parseCommand(["--dir", dir, "--only", "secuirty", "prompt"])).rejects.toThrow('unknown step "secuirty"')
    await expect(parseCommand(["--dir", dir, "--skip", "desing", "prompt"])).rejects.toThrow('unknown step "desing"')

    const command = await parseCommand(["--dir", dir, "--skip", "human-review", "prompt"])
    expect(command.type).toBe("run")
  })
})

describe("base and worktree auto-detection regressions", () => {
  test("detects the current base and falls back to HEAD outside Git", async () => {
    const repo = await repoOn("develop")
    const detected = await parseCommand(["--dir", repo, "prompt"])
    expect(detected.type).toBe("run")
    if (detected.type === "run") expect(detected.options.baseRef).toBe("develop")

    const plainDir = await tempDir("convoy-cli-regression-nonrepo-")
    const fallback = await parseCommand(["--dir", plainDir, "prompt"])
    expect(fallback.type).toBe("run")
    if (fallback.type === "run") expect(fallback.options.baseRef).toBe("HEAD")
  })

  test("detects the base against the original repo for worktree runs", async () => {
    const repo = await repoOn("squad-x")
    const worktree = await tempDir("convoy-cli-regression-worktree-")
    await rm(worktree, { recursive: true, force: true })
    await addWorktree(worktree, "agent-branch", "HEAD", repo)

    const parsed = parseArgs(["prompt"])
    parsed.targetDir = worktree
    parsed.baseDetectionDir = repo

    expect((await resolveRunOptions(parsed)).baseRef).toBe("squad-x")
  })

  test("isolates trunks, stays on feature branches, and honors config and flags", async () => {
    const trunk = await repoOn("main")
    const branch = await repoOn("main")
    await git(["checkout", "-q", "-b", "feat/thing"], branch)
    const worktreeFor = async (argv: string[]) => {
      const command = await parseCommand(argv)
      if (command.type !== "run") throw new Error(`expected run, got ${command.type}`)
      return command.options.worktree
    }

    expect(await worktreeFor(["--dir", trunk, "prompt"])).toBe(true)
    expect(await worktreeFor(["--dir", branch, "prompt"])).toBe(false)
    expect(await worktreeFor(["--dir", trunk, "--no-worktree", "prompt"])).toBe(false)
    expect(await worktreeFor(["--dir", branch, "--worktree", "prompt"])).toBe(true)

    await writeFile(join(process.env.CONVOY_HOME!, ".convoy", "config.yaml"), "version: 1\ndefaults:\n  worktree: false\n")
    expect(await worktreeFor(["--dir", trunk, "prompt"])).toBe(false)
    expect(await worktreeFor(["--dir", trunk, "--worktree", "prompt"])).toBe(true)
  })
})

describe("parseAndRun init and agents effects", () => {
  test("creates project config without overwriting unless forced", async () => {
    const dir = await tempDir("convoy-cli-regression-init-")
    const path = join(dir, ".convoy", "config.yaml")

    await parseAndRun(["init", "--dir", dir, "--quiet"])
    expect(await readFile(path, "utf8")).toContain("version: 1")
    expect(await readFile(path, "utf8")).toContain("#   implementer:")
    expect(existsSync(join(dir, ".convoy", "agents"))).toBe(false)

    await writeFile(path, "version: 1\nattachments:\n  - custom.md\n")
    await parseAndRun(["init", "--dir", dir, "--quiet"])
    expect(await readFile(path, "utf8")).toContain("custom.md")

    await parseAndRun(["init", "--dir", dir, "--force", "--quiet"])
    expect(await readFile(path, "utf8")).not.toContain("custom.md")
  })

  test("agents eject writes only the requested prompt and honors force", async () => {
    const dir = await tempDir("convoy-cli-regression-agents-")
    const prompt = join(dir, ".convoy", "agents", "implementer.md")

    await parseAndRun(["agents", "eject", "implementer", "--dir", dir, "--quiet"])
    expect(await readFile(prompt, "utf8")).toContain("# Implementer")
    expect(existsSync(join(dir, ".convoy", "agents", "design-polisher.md"))).toBe(false)

    await writeFile(prompt, "# Mine\n")
    await parseAndRun(["agents", "eject", "implementer", "--dir", dir, "--quiet"])
    expect(await readFile(prompt, "utf8")).toBe("# Mine\n")

    await parseAndRun(["agents", "eject", "implementer", "--dir", dir, "--force", "--quiet"])
    expect(await readFile(prompt, "utf8")).toContain("# Implementer")
  })
})

describe("feature toggles", () => {
  test("a launcher-first session reopens the launcher after each destination and ends on quit or interrupt", async () => {
    const outcomes: Array<"quit" | "continue"> = ["continue", "continue", "quit", "continue"]
    let opened = 0
    await runRootLauncherLoop(async () => {
      opened++
      return outcomes.shift()!
    }, () => false)
    expect(opened).toBe(3)

    let interrupted = false
    opened = 0
    await runRootLauncherLoop(async () => {
      opened++
      interrupted = true
      return "continue"
    }, () => interrupted)
    expect(opened).toBe(1)
  })

  test("spec-tool commands refuse in a project that turned specs off", async () => {
    const repo = await mkdtemp(join(tmpdir(), "convoy-specs-off-"))
    try {
      await mkdir(join(repo, ".convoy"), { recursive: true })
      await writeFile(join(repo, ".convoy", "config.yaml"), "features:\n  specs: false\n")
      for (const command of ["specs", "spin"]) {
        const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), command], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
        const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
        expect(code).toBe(1)
        expect(stderr).toContain(`convoy ${command} needs specs, which this project turned off (features.specs: false)`)
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
