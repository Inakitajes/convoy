import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assertEnforcementReady } from "../src/runners/claude/enforcement"
import { buildEnforcementPlan, composeRunners } from "../src/runners/compose"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("runner composition", () => {
  test("builds a ready enforcement plan from concrete commands", () => {
    const plan = buildEnforcementPlan({ hookCommand: "convoy hook", permissionCommand: "convoy-mcp", permissionArgs: ["permission"] })
    expect(() => assertEnforcementReady(plan)).not.toThrow()
    expect(plan.permissionPromptTool).toBe("mcp__convoy__permission")
    expect(plan.mcpConfig).toEqual({ mcpServers: { convoy: { command: "convoy-mcp", args: ["permission"] } } })
  })

  test("composes both adapters (with enforcement) behind the registry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-compose-"))
    dirs.push(dir)
    const composition = composeRunners({
      cwd: dir,
      enforcement: buildEnforcementPlan({ hookCommand: "convoy hook", permissionCommand: "convoy-mcp" }),
    })
    expect(composition.registry.list()).toEqual(["opencode", "claude-code", "codex"])
    await composition.close()
  })
})
