import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { loadAgentPrompt, opencodeConfig } from "../src/agents"
import { builtInPrompts } from "../src/built-in-prompts"

describe("opencode config", () => {
  test("disables total provider timeouts but keeps idle stream timeouts", () => {
    const config = opencodeConfig("/tmp/convoy-run")

    for (const provider of ["anthropic", "openai", "openrouter", "vercel", "zai"]) {
      expect(config.provider?.[provider]?.options?.timeout).toBe(false)
      expect(config.provider?.[provider]?.options?.chunkTimeout).toBe(600_000)
    }
  })

  test("embedded built-in prompts stay in sync with the prompts/ directory", async () => {
    const files = (await readdir(join(import.meta.dir, "..", "prompts")))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -".md".length))
      .sort()

    expect(Object.keys(builtInPrompts).sort()).toEqual(files)
  })

  test("loads built-in markdown prompts with runtime safety guard rails", () => {
    const prompt = loadAgentPrompt("implementer", "/tmp/non-existent-convoy-target")

    expect(prompt).toContain("# Implementer")
    expect(prompt).toContain("# Convoy Runtime Safety")
    expect(prompt).toContain("not replaceable")
  })

  test("project agent prompts replace built-ins but keep runtime safety", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-agents-"))
    try {
      await mkdir(join(dir, ".convoy", "agents"), { recursive: true })
      await writeFile(join(dir, ".convoy", "agents", "implementer.md"), "# Custom Implementer\n\nProject-specific prompt.")

      const prompt = loadAgentPrompt("implementer", dir)

      expect(prompt.startsWith("# Custom Implementer")).toBe(true)
      expect(prompt).toContain("Project-specific prompt.")
      expect(prompt).not.toContain("# Implementer\n\nYou are the **implementer**")
      expect(prompt).toContain("# Convoy Runtime Safety")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("project agents need a prompt file", () => {
    expect(() => loadAgentPrompt("ghost", "/tmp/non-existent-convoy-target")).toThrow("create .convoy/agents/ghost.md")
  })

  test("project agents land in the opencode config with their prompt and temperature", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-custom-agent-"))
    try {
      await mkdir(join(dir, ".convoy", "agents"), { recursive: true })
      await writeFile(join(dir, ".convoy", "agents", "api-reviewer.md"), "# API Reviewer\n\nReview the API surface.")

      const config = opencodeConfig("/tmp/convoy-run", dir, [
        { name: "implementer", description: "Implements", builtIn: true },
        { name: "api-reviewer", description: "Reviews APIs", temperature: 0.3, builtIn: false },
      ])

      const custom = config.agent?.["api-reviewer"]
      expect(custom?.description).toBe("Reviews APIs")
      expect(custom?.temperature).toBe(0.3)
      expect(custom?.prompt).toContain("# API Reviewer")
      expect(custom?.prompt).toContain("# Convoy Runtime Safety")
      expect(config.agent?.implementer?.temperature).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a synthesized forced-read-only agent (__ro suffix) loads the base agent's prompt, not its own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-ro-variant-"))
    try {
      await mkdir(join(dir, ".convoy", "agents"), { recursive: true })
      await writeFile(join(dir, ".convoy", "agents", "clean-code.md"), "# Clean Code\n\nLook for unnecessary complexity.")

      // Only "clean-code" has a prompt file on disk; "clean-code__ro" is
      // synthesized by synthesizeReadOnlyAgents and must not need its own.
      const config = opencodeConfig("/tmp/convoy-run", dir, [
        { name: "clean-code", description: "Clean code review", builtIn: false },
        { name: "clean-code__ro", description: "Clean code review", readOnly: true, builtIn: false },
      ])

      const forced = config.agent?.["clean-code__ro"]
      expect(forced?.prompt).toContain("# Clean Code")
      expect(forced?.prompt).toContain("Look for unnecessary complexity.")
      expect(forced?.tools?.write).toBe(false)
      expect(forced?.tools?.edit).toBe(false)
      expect(forced?.tools?.bash).toBe(false)
      expect(forced?.tools?.write_report).toBe(true)
      // The base agent's own config is untouched: still writable.
      expect(config.agent?.["clean-code"]?.tools?.write).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a synthesized verifying agent (__verify suffix) loads the base agent's prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-verify-variant-"))
    try {
      await mkdir(join(dir, ".convoy", "agents"), { recursive: true })
      await writeFile(join(dir, ".convoy", "agents", "validator.md"), "# Validator\n\nRerun the proofs.")

      const config = opencodeConfig("/tmp/convoy-run", dir, [
        { name: "validator", description: "Validator", readOnly: true, builtIn: false },
        { name: "validator__verify", description: "Validator", readOnly: true, verify: true, builtIn: false },
      ])

      const verifying = config.agent?.["validator__verify"]
      expect(verifying?.prompt).toContain("# Validator")
      expect(verifying?.tools?.bash).toBe(true)
      expect(verifying?.tools?.write).toBe(false)
      expect(verifying?.tools?.write_report).toBe(true)
      const bash = (verifying?.permission as { bash?: Record<string, string> } | undefined)?.bash
      expect(bash?.["git commit*"]).toBe("deny")
      expect(config.agent?.["validator"]?.tools?.bash).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("read-only agents cannot write, edit, or run shell commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-readonly-agent-"))
    try {
      await mkdir(join(dir, ".convoy", "agents"), { recursive: true })
      await writeFile(join(dir, ".convoy", "agents", "audit-only.md"), "# Audit Only\n\nReview without editing.")

      const config = opencodeConfig("/tmp/convoy-run", dir, [{ name: "audit-only", description: "Audits only", readOnly: true, builtIn: false }])

      const audit = config.agent?.["audit-only"]
      expect(audit?.tools?.read).toBe(true)
      expect(audit?.tools?.glob).toBe(true)
      expect(audit?.tools?.grep).toBe(true)
      expect(audit?.tools?.list).toBe(true)
      expect(audit?.tools?.write).toBe(false)
      expect(audit?.tools?.edit).toBe(false)
      expect(audit?.tools?.bash).toBe(false)
      expect(audit?.tools?.write_report).toBe(true)
      expect(audit?.permission).toMatchObject({ edit: "deny", bash: "deny", task: "deny", question: "deny" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("verifying agents get bash under the normal policy while staying unable to write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-verify-agent-"))
    try {
      await mkdir(join(dir, ".convoy", "agents"), { recursive: true })
      await writeFile(join(dir, ".convoy", "agents", "validator.md"), "# Validator\n\nRerun the proofs.")

      const config = opencodeConfig("/tmp/convoy-run", dir, [
        { name: "validator", description: "Verifies", readOnly: true, verify: true, builtIn: false },
      ])

      const validator = config.agent?.["validator"]
      expect(validator?.tools?.read).toBe(true)
      expect(validator?.tools?.bash).toBe(true)
      // The whole point: it can run the checks its prompt demands, but the write
      // path stays closed and runner.ts still holds it to an unchanged repo.
      expect(validator?.tools?.write).toBe(false)
      expect(validator?.tools?.edit).toBe(false)
      expect(validator?.tools?.task).toBe(false)
      expect(validator?.tools?.write_report).toBe(true)
      expect(validator?.permission).toMatchObject({ edit: "deny", task: "deny", question: "deny" })
      const bash = (validator?.permission as { bash?: Record<string, string> } | undefined)?.bash
      // Same policy writable agents get: allowlisted checks run silently, the
      // hard denylist stays deny.
      expect(bash).toMatchObject({ "bun test*": "allow", "git commit*": "deny", "*": "ask" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("writable agents keep the full bash policy, denylist included", () => {
    const config = opencodeConfig("/tmp/convoy-run", "/tmp/non-existent-convoy-target", [
      { name: "implementer", description: "writes", builtIn: true },
    ])

    const bash = (config.agent?.implementer?.permission as { bash?: Record<string, string> } | undefined)?.bash
    expect(bash).toMatchObject({ "bun test*": "allow", "git commit*": "deny", "*": "ask" })
    expect(config.agent?.implementer?.tools?.write_report).toBe(true)
  })

  test("verify without readOnly is ignored: a writable agent is already allowed everything", async () => {
    const config = opencodeConfig("/tmp/convoy-run", "/tmp/non-existent-convoy-target", [
      { name: "implementer", description: "writes", verify: true, builtIn: true },
    ])

    expect(config.agent?.implementer?.tools?.write).toBe(true)
    expect(config.agent?.implementer?.tools?.bash).toBe(true)
    expect(config.agent?.implementer?.tools?.write_report).toBe(true)
  })

  test("asks doom_loop and never injects OpenCode's maximum-steps prompt", () => {
    const config = opencodeConfig("/tmp/convoy-run")

    expect(config.permission).toMatchObject({ question: "deny", doom_loop: "ask" })
    expect(config.agent?.implementer?.permission).toMatchObject({ doom_loop: "ask" })
    expect(config.agent?.["pattern-auditor"]?.permission).toMatchObject({ doom_loop: "ask" })
    expect(config.agent?.implementer?.steps).toBeUndefined()
    expect(config.agent?.["bug-auditor"]?.steps).toBeUndefined()
  })
})

describe("advisor wiring in the opencode config", () => {
  const agents = [
    { name: "implementer", description: "writes", builtIn: true },
    { name: "bug-auditor", description: "audits", readOnly: true, builtIn: true },
  ]

  test("leaves every agent untouched when no step has an advisor", () => {
    const config = opencodeConfig("/tmp/convoy-run", "/tmp/non-existent-convoy-target", agents)

    expect(config.agent?.implementer?.tools?.advisor).toBe(false)
    expect(config.agent?.implementer?.tools?.write_report).toBe(true)
    expect(config.agent?.implementer?.permission).toMatchObject({ edit: "allow" })
    expect(config.agent?.implementer?.prompt).not.toContain("You have an `advisor` tool")
    expect(Object.keys(config.provider?.anthropic?.models ?? {})).toEqual([])
  })

  test("gives an advised agent the tool, the timing block, and a gated first write", () => {
    const config = opencodeConfig("/tmp/convoy-run", "/tmp/non-existent-convoy-target", agents, undefined, {
      advisorAgents: new Set(["implementer"]),
    })

    expect(config.agent?.implementer?.tools?.advisor).toBe(true)
    // "ask" is what routes the first edit through the permission gate.
    expect(config.agent?.implementer?.permission).toMatchObject({ edit: "ask" })
    expect(config.agent?.implementer?.prompt).toContain("You have an `advisor` tool")
    // Timing lands before the agent's own instructions.
    expect(config.agent?.implementer?.prompt?.indexOf("advisor")).toBeLessThan(config.agent!.implementer!.prompt!.indexOf("Convoy Runtime Safety"))

    // An unadvised agent in the same run is unaffected.
    expect(config.agent?.["bug-auditor"]?.tools?.advisor).toBe(false)
    expect(config.agent?.["bug-auditor"]?.tools?.write_report).toBe(true)
    expect(config.agent?.["bug-auditor"]?.prompt).not.toContain("You have an `advisor` tool")
  })

  test("a read-only advised agent gets the tool without gaining any write path", () => {
    const config = opencodeConfig("/tmp/convoy-run", "/tmp/non-existent-convoy-target", agents, undefined, {
      advisorAgents: new Set(["bug-auditor"]),
    })

    expect(config.agent?.["bug-auditor"]?.tools?.advisor).toBe(true)
    expect(config.agent?.["bug-auditor"]?.tools?.write_report).toBe(true)
    expect(config.agent?.["bug-auditor"]?.tools).toMatchObject({ write: false, edit: false, bash: false })
    expect(config.agent?.["bug-auditor"]?.permission).toMatchObject({ edit: "deny", bash: "deny" })
  })

  test("declares capped advisor aliases alongside the provider timeout options", () => {
    const config = opencodeConfig("/tmp/convoy-run", "/tmp/non-existent-convoy-target", agents, undefined, {
      advisorModels: [{ providerID: "anthropic", modelID: "claude-opus-5" }],
    })

    // The alias is added without losing the provider-level timeout settings.
    expect(config.provider?.anthropic?.options?.timeout).toBe(false)
    expect(config.provider?.anthropic?.models?.["convoy-advisor-claude-opus-5"]).toMatchObject({
      id: "claude-opus-5",
      limit: { output: 2048 },
    })
  })
})

describe("throughput routing in the opencode config", () => {
  test("declares provider.sort throughput on every OpenRouter model of a nitro run", () => {
    const config = opencodeConfig("/tmp/convoy-run", "/tmp/non-existent-convoy-target", [
      { name: "implementer", description: "writes", builtIn: true },
    ], undefined, {
      throughputModels: [
        { providerID: "openrouter", modelID: "z-ai/glm-5.3" },
        { providerID: "openrouter", modelID: "deepseek/deepseek-v4.1-flash" },
      ],
    })

    expect(config.provider?.openrouter?.models?.["z-ai/glm-5.3"]).toEqual({ options: { provider: { sort: "throughput" } } })
    expect(config.provider?.openrouter?.models?.["deepseek/deepseek-v4.1-flash"]).toEqual({ options: { provider: { sort: "throughput" } } })
    // Options-only entries: no name or limit is invented over the catalog's real model.
    expect(config.provider?.openrouter?.models?.["z-ai/glm-5.3"]?.name).toBeUndefined()
    expect(config.provider?.openrouter?.models?.["z-ai/glm-5.3"]?.limit).toBeUndefined()
    // The provider-level timeout settings survive the merge.
    expect(config.provider?.openrouter?.options?.timeout).toBe(false)
    expect(config.provider?.openrouter?.options?.chunkTimeout).toBe(10 * 60 * 1000)
  })

  test("ignores non-OpenRouter models and stays inert without throughput models", () => {
    const withOthers = opencodeConfig("/tmp/convoy-run", "/tmp/non-existent-convoy-target", [
      { name: "implementer", description: "writes", builtIn: true },
    ], undefined, {
      throughputModels: [{ providerID: "zai", modelID: "glm-5.3" }, { providerID: "openai", modelID: "gpt-5.6-terra" }],
    })
    expect(Object.keys(withOthers.provider?.openrouter?.models ?? {})).toEqual([])

    const plain = opencodeConfig("/tmp/convoy-run")
    expect(Object.keys(plain.provider?.openrouter?.models ?? {})).toEqual([])
  })

  test("merges throughput options with advisor aliases on the same provider", () => {
    const config = opencodeConfig("/tmp/convoy-run", "/tmp/non-existent-convoy-target", [
      { name: "implementer", description: "writes", builtIn: true },
    ], undefined, {
      throughputModels: [{ providerID: "openrouter", modelID: "z-ai/glm-5.3" }],
      advisorModels: [{ providerID: "openrouter", modelID: "z-ai/glm-5.3" }],
    })

    expect(config.provider?.openrouter?.models?.["z-ai/glm-5.3"]).toEqual({ options: { provider: { sort: "throughput" } } })
    expect(config.provider?.openrouter?.models?.["convoy-advisor-z-ai/glm-5.3"]).toMatchObject({
      id: "z-ai/glm-5.3",
      limit: { output: 2048 },
    })
  })
})
