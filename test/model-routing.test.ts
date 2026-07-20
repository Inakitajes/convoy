import { describe, expect, test } from "bun:test"

import { logicalModel, resolveModel } from "../src/model-routing"

describe("model gateway routing", () => {
  test("routes OpenAI and Anthropic through every gateway", () => {
    expect(resolveModel("openai/gpt-5.6-sol#xhigh", "direct").target).toBe("openai/gpt-5.6-sol#xhigh")
    expect(resolveModel("anthropic/claude-opus-4.8", "openrouter").target).toBe("openrouter/anthropic/claude-opus-4.8")
    expect(resolveModel("anthropic/claude-opus-4.8", "vercel")).toMatchObject({
      providerID: "vercel",
      modelID: "anthropic/claude-opus-4.8",
    })
  })

  test("unwraps an existing gateway and does not duplicate prefixes", () => {
    expect(resolveModel("openrouter/anthropic/claude-opus-4.8", "vercel").target).toBe("vercel/anthropic/claude-opus-4.8")
    expect(resolveModel("vercel/openai/gpt-5.6-sol#high", "openrouter").target).toBe("openrouter/openai/gpt-5.6-sol#high")
  })

  test("normalizes zai and z-ai while preserving the logical identity", () => {
    expect(logicalModel("openrouter/z-ai/glm-5.2").model).toBe("zai/glm-5.2")
    expect(resolveModel("openrouter/z-ai/glm-5.2", "direct").target).toBe("zai/glm-5.2")
    expect(resolveModel("zai/glm-5.2", "openrouter").target).toBe("openrouter/z-ai/glm-5.2")
    expect(resolveModel("openrouter/z-ai/glm-5.2", "vercel").target).toBe("vercel/zai/glm-5.2")
  })

  test("configured remains literal", () => {
    expect(resolveModel("custom/private/model#v2", "configured").target).toBe("custom/private/model#v2")
  })

  test("explicit overrides enable otherwise unsafe custom routes", () => {
    expect(resolveModel("custom/private-model#fast", "vercel", { "custom/private-model": { vercel: "vercel/acme/private-model" } }).target).toBe(
      "vercel/acme/private-model#fast",
    )
    expect(() => resolveModel("custom/private-model", "vercel")).toThrow("modelRouting.overrides")
  })
})
