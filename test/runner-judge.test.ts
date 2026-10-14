import { describe, expect, test } from "bun:test"

import type { ModelReference } from "../src/runners/contracts"
import { resolveJudgeRoute } from "../src/runners/judge"

const claudeModel: ModelReference = { runner: "claude-code", modelId: "opus" }

describe("smart judge routing", () => {
  test("preserves an explicit Claude judge route and auth mode", () => {
    const { route, error } = resolveJudgeRoute({
      judge: {
        runner: "claude-code",
        model: { runner: "claude-code", modelId: "opus", variant: "high" },
        authMode: "api-key",
      },
    })
    expect(error).toBeUndefined()
    expect(route).toEqual({
      runner: "claude-code",
      model: { runner: "claude-code", modelId: "opus", variant: "high" },
      auth: { mode: "api-key" },
    })
  })

  test("defaults the resolved auth mode to subscription", () => {
    const { route, error } = resolveJudgeRoute({
      judge: { runner: "opencode", model: { runner: "opencode", modelId: "openai/gpt-5" } },
    })
    expect(error).toBeUndefined()
    expect(route).toEqual({
      runner: "opencode",
      model: { runner: "opencode", modelId: "openai/gpt-5" },
      auth: { mode: "subscription" },
    })
  })

  test("resolves a Claude-only judge without OpenCode", () => {
    const { route, error } = resolveJudgeRoute(
      { judge: { runner: "claude-code", model: claudeModel } },
      { hasRunner: (id) => id === "claude-code" },
    )
    expect(error).toBeUndefined()
    expect(route?.runner).toBe("claude-code")
    expect(route?.auth).toEqual({ mode: "subscription" })
  })

  test("an unavailable judge runner is an error, not a silent substitution", () => {
    const { route, error } = resolveJudgeRoute(
      { judge: { runner: "opencode", model: { runner: "opencode", modelId: "openai/gpt-5" } } },
      { hasRunner: (id) => id === "claude-code" },
    )
    expect(route).toBeUndefined()
    expect(error).toContain("opencode")
    // It must not silently change the runner to the one that is installed.
    expect(error).not.toContain("claude-code")
  })

  test("a runner without a model is an error", () => {
    const { route, error } = resolveJudgeRoute({ judge: { runner: "claude-code" } })
    expect(route).toBeUndefined()
    expect(error).toContain("model")
  })

  test("a judge runner/model mismatch is an error", () => {
    const { route, error } = resolveJudgeRoute({
      judge: { runner: "claude-code", model: { runner: "opencode", modelId: "openai/gpt-5" } },
    })
    expect(route).toBeUndefined()
    expect(error).toContain("match")
  })

  test("no judge configured resolves to no route", () => {
    expect(resolveJudgeRoute({})).toEqual({})
  })

  test("an auth-only selection without a runner is an error", () => {
    const { route, error } = resolveJudgeRoute({ judge: { authMode: "subscription" } })
    expect(route).toBeUndefined()
    expect(error).toContain("runner")
  })

  test("availability is not checked when capabilities are omitted", () => {
    const { route, error } = resolveJudgeRoute({
      judge: { runner: "opencode", model: { runner: "opencode", modelId: "openai/gpt-5" } },
    })
    expect(error).toBeUndefined()
    expect(route?.runner).toBe("opencode")
  })
})
