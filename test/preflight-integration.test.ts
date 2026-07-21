import { beforeEach, expect, mock, test } from "bun:test"

import type { RunPlan } from "../src/types"

const close = mock(() => {})
let providerResponseData: unknown
let modelResponseData: unknown

mock.module("../src/opencode", () => ({
  startOpencode: async () => ({
    client: {
      v2: {
        provider: {
          list: async () => ({ data: providerResponseData }),
        },
        model: {
          list: async () => ({ data: modelResponseData }),
        },
      },
    },
    url: "http://127.0.0.1:1234",
    close,
  }),
}))

beforeEach(() => {
  close.mockClear()
  providerResponseData = {
    location: { directory: "/repo" },
    data: [{ id: "vercel", disabled: false }],
  }
  modelResponseData = {
    location: { directory: "/repo" },
    data: [{ providerID: "vercel", id: "openai/gpt-5.6-sol" }],
  }
})

test("preflight accepts location-scoped provider and model discovery", async () => {
  const { preflightRunPlan } = await import("../src/preflight")

  await expect(preflightRunPlan(plan())).resolves.toBeUndefined()
  expect(close).toHaveBeenCalledTimes(1)
})

test("preflight reports an incompatible OpenCode discovery contract", async () => {
  providerResponseData = [{ id: "vercel", enabled: true }]
  modelResponseData = [{ providerID: "vercel", id: "openai/gpt-5.6-sol" }]
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
