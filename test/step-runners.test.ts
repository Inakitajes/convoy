import { describe, expect, test } from "bun:test"

import {
  claudeCodeModelAliases,
  createStepRunnerImpl,
  normalizeStepRunnerModel,
  stepRunnerFor,
  stepRunnerModel,
} from "../src/step-runners"

describe("step runner registry", () => {
  test("missing runner resolves to the OpenCode default", () => {
    const runner = stepRunnerFor()

    expect(runner.id).toBe("opencode")
    expect(runner.capabilities).toEqual({
      liveAttach: true,
      takeover: true,
      writeSteps: true,
      modelFanout: true,
      globalModelOverride: true,
    })
  })

  test("Claude Code exposes its constrained capabilities", () => {
    expect(stepRunnerFor("claude-code").capabilities).toEqual({
      liveAttach: false,
      takeover: false,
      writeSteps: false,
      modelFanout: false,
      globalModelOverride: false,
    })
  })

  test("normalizes supported Claude aliases and Anthropic model IDs", () => {
    expect(claudeCodeModelAliases).toEqual(["opus", "sonnet", "haiku"])
    expect(normalizeStepRunnerModel("claude-code", " opus ")).toBe("opus")
    expect(normalizeStepRunnerModel("claude-code", "claude-opus-4-8")).toBe("claude-opus-4-8")
    expect(normalizeStepRunnerModel("claude-code", "anthropic/claude-sonnet-5")).toBe("claude-sonnet-5")
  })

  test("rejects non-Anthropic and malformed Claude model values", () => {
    const message = "runner claude-code executes Anthropic models"
    expect(() => normalizeStepRunnerModel("claude-code", "openai/gpt-5.6")).toThrow(message)
    expect(() => normalizeStepRunnerModel("claude-code", "anthropic/not-claude")).toThrow(message)
    expect(() => normalizeStepRunnerModel("claude-code", "opus#high")).toThrow(message)
    expect(() => normalizeStepRunnerModel("claude-code", "")).toThrow(message)
  })

  test("keeps OpenCode provider/model validation in the same registry", () => {
    expect(normalizeStepRunnerModel("opencode", " openai/gpt-5.6#xhigh ")).toBe("openai/gpt-5.6#xhigh")
    expect(() => normalizeStepRunnerModel("opencode", "opus")).toThrow("provider/model")
  })

  test("selects models according to each runner's override capability", () => {
    expect(stepRunnerModel(undefined, "openai/gpt-5.6", "high", "openrouter/z-ai/glm-5.2#max")).toEqual({
      providerID: "openrouter",
      modelID: "z-ai/glm-5.2",
      variant: "max",
      label: "openrouter/z-ai/glm-5.2#max",
    })
    expect(stepRunnerModel("claude-code", "opus", undefined, "openai/gpt-5.6#xhigh")).toEqual({
      providerID: "claude-code",
      modelID: "opus",
      label: "claude-code/opus",
    })
    expect(stepRunnerModel("claude-code", "", undefined, "openai/gpt-5.6#xhigh").label).toBe("claude-code/default")
  })

  test("binds execution without coupling the definitions registry to implementations", async () => {
    const runner = createStepRunnerImpl("claude-code", async (value: number) => value * 2)

    expect(runner.id).toBe("claude-code")
    expect(runner.capabilities.takeover).toBe(false)
    expect(await runner.executeAttempt(4)).toBe(8)
  })
})
