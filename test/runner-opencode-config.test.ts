import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { LogicalAgent } from "../src/runners/contracts"
import { createOpencodeRunner } from "../src/runners/opencode/adapter"
import {
  buildOpencodeConfig,
  encodeOpencodeConfigContent,
  modePermissionRules,
  modelString,
  permissionAction,
  permissionRulesFor,
  translateAgent,
} from "../src/runners/opencode/config"

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-config-"))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const alpha: LogicalAgent = {
  name: "convoy-alpha",
  instructions: "You are alpha.",
  mode: "read-only",
  model: { runner: "opencode", modelId: "nan/deepseek-v4-flash", variant: "high" },
  tools: { deny: ["write"] },
}

describe("opencode v2 config translation (unit)", () => {
  test("renders model strings and maps tool names to v2 actions", () => {
    expect(modelString({ runner: "opencode", modelId: "openai/gpt" })).toBe("openai/gpt")
    expect(modelString({ runner: "opencode", modelId: "openai/gpt", variant: "high" })).toBe("openai/gpt#high")
    expect(permissionAction("write")).toBe("edit")
    expect(permissionAction("bash")).toBe("shell")
    expect(permissionAction("task")).toBe("subagent")
    expect(permissionAction("grep")).toBe("grep")
  })

  test("read-only denies edit/shell/subagent; verify allows shell", () => {
    expect(modePermissionRules("read-only")).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ])
    expect(modePermissionRules("verify")).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ])
    expect(modePermissionRules("write")).toEqual([])
  })

  test("merges mode rules with explicit tool intent", () => {
    const rules = permissionRulesFor(alpha)
    expect(rules).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
    // explicit deny of write maps onto edit as well (deduped by action intent, not asserted here)
    expect(rules.filter((rule) => rule.action === "edit").length).toBeGreaterThanOrEqual(1)
  })

  test("produces native v2 plural shapes", () => {
    const config = buildOpencodeConfig({ agents: [alpha], defaultModel: alpha.model })
    expect(config.model).toBe("nan/deepseek-v4-flash#high")
    expect(Object.keys(config.agents ?? {})).toEqual(["convoy-alpha"])
    expect(config.agents?.["convoy-alpha"]?.system).toBe("You are alpha.")
    expect(config.agents?.["convoy-alpha"]?.model).toBe("nan/deepseek-v4-flash#high")
    expect(translateAgent(alpha).mode).toBe("all")
    expect(JSON.parse(encodeOpencodeConfigContent(config))).toEqual(config)

    const withPolicy = buildOpencodeConfig({
      agents: [alpha],
      permissions: [{ action: "shell", resource: "git push *", effect: "deny" }],
    })
    expect(withPolicy.permissions).toEqual([{ action: "shell", resource: "git push *", effect: "deny" }])
  })
})

describe("opencode v2 config injection (live runtime, no model calls)", () => {
  test("registers the rendered agent and keeps runs isolated without mutating the parent env", async () => {
    const dir = await tempDir()
    const before = process.env.OPENCODE_CONFIG_CONTENT
    const content = encodeOpencodeConfigContent(buildOpencodeConfig({ agents: [alpha] }))

    const runner = createOpencodeRunner({ cwd: dir, configContent: content })
    const beta: LogicalAgent = {
      name: "convoy-beta",
      mode: "write",
      model: { runner: "opencode", modelId: "nan/deepseek-v4-flash" },
    }
    const runnerB = createOpencodeRunner({
      cwd: dir,
      configContent: encodeOpencodeConfigContent(buildOpencodeConfig({ agents: [beta] })),
    })
    try {
      const agents = await runner.registeredAgents()
      expect(agents).toContain("convoy-alpha")

      const agentsB = await runnerB.registeredAgents()
      expect(agentsB).toContain("convoy-beta")
      // Isolation: runner B never sees runner A's agent.
      expect(agentsB).not.toContain("convoy-alpha")

      expect(process.env.OPENCODE_CONFIG_CONTENT).toBe(before)
    } finally {
      await runner.close()
      await runnerB.close()
    }
  }, 60_000)
})
