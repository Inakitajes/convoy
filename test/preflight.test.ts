import { describe, expect, test } from "bun:test"

import { preflightTargets, validatePreflightTargets } from "../src/preflight-validation"
import { preflightRunPlan } from "../src/preflight"
import type { RunPlan } from "../src/types"

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

function directOpenAIPlan(): RunPlan {
  const result = plan()
  const step = result.pipeline.steps[0]!
  if (step.type !== "agent") throw new Error("expected agent step")
  step.model = "openai/gpt-5.6-terra"
  step.variant = "xhigh"
  step.resolvedModel = {
    configured: "openai/gpt-5.6-terra#xhigh",
    logical: "openai/gpt-5.6-terra#xhigh",
    gateway: "configured",
    providerID: "openai",
    modelID: "gpt-5.6-terra",
    variant: "xhigh",
    target: "openai/gpt-5.6-terra#xhigh",
  }
  result.modelRouting.gateway = "configured"
  return result
}

function catalog(input: { providerID?: string; connected?: boolean; modelID?: string; variants?: string[] } = {}) {
  const providerID = input.providerID ?? "vercel"
  const modelID = input.modelID ?? "openai/gpt-5.6-sol"
  return {
    all: [
      {
        id: providerID,
        models: {
          [modelID]: { variants: Object.fromEntries((input.variants ?? []).map((variant) => [variant, {}])) },
        },
      },
    ],
    connected: input.connected === false ? [] : [providerID],
  }
}

describe("OpenCode run-plan preflight", () => {
  test("collects OpenCode steps, smart judge, and branch namer targets — never Claude Code", () => {
    const reviewed = plan()
    reviewed.pipeline.steps.push({
      type: "agent",
      name: "external-audit",
      stepName: "external-audit",
      groupId: "g2",
      agentName: "external-audit",
      description: "External audit",
      runner: "claude-code",
      model: "opus",
      inputFiles: ["prd.md"],
      inputDiff: false,
      reportPath: "reports/external-audit.md",
      readOnly: true,
    })
    reviewed.smartJudge = {
      model: {
        configured: "anthropic/claude-haiku-4.5",
        logical: "anthropic/claude-haiku-4.5",
        gateway: "vercel",
        providerID: "vercel",
        modelID: "anthropic/claude-haiku-4.5",
        target: "vercel/anthropic/claude-haiku-4.5",
      },
    }
    reviewed.branchNamer = {
      model: {
        configured: "anthropic/claude-haiku-4-5",
        logical: "anthropic/claude-haiku-4-5",
        gateway: "vercel",
        providerID: "vercel",
        modelID: "anthropic/claude-haiku-4-5",
        target: "vercel/anthropic/claude-haiku-4-5",
      },
    }

    expect(preflightTargets(reviewed).map((target) => target.target)).toEqual([
      "vercel/openai/gpt-5.6-sol",
      "vercel/anthropic/claude-haiku-4.5",
      "vercel/anthropic/claude-haiku-4-5",
    ])
  })

  test("accepts connected providers and exact physical model IDs", () => {
    expect(() => validatePreflightTargets(preflightTargets(plan()), catalog())).not.toThrow()
  })

  test("accepts the classic connected OpenAI catalog used by session.prompt", () => {
    expect(() =>
      validatePreflightTargets(
        preflightTargets(directOpenAIPlan()),
        catalog({ providerID: "openai", modelID: "gpt-5.6-terra", variants: ["xhigh"] }),
      ),
    ).not.toThrow()
  })

  test("preflights the resolved run against classic discovery in its target directory", async () => {
    const reviewed = directOpenAIPlan()
    let discoveredDirectory: string | undefined

    await preflightRunPlan(reviewed, async (directory) => {
      discoveredDirectory = directory
      return catalog({ providerID: "openai", modelID: "gpt-5.6-terra", variants: ["xhigh"] })
    })

    expect(discoveredDirectory).toBe("/repo")
  })

  test("reports Vercel authentication guidance when it is not connected", () => {
    expect(() => validatePreflightTargets(preflightTargets(plan()), catalog({ connected: false }))).toThrow(
      "Missing provider credentials: vercel",
    )
    expect(() => validatePreflightTargets(preflightTargets(plan()), catalog({ connected: false }))).toThrow(
      "AI_GATEWAY_API_KEY",
    )
  })

  test("reports unavailable variants from the exact classic model catalog", () => {
    expect(() =>
      validatePreflightTargets(preflightTargets(directOpenAIPlan()), catalog({ providerID: "openai", modelID: "gpt-5.6-terra", variants: ["high"] })),
    ).toThrow("Model unavailable through As configured")
  })

  test("reports the logical and exact physical target when a model is unavailable", () => {
    const targets = preflightTargets(plan())
    const withoutTarget = catalog({ modelID: "some-other-model" })

    expect(() => validatePreflightTargets(targets, withoutTarget)).toThrow("Model unavailable through Vercel AI Gateway")
    expect(() => validatePreflightTargets(targets, withoutTarget)).toThrow("logical: openai/gpt-5.6-sol")
    expect(() => validatePreflightTargets(targets, withoutTarget)).toThrow("target:  vercel/openai/gpt-5.6-sol")
  })
})
