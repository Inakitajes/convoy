import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"

import { parseAndRun, parseArgs, parseCommand, resolveRunOptions } from "../src/cli"
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

// `convoy runs --json` and `convoy runs stats` read the history under
// CONVOY_HOME (relocated by beforeEach) and print to stdout without opening
// the runs browser, so the dispatch is observable headlessly.
describe("parseAndRun run history outputs", () => {
  async function writeRun(runID: string, metadata: Omit<RunMetadata, "runID" | "control" | "updatedAt">): Promise<void> {
    const dir = join(process.env.CONVOY_HOME!, ".convoy", "runs", runID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "prd.md"), `# ${runID}\n`)
    await writeFile(join(dir, "metadata.json"), JSON.stringify({ ...metadata, runID, updatedAt: metadata.createdAt, control: { state: "running" } }))
  }

  async function captureStdout(run: () => Promise<void>): Promise<string> {
    const chunks: string[] = []
    const original = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await run()
    } finally {
      process.stdout.write = original
    }
    return chunks.join("")
  }

  const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 100, cacheWrite: 0, total: 115 }

  beforeEach(async () => {
    await writeRun("20260910-090000-old1", {
      schemaVersion: 3,
      targetDir: "/tmp/repo",
      createdAt: new Date(2026, 8, 10, 9).getTime(),
      pipeline: { name: "review", steps: [] },
      phases: { reviewer: { status: "failed", cost: 0.5, model: "gpt", tokens, durationMs: 1_000 } },
    })
    await writeRun("20260912-090000-new1", {
      schemaVersion: 3,
      targetDir: "/tmp/repo",
      createdAt: new Date(2026, 8, 12, 9).getTime(),
      pipeline: { name: "implement", steps: [] },
      phases: { implementer: { status: "completed", cost: 0, model: "gpt", tokens, durationMs: 263_135 } },
    })
  })

  test("runs --json prints durable records newest first and honors the filters", async () => {
    const all = JSON.parse(await captureStdout(() => parseAndRun(["runs", "--json"])))
    expect(all.map((entry: { runID: string }) => entry.runID)).toEqual(["20260912-090000-new1", "20260910-090000-old1"])
    expect(all[0]).toMatchObject({ pipeline: "implement", statusKind: "completed", cost: 0, phases: [{ name: "implementer", status: "completed", cost: 0, tokens, model: "gpt" }] })
    expect(all[0]).not.toHaveProperty("live")
    expect(all[0]).not.toHaveProperty("dir")

    const filtered = JSON.parse(await captureStdout(() => parseAndRun(["runs", "--json", "--pipeline", "review", "--since", "2026-09-10"])))
    expect(filtered.map((entry: { runID: string }) => entry.runID)).toEqual(["20260910-090000-old1"])
    expect(JSON.parse(await captureStdout(() => parseAndRun(["runs", "--json", "--since", "2026-09-13"])))).toEqual([])
  })

  test("runs stats prints a table with a total row, or raw rows as JSON", async () => {
    const table = await captureStdout(() => parseAndRun(["runs", "stats"]))
    expect(table).toMatch(/^pipeline\s+\| runs \| phases \| ok \| failed \| tokens/)
    expect(table).toMatch(/^implement\s+\|\s+1\s+\|\s+1\s+\|\s+1\s+\|\s+0\s+\|\s+115\s+\|\s+100\s+\|\s+\$0\.0000\s+\|\s+\$0\.0000\s+\|\s+4m23s$/m)
    expect(table).toMatch(/^total\s+\|\s+2\s+\|\s+2\s+\|\s+1\s+\|\s+1\s+\|\s+230\s+\|\s+200\s+\|\s+\$0\.5000\s+\|\s+\$0\.0000\s+\|\s+4m24s$/m)

    const rows = JSON.parse(await captureStdout(() => parseAndRun(["runs", "stats", "--group-by", "model", "--json"])))
    expect(rows).toEqual([{ key: "gpt", runs: 2, phases: 2, completed: 1, failed: 1, tokens: { ...tokens, input: 20, output: 10, cacheRead: 200, total: 230 }, cost: 0.5, advisorCost: 0, durationMs: 264_135 }])
  })
})
