import { expect, test } from "bun:test"

import type { Provider } from "@opencode-ai/sdk/v2"

import { providerDiscovery } from "../src/opencode-discovery"

test("normalizes connected providers, models, and variant maps", () => {
  const provider = {
    id: "openai",
    models: {
      "gpt-5.6-sol": {
        name: "GPT-5.6 Sol",
        status: "active",
        limit: { context: 400_000 },
        variants: { medium: {}, xhigh: {} },
      },
    },
  } as unknown as Provider

  expect(providerDiscovery({ all: [provider], connected: ["openai"] })).toEqual({
    providers: [{ id: "openai", disabled: false }],
    models: [
      {
        providerID: "openai",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        status: "active",
        limit: { context: 400_000 },
        variants: [{ id: "medium" }, { id: "xhigh" }],
      },
    ],
  })
})
