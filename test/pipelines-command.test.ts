import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parsePipelineFile } from "../src/config"
import { listPipelineViews, parsePipelinesArgs, renderPipelineList, renderPipelineView, runPipelinesCommand, showPipelineView } from "../src/pipelines-command"

async function withRepo<T>(config: string | undefined, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-pipelines-"))
  try {
    if (config !== undefined) {
      await mkdir(join(dir, ".convoy"), { recursive: true })
      await writeFile(join(dir, ".convoy", "config.yaml"), config)
    }
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("parsePipelineFile", () => {
  test("names the pipeline after the file unless it sets a name", () => {
    expect(parsePipelineFile("steps: [implementer]\n", "x.yaml", "My-Audit")).toEqual({ name: "my-audit", spec: { steps: ["implementer"] } })
    expect(parsePipelineFile("name: payments\ndescription: d\nsteps: [implementer]\n", "x.yaml", "file").name).toBe("payments")
  })

  test("validates like a config pipeline", () => {
    expect(() => parsePipelineFile("description: nothing to run\n", "x.yaml", "p")).toThrow("x.yaml: pipelines.p.steps must be a non-empty list of steps")
    expect(() => parsePipelineFile("steps:\n  - parallel:\n      - parallel: [a]\n", "x.yaml", "p")).toThrow("parallel blocks can't be nested")
    expect(() => parsePipelineFile("steps: [implementer\n", "x.yaml", "p")).toThrow("invalid YAML")
    expect(() => parsePipelineFile("- implementer\n", "x.yaml", "p")).toThrow("must be a mapping")
  })

  test("refuses unsafe and reserved names and legacy goal keys", () => {
    expect(() => parsePipelineFile("name: a b\nsteps: [implementer]\n", "x.yaml", "p")).toThrow("filesystem-safe")
    expect(() => parsePipelineFile("name: goal-fix\nsteps: [implementer]\n", "x.yaml", "p")).toThrow("reserved")
    expect(() => parsePipelineFile("goal: 90\nsteps: [implementer]\n", "x.yaml", "p")).toThrow("legacy goal configuration")
  })
})

describe("pipeline catalog", () => {
  test("lists built-ins with their source, what they change, and the default", async () => {
    await withRepo(undefined, async (dir) => {
      const { pipelines, agents } = await listPipelineViews(dir)
      const byName = new Map(pipelines.map((view) => [view.name, view]))
      expect(byName.get("review")).toMatchObject({ source: "built-in", writesCode: false, default: false, runners: ["opencode"] })
      expect(byName.get("full-cycle")).toMatchObject({ source: "built-in", writesCode: true, default: true, goal: { target: 90 } })
      expect(byName.get("claude-review")?.runners).toEqual(["claude-code"])
      expect(agents.find((agent) => agent.name === "bug-auditor")).toMatchObject({ readOnly: true, builtIn: true })
    })
  })

  test("a project pipeline is listed as project and can become the default", async () => {
    const config = "version: 1\ndefaults:\n  pipeline: quick\npipelines:\n  quick:\n    description: Just implement\n    steps: [implementer]\n  review:\n    steps: [bug-auditor]\n"
    await withRepo(config, async (dir) => {
      const { pipelines } = await listPipelineViews(dir)
      const byName = new Map(pipelines.map((view) => [view.name, view]))
      expect(byName.get("quick")).toMatchObject({ source: "project", default: true, description: "Just implement" })
      expect(byName.get("full-cycle")?.default).toBe(false)
      // A project pipeline shadows the built-in of the same name.
      expect(byName.get("review")).toMatchObject({ source: "project", steps: [{ agent: "bug-auditor", readOnly: true }] })
    })
  })

  test("show resolves steps, parallel groups, and the goal loop", async () => {
    await withRepo(undefined, async (dir) => {
      const view = await showPipelineView(dir, { name: "review" })
      const scope = view.steps.find((step) => step.name === "scope")
      expect(scope).toMatchObject({ agent: "review-scope", readOnly: true, verify: true, runner: "opencode" })
      const audits = view.steps.filter((step) => step.agent === "bug-auditor")
      expect(audits.length).toBe(2)
      expect(new Set(audits.map((step) => step.group)).size).toBe(1)

      const text = renderPipelineView(await showPipelineView(dir, { name: "full-cycle" }))
      expect(text).toContain("pipeline full-cycle (built-in, default) · writes code")
      expect(text).toContain("goal: reach 90/100")
      expect(text).toContain("  improve:\n    1. fix · goal-fixer")
    })
  })

  test("show describes a pipeline file and rejects unknown names", async () => {
    await withRepo(undefined, async (dir) => {
      const file = join(dir, "audit.yaml")
      await writeFile(file, "steps:\n  - agent: bug-auditor\n    runner: claude-code\n    models: [opus, sonnet]\n")
      const view = await showPipelineView(dir, { pipelineFile: file })
      expect(view).toMatchObject({ name: "audit", source: "file", writesCode: false, runners: ["claude-code"] })
      expect(view.steps.map((step) => step.model)).toEqual(["opus", "sonnet"])
      await expect(showPipelineView(dir, { name: "nope" })).rejects.toThrow('unknown pipeline "nope"')
    })
  })

  test("a fan-out across runners keeps each member's runner", async () => {
    await withRepo(undefined, async (dir) => {
      const file = join(dir, "cross.yaml")
      await writeFile(file, "steps:\n  - agent: bug-auditor\n    runner: codex\n    models:\n      - openai/gpt-5.5#high\n      - { runner: claude-code, model: anthropic/sonnet }\n      - { runner: opencode, model: openai/gpt-5.5 }\n")
      const view = await showPipelineView(dir, { pipelineFile: file })
      expect(view.steps.map((step) => step.runner)).toEqual(["codex", "claude-code", "opencode"])
      expect(view.runners).toEqual(["claude-code", "codex", "opencode"])
      expect(renderPipelineView(view)).toContain("· read-only · claude-code + codex + opencode")
      const { agents } = await listPipelineViews(dir)
      expect(renderPipelineList([{ ...view, default: false }], agents)).toMatch(/cross\s+file · read-only · uses claude-code \+ codex/)
    })
  })

  test("the list text names every pipeline and the agents to compose with", async () => {
    await withRepo(undefined, async (dir) => {
      const { pipelines, agents } = await listPipelineViews(dir)
      const text = renderPipelineList(pipelines, agents)
      expect(text).toMatch(/full-cycle\s+built-in · writes code · goal 90 · default/)
      expect(text).toMatch(/claude-review\s+built-in · read-only · claude-code only/)
      expect(text).toMatch(/bug-auditor\s+read-only · Audit-only reviewer/)
    })
  })

  test("--json prints the catalog as data", async () => {
    await withRepo(undefined, async (dir) => {
      const output: string[] = []
      await runPipelinesCommand({ type: "pipelines", targetDir: dir, json: true }, (text) => output.push(text))
      const parsed = JSON.parse(output.join("")) as { pipelines: { name: string }[]; agents: unknown[] }
      expect(parsed.pipelines.map((view) => view.name)).toContain("review")
      expect(parsed.agents.length).toBeGreaterThan(0)
    })
  })
})

describe("parsePipelinesArgs", () => {
  test("list, show, and show --pipeline-file", () => {
    expect(parsePipelinesArgs([])).toMatchObject({ type: "pipelines", json: false })
    expect(parsePipelinesArgs(["--json"])).toMatchObject({ type: "pipelines", json: true })
    expect(parsePipelinesArgs(["show", "review", "--json"])).toMatchObject({ type: "pipelines", name: "review", json: true })
    expect(parsePipelinesArgs(["show", "--pipeline-file", "p.yaml"])).toMatchObject({ type: "pipelines", pipelineFile: "p.yaml" })
    expect(parsePipelinesArgs(["--help"])).toMatchObject({ type: "help" })
  })

  test("refuses malformed invocations", () => {
    expect(() => parsePipelinesArgs(["show"])).toThrow("usage: convoy pipelines show <name>")
    expect(() => parsePipelinesArgs(["show", "review", "--pipeline-file", "p.yaml"])).toThrow("usage: convoy pipelines show <name>")
    expect(() => parsePipelinesArgs(["--pipeline-file", "p.yaml"])).toThrow("usage: convoy pipelines show --pipeline-file")
    expect(() => parsePipelinesArgs(["list"])).toThrow("usage: convoy pipelines")
    expect(() => parsePipelinesArgs(["--verbose"])).toThrow("unknown flag: --verbose")
    expect(() => parsePipelinesArgs(["--dir"])).toThrow("--dir requires a value")
  })
})
