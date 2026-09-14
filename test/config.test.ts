import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"

import { modelGateways } from "../src/model-routing"
import {
  buildAgentRegistry,
  checkPipelineResolves,
  ConfigError,
  defaultConfigTemplate,
  defaultConvoyConfig,
  ejectAgentPrompt,
  isValidModelString,
  loadConvoyConfig,
  loadGlobalConvoyConfig,
  loadMergedConvoyConfig,
  materializePipelineSpec,
  mergeConvoyConfigs,
  parseConvoyConfig,
  selectPipelineSpec,
  serializeConvoyConfig,
  writeConvoyConfig,
  writeDefaultConvoyConfig,
  writeDefaultProjectConfig,
} from "../src/config"
import { loadAgentPrompt } from "../src/agents"
import {
  builtInAgents,
  builtInPipelines,
  defaultAdversarialModel,
  defaultGptModel,
  defaultGptVariant,
  defaultImplementAuditModel,
  defaultImplementAdvisorModel,
  defaultImplementerModel,
  defaultImplementReviewModel,
  defaultRunReportModel,
  defaultOpusModel,
  isHumanStepSpec,
  isGoalStepSpec,
  isParallelSpec,
  resolvePipeline,
} from "../src/pipeline"
import type { PipelineSpec } from "../src/pipeline"

const dirs: string[] = []

async function projectDir(config?: string, agentPrompts: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "convoy-config-"))
  dirs.push(dir)
  await mkdir(join(dir, ".convoy", "agents"), { recursive: true })
  if (config !== undefined) await writeFile(join(dir, ".convoy", "config.yaml"), config)
  for (const agent of agentPrompts) {
    await writeFile(join(dir, ".convoy", "agents", `${agent}.md`), `# ${agent}\n\nProject prompt.`)
  }
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const parse = (body: string, targetDir = "/tmp/non-existent-convoy-target") => parseConvoyConfig(body, ".convoy/config.yaml", targetDir)

describe("config loading", () => {
  test("no config file means no config", async () => {
    const dir = await projectDir()
    expect(await loadConvoyConfig(dir)).toBeUndefined()
  })

  test("an empty file is a valid, empty config", () => {
    const config = parse("")
    expect(config.defaults).toEqual({})
    expect(config.pipelines).toEqual({})
    expect(config.permissions).toEqual({ allow: [], deny: [] })
    expect(config.hooks).toEqual({ pre: [], post: [], pipelines: {} })
  })

  test("parses the optional PRD history default and rejects non-booleans", () => {
    expect(parse("defaults:\n  prdHistory: true").defaults.prdHistory).toBe(true)
    expect(parse("defaults:\n  prdHistory: false").defaults.prdHistory).toBe(false)
    expect(() => parse("defaults:\n  prdHistory: enabled")).toThrow("defaults.prdHistory must be true or false")
  })

  test("parses a full project config", async () => {
    const dir = await projectDir(undefined, ["api-reviewer"])
    const config = parse(
      [
        "version: 1",
        "defaults:",
        "  model: openai/gpt-5.5#xhigh",
        "  baseRef: develop",
        "  pipeline: quick",
        "  branchNameModel: anthropic/claude-haiku-4-5",
        "agents:",
        "  api-reviewer:",
        "    description: Reviews API consistency",
        "    model: anthropic/claude-opus-4-7",
        "    temperature: 0.1",
        "    readOnly: true",
        "pipelines:",
        "  quick:",
        "    description: Implementation plus tests",
        "    steps:",
        "      - implementer",
        "      - type: human",
        "        name: planning",
        "        description: Plan implementation interactively",
        "      - agent: tests",
        "      - agent: api-reviewer",
        "        reports: all",
        "permissions:",
        "  allow:",
        '    - "supabase gen types*"',
        "  deny:",
        '    - "stripe *"',
        "hooks:",
        "  pre:",
        "    - pnpm lint",
        "  post:",
        "    - command: ./scripts/notify.sh",
        "      when: always",
        "      continueOnError: true",
        "  pipelines:",
        "    quick:",
        "      post:",
        "        - name: open-pr",
        "          command: gh pr create --fill",
        "          cwd: target",
        "          timeoutSeconds: 120",
        "attachments:",
        "  - docs/architecture.md",
      ].join("\n"),
      dir,
    )

    expect(config.defaults).toEqual({
      model: "openai/gpt-5.5#xhigh",
      baseRef: "develop",
      pipeline: "quick",
      branchNameModel: "anthropic/claude-haiku-4-5",
    })
    expect(config.agents["api-reviewer"]).toEqual({
      description: "Reviews API consistency",
      model: "anthropic/claude-opus-4-7",
      temperature: 0.1,
      readOnly: true,
    })
    expect(config.pipelines.quick?.steps).toEqual([
      "implementer",
      { type: "human", name: "planning", description: "Plan implementation interactively" },
      { agent: "tests" },
      { agent: "api-reviewer", reports: "all" },
    ])
    expect(config.permissions).toEqual({ allow: ["supabase gen types*"], deny: ["stripe *"] })
    expect(config.hooks).toEqual({
      pre: [{ command: "pnpm lint" }],
      post: [{ command: "./scripts/notify.sh", when: "always", continueOnError: true }],
      pipelines: {
        quick: {
          pre: [],
          post: [{ name: "open-pr", command: "gh pr create --fill", cwd: "target", timeoutSeconds: 120 }],
        },
      },
    })
    expect(config.attachments).toEqual(["docs/architecture.md"])
  })

  test("notifications keeps only the switches the user actually set", () => {
    // Unset keys must stay absent so they keep following the built-in default
    // rather than being pinned to whatever it was when the file was written.
    expect(parse("notifications:\n  steps: false\n  sound: Ping").notifications).toEqual({ steps: false, sound: "Ping" })
    expect(parse("notifications: {}").notifications).toEqual({})
    expect(parse("defaults: {}").notifications).toEqual({})
  })

  test("notifications accepts every switch", () => {
    const config = parse(
      ["notifications:", "  enabled: true", "  steps: false", "  waiting: true", "  failures: false", "  finish: true", "  terminalTitle: false", '  sound: ""'].join(
        "\n",
      ),
    )
    expect(config.notifications).toEqual({
      enabled: true,
      steps: false,
      waiting: true,
      failures: false,
      finish: true,
      terminalTitle: false,
      sound: "",
    })
  })

  test("a project config's notifications override the global one key by key", () => {
    const global = parse("notifications:\n  enabled: false\n  sound: Ping")
    const project = parse("notifications:\n  enabled: true")
    expect(mergeConvoyConfigs(global, project)!.notifications).toEqual({ enabled: true, sound: "Ping" })
  })

  test("rejects invalid notification values", () => {
    expect(() => parse("notifications:\n  enabled: sometimes")).toThrow("notifications.enabled must be true or false")
    expect(() => parse("notifications:\n  sound: 42")).toThrow("notifications.sound must be a string")
    // The name reaches AppleScript, so anything exotic fails at load time.
    expect(() => parse('notifications:\n  sound: \'Ping" evil\'')).toThrow("notifications.sound must be a macOS sound name")
  })

  test("rejects configs with errors that point at the offending field", async () => {
    expect(() => parse("version: 2")).toThrow("version")
    expect(() => parse("defaults:\n  maxConcurrentAgents: 0")).toThrow("defaults.maxConcurrentAgents must be a positive integer")
    expect(() => parse("defaults:\n  model: gpt-5.5")).toThrow("defaults.model must look like provider/model")
    expect(() => parse("agents:\n  implementer:\n    readOnly: sometimes")).toThrow("agents.implementer.readOnly must be true or false")
    expect(() => parse("pipelines:\n  broken:\n    steps: []")).toThrow("pipelines.broken.steps must be a non-empty list")
    expect(() => parse("pipelines:\n  broken:\n    steps:\n      - agent: tests\n        reports: previous-two")).toThrow(
      'pipelines.broken.steps[0].reports must be "previous", "all", "none", or a list',
    )
    expect(() => parse("hooks:\n  pre: ./scripts/pre.sh")).toThrow("hooks.pre must be a list")
    expect(() => parse("hooks:\n  post:\n    - command: ./scripts/post.sh\n      when: sometimes")).toThrow('hooks.post[0].when must be "success", "failure", or "always"')
    expect(() => parse("hooks:\n  pre:\n    - command: ./scripts/pre.sh\n      timeoutSeconds: 0")).toThrow("hooks.pre[0].timeoutSeconds must be a positive integer")
    expect(() => parse("not yaml: [unclosed")).toThrow("invalid YAML")
  })

  test("a legacy maxAttempts key is accepted but ignored, not a validation error", () => {
    // A config that still sets the removed maxAttempts (in defaults and on a
    // step) must parse without error: the key stays in the allowlist so an old
    // ~/.convoy/config.yaml doesn't break, but the value is dropped entirely.
    const config = parse(
      [
        "version: 1",
        "defaults:",
        "  model: openai/gpt-5.5",
        "  maxAttempts: 5",
        "pipelines:",
        "  impl:",
        "    steps:",
        "      - agent: tests",
        "        maxAttempts: 3",
      ].join("\n"),
    )

    expect(config.defaults).toEqual({ model: "openai/gpt-5.5" })
    expect(config.defaults).not.toHaveProperty("maxAttempts")
    expect(config.pipelines.impl?.steps).toEqual([{ agent: "tests" }])
  })

  test("rejects step names that can escape the reports directory", () => {
    expect(() =>
      parse("pipelines:\n  audit:\n    steps:\n      - agent: security\n        name: ../../../../tmp/owned"),
    ).toThrow("must be a filesystem-safe identifier")
  })

  test("rejects agent names that can escape the prompts directory", () => {
    expect(() => parse('agents:\n  "../../../../tmp/owned": {}')).toThrow("must be a filesystem-safe identifier")
  })

  test("applies filesystem-safe names to human steps too", () => {
    expect(() => parse("pipelines:\n  audit:\n    steps:\n      - type: human\n        name: ../../../../tmp/owned")).toThrow(
      "must be a filesystem-safe identifier",
    )
  })

  test("a repo cannot grant itself yolo", () => {
    expect(() => parse("permissions:\n  yolo: true")).toThrow("--yolo is per-invocation only")
  })

  test("project agents must bring a prompt file", async () => {
    const without = await projectDir()
    expect(() => parse("agents:\n  ghost: {}", without)).toThrow("needs a prompt at .convoy/agents/ghost.md")

    const withPrompt = await projectDir(undefined, ["ghost"])
    expect(() => parse("agents:\n  ghost: {}", withPrompt)).not.toThrow()
  })

  test("built-in overrides don't need a prompt, aliases and reserved names are rejected", async () => {
    const dir = await projectDir()
    expect(() => parse("agents:\n  design-polisher:\n    model: openai/gpt-5.5", dir)).not.toThrow()
    expect(() => parse("agents:\n  design:\n    model: openai/gpt-5.5", dir)).toThrow('alias of the built-in agent "design-polisher"')
    expect(() => parse("agents:\n  human-review: {}", dir)).toThrow("reserved step keyword")
  })
})

describe("parallel steps and model fan-out", () => {
  test("parses a parallel block with a models fan-out member", async () => {
    const dir = await projectDir(undefined, ["clean-code"])
    const config = parse(
      [
        "pipelines:",
        "  audit:",
        "    steps:",
        "      - implementer",
        "      - parallel:",
        "          - patterns",
        "          - security",
        "          - agent: clean-code",
        "            models:",
        "              - anthropic/claude-opus-4-7",
        "              - openai/gpt-5.5#xhigh",
        "      - agent: adversarial",
        "        name: triage",
        "        reports: all",
      ].join("\n"),
      dir,
    )

    expect(config.pipelines.audit?.steps).toEqual([
      "implementer",
      {
        parallel: [
          "patterns",
          "security",
          { agent: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] },
        ],
      },
      { agent: "adversarial", name: "triage", reports: "all" },
    ])
  })

  test("rejects nested parallel blocks", () => {
    expect(() =>
      parse("pipelines:\n  p:\n    steps:\n      - implementer\n      - parallel:\n          - parallel:\n              - patterns"),
    ).toThrow("nested")
  })

  test("rejects human steps inside a parallel block", () => {
    expect(() => parse("pipelines:\n  p:\n    steps:\n      - implementer\n      - parallel:\n          - patterns\n          - human-review")).toThrow(
      "can't run inside a parallel block",
    )
    expect(() =>
      parse("pipelines:\n  p:\n    steps:\n      - implementer\n      - parallel:\n          - patterns\n          - agent: human-review"),
    ).toThrow("can't run inside a parallel block")
    expect(() =>
      parse("pipelines:\n  p:\n    steps:\n      - implementer\n      - parallel:\n          - patterns\n          - type: human\n            name: planning"),
    ).toThrow("human steps can't run inside a parallel block")
  })

  test("parses generic human steps", () => {
    const config = parse(
      "pipelines:\n  p:\n    steps:\n      - type: human\n        name: planning\n        description: Plan interactively\n      - implementer",
    )
    expect(config.pipelines.p?.steps).toEqual([{ type: "human", name: "planning", description: "Plan interactively" }, "implementer"])
    expect(() => parse("pipelines:\n  p:\n    steps:\n      - type: robot\n      - implementer")).toThrow('type must be "human"')
  })

  test("parses verify on a step, not on the agent", () => {
    const config = parse(
      "pipelines:\n  p:\n    steps:\n      - agent: review-scope\n        name: scope\n        verify: true\n      - agent: review-report\n        name: report",
    )
    expect(config.pipelines.p?.steps).toEqual([
      { agent: "review-scope", name: "scope", verify: true },
      { agent: "review-report", name: "report" },
    ])
  })

  test("parses PRD history on a step and rejects non-booleans", () => {
    expect(parse("pipelines:\n  p:\n    steps:\n      - agent: review-scope\n        prdHistory: true").pipelines.p?.steps).toEqual([
      { agent: "review-scope", prdHistory: true },
    ])
    expect(() => parse("pipelines:\n  p:\n    steps:\n      - agent: review-scope\n        prdHistory: yes")).toThrow(
      "prdHistory must be true or false",
    )
  })

  test("rejects an empty parallel block", () => {
    expect(() => parse("pipelines:\n  p:\n    steps:\n      - implementer\n      - parallel: []")).toThrow("must be a non-empty list of steps")
  })

  test("rejects models with fewer than 2 entries", () => {
    expect(() =>
      parse("pipelines:\n  p:\n    steps:\n      - agent: implementer\n        models:\n          - anthropic/claude-opus-4-7"),
    ).toThrow("at least 2 entries")
  })

  test("rejects setting both model and models", () => {
    expect(() =>
      parse(
        [
          "pipelines:",
          "  p:",
          "    steps:",
          "      - agent: implementer",
          "        model: anthropic/claude-opus-4-7",
          "        models:",
          "          - anthropic/claude-opus-4-7",
          "          - openai/gpt-5.5#xhigh",
        ].join("\n"),
      ),
    ).toThrow('set either "model" or "models"')
  })

  test("rejects agent names ending in the reserved read-only suffix", () => {
    expect(() => parse("agents:\n  clean-code__ro:\n    model: anthropic/claude-opus-4-7")).toThrow('reserved for convoy\'s forced-read-only variants')
  })

  test("rejects agent names ending in the reserved verifying-step suffix", () => {
    expect(() => parse("agents:\n  review-scope__verify:\n    model: anthropic/claude-opus-4-7")).toThrow('reserved for convoy\'s verifying-step variants')
  })

  test("a config with parallel/models round-trips through serialize + reparse", async () => {
    const dir = await projectDir(undefined, ["clean-code"])
    const config = parse(
      [
        "pipelines:",
        "  audit:",
        "    steps:",
        "      - implementer",
        "      - parallel:",
        "          - patterns",
        "          - agent: clean-code",
        "            models:",
        "              - anthropic/claude-opus-4-7",
        "              - openai/gpt-5.5#xhigh",
      ].join("\n"),
      dir,
    )

    const path = join(dir, ".convoy", "config.yaml")
    await writeConvoyConfig(path, config, dir)
    const reparsed = parse(await readFile(path, "utf8"), dir)
    expect(reparsed.pipelines).toEqual(config.pipelines)
  })
})

describe("agent registry", () => {
  test("merges built-in overrides and appends project agents", async () => {
    const dir = await projectDir(undefined, ["api-reviewer"])
    const config = parse(
      [
        "agents:",
        "  design-polisher:",
        "    model: openai/gpt-5.5#xhigh",
        "    temperature: 0.5",
        "    readOnly: true",
        "  api-reviewer:",
        "    description: Reviews APIs",
        "    readOnly: true",
      ].join("\n"),
      dir,
    )

    const registry = buildAgentRegistry(config)
    const design = registry.find((agent) => agent.name === "design-polisher")
    expect(design).toMatchObject({ model: "openai/gpt-5.5#xhigh", temperature: 0.5, readOnly: true, builtIn: true })
    // The built-in preference survives underneath the override.
    expect(design?.defaultModel).toBe("openrouter/x-ai/grok-4.6#high")

    const custom = registry.find((agent) => agent.name === "api-reviewer")
    expect(custom).toMatchObject({ description: "Reviews APIs", readOnly: true, builtIn: false })
  })

  test("without config the registry is exactly the built-ins", () => {
    expect(buildAgentRegistry(undefined).map((agent) => agent.name)).toEqual([
      "implementer",
      "pattern-auditor",
      "security-auditor",
      "design-polisher",
      "test-engineer",
      "adversarial-reviewer",
      "review-scope",
      "bug-auditor",
      "clean-code-auditor",
      "security-reviewer",
      "review-adversary",
      "review-fixer",
      "review-validator",
      "review-report",
      "sync-with-base",
      "implementation-triage",
      "implementation-final-review",
      "implementation-fixer",
      "implementation-validator",
      "fixer-test-author",
      "fixer-implementer",
      "fixer-validator",
      "hunter-correctness",
      "hunter-memory",
      "hunter-performance",
      "hunter-security",
      "hunter-reliability",
      "hunter-supply-chain",
      "hunter-report",
      "hunter-max-report",
      "quality-scorer",
      "quality-score-report",
      "goal-fixer",
      "run-reporter",
    ])
  })
})

describe("pipeline selection", () => {
  test("project pipelines shadow built-ins; unknown names list what exists", async () => {
    const dir = await projectDir()
    const config = parse("pipelines:\n  quick:\n    steps:\n      - implementer\n  implement:\n    steps:\n      - tests", dir)

    expect(selectPipelineSpec(config, "quick").steps).toEqual(["implementer"])
    expect(selectPipelineSpec(config, "implement").steps).toEqual(["tests"])
    expect(selectPipelineSpec(undefined, "implement").steps.length).toBeGreaterThan(1)
    expect(() => selectPipelineSpec(config, "ghost")).toThrow(
      'unknown pipeline "ghost" (available: astra, fixer, full-cycle, hunter, hunter-max, implement, implement-lite, quick, review, review-cc, review-lite, ship)',
    )
    expect(() => selectPipelineSpec(config, "ghost")).toThrow(ConfigError)
  })

  test("parses a terminal goal step and resolves its fragments onto the pipeline", async () => {
    const dir = await projectDir()
    const config = parse(
      [
        "pipelines:",
        "  scored:",
        "    steps:",
        "      - implementer",
        "      - goal:",
        "          target: 92",
        "          maxIterations: 5",
        "          plateau: 2",
        "          improve:",
        "            briefStep: fix",
        "            steps:",
        "              - agent: goal-fixer",
        "                name: fix",
        "          measure:",
        "            steps:",
        "              - agent: quality-score-report",
        "                name: score-report",
      ].join("\n"),
      dir,
    )
    const spec = selectPipelineSpec(config, "scored")
    const node = spec.steps[1] as { goal: { target: number; maxIterations: number; plateau: number } }
    expect(node.goal).toMatchObject({ target: 92, maxIterations: 5, plateau: 2 })

    const resolved = resolvePipeline({ name: "scored", spec, agents: builtInAgents })
    expect(resolved.goalPlan).toMatchObject({ target: 92, maxIterations: 5, plateau: 2, briefRecipient: "fix", scoreProducer: "score-report" })
  })

  test("a config with a terminal goal step round-trips through serialize + reparse", async () => {
    // The config editor materializes a goal pipeline into the editable copy and
    // saves it back; that serialization must preserve the full embedded goal
    // definition so a saved goal pipeline still declares its loop.
    const dir = await projectDir()
    const config = parse(
      [
        "pipelines:",
        "  scored:",
        "    steps:",
        "      - implementer",
        "      - goal:",
        "          target: 85",
        "          maxIterations: 2",
        "          plateau: 4",
        "          improve:",
        "            briefStep: fix",
        "            steps:",
        "              - agent: goal-fixer",
        "                name: fix",
        "          measure:",
        "            steps:",
        "              - parallel:",
        "                  - quality-scorer",
        "                  - agent: quality-score-report",
        "                    name: score-report",
      ].join("\n"),
      dir,
    )

    const path = join(dir, ".convoy", "config.yaml")
    await writeConvoyConfig(path, config, dir)
    const reparsed = parse(await readFile(path, "utf8"), dir)
    expect(reparsed.pipelines).toEqual(config.pipelines)

    const before = resolvePipeline({ name: "scored", spec: selectPipelineSpec(config, "scored"), agents: builtInAgents })
    const after = resolvePipeline({ name: "scored", spec: selectPipelineSpec(reparsed, "scored"), agents: builtInAgents })
    expect(after.goalPlan).toMatchObject({
      target: 85,
      maxIterations: 2,
      plateau: 4,
      briefRecipient: "fix",
      scoreProducer: "score-report",
    })
    expect(after.goalPlan?.measure.steps).toHaveLength(2)
    expect(before.goalPlan).toEqual(after.goalPlan)
  })

  test("rejects a goal target outside 1–100", async () => {
    const dir = await projectDir()
    expect(() => parse("pipelines:\n  bad:\n    steps:\n      - goal:\n          target: 150\n          improve:\n            briefStep: fix\n            steps:\n              - implementer\n          measure:\n            steps:\n              - quality-score-report", dir)).toThrow("goal.target")
  })

  test("rejects a goal target of zero", async () => {
    // target: 0 would make the loop a no-op — any score instantly meets it — so
    // the configured target must live in the same 1–100 range the CLI enforced.
    const dir = await projectDir()
    expect(() => parse("pipelines:\n  bad:\n    steps:\n      - goal:\n          target: 0\n          improve:\n            briefStep: fix\n            steps:\n              - implementer\n          measure:\n            steps:\n              - quality-score-report", dir)).toThrow("goal.target")
  })

  test("legacy scalar goal fails the load with a migration diagnostic, before anything runs", async () => {
    const dir = await projectDir()
    const body = "pipelines:\n  scored:\n    steps:\n      - implementer\n    goal: 85"
    expect(() => parse(body, dir)).toThrow(/legacy goal configuration/)
    expect(() => parse(body, dir)).toThrow(/terminal `goal` step/)
    // The skeleton preserves the operator's target.
    expect(() => parse(body, dir)).toThrow(/target: 85/)
  })

  test("every legacy goal path is aggregated into one diagnostic", async () => {
    const dir = await projectDir()
    const body = [
      "pipelines:",
      "  a:",
      "    steps:",
      "      - implementer",
      "    goal: 85",
      "    goalMaxIterations: 2",
      "    goalPlateau: 4",
      "  b:",
      "    steps:",
      "      - implementer",
      "    goal: 70",
      "  goal-fix:",
      "    steps:",
      "      - goal-fixer",
    ].join("\n")
    try {
      parse(body, dir)
      throw new Error("expected the parse to fail")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const path of ["pipelines.a.goal", "pipelines.a.goalMaxIterations", "pipelines.a.goalPlateau", "pipelines.b.goal", "pipelines.goal-fix"]) {
        expect(message).toContain(path)
      }
      // Both scalar owners get skeletons; the goal-fix steps appear as source material.
      expect(message).toContain("target: 85")
      expect(message).toContain("target: 70")
      expect(message).toContain("source material from pipelines.goal-fix")
    }
  })

  test("the reserved goal-fix name is refused from project pipeline definitions", async () => {
    const dir = await projectDir()
    expect(() => parse("pipelines:\n  goal-fix:\n    steps:\n      - implementer", dir)).toThrow(/goal-fix/)
  })

  test("the goal-fix built-in is gone from the public registry", () => {
    expect(builtInPipelines["goal-fix"]).toBeUndefined()
    expect(Object.keys(builtInPipelines)).not.toContain("goal-fix")
  })

  test("parses defaultPrompt and suggestedPrompts and resolves them onto the pipeline", async () => {
    const dir = await projectDir()
    const config = parse(
      [
        "pipelines:",
        "  quick:",
        "    steps:",
        "      - implementer",
        "    defaultPrompt: Review the current branch against its base.",
        "    suggestedPrompts:",
        "      - Review the open PR",
        "      - Review only the last commit",
      ].join("\n"),
      dir,
    )
    const spec = selectPipelineSpec(config, "quick")
    expect(spec.defaultPrompt).toBe("Review the current branch against its base.")
    expect(spec.suggestedPrompts).toEqual(["Review the open PR", "Review only the last commit"])

    const resolved = resolvePipeline({ name: "quick", spec, agents: builtInAgents })
    expect(resolved.defaultPrompt).toBe("Review the current branch against its base.")
    expect(resolved.suggestedPrompts).toEqual(["Review the open PR", "Review only the last commit"])
  })

  test("accepts a pipeline without defaultPrompt or suggestedPrompts, and with only one of them", async () => {
    const dir = await projectDir()
    const bare = parse("pipelines:\n  bare:\n    steps:\n      - implementer", dir)
    expect(selectPipelineSpec(bare, "bare").defaultPrompt).toBeUndefined()
    expect(selectPipelineSpec(bare, "bare").suggestedPrompts).toBeUndefined()

    const onlyDefault = parse(
      "pipelines:\n  only-default:\n    steps:\n      - implementer\n    defaultPrompt: Run the default thing.",
      dir,
    )
    expect(selectPipelineSpec(onlyDefault, "only-default").defaultPrompt).toBe("Run the default thing.")
    expect(selectPipelineSpec(onlyDefault, "only-default").suggestedPrompts).toBeUndefined()

    const onlySuggestions = parse(
      "pipelines:\n  only-suggestions:\n    steps:\n      - implementer\n    suggestedPrompts:\n      - Suggestion one",
      dir,
    )
    expect(selectPipelineSpec(onlySuggestions, "only-suggestions").defaultPrompt).toBeUndefined()
    expect(selectPipelineSpec(onlySuggestions, "only-suggestions").suggestedPrompts).toEqual(["Suggestion one"])
  })

  test("rejects an empty defaultPrompt", async () => {
    const dir = await projectDir()
    expect(() => parse("pipelines:\n  bad:\n    steps:\n      - implementer\n    defaultPrompt: ''", dir)).toThrow(
      "defaultPrompt must be a non-empty string",
    )
  })

  test("rejects suggestedPrompts with empty strings in the array", async () => {
    const dir = await projectDir()
    expect(() => parse("pipelines:\n  bad:\n    steps:\n      - implementer\n    suggestedPrompts:\n      - ''", dir)).toThrow(
      "suggestedPrompts[0] must be a non-empty string",
    )
  })

  test("rejects suggestedPrompts that is not a list", async () => {
    const dir = await projectDir()
    expect(() => parse("pipelines:\n  bad:\n    steps:\n      - implementer\n    suggestedPrompts: nope", dir)).toThrow(
      "suggestedPrompts must be a list of non-empty strings",
    )
  })

  test("trims suggestedPrompts values on parse", async () => {
    const dir = await projectDir()
    const config = parse("pipelines:\n  quick:\n    steps:\n      - implementer\n    suggestedPrompts:\n      - '  padded  '", dir)
    expect(selectPipelineSpec(config, "quick").suggestedPrompts).toEqual(["padded"])
  })

  test("materializePipelineSpec carries defaultPrompt and suggestedPrompts into the editable copy", async () => {
    const spec: PipelineSpec = {
      description: "x",
      defaultPrompt: "Do the thing.",
      suggestedPrompts: ["A", "B"],
      steps: ["implementer"],
    }
    const materialized = materializePipelineSpec(spec)
    expect(materialized.defaultPrompt).toBe("Do the thing.")
    expect(materialized.suggestedPrompts).toEqual(["A", "B"])
    expect(materialized.steps).toEqual(["implementer"])
    materialized.suggestedPrompts![0] = "changed"
    expect(spec.suggestedPrompts).toEqual(["A", "B"])
  })
})

describe("isValidModelString", () => {
  test("accepts provider/model and provider/model#variant, rejects the rest", () => {
    expect(isValidModelString("openai/gpt-5.5")).toBe(true)
    expect(isValidModelString("openai/gpt-5.5#xhigh")).toBe(true)
    expect(isValidModelString("anthropic/claude/opus")).toBe(true)
    expect(isValidModelString("gpt-5.5")).toBe(false)
    expect(isValidModelString("openai/")).toBe(false)
    expect(isValidModelString("")).toBe(false)
  })
})

describe("config merging", () => {
  test("defaults merge shallow by key; project wins", () => {
    const global = parse("defaults:\n  model: openai/gpt-5.5#xhigh\n  maxAttempts: 9\n  branchNameModel: anthropic/claude-haiku-4-5")
    const project = parse("defaults:\n  maxAttempts: 2\n  baseRef: dev\n  branchNameModel: openai/gpt-5.5-mini")
    expect(mergeConvoyConfigs(global, project)?.defaults).toEqual({
      model: "openai/gpt-5.5#xhigh",
      baseRef: "dev",
      branchNameModel: "openai/gpt-5.5-mini",
    })
  })

  test("agents and pipelines merge by name; project entry wins wholesale", () => {
    const global = parse("agents:\n  design-polisher:\n    model: openai/gpt-5.5#xhigh\npipelines:\n  default:\n    steps:\n      - tests\n  shared:\n    steps:\n      - implementer")
    const project = parse("agents:\n  design-polisher:\n    temperature: 0.2\npipelines:\n  default:\n    steps:\n      - implementer")
    const merged = mergeConvoyConfigs(global, project)!
    expect(merged.agents["design-polisher"]).toEqual({ temperature: 0.2 })
    expect(merged.pipelines.default?.steps).toEqual(["implementer"])
    expect(merged.pipelines.shared?.steps).toEqual(["implementer"])
  })

  test("permissions and attachments concatenate, global first", () => {
    const global = parse("permissions:\n  allow:\n    - 'a'\nattachments:\n  - 'g.md'")
    const project = parse("permissions:\n  allow:\n    - 'b'\n  deny:\n    - 'x'\nattachments:\n  - 'p.md'")
    const merged = mergeConvoyConfigs(global, project)!
    expect(merged.permissions).toEqual({ allow: ["a", "b"], deny: ["x"] })
    expect(merged.attachments).toEqual(["g.md", "p.md"])
  })

  test("hooks concatenate globally and per pipeline, global first", () => {
    const global = parse("hooks:\n  pre:\n    - g-pre\n  pipelines:\n    implement:\n      post:\n        - g-impl-post")
    const project = parse("hooks:\n  post:\n    - p-post\n  pipelines:\n    implement:\n      pre:\n        - p-impl-pre\n      post:\n        - p-impl-post")
    const merged = mergeConvoyConfigs(global, project)!
    expect(merged.hooks.pre).toEqual([{ command: "g-pre" }])
    expect(merged.hooks.post).toEqual([{ command: "p-post" }])
    expect(merged.hooks.pipelines.implement).toEqual({
      pre: [{ command: "p-impl-pre" }],
      post: [{ command: "g-impl-post" }, { command: "p-impl-post" }],
    })
  })

  test("a missing side passes the other through unchanged", () => {
    const only = parse("defaults:\n  model: openai/gpt-5.5")
    expect(mergeConvoyConfigs(undefined, undefined)).toBeUndefined()
    expect(mergeConvoyConfigs(only, undefined)).toBe(only)
    expect(mergeConvoyConfigs(undefined, only)).toBe(only)
  })
})

describe("model routing config", () => {
  test("parses gateway choices and explicit model targets", () => {
    const config = parse(
      [
        "modelRouting:",
        "  gateway: vercel",
        "  overrides:",
        "    zai/glm-5.2:",
        "      direct: zai/glm-5.2",
        "      openrouter: openrouter/z-ai/glm-5.2",
        "      vercel: vercel/zai/glm-5.2#high",
      ].join("\n"),
    )

    expect(config.modelRouting).toEqual({
      gateway: "vercel",
      overrides: {
        "zai/glm-5.2": {
          direct: "zai/glm-5.2",
          openrouter: "openrouter/z-ai/glm-5.2",
          vercel: "vercel/zai/glm-5.2#high",
        },
      },
    })
    expect(() => parse("modelRouting:\n  gateway: automatic")).toThrow("modelRouting.gateway")
    expect(() => parse("modelRouting:\n  overrides:\n    missing-provider: {} ")).toThrow("modelRouting.overrides.missing-provider")
  })

  test("project routing can explicitly return to configured and deep-merges overrides", () => {
    const global = parse(
      [
        "modelRouting:",
        "  gateway: openrouter",
        "  overrides:",
        "    custom/private-model:",
        "      direct: custom/private-model",
        "      openrouter: openrouter/acme/private-model",
      ].join("\n"),
    )
    const project = parse(
      [
        "modelRouting:",
        "  gateway: configured",
        "  overrides:",
        "    custom/private-model:",
        "      vercel: vercel/acme/private-model",
      ].join("\n"),
    )

    expect(mergeConvoyConfigs(global, project)?.modelRouting).toEqual({
      gateway: "configured",
      overrides: {
        "custom/private-model": {
          direct: "custom/private-model",
          openrouter: "openrouter/acme/private-model",
          vercel: "vercel/acme/private-model",
        },
      },
    })
  })

  test("serializes routing without dropping gateway targets or variants", () => {
    const config = parse(
      "modelRouting:\n  gateway: vercel\n  overrides:\n    custom/private-model:\n      vercel: vercel/acme/private-model#fast",
    )

    const yaml = serializeConvoyConfig(config)
    expect(yaml).toContain("modelRouting:")
    expect(parse(yaml).modelRouting).toEqual(config.modelRouting)
  })

  test("override keys canonicalize wrapped gateways, aliases, and variants to the logical model", () => {
    const config = parse(
      [
        "modelRouting:",
        "  overrides:",
        "    openrouter/z-ai/glm-5.2#high:",
        "      vercel: vercel/zai/glm-5.2",
      ].join("\n"),
    )

    // resolveModel looks up the canonical logical identity "zai/glm-5.2".
    expect(config.modelRouting?.overrides).toEqual({ "zai/glm-5.2": { vercel: "vercel/zai/glm-5.2" } })
  })

  test("parses the nitro gateway and a nitro override target", () => {
    const config = parse(
      [
        "modelRouting:",
        "  gateway: nitro",
        "  overrides:",
        "    zai/glm-5.2:",
        "      openrouter: openrouter/z-ai/glm-5.2",
        "      nitro: openrouter/z-ai/glm-5.2:nitro",
      ].join("\n"),
    )

    expect(config.modelRouting?.gateway).toBe("nitro")
    expect(config.modelRouting?.overrides["zai/glm-5.2"]).toEqual({
      openrouter: "openrouter/z-ai/glm-5.2",
      nitro: "openrouter/z-ai/glm-5.2:nitro",
    })
    expect(() => parse("modelRouting:\n  gateway: automatic")).toThrow("modelRouting.gateway")
  })

  test("an unknown override target key is dropped from the parsed routing", () => {
    const config = parse("modelRouting:\n  overrides:\n    zai/glm-5.2:\n      bogus: whatever")
    expect(config.modelRouting?.overrides["zai/glm-5.2"]).toEqual({})
  })

  test("override keys with a nitro suffix canonicalize to the logical model", () => {
    const config = parse("modelRouting:\n  overrides:\n    openrouter/z-ai/glm-5.2:nitro:\n      openrouter: openrouter/z-ai/glm-5.2")

    expect(config.modelRouting?.overrides).toEqual({ "zai/glm-5.2": { openrouter: "openrouter/z-ai/glm-5.2" } })
  })

  test("canonicalized override keys that collide fail instead of silently replacing", () => {
    expect(() =>
      parse(
        [
          "modelRouting:",
          "  overrides:",
          "    zai/glm-5.2:",
          "      openrouter: openrouter/z-ai/glm-5.2",
          "    zai/glm-5.2:nitro:",
          "      vercel: vercel/zai/glm-5.2",
        ].join("\n"),
      ),
    ).toThrow('modelRouting.overrides.zai/glm-5.2:nitro canonicalizes to "zai/glm-5.2", same as "zai/glm-5.2"')
  })

  test("serializes a nitro gateway and override target", () => {
    const config = parse(
      "modelRouting:\n  gateway: nitro\n  overrides:\n    custom/private-model:\n      nitro: openrouter/acme/private:nitro",
    )

    const yaml = serializeConvoyConfig(config)
    expect(yaml).toContain("gateway: nitro")
    expect(yaml).toContain("nitro: openrouter/acme/private:nitro")
    expect(parse(yaml).modelRouting).toEqual(config.modelRouting)
  })

  test("the init template documents nitro in the gateway comment", () => {
    expect(defaultConvoyConfig).toContain(modelGateways.join(" | "))
    expect(defaultConvoyConfig).toContain("nitro: openrouter/z-ai/glm-5.2 # optional; the openrouter fallback alone is enough")
  })

  test("global and project overrides merge after canonicalization", () => {
    const global = parse("modelRouting:\n  overrides:\n    z-ai/glm-5.2:\n      openrouter: openrouter/z-ai/glm-5.2")
    const project = parse("modelRouting:\n  overrides:\n    zai/glm-5.2:\n      vercel: vercel/zai/glm-5.2")

    expect(mergeConvoyConfigs(global, project)?.modelRouting?.overrides).toEqual({
      "zai/glm-5.2": {
        openrouter: "openrouter/z-ai/glm-5.2",
        vercel: "vercel/zai/glm-5.2",
      },
    })
  })
})

describe("loopGuard config", () => {
  test("parses a partial override and leaves the rest unset", () => {
    const config = parse("loopGuard:\n  identicalCalls: 8\n  maxPhaseCost: 12.5")
    expect(config.loopGuard).toEqual({ identicalCalls: 8, maxPhaseCost: 12.5 })
  })

  test("accepts maxPhaseCost: false to disable the cost fuse", () => {
    expect(parse("loopGuard:\n  maxPhaseCost: false").loopGuard).toEqual({ maxPhaseCost: false })
  })

  test("rejects values that would trip on the first call", () => {
    expect(() => parse("loopGuard:\n  identicalCalls: 1")).toThrow("loopGuard.identicalCalls")
    expect(() => parse("loopGuard:\n  maxSteps: 3")).toThrow("loopGuard.maxSteps")
    expect(() => parse("loopGuard:\n  maxPhaseCost: 0")).toThrow("loopGuard.maxPhaseCost")
  })

  test("project keys win over global keys", () => {
    const global = parse("loopGuard:\n  identicalCalls: 8\n  maxPhaseCost: 30")
    const project = parse("loopGuard:\n  maxPhaseCost: false")
    expect(mergeConvoyConfigs(global, project)?.loopGuard).toEqual({ identicalCalls: 8, maxPhaseCost: false })
  })

  test("round-trips through serialize", () => {
    const config = parse("loopGuard:\n  enabled: false\n  maxSteps: 40\n  maxPhaseCost: false")
    expect(parse(serializeConvoyConfig(config)).loopGuard).toEqual(config.loopGuard)
  })
})

describe("ui config", () => {
  test("parses the reduced-motion switch and leaves it unset by default", () => {
    expect(parse("ui:\n  reducedMotion: on").ui).toEqual({ reducedMotion: "on" })
    expect(parse("ui:\n  reducedMotion: off").ui).toEqual({ reducedMotion: "off" })
    expect(parse("ui:\n  reducedMotion: auto").ui).toEqual({ reducedMotion: "auto" })
    expect(parse("defaults:\n  prdHistory: true").ui).toBeUndefined()
  })

  test("rejects values outside the auto/on/off tri-state", () => {
    expect(() => parse("ui:\n  reducedMotion: sometimes")).toThrow("ui.reducedMotion")
    expect(() => parse("ui:\n  reducedMotion: true")).toThrow("ui.reducedMotion")
  })

  test("the project choice wins over the global one", () => {
    const global = parse("ui:\n  reducedMotion: off")
    const project = parse("ui:\n  reducedMotion: on")
    expect(mergeConvoyConfigs(global, project)?.ui).toEqual({ reducedMotion: "on" })
    expect(mergeConvoyConfigs(project, undefined)?.ui).toEqual({ reducedMotion: "on" })
  })

  test("round-trips through serialize", () => {
    const config = parse("ui:\n  reducedMotion: on")
    const yaml = serializeConvoyConfig(config)
    // The serializer quotes "on" defensively; the parse is what matters.
    expect(yaml).toContain("reducedMotion:")
    expect(parse(yaml).ui).toEqual(config.ui)
  })

  test("the config template documents the section", () => {
    expect(defaultConvoyConfig).toContain("# ui:")
    expect(defaultConvoyConfig).toContain("#   reducedMotion: auto")
  })
})

describe("serialization", () => {
  test("preserves notification settings when a config is written and reloaded", () => {
    const config = parse("notifications:\n  enabled: false\n  waiting: false\n  terminalTitle: false\n  sound: Ping")

    const reparsed = parse(serializeConvoyConfig(config))

    expect(reparsed.notifications).toEqual(config.notifications)
  })

  test("omits empty sections and round-trips through parse", () => {
    const config = parse("defaults:\n  model: openai/gpt-5.5#xhigh\npipelines:\n  default:\n    steps:\n      - implementer\n      - human-review")
    const yaml = serializeConvoyConfig(config)
    expect(yaml).toContain("version: 1")
    expect(yaml).not.toContain("agents")
    expect(yaml).not.toContain("permissions")
    expect(yaml).not.toContain("hooks")
    expect(yaml).not.toContain("attachments")
    const reparsed = parse(yaml)
    expect(reparsed.defaults).toEqual(config.defaults)
    expect(reparsed.pipelines).toEqual(config.pipelines)
  })

  test("serializes hooks and round-trips through parse", () => {
    const config = parse(
      [
        "hooks:",
        "  pre:",
        "    - pnpm lint",
        "  pipelines:",
        "    implement:",
        "      post:",
        "        - command: gh pr create --fill",
        "          when: success",
        "          continueOnError: true",
      ].join("\n"),
    )
    const reparsed = parse(serializeConvoyConfig(config))
    expect(reparsed.hooks).toEqual(config.hooks)
  })

  test("defaultConfigTemplate materializes the default pipeline's step model overrides and round-trips", () => {
    const template = defaultConfigTemplate()
    expect(template.defaults.model).toBe(`${defaultGptModel}#${defaultGptVariant}`)
    const steps = template.pipelines["full-cycle"]!.steps
    expect(steps.find((step) => typeof step !== "string" && !isParallelSpec(step) && !isHumanStepSpec(step) && !isGoalStepSpec(step) && step.agent === "design")).toEqual({ agent: "design", model: defaultImplementReviewModel, advisor: false })
    expect(steps.find((step) => typeof step !== "string" && !isParallelSpec(step) && !isHumanStepSpec(step) && !isGoalStepSpec(step) && step.agent === "implementer")).toEqual({ agent: "implementer", model: "openrouter/z-ai/glm-5.3-flash#high", advisor: "openrouter/x-ai/grok-4.6#high", reports: "none" })
    const reparsed = parse(serializeConvoyConfig(template))
    expect(reparsed.defaults).toEqual(template.defaults)
    expect(reparsed.pipelines).toEqual(template.pipelines)
    expect(reparsed.hooks).toEqual(template.hooks)
  })
})

describe("global config", () => {
  let savedHome: string | undefined
  beforeEach(() => {
    savedHome = process.env.CONVOY_HOME
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.CONVOY_HOME
    else process.env.CONVOY_HOME = savedHome
  })

  // CONVOY_HOME points at the directory that contains .convoy, like a repo root.
  async function globalHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "convoy-home-"))
    dirs.push(root)
    await mkdir(join(root, ".convoy", "agents"), { recursive: true })
    process.env.CONVOY_HOME = root
    return join(root, ".convoy")
  }

  test("loads ~/.convoy/config.yaml and validates global agents against ~/.convoy/agents", async () => {
    const home = await globalHome()
    await writeFile(join(home, "agents", "global-agent.md"), "# global-agent\n")
    await writeFile(join(home, "config.yaml"), "defaults:\n  model: openai/gpt-5.5#xhigh\nagents:\n  global-agent:\n    description: A global agent\n    model: anthropic/claude-opus-4-7\n")

    const config = await loadGlobalConvoyConfig()
    expect(config?.defaults.model).toBe("openai/gpt-5.5#xhigh")
    expect(config?.agents["global-agent"]).toMatchObject({ model: "anthropic/claude-opus-4-7" })
  })

  test("migrates existing global pipeline names and their references to lowercase", async () => {
    const home = await globalHome()
    await writeFile(
      join(home, "config.yaml"),
      [
        "defaults:",
        "  pipeline: Deploy-Prod",
        "pipelines:",
        "  Deploy-Prod:",
        "    steps:",
        "      - implementer",
        "hooks:",
        "  pipelines:",
        "    Deploy-Prod:",
        "      pre:",
        "        - echo deploy",
      ].join("\n"),
    )

    const config = await loadGlobalConvoyConfig()
    expect(config?.defaults.pipeline).toBe("deploy-prod")
    expect(config?.pipelines["deploy-prod"]?.steps).toEqual(["implementer"])
    expect(config?.hooks.pipelines["deploy-prod"]?.pre).toEqual([{ command: "echo deploy" }])

    const persisted = await readFile(join(home, "config.yaml"), "utf8")
    expect(persisted).toContain("deploy-prod:")
    expect(persisted).not.toContain("Deploy-Prod")
  })

  test("rejects global pipeline names that collide when lowercased", async () => {
    const home = await globalHome()
    await writeFile(join(home, "config.yaml"), "pipelines:\n  Deploy:\n    steps:\n      - implementer\n  deploy:\n    steps:\n      - tests\n")

    await expect(loadGlobalConvoyConfig()).rejects.toThrow('pipelines contains names "Deploy" and "deploy" that collide when lowercased to "deploy"')
  })

  test("merges global under project so the project wins", async () => {
    const home = await globalHome()
    await writeFile(join(home, "config.yaml"), "defaults:\n  model: openai/gpt-5.5#xhigh\n  maxAttempts: 9\n")

    const project = await projectDir("defaults:\n  maxAttempts: 2\n")
    const merged = await loadMergedConvoyConfig(project)
    expect(merged?.defaults).toEqual({ model: "openai/gpt-5.5#xhigh" })
  })
})

describe("default config init", () => {
  test("the default config template is valid and explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-default-config-"))
    dirs.push(dir)
    const path = join(dir, "config.yaml")
    await writeDefaultConvoyConfig(path)

    const body = await readFile(path, "utf8")
    const config = parseConvoyConfig(body, path, dir)

    expect(body).toContain("# maxConcurrentAgents: 30")
    expect(body).toContain("# baseRef: main")
    expect(body).toContain("# pipeline: implement")
    expect(body).toContain("# branchNameModel: openrouter/deepseek/deepseek-v4-flash-0731")
    expect(body).toContain("# hooks:")
    expect(body).toContain("#           command: gh pr create --fill")
    expect(body).toContain("# agents:")
    expect(body).toContain("#   implementer:")
    expect(body).toContain("#   design-polisher:")
    expect(body).toContain("#   api-reviewer:")
    expect(body).toContain("# loopGuard:")
    expect(body).toContain("#   identicalCalls: 4")
    expect(body).toContain("#   maxPhaseCost: 20")
    expect(config.defaults).toEqual({})
    expect(config.agents).toEqual({})
    // Seeding prompts would shadow every built-in for good, so init writes none.
    expect(existsSync(join(dir, "agents"))).toBe(false)
    // The inlined copy mirrors the built-in exactly, advisor opt-outs included:
    // without them, a project that later sets defaults.advisor would advise
    // phases the built-in deliberately leaves unadvised.
    expect(config.pipelines.implement?.steps).toEqual([
      { agent: "implementer", model: defaultImplementerModel, advisor: defaultImplementAdvisorModel, reports: "none" },
      { agent: "patterns", model: defaultImplementAuditModel, advisor: false },
      { agent: "security", model: defaultImplementAuditModel, advisor: false },
      { agent: "design", model: defaultImplementReviewModel, advisor: false },
      { agent: "tests", model: defaultImplementAuditModel, advisor: false, reports: "none" },
      { agent: "adversarial", model: defaultAdversarialModel, advisor: false, reports: "all" },
      { agent: "run-report", model: defaultRunReportModel, advisor: false, reports: "all", diff: false },
    ])
    expect(config.permissions).toEqual({ allow: [], deny: [] })
    expect(config.hooks).toEqual({ pre: [], post: [], pipelines: {} })
    expect(config.attachments).toEqual([])
  })

  test("writes default config without overwriting unless forced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-config-write-"))
    dirs.push(dir)
    const path = join(dir, "config.yaml")

    expect(await writeDefaultConvoyConfig(path)).toEqual({ path, created: true })
    expect(await readFile(path, "utf8")).toContain("version: 1")

    await writeFile(path, "version: 1\nattachments:\n  - custom.md\n")
    expect(await writeDefaultConvoyConfig(path)).toEqual({ path, created: false })
    expect(await readFile(path, "utf8")).toContain("custom.md")

    expect(await writeDefaultConvoyConfig(path, true)).toEqual({ path, created: true })
    expect(await readFile(path, "utf8")).not.toContain("custom.md")
  })

  test("init leaves an ejected prompt alone even with --force", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-config-force-"))
    dirs.push(dir)
    const path = join(dir, "config.yaml")

    await writeDefaultConvoyConfig(path)
    const ejected = await ejectAgentPrompt(dir, "implementer")
    await writeFile(ejected.path, "# Custom Implementer\n")

    // --force is about the config file; it must never reclaim an override.
    await writeDefaultConvoyConfig(path, true)
    expect(await readFile(ejected.path, "utf8")).toBe("# Custom Implementer\n")
  })

  test("writes project default config under .convoy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-project-config-"))
    dirs.push(dir)
    const path = join(dir, ".convoy", "config.yaml")

    expect(await writeDefaultProjectConfig(dir)).toEqual({ path, created: true })
    expect(await writeDefaultProjectConfig(dir)).toEqual({ path, created: false })
    expect(await readFile(path, "utf8")).toContain("pipelines:")
    expect(existsSync(join(dir, ".convoy", "agents"))).toBe(false)
  })
})

describe("ejecting agent prompts", () => {
  test("copies one built-in prompt and reports whether it wrote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-eject-"))
    dirs.push(dir)
    const path = join(dir, "agents", "implementer.md")

    expect(await ejectAgentPrompt(dir, "implementer")).toEqual({ path, created: true })
    expect(await readFile(path, "utf8")).toContain("# Implementer")
    // Only the requested agent lands on disk.
    expect(existsSync(join(dir, "agents", "design-polisher.md"))).toBe(false)
  })

  test("refuses to clobber an edited prompt unless forced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-eject-force-"))
    dirs.push(dir)
    const path = join(dir, "agents", "implementer.md")

    await ejectAgentPrompt(dir, "implementer")
    await writeFile(path, "# Mine\n")

    expect(await ejectAgentPrompt(dir, "implementer")).toEqual({ path, created: false })
    expect(await readFile(path, "utf8")).toBe("# Mine\n")

    expect(await ejectAgentPrompt(dir, "implementer", true)).toEqual({ path, created: true })
    expect(await readFile(path, "utf8")).toContain("# Implementer")
  })

  test("an ejected prompt overrides the built-in for the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-eject-override-"))
    dirs.push(dir)
    // Point the global home at an empty dir so this asserts the project layer
    // rather than whatever the developer happens to have in ~/.convoy/agents.
    const previousHome = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = dir
    try {
      expect(loadAgentPrompt("implementer", dir)).toContain("# Implementer")
      const ejected = await ejectAgentPrompt(join(dir, ".convoy"), "implementer")
      await writeFile(ejected.path, "# Overridden\n")
      expect(loadAgentPrompt("implementer", dir)).toContain("# Overridden")
    } finally {
      if (previousHome === undefined) delete process.env.CONVOY_HOME
      else process.env.CONVOY_HOME = previousHome
    }
  })

  test("rejects unknown agents and non-agent prompts, listing what is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-eject-unknown-"))
    dirs.push(dir)

    expect(ejectAgentPrompt(dir, "nope")).rejects.toThrow("unknown built-in agent: nope")
    expect(ejectAgentPrompt(dir, "nope")).rejects.toThrow("implementer")
    // An alias is a name convoy otherwise accepts, so it gets redirected rather than listed at.
    expect(ejectAgentPrompt(dir, "patterns")).rejects.toThrow("convoy agents eject pattern-auditor")
    // Always read from the built-ins, so a copy would be inert.
    expect(ejectAgentPrompt(dir, "runtime-safety")).rejects.toThrow("unknown built-in agent")
    expect(existsSync(join(dir, "agents"))).toBe(false)
  })
})

describe("runner field on steps", () => {
  const parse = (yaml: string) => parseConvoyConfig(yaml, ".convoy/config.yaml", "/tmp/non-existent-convoy-target")

  test("parses runner: claude-code with a bare CLI model alias", () => {
    const config = parse(
      [
        "pipelines:",
        "  p:",
        "    steps:",
        "      - agent: security-reviewer",
        "        name: external-security",
        "        runner: claude-code",
        "        model: opus",
        "        reports: all",
      ].join("\n"),
    )
    expect(config.pipelines.p?.steps).toEqual([
      { agent: "security-reviewer", name: "external-security", runner: "claude-code", model: "opus", reports: "all" },
    ])
  })

  test("parses runner: claude-code with no model (CLI default)", () => {
    const config = parse("pipelines:\n  p:\n    steps:\n      - agent: bug-auditor\n        runner: claude-code")
    expect(config.pipelines.p?.steps).toEqual([{ agent: "bug-auditor", runner: "claude-code" }])
  })

  test("normalizes Anthropic-prefixed Claude models before persistence", () => {
    const config = parse(
      "pipelines:\n  p:\n    steps:\n      - agent: bug-auditor\n        runner: claude-code\n        model: anthropic/claude-opus-4-8",
    )

    expect(config.pipelines.p?.steps).toEqual([{ agent: "bug-auditor", runner: "claude-code", model: "claude-opus-4-8" }])
  })

  test("rejects non-Anthropic and malformed Claude models at config parse time", () => {
    const prefix = "pipelines:\n  p:\n    steps:\n      - agent: bug-auditor\n        runner: claude-code\n        model: "
    const message = "runner claude-code executes Anthropic models"

    expect(() => parse(`${prefix}openai/gpt-5.6`)).toThrow(message)
    expect(() => parse(`${prefix}anthropic/not-claude`)).toThrow(message)
    expect(() => parse(`${prefix}opus#high`)).toThrow(message)
  })

  test("still requires provider/model for the default runner", () => {
    expect(() => parse("pipelines:\n  p:\n    steps:\n      - agent: bug-auditor\n        model: opus")).toThrow(
      "must look like provider/model",
    )
  })

  test("rejects unknown runner values", () => {
    expect(() => parse("pipelines:\n  p:\n    steps:\n      - agent: bug-auditor\n        runner: codex")).toThrow(
      'pipelines.p.steps[0].runner must be "opencode" or "claude-code"',
    )
  })

  test("rejects runner: claude-code with a models fan-out", () => {
    expect(() =>
      parse(
        [
          "pipelines:",
          "  p:",
          "    steps:",
          "      - agent: bug-auditor",
          "        runner: claude-code",
          "        models:",
          "          - openai/gpt-5.5#xhigh",
          "          - anthropic/claude-opus-4-8",
        ].join("\n"),
      ),
    ).toThrow('pipelines.p.steps[0] can\'t combine runner: claude-code with "models"')
  })
})

describe("materializing built-in pipelines", () => {
  const fallback = `${defaultGptModel}#${defaultGptVariant}`
  const emptyConfig = (pipelines: Record<string, ReturnType<typeof materializePipelineSpec>>) => ({
    defaults: {},
    agents: {},
    pipelines,
    permissions: { allow: [] as string[], deny: [] as string[] },
    hooks: { pre: [], post: [], pipelines: {} },
    attachments: [] as string[],
    notifications: {},
  })

  test("without an effective default model, every built-in materializes to an identical spec", () => {
    for (const spec of Object.values(builtInPipelines)) {
      expect(materializePipelineSpec(spec)).toEqual(spec)
    }
  })

  test("the materialized copy is independent of the built-in spec", () => {
    const spec = materializePipelineSpec(builtInPipelines.review!)
    const group = spec.steps[1]
    if (group === undefined || !isParallelSpec(group)) throw new Error("expected a parallel block")
    const member = group.parallel[0]
    if (typeof member === "string") throw new Error("expected a member object")
    member.models!.push("mutated/model")
    member.name = "mutated"
    group.parallel.push("mutated-agent")
    spec.steps.push("mutated-step")

    const original = builtInPipelines.review!
    const originalGroup = original.steps[1]
    if (originalGroup === undefined || !isParallelSpec(originalGroup)) throw new Error("expected a parallel block")
    const originalMember = originalGroup.parallel[0]
    if (typeof originalMember === "string") throw new Error("expected a member object")
    expect(original.steps).toHaveLength(5)
    expect(originalGroup.parallel).toHaveLength(3)
    expect(originalMember.models).toHaveLength(2)
    expect(originalMember.name).toBe("clean-code")
  })

  test("carries the terminal goal step into the copy, so customizing ship does not disable its loop", () => {
    const materialized = materializePipelineSpec(builtInPipelines.ship!)
    const goalIndex = materialized.steps.length - 1
    const node = materialized.steps[goalIndex] as { goal?: { target: number; improve: unknown; measure: unknown } }
    expect(node.goal?.target).toBe(90)
    // The fragments travel with the copy, deep-cloned: editing the copy can
    // never touch the built-in's goal definition.
    expect(node.goal?.improve).toBeDefined()
    expect(node.goal?.measure).toBeDefined()
    expect(builtInPipelines.ship!.steps[goalIndex]).not.toBe(materialized.steps[goalIndex])
  })

  test("inlines built-in agent model preferences only when a default model would shadow them", () => {
    const spec = { steps: [{ agent: "implementer", reports: "none" as const }, "patterns", { agent: "design", model: "x/y" }] }
    expect(materializePipelineSpec(spec, "other/model").steps).toEqual([
      { agent: "implementer", reports: "none", model: fallback },
      { agent: "patterns", model: fallback },
      { agent: "design", model: "x/y" },
    ])
    // A matching default doesn't shadow anything, so nothing gets pinned.
    expect(materializePipelineSpec(spec, fallback).steps).toEqual(spec.steps)
  })

  test("never injects an OpenCode model into a model-less Claude Code step", () => {
    const spec = { steps: [{ agent: "review-report", runner: "claude-code" as const }] }

    expect(materializePipelineSpec(spec, "other/model").steps).toEqual([{ agent: "review-report", runner: "claude-code" }])
  })

  test("every materialized built-in serializes, re-parses, and resolves", () => {
    for (const [name, spec] of Object.entries(builtInPipelines)) {
      const materialized = materializePipelineSpec(spec, fallback)
      const config = parse(serializeConvoyConfig(emptyConfig({ [name]: materialized })))
      expect(config.pipelines[name]).toEqual(materialized)
      expect(checkPipelineResolves(name, config.pipelines[name]!, config)).toBeUndefined()
    }
  })

  test("checkPipelineResolves reports duplicate names, unknown agents, and dangling reports", () => {
    expect(checkPipelineResolves("x", { steps: ["patterns", "patterns"] }, undefined)).toContain("duplicate step name")
    expect(checkPipelineResolves("x", { steps: ["nope"] }, undefined)).toContain("unknown agent")
    expect(checkPipelineResolves("x", { steps: ["patterns", { agent: "security", reports: ["missing"] }] }, undefined)).toContain(
      "not an earlier agent step",
    )
    expect(checkPipelineResolves("x", { steps: ["patterns"] }, undefined)).toBeUndefined()
  })
})

describe("advisor config", () => {
  const parseAdvisor = (body: string) => parseConvoyConfig(body, ".convoy/config.yaml", "/tmp/non-existent-convoy-target")

  test("accepts an advisor at all three levels", () => {
    const config = parseAdvisor(`version: 1
defaults:
  advisor: anthropic/claude-opus-5
  advisorMaxCalls: 2
agents:
  implementer:
    advisor: anthropic/claude-opus-4-8
pipelines:
  advised:
    steps:
      - agent: implementer
        advisor: anthropic/claude-opus-5#high
        advisorMaxCalls: 1
`)

    expect(config.defaults.advisor).toBe("anthropic/claude-opus-5")
    expect(config.defaults.advisorMaxCalls).toBe(2)
    expect(config.agents.implementer?.advisor).toBe("anthropic/claude-opus-4-8")
    expect(config.pipelines.advised?.steps[0]).toMatchObject({ advisor: "anthropic/claude-opus-5#high", advisorMaxCalls: 1 })
  })

  test("validates advisor audit retention policies", () => {
    expect(parseAdvisor("version: 1\ndefaults:\n  advisorAuditPolicy: full\n").defaults.advisorAuditPolicy).toBe("full")
    expect(() => parseAdvisor("version: 1\ndefaults:\n  advisorAuditPolicy: forever\n")).toThrow(/summary, redacted, or full/)
  })

  test("keeps advisor: false as an explicit opt-out rather than dropping it", () => {
    const config = parseAdvisor(`version: 1
pipelines:
  advised:
    steps:
      - agent: implementer
        advisor: false
`)

    expect(config.pipelines.advised?.steps[0]).toMatchObject({ advisor: false })
  })

  test("rejects malformed advisors, advisor: true, and caps without an advisor", () => {
    const step = (body: string) => `version: 1\npipelines:\n  p:\n    steps:\n      - agent: implementer\n${body}`

    expect(() => parseAdvisor(step("        advisor: not-a-model\n"))).toThrow(/advisor/)
    expect(() => parseAdvisor(step("        advisor: true\n"))).toThrow(/true is not a model/)
    expect(() => parseAdvisor(step("        advisor: false\n        advisorMaxCalls: 2\n"))).toThrow(/meaningless with advisor: false/)
    expect(() => parseAdvisor(step("        advisorMaxCalls: 0\n"))).toThrow(/advisorMaxCalls/)
    expect(() => parseAdvisor(`version: 1\ndefaults:\n  advisor: nope\n`)).toThrow(/defaults.advisor/)
  })

  test("rejects an advisor on a claude-code step", () => {
    expect(() =>
      parseAdvisor(`version: 1
pipelines:
  p:
    steps:
      - agent: bug-auditor
        runner: claude-code
        advisor: anthropic/claude-opus-5
`),
    ).toThrow(/does not support an advisor/)
  })

  test("buildAgentRegistry carries the advisor onto built-in and project agents", () => {
    const config = parseAdvisor(`version: 1
agents:
  implementer:
    advisor: anthropic/claude-opus-5
`)
    const registry = buildAgentRegistry(config)

    expect(registry.find((agent) => agent.name === "implementer")?.advisor).toBe("anthropic/claude-opus-5")
  })

  test("survives a serialize/re-parse round trip", () => {
    const config = parseAdvisor(`version: 1
defaults:
  advisor: anthropic/claude-opus-5
pipelines:
  advised:
    steps:
      - agent: implementer
        advisor: false
      - agent: tests
        advisor: anthropic/claude-opus-5#high
        advisorMaxCalls: 3
`)
    const reparsed = parseAdvisor(serializeConvoyConfig(config))

    expect(reparsed.defaults.advisor).toBe("anthropic/claude-opus-5")
    expect(reparsed.pipelines.advised?.steps[0]).toMatchObject({ advisor: false })
    expect(reparsed.pipelines.advised?.steps[1]).toMatchObject({ advisor: "anthropic/claude-opus-5#high", advisorMaxCalls: 3 })
  })
})
