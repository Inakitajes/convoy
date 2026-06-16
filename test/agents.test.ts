import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { bashPolicy, denyBashPatterns, loadAgentPrompt, opencodeConfig, projectScriptAllowPatterns } from "../src/agents"

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

  test("global agent prompts replace built-ins but keep runtime safety", async () => {
    const previousHome = process.env.ARCHER_HOME
    const home = await mkdtemp(join(tmpdir(), "archer-agent-global-home-"))
    try {
      process.env.ARCHER_HOME = home
      await mkdir(join(home, "agents"), { recursive: true })
      await writeFile(join(home, "agents", "implementer.md"), "# Global Implementer\n\nGlobal prompt.")

      const prompt = loadAgentPrompt("implementer", "/tmp/non-existent-archer-target")

      expect(prompt.startsWith("# Global Implementer")).toBe(true)
      expect(prompt).toContain("Global prompt.")
      expect(prompt).toContain("# Archer Runtime Safety")
    } finally {
      if (previousHome === undefined) delete process.env.ARCHER_HOME
      else process.env.ARCHER_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  test("project prompt path beats a global prompt path", async () => {
    const previousHome = process.env.ARCHER_HOME
    const dir = await mkdtemp(join(tmpdir(), "archer-agent-global-prompt-"))
    const home = await mkdtemp(join(tmpdir(), "archer-agent-global-home-"))
    try {
      process.env.ARCHER_HOME = home
      await mkdir(join(home, "agents"), { recursive: true })
      await writeFile(join(home, "agents", "implementer.md"), "# Global Implementer\n\nGlobal prompt.")
      await mkdir(join(dir, ".archer", "agents"), { recursive: true })
      await writeFile(join(dir, ".archer", "agents", "implementer.md"), "# Local Implementer\n\nLocal prompt.")

      const prompt = loadAgentPrompt("implementer", dir)

      expect(prompt.startsWith("# Local Implementer")).toBe(true)
      expect(prompt).not.toContain("# Global Implementer")
    } finally {
      if (previousHome === undefined) delete process.env.ARCHER_HOME
      else process.env.ARCHER_HOME = previousHome
      await rm(dir, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  test("bash policy includes web checks and keeps dangerous operations denied", () => {
    const policy = bashPolicy()

    expect(policy["pnpm run lint*"]).toBe("allow")
    expect(policy["npm run typecheck*"]).toBe("allow")
    expect(policy["bun test*"]).toBe("allow")
    expect(policy["tsc --noEmit*"]).toBe("allow")
    expect(policy["git push*"]).toBe("deny")
    expect(policy["npm install*"]).toBe("deny")
    expect(policy["npm run deploy*"]).toBe("deny")
    expect(policy["*"]).toBe("ask")
  })

  test("bash policy avoids destructive allows and over-broad denies", () => {
    const policy = bashPolicy()

    // find -delete/-exec and git branch -D must fall through to ask
    expect(policy["find*"]).toBeUndefined()
    expect(policy["git branch*"]).toBeUndefined()
    expect(policy["git branch --list*"]).toBe("allow")
    expect(policy["git branch"]).toBe("allow")

    // su/gh denies must not swallow supabase, subl, ghc…
    expect(policy["su*"]).toBeUndefined()
    expect(policy["su"]).toBe("deny")
    expect(policy["su *"]).toBe("deny")
    expect(policy["gh*"]).toBeUndefined()
    expect(policy["gh"]).toBe("deny")
    expect(policy["gh *"]).toBe("deny")

    expect(policy["rm -fr ${HOME}*"]).toBe("deny")
    expect(policy["curl* | zsh*"]).toBe("deny")
  })

  test("bash policy allows common check commands across ecosystems", () => {
    const policy = bashPolicy()

    expect(policy["pytest*"]).toBe("allow")
    expect(policy["ruff check*"]).toBe("allow")
    expect(policy["go test*"]).toBe("allow")
    expect(policy["cargo clippy*"]).toBe("allow")
    expect(policy["make test"]).toBe("allow")
    expect(policy["jq*"]).toBe("allow")

    // only the known-safe make targets, never a blanket make
    expect(policy["make*"]).toBeUndefined()
    expect(policy["make deploy"]).toBeUndefined()
  })

  test("safe package.json scripts are allowlisted, dangerous names are not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-scripts-"))
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: {
            "test:unit": "vitest run",
            "type-check": "tsc --noEmit",
            format: "prettier --write .",
            deploy: "vercel deploy",
            "build:deploy": "build && push",
            seed: "node seed.js",
          },
        }),
      )

      const patterns = projectScriptAllowPatterns(dir)
      expect(patterns).toContain("npm run test:unit")
      expect(patterns).toContain("npm run test:unit *")
      expect(patterns).toContain("bun run type-check")
      expect(patterns).toContain("pnpm format")
      expect(patterns.some((pattern) => pattern.includes("deploy"))).toBe(false)
      expect(patterns.some((pattern) => pattern.includes("seed"))).toBe(false)

      const policy = bashPolicy(dir)
      expect(policy["yarn run format"]).toBe("allow")
      expect(policy["npm run deploy"]).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("project without package.json adds no script patterns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-noscripts-"))
    try {
      expect(projectScriptAllowPatterns(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("the denylist always wins: every deny pattern stays denied in the assembled policy", () => {
    const policy = bashPolicy()
    for (const pattern of denyBashPatterns) {
      expect(policy[pattern]).toBe("deny")
    }
    // --yolo never touches the policy: unknowns still surface as ask and are
    // resolved by archer's gate, where only ask-level requests can auto-allow.
    expect(policy["*"]).toBe("ask")
  })

  test("project permission additions extend the policy without weakening it", () => {
    const policy = bashPolicy("/tmp/non-existent-archer-target", {
      allow: ["supabase gen types*", "git push*"],
      deny: ["stripe *"],
    })

    expect(policy["supabase gen types*"]).toBe("allow")
    expect(policy["stripe *"]).toBe("deny")
    // A config allow can never resurrect a denied pattern.
    expect(policy["git push*"]).toBe("deny")
    expect(policy["*"]).toBe("ask")
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
})
