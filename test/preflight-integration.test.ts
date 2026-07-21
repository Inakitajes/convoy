import { beforeEach, expect, mock, test } from "bun:test"

import type { RunPlan } from "../src/types"

const close = mock(() => {})
let providerResponseData: unknown

mock.module("../src/opencode", () => ({
  startOpencode: async () => ({
    client: {
      provider: {
        list: async () => ({ data: providerResponseData }),
      },
    },
    url: "http://127.0.0.1:1234",
    close,
  }),
}))

beforeEach(() => {
  close.mockClear()
  providerResponseData = {
    all: [
      {
        id: "vercel",
        models: {
          "openai/gpt-5.6-sol": { name: "GPT-5.6 Sol", variants: {} },
        },
      },
    ],
    connected: ["vercel"],
    default: {},
  }
})

test("preflight accepts connected providers and their models", async () => {
  const { preflightRunPlan } = await import("../src/preflight")

  await expect(preflightRunPlan(plan())).resolves.toBeUndefined()
  expect(close).toHaveBeenCalledTimes(1)
})

test("preflight reports an incompatible OpenCode discovery contract", async () => {
  providerResponseData = []
  const { preflightRunPlan } = await import("../src/preflight")

  await expect(preflightRunPlan(plan())).rejects.toThrow("OpenCode 1.18.4 or newer is required")
  expect(close).toHaveBeenCalledTimes(1)
})

function plan(): RunPlan {
  return {
    prompt: { source: "inline", text: "ship it" },
    target: { directory: "/repo", baseRef: "main", worktree: false, dirty: false },
    pipeline: {
      name: "implement",
      steps: [
        {
          type: "agent",
          name: "implementer",
          stepName: "implementer",
          groupId: "g1",
          agentName: "implementer",
          description: "Implements",
          model: "vercel/openai/gpt-5.6-sol",
          resolvedModel: {
            configured: "openai/gpt-5.6-sol",
            logical: "openai/gpt-5.6-sol",
            gateway: "vercel",
            providerID: "vercel",
            modelID: "openai/gpt-5.6-sol",
            target: "vercel/openai/gpt-5.6-sol",
          },
          inputFiles: ["prd.md"],
          inputDiff: false,
          reportPath: "reports/implementer.md",
        },
      ],
    },
    modelRouting: { gateway: "vercel" },
    hooks: { pre: [], post: [] },
    attachments: [],
    permissions: "interactive",
    maxAttempts: 2,
  }
}
