import { describe, expect, test } from "bun:test"

import { helperRoles, resolveHelperRoutes, runHelper, titleIsDeterministic } from "../src/runners/helpers"

describe("helper routing port", () => {
  test("unspecified helper roles inherit the run's route", () => {
    const routes = resolveHelperRoutes({
      defaultRunner: "claude-code",
      defaultModel: { runner: "claude-code", modelId: "sonnet" },
    })
    expect(helperRoles.every((role) => routes[role].runner === "claude-code")).toBe(true)
    expect(routes["commit-message"].model?.modelId).toBe("sonnet")
  })

  test("an explicit helper route is preserved", () => {
    const routes = resolveHelperRoutes({
      config: { "branch-name": { runner: "opencode", model: { runner: "opencode", modelId: "openai/gpt" } } },
      defaultRunner: "claude-code",
    })
    expect(routes["branch-name"]).toEqual({ role: "branch-name", runner: "opencode", model: { runner: "opencode", modelId: "openai/gpt" } })
    expect(routes["commit-message"].runner).toBe("claude-code")
  })

  test("titles are deterministic and gain no model dependency", () => {
    expect(titleIsDeterministic).toBe(true)
    expect(helperRoles).not.toContain("title" as never)
  })

  test("runHelper dispatches by runner and fails closed without an executor", async () => {
    const route = { role: "commit-message" as const, runner: "claude-code" as const }
    await expect(runHelper(route, "x", { "claude-code": async () => "ok" })).resolves.toBe("ok")
    await expect(runHelper(route, "x", {})).rejects.toThrow(/no helper executor/)
  })
})
