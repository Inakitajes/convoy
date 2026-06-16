import "./env"

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { builtInAgents } from "../src/pipeline"
import {
  buildAgentRegistry,
  loadArcherConfig,
  parseArcherConfig,
  selectPipelineSpec,
  writeDefaultArcherConfig,
  writeDefaultProjectConfig,
  ConfigError,
} from "../src/config"

const dirs: string[] = []

async function projectDir(config?: string, agentPrompts: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "archer-config-"))
  dirs.push(dir)
  await mkdir(join(dir, ".archer", "agents"), { recursive: true })
  if (config !== undefined) await writeFile(join(dir, ".archer", "config.yaml"), config)
  for (const agent of agentPrompts) {
    await writeFile(join(dir, ".archer", "agents", `${agent}.md`), `# ${agent}\n\nProject prompt.`)
  }
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const parse = (body: string, targetDir = "/tmp/non-existent-archer-target") => parseArcherConfig(body, ".archer/config.yaml", targetDir)

describe("config loading", () => {
  test("no config file means no config", async () => {
    const dir = await projectDir()
    expect(await loadArcherConfig(dir)).toBeUndefined()
  })

  test("the default config template is valid and explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-default-config-"))
    dirs.push(dir)
    const path = join(dir, "config.yaml")
    await writeDefaultArcherConfig(path)

    const body = await readFile(path, "utf8")
    const config = parseArcherConfig(body, path, dir)

    expect(body).toContain("# maxAttempts: 2")
    expect(body).toContain("# baseRef: main")
    expect(body).toContain("# pipeline: default")
    expect(body).toContain("# interactiveModel: openai/gpt-5.5#xhigh")
    expect(body).toContain("# appRunCommand: pnpm dev")
    expect(body).toContain("# agents:")
    expect(body).toContain("#   implementer:")
    expect(body).toContain("#   design-polisher:")
    expect(body).toContain("#   api-reviewer:")
    expect(config.defaults).toEqual({})
    expect(config.agents).toEqual({})
    for (const agent of builtInAgents) {
      expect(await readFile(join(dir, "agents", `${agent.name}.md`), "utf8")).toContain("#")
    }
    expect(config.pipelines.default?.steps).toEqual([
      { agent: "implementer", reports: "none" },
      "human-review",
      "patterns",
      "security",
      "design",
      { agent: "tests", reports: "none" },
      { agent: "adversarial", reports: "all" },
    ])
    expect(config.permissions).toEqual({ allow: [], deny: [] })
    expect(config.attachments).toEqual([])
  })

  test("an empty file is a valid, empty config", () => {
    const config = parse("")
    expect(config.defaults).toEqual({})
    expect(config.pipelines).toEqual({})
    expect(config.permissions).toEqual({ allow: [], deny: [] })
  })

  test("parses a full project config", async () => {
    const dir = await projectDir(undefined, ["api-reviewer"])
    const config = parse(
      [
        "version: 1",
        "defaults:",
        "  model: openai/gpt-5.5#xhigh",
        "  maxAttempts: 3",
        "  baseRef: develop",
        "  pipeline: quick",
        "agents:",
        "  api-reviewer:",
        "    description: Reviews API consistency",
        "    model: anthropic/claude-opus-4-7",
        "    temperature: 0.1",
        "pipelines:",
        "  quick:",
        "    description: Implementation plus tests",
        "    steps:",
        "      - implementer",
        "      - human-review",
        "      - agent: tests",
        "        maxAttempts: 3",
        "      - agent: api-reviewer",
        "        reports: all",
        "permissions:",
        "  allow:",
        '    - "supabase gen types*"',
        "  deny:",
        '    - "stripe *"',
        "attachments:",
        "  - docs/architecture.md",
      ].join("\n"),
      dir,
    )

    expect(config.defaults).toEqual({ model: "openai/gpt-5.5#xhigh", maxAttempts: 3, baseRef: "develop", pipeline: "quick" })
    expect(config.agents["api-reviewer"]).toEqual({
      description: "Reviews API consistency",
      model: "anthropic/claude-opus-4-7",
      temperature: 0.1,
    })
    expect(config.pipelines.quick?.steps).toEqual([
      "implementer",
      "human-review",
      { agent: "tests", maxAttempts: 3 },
      { agent: "api-reviewer", reports: "all" },
    ])
    expect(config.permissions).toEqual({ allow: ["supabase gen types*"], deny: ["stripe *"] })
    expect(config.attachments).toEqual(["docs/architecture.md"])
  })

  test("loads global config before project overrides", async () => {
    const previousHome = process.env.ARCHER_HOME
    const home = await mkdtemp(join(tmpdir(), "archer-config-home-"))
    dirs.push(home)
    process.env.ARCHER_HOME = home

    try {
      await writeFile(
        join(home, "config.yaml"),
        [
          "defaults:",
          "  maxAttempts: 4",
          "  baseRef: trunk",
          "  pipeline: global-only",
          "pipelines:",
          "  global-only:",
          "    steps:",
          "      - implementer",
          "permissions:",
          "  allow:",
          '    - "global-check *"',
          "attachments:",
          "  - global.md",
        ].join("\n"),
      )
      const dir = await projectDir(
        [
          "defaults:",
          "  maxAttempts: 1",
          "  pipeline: quick",
          "pipelines:",
          "  quick:",
          "    steps:",
          "      - tests",
          "permissions:",
          "  deny:",
          '    - "local-danger *"',
          "attachments:",
          "  - local.md",
        ].join("\n"),
      )

      const config = await loadArcherConfig(dir)

      expect(config?.defaults).toEqual({ maxAttempts: 1, baseRef: "trunk", pipeline: "quick" })
      expect(config?.permissions).toEqual({ allow: ["global-check *"], deny: ["local-danger *"] })
      expect(config?.attachments).toEqual(["global.md", "local.md"])
      expect(selectPipelineSpec(config, "global-only").steps).toEqual(["implementer"])
      expect(selectPipelineSpec(config, "quick").steps).toEqual(["tests"])
    } finally {
      if (previousHome === undefined) delete process.env.ARCHER_HOME
      else process.env.ARCHER_HOME = previousHome
    }
  })

  test("writes default config without overwriting unless forced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-config-write-"))
    dirs.push(dir)
    const path = join(dir, "config.yaml")

    expect(await writeDefaultArcherConfig(path)).toEqual({ path, created: true })
    expect(await readFile(path, "utf8")).toContain("version: 1")
    expect(await readFile(join(dir, "agents", "implementer.md"), "utf8")).toContain("# Implementer")

    await writeFile(path, "version: 1\nattachments:\n  - custom.md\n")
    await writeFile(join(dir, "agents", "implementer.md"), "# Custom Implementer\n")
    expect(await writeDefaultArcherConfig(path)).toEqual({ path, created: false })
    expect(await readFile(path, "utf8")).toContain("custom.md")
    expect(await readFile(join(dir, "agents", "implementer.md"), "utf8")).toContain("# Custom Implementer")

    expect(await writeDefaultArcherConfig(path, true)).toEqual({ path, created: true })
    expect(await readFile(path, "utf8")).not.toContain("custom.md")
    expect(await readFile(join(dir, "agents", "implementer.md"), "utf8")).toContain("# Implementer")
  })

  test("writes project default config under .archer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-project-config-"))
    dirs.push(dir)
    const path = join(dir, ".archer", "config.yaml")

    expect(await writeDefaultProjectConfig(dir)).toEqual({ path, created: true })
    expect(await writeDefaultProjectConfig(dir)).toEqual({ path, created: false })
    expect(await readFile(path, "utf8")).toContain("pipelines:")
    expect(await readFile(join(dir, ".archer", "agents", "implementer.md"), "utf8")).toContain("# Implementer")
  })

  test("rejects configs with errors that point at the offending field", async () => {
    expect(() => parse("version: 2")).toThrow("version")
    expect(() => parse("defaults:\n  maxAttempts: 0")).toThrow("defaults.maxAttempts must be a positive integer")
    expect(() => parse("defaults:\n  model: gpt-5.5")).toThrow("defaults.model must look like provider/model")
    expect(() => parse("pipelines:\n  broken:\n    steps: []")).toThrow("pipelines.broken.steps must be a non-empty list")
    expect(() => parse("pipelines:\n  broken:\n    steps:\n      - agent: tests\n        reports: previous-two")).toThrow(
      'pipelines.broken.steps[0].reports must be "previous", "all", "none", or a list',
    )
    expect(() => parse("not yaml: [unclosed")).toThrow("invalid YAML")
  })

  test("a repo cannot grant itself yolo", () => {
    expect(() => parse("permissions:\n  yolo: true")).toThrow("--yolo is per-invocation only")
  })

  test("project agents must bring a prompt file", async () => {
    const without = await projectDir()
    expect(() => parse("agents:\n  ghost: {}", without)).toThrow("needs a prompt at agents/ghost.md next to the config")

    const withPrompt = await projectDir(undefined, ["ghost"])
    expect(() => parse("agents:\n  ghost: {}", withPrompt)).not.toThrow()
  })

  test("global project agents use same-name prompts next to global config", async () => {
    const previousHome = process.env.ARCHER_HOME
    const home = await mkdtemp(join(tmpdir(), "archer-global-custom-agent-"))
    const target = await projectDir()
    dirs.push(home)
    process.env.ARCHER_HOME = home

    try {
      await mkdir(join(home, "agents"), { recursive: true })
      await writeFile(join(home, "config.yaml"), "agents:\n  ghost: {}")
      await writeFile(join(home, "agents", "ghost.md"), "# Ghost\n\nGlobal prompt.")

      const config = await loadArcherConfig(target)

      expect(config?.agents.ghost).toEqual({})
    } finally {
      if (previousHome === undefined) delete process.env.ARCHER_HOME
      else process.env.ARCHER_HOME = previousHome
    }
  })

  test("built-in overrides don't need a prompt, aliases and reserved names are rejected", async () => {
    const dir = await projectDir()
    expect(() => parse("agents:\n  design-polisher:\n    model: openai/gpt-5.5", dir)).not.toThrow()
    expect(() => parse("agents:\n  design:\n    model: openai/gpt-5.5", dir)).toThrow('alias of the built-in agent "design-polisher"')
    expect(() => parse("agents:\n  human-review: {}", dir)).toThrow("reserved step keyword")
  })
})

describe("agent registry", () => {
  test("merges built-in overrides and appends project agents", async () => {
    const dir = await projectDir(undefined, ["api-reviewer"])
    const config = parse(
      ["agents:", "  design-polisher:", "    model: openai/gpt-5.5#xhigh", "    temperature: 0.5", "  api-reviewer:", "    description: Reviews APIs"].join("\n"),
      dir,
    )

    const registry = buildAgentRegistry(config)
    const design = registry.find((agent) => agent.name === "design-polisher")
    expect(design).toMatchObject({ model: "openai/gpt-5.5#xhigh", temperature: 0.5, builtIn: true })
    // The built-in preference survives underneath the override.
    expect(design?.defaultModel).toBe("anthropic/claude-opus-4-7")

    const custom = registry.find((agent) => agent.name === "api-reviewer")
    expect(custom).toMatchObject({ description: "Reviews APIs", builtIn: false })
  })

  test("without config the registry is exactly the built-ins", () => {
    expect(buildAgentRegistry(undefined).map((agent) => agent.name)).toEqual([
      "implementer",
      "pattern-auditor",
      "security-auditor",
      "design-polisher",
      "test-engineer",
      "adversarial-reviewer",
    ])
  })
})

describe("pipeline selection", () => {
  test("project pipelines shadow built-ins; unknown names list what exists", async () => {
    const dir = await projectDir()
    const config = parse("pipelines:\n  quick:\n    steps:\n      - implementer\n  default:\n    steps:\n      - tests", dir)

    expect(selectPipelineSpec(config, "quick").steps).toEqual(["implementer"])
    expect(selectPipelineSpec(config, "default").steps).toEqual(["tests"])
    expect(selectPipelineSpec(undefined, "default").steps.length).toBeGreaterThan(1)
    expect(() => selectPipelineSpec(config, "ghost")).toThrow('unknown pipeline "ghost" (available: default, quick)')
    expect(() => selectPipelineSpec(config, "ghost")).toThrow(ConfigError)
  })
})
