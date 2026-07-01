import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { loadAgentPrompt, opencodeConfig } from "../src/agents"

describe("opencode config", () => {
  test("disables total provider timeouts but keeps idle stream timeouts", () => {
    const config = opencodeConfig("/tmp/archer-run")

    for (const provider of ["anthropic", "openai", "openrouter"]) {
      expect(config.provider?.[provider]?.options?.timeout).toBe(false)
      expect(config.provider?.[provider]?.options?.chunkTimeout).toBe(600_000)
    }
  })

  test("loads built-in markdown prompts with runtime safety guard rails", () => {
    const prompt = loadAgentPrompt("implementer", "/tmp/non-existent-archer-target")

    expect(prompt).toContain("# Implementer")
    expect(prompt).toContain("# Archer Runtime Safety")
    expect(prompt).toContain("not replaceable")
  })

  test("project agent prompts replace built-ins but keep runtime safety", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-agents-"))
    try {
      await mkdir(join(dir, ".archer", "agents"), { recursive: true })
      await writeFile(join(dir, ".archer", "agents", "implementer.md"), "# Custom Implementer\n\nProject-specific prompt.")

      const prompt = loadAgentPrompt("implementer", dir)

      expect(prompt.startsWith("# Custom Implementer")).toBe(true)
      expect(prompt).toContain("Project-specific prompt.")
      expect(prompt).not.toContain("# Implementer\n\nYou are the **implementer**")
      expect(prompt).toContain("# Archer Runtime Safety")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("project agents need a prompt file", () => {
    expect(() => loadAgentPrompt("ghost", "/tmp/non-existent-archer-target")).toThrow("create .archer/agents/ghost.md")
  })

  test("project agents land in the opencode config with their prompt and temperature", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-custom-agent-"))
    try {
      await mkdir(join(dir, ".archer", "agents"), { recursive: true })
      await writeFile(join(dir, ".archer", "agents", "api-reviewer.md"), "# API Reviewer\n\nReview the API surface.")

      const config = opencodeConfig("/tmp/archer-run", dir, [
        { name: "implementer", description: "Implements", builtIn: true },
        { name: "api-reviewer", description: "Reviews APIs", temperature: 0.3, builtIn: false },
      ])

      const custom = config.agent?.["api-reviewer"]
      expect(custom?.description).toBe("Reviews APIs")
      expect(custom?.temperature).toBe(0.3)
      expect(custom?.prompt).toContain("# API Reviewer")
      expect(custom?.prompt).toContain("# Archer Runtime Safety")
      expect(config.agent?.implementer?.temperature).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a synthesized forced-read-only agent (__ro suffix) loads the base agent's prompt, not its own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-ro-variant-"))
    try {
      await mkdir(join(dir, ".archer", "agents"), { recursive: true })
      await writeFile(join(dir, ".archer", "agents", "clean-code.md"), "# Clean Code\n\nLook for unnecessary complexity.")

      // Only "clean-code" has a prompt file on disk; "clean-code__ro" is
      // synthesized by synthesizeReadOnlyAgents and must not need its own.
      const config = opencodeConfig("/tmp/archer-run", dir, [
        { name: "clean-code", description: "Clean code review", builtIn: false },
        { name: "clean-code__ro", description: "Clean code review", readOnly: true, builtIn: false },
      ])

      const forced = config.agent?.["clean-code__ro"]
      expect(forced?.prompt).toContain("# Clean Code")
      expect(forced?.prompt).toContain("Look for unnecessary complexity.")
      expect(forced?.tools?.write).toBe(false)
      expect(forced?.tools?.edit).toBe(false)
      expect(forced?.tools?.bash).toBe(false)
      // The base agent's own config is untouched: still writable.
      expect(config.agent?.["clean-code"]?.tools?.write).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("read-only agents cannot write, edit, or run shell commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-readonly-agent-"))
    try {
      await mkdir(join(dir, ".archer", "agents"), { recursive: true })
      await writeFile(join(dir, ".archer", "agents", "audit-only.md"), "# Audit Only\n\nReview without editing.")

      const config = opencodeConfig("/tmp/archer-run", dir, [{ name: "audit-only", description: "Audits only", readOnly: true, builtIn: false }])

      const audit = config.agent?.["audit-only"]
      expect(audit?.tools?.read).toBe(true)
      expect(audit?.tools?.glob).toBe(true)
      expect(audit?.tools?.grep).toBe(true)
      expect(audit?.tools?.list).toBe(true)
      expect(audit?.tools?.write).toBe(false)
      expect(audit?.tools?.edit).toBe(false)
      expect(audit?.tools?.bash).toBe(false)
      expect(audit?.permission).toMatchObject({ edit: "deny", bash: "deny", task: "deny", question: "deny" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
