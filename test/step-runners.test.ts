import { describe, expect, test } from "bun:test"

import {
  isStepRunnerId,
  modelOverrideTargetsRunner,
  normalizeStepRunnerModel,
  parseModelOverride,
  resolveStepRunnerCapabilities,
  stepRunnerCapabilityReason,
  stepRunnerFor,
  stepRunnerModel,
} from "../src/step-runners"

describe("stepRunnerFor", () => {
  test("returns opencode definition by default", () => {
    const runner = stepRunnerFor()
    expect(runner.id).toBe("opencode")
    expect(runner.displayName).toBe("OpenCode")
  })

  test("returns opencode definition", () => {
    const runner = stepRunnerFor("opencode")
    expect(runner.id).toBe("opencode")
    expect(runner.displayName).toBe("OpenCode")
    expect(runner.capabilities.advisor).toBe(true)
    expect(runner.capabilities.liveAttach).toBe(true)
    expect(runner.capabilities.writeSteps).toBe(true)
    expect(runner.capabilities.modelFanout).toBe(true)
  })

  test("resolves Claude Code capabilities from the capability model, not a brand flag", () => {
    const runner = stepRunnerFor("claude-code")
    expect(runner.id).toBe("claude-code")
    expect(runner.displayName).toBe("Claude Code")
    // Claude supports the full execution surface, advisors included; only
    // native attach, quiesced takeover, and the unqualified override are off.
    expect(runner.capabilities.writeSteps).toBe(true)
    expect(runner.capabilities.verifySteps).toBe(true)
    expect(runner.capabilities.modelFanout).toBe(true)
    expect(runner.capabilities.liveAttach).toBe(false)
    expect(runner.capabilities.takeover).toBe(false)
    expect(runner.capabilities.advisor).toBe(true)
    expect(runner.capabilities.globalModelOverride).toBe(false)
  })

  test("modelLabel formats correctly for opencode", () => {
    const runner = stepRunnerFor("opencode")
    expect(runner.modelLabel("gpt-4", "turbo")).toBe("gpt-4#turbo")
    expect(runner.modelLabel("gpt-4")).toBe("gpt-4")
  })

  test("modelLabel formats correctly for claude-code", () => {
    const runner = stepRunnerFor("claude-code")
    expect(runner.modelLabel("opus")).toBe("claude-code/opus")
    expect(runner.modelLabel("")).toBe("claude-code/default")
  })
})

describe("effective step-runner capabilities", () => {
  test("OpenCode on an unsupported runtime resolves write/verify/fan-out unavailable with a reason", () => {
    const capabilities = resolveStepRunnerCapabilities("opencode", { version: "1.18.4" })
    expect(capabilities.writeSteps).toBe(false)
    expect(capabilities.verifySteps).toBe(false)
    expect(capabilities.modelFanout).toBe(false)
    expect(stepRunnerCapabilityReason("opencode", "write", { version: "1.18.4" })).toContain("OpenCode 1.18.4 is not a supported V2 runtime")
  })

  test("a supported runtime leaves the flags available and reports no reason", () => {
    const capabilities = resolveStepRunnerCapabilities("claude-code", { enforcementReady: true })
    expect(capabilities.writeSteps).toBe(true)
    expect(capabilities.verifySteps).toBe(true)
    expect(capabilities.modelFanout).toBe(true)
    expect(stepRunnerCapabilityReason("claude-code", "write")).toBe("")
  })
})

describe("isStepRunnerId", () => {
  test("returns true for valid IDs", () => {
    expect(isStepRunnerId("opencode")).toBe(true)
    expect(isStepRunnerId("claude-code")).toBe(true)
  })

  test("returns false for invalid IDs", () => {
    expect(isStepRunnerId("unknown")).toBe(false)
    expect(isStepRunnerId("")).toBe(false)
    expect(isStepRunnerId(undefined)).toBe(false)
  })
})

describe("normalizeStepRunnerModel", () => {
  test("accepts any model for opencode", () => {
    expect(normalizeStepRunnerModel("opencode", "openai/gpt-4")).toBe("openai/gpt-4")
    expect(normalizeStepRunnerModel("opencode", "  anthropic/claude-opus-4  ")).toBe("anthropic/claude-opus-4")
  })

  test("accepts claude-code aliases", () => {
    expect(normalizeStepRunnerModel("claude-code", "opus")).toBe("opus")
    expect(normalizeStepRunnerModel("claude-code", "sonnet")).toBe("sonnet")
    expect(normalizeStepRunnerModel("claude-code", "haiku")).toBe("haiku")
  })

  test("strips anthropic/ prefix for claude-code", () => {
    expect(normalizeStepRunnerModel("claude-code", "anthropic/claude-opus-4")).toBe("claude-opus-4")
  })

  test("accepts valid claude-* model IDs", () => {
    expect(normalizeStepRunnerModel("claude-code", "claude-opus-4")).toBe("claude-opus-4")
    expect(normalizeStepRunnerModel("claude-code", "claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
  })

  test("throws for invalid models on claude-code", () => {
    expect(() => normalizeStepRunnerModel("claude-code", "gpt-4")).toThrow()
    expect(() => normalizeStepRunnerModel("claude-code", "random")).toThrow()
    expect(() => normalizeStepRunnerModel("claude-code", "")).toThrow()
  })

  test("rejects a #variant on a Claude model rather than silently dropping it", () => {
    expect(() => normalizeStepRunnerModel("claude-code", "opus#high")).toThrow(/#variant/)
    expect(() => normalizeStepRunnerModel("claude-code", "anthropic/claude-opus-4#high")).toThrow(/#variant/)
  })
})

describe("model override scope", () => {
  test("an unqualified override is OpenCode-only", () => {
    const override = parseModelOverride("anthropic/claude-opus-5")
    expect(override).toEqual({ model: "anthropic/claude-opus-5" })
    expect(modelOverrideTargetsRunner(override, "opencode")).toBe(true)
    expect(modelOverrideTargetsRunner(override, "claude-code")).toBe(false)
  })

  test("a runner-prefixed override is scoped to that runner", () => {
    expect(parseModelOverride("claude-code/opus")).toEqual({ scope: "claude-code", model: "opus" })
    expect(parseModelOverride("opencode/openai/gpt-5")).toEqual({ scope: "opencode", model: "openai/gpt-5" })
    expect(modelOverrideTargetsRunner(parseModelOverride("claude-code/opus"), "claude-code")).toBe(true)
    expect(modelOverrideTargetsRunner(parseModelOverride("claude-code/opus"), "opencode")).toBe(false)
  })

  test("an empty override targets neither runner", () => {
    expect(parseModelOverride("")).toEqual({ model: "" })
    expect(modelOverrideTargetsRunner(parseModelOverride(""), "opencode")).toBe(false)
    expect(modelOverrideTargetsRunner(parseModelOverride(""), "claude-code")).toBe(false)
  })
})

describe("stepRunnerModel", () => {
  test("returns model info for opencode without global override", () => {
    const result = stepRunnerModel("opencode", "openai/gpt-4", "turbo")
    expect(result.providerID).toBe("openai")
    expect(result.modelID).toBe("gpt-4")
    expect(result.variant).toBe("turbo")
    expect(result.label).toContain("gpt-4")
  })

  test("returns model info for claude-code", () => {
    const result = stepRunnerModel("claude-code", "opus")
    expect(result.providerID).toBe("claude-code")
    expect(result.modelID).toBe("opus")
    expect(result.label).toBe("claude-code/opus")
  })

  test("returns default model for claude-code when model is empty", () => {
    const result = stepRunnerModel("claude-code", "")
    expect(result.modelID).toBe("default")
  })

  test("applies an unqualified global override to opencode only", () => {
    const opencode = stepRunnerModel("opencode", "openai/gpt-4", undefined, "anthropic/claude-opus-4")
    expect(opencode.providerID).toBe("anthropic")
    expect(opencode.modelID).toBe("claude-opus-4")

    const claude = stepRunnerModel("claude-code", "opus", undefined, "anthropic/claude-opus-4")
    expect(claude.providerID).toBe("claude-code")
    expect(claude.modelID).toBe("opus")
  })

  test("applies a Claude-scoped override to claude-code only", () => {
    const claude = stepRunnerModel("claude-code", "opus", undefined, "claude-code/sonnet")
    expect(claude.providerID).toBe("claude-code")
    expect(claude.modelID).toBe("sonnet")

    const opencode = stepRunnerModel("opencode", "openai/gpt-4", undefined, "claude-code/sonnet")
    expect(opencode.providerID).toBe("openai")
    expect(opencode.modelID).toBe("gpt-4")
  })

  test("handles undefined runner ID (defaults to opencode)", () => {
    const result = stepRunnerModel(undefined, "openai/gpt-4")
    expect(result.providerID).toBe("openai")
    expect(result.modelID).toBe("gpt-4")
  })
})