import { describe, expect, test } from "bun:test"

import type { Provider } from "@opencode-ai/sdk/v2"

import { parseModelsDev, toModelChoices } from "../src/model-catalog"

function provider(id: string, models: Array<{ id: string; name: string; status?: string; context?: number; variants?: string[] }>): Provider {
  return {
    id,
    models: Object.fromEntries(
      models.map((model) => [
        model.id,
        {
          id: model.id,
          providerID: id,
          name: model.name,
          status: model.status ?? "active",
          limit: { context: model.context ?? 0 },
          variants: Object.fromEntries((model.variants ?? []).map((variant) => [variant, {}])),
        },
      ]),
    ),
  } as unknown as Provider
}

describe("toModelChoices", () => {
  test("keeps connected providers and expands classic catalog variants", () => {
    const providers = [
      provider("openai", [{ id: "gpt-5.5", name: "GPT-5.5", context: 400_000, variants: ["xhigh", "high"] }]),
      provider("anthropic", [{ id: "claude-opus-4-7", name: "Opus" }]),
    ]

    const choices = toModelChoices(providers, ["openai"])
    expect(choices.map((choice) => choice.value)).toEqual(["openai/gpt-5.5", "openai/gpt-5.5#xhigh", "openai/gpt-5.5#high"])
    expect(choices[0]).toMatchObject({ value: "openai/gpt-5.5", label: "GPT-5.5", providerID: "openai", contextK: 400 })
    expect(choices[1]).toMatchObject({ value: "openai/gpt-5.5#xhigh", label: "GPT-5.5 (xhigh)" })
  })

  test("with no connected providers, keeps no models", () => {
    expect(toModelChoices([provider("x", [{ id: "m", name: "M" }])], [])).toEqual([])
  })

  test("surfaces a non-active status and skips it when active", () => {
    const providers = [provider("x", [{ id: "beta", name: "Beta", status: "beta" }, { id: "stable", name: "Stable" }])]
    const choices = toModelChoices(providers, ["x"])
    expect(choices[0]).toMatchObject({ status: "beta" })
    expect(choices[1]?.status).toBeUndefined()
  })

  test("dedupes repeated values", () => {
    const providers = [provider("x", [{ id: "m", name: "M" }]), provider("x", [{ id: "m", name: "M again" }])]
    expect(toModelChoices(providers, ["x"]).map((choice) => choice.value)).toEqual(["x/m"])
  })
})

describe("parseModelsDev", () => {
  test("flattens providers/models and sorts by value", () => {
    const data = {
      openai: { models: { "gpt-5.5": { name: "GPT-5.5", limit: { context: 400_000 } } } },
      anthropic: { models: { "claude-opus-4-7": { name: "Opus" } } },
    }
    const choices = parseModelsDev(data)
    expect(choices.map((choice) => choice.value)).toEqual(["anthropic/claude-opus-4-7", "openai/gpt-5.5"])
    expect(choices.find((choice) => choice.value === "openai/gpt-5.5")).toMatchObject({ label: "GPT-5.5", contextK: 400 })
  })

  test("tolerates providers without models", () => {
    expect(parseModelsDev({ openai: {} })).toEqual([])
  })
})
