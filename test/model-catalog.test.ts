import { describe, expect, test } from "bun:test"

import type { ModelV2Info, ProviderV2Info } from "@opencode-ai/sdk/v2"

import { parseModelsDev, toModelChoices } from "../src/model-catalog"

describe("toModelChoices", () => {
  test("keeps enabled providers, expands variants, preserves SDK order", () => {
    const providers = [
      { id: "openai", disabled: false },
      { id: "anthropic", disabled: true },
    ] as unknown as ProviderV2Info[]
    const models = [
      { providerID: "openai", id: "gpt-5.5", name: "GPT-5.5", status: "active", limit: { context: 400_000 }, variants: [{ id: "xhigh" }, { id: "high" }] },
      { providerID: "anthropic", id: "claude-opus-4-7", name: "Opus", status: "active", variants: [] },
    ] as unknown as ModelV2Info[]

    const choices = toModelChoices(providers, models)
    expect(choices.map((choice) => choice.value)).toEqual(["openai/gpt-5.5", "openai/gpt-5.5#xhigh", "openai/gpt-5.5#high"])
    expect(choices[0]).toMatchObject({ value: "openai/gpt-5.5", label: "GPT-5.5", providerID: "openai", contextK: 400 })
    expect(choices[1]).toMatchObject({ value: "openai/gpt-5.5#xhigh", label: "GPT-5.5 (xhigh)" })
  })

  test("still recognizes the former enabled provider field", () => {
    const providers = [
      { id: "openai", enabled: { via: "env", name: "OPENAI_API_KEY" } },
      { id: "anthropic", enabled: false },
    ] as unknown as ProviderV2Info[]
    const models = [
      { providerID: "openai", id: "gpt", name: "GPT", variants: [] },
      { providerID: "anthropic", id: "claude", name: "Claude", variants: [] },
    ] as unknown as ModelV2Info[]

    expect(toModelChoices(providers, models).map((choice) => choice.value)).toEqual(["openai/gpt"])
  })

  test("with no provider info, keeps every model", () => {
    const models = [{ providerID: "x", id: "m", name: "M", variants: [] }] as unknown as ModelV2Info[]
    expect(toModelChoices([], models).map((choice) => choice.value)).toEqual(["x/m"])
  })

  test("surfaces a non-active status and skips it when active", () => {
    const models = [
      { providerID: "x", id: "beta", name: "Beta", status: "beta", variants: [] },
      { providerID: "x", id: "stable", name: "Stable", status: "active", variants: [] },
    ] as unknown as ModelV2Info[]
    const choices = toModelChoices([], models)
    expect(choices[0]).toMatchObject({ status: "beta" })
    expect(choices[1]?.status).toBeUndefined()
  })

  test("dedupes repeated values", () => {
    const models = [
      { providerID: "x", id: "m", name: "M", variants: [] },
      { providerID: "x", id: "m", name: "M again", variants: [] },
    ] as unknown as ModelV2Info[]
    expect(toModelChoices([], models).map((choice) => choice.value)).toEqual(["x/m"])
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
