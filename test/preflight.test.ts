import { describe, expect, test } from "bun:test"

import { preflightTargets, validatePreflightTargets } from "../src/preflight-validation"
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

  test("accepts discovered providers and physical model IDs", () => {
    expect(() =>
      validatePreflightTargets(preflightTargets(plan()), [{ id: "vercel", enabled: true }], [{ providerID: "vercel", id: "openai/gpt-5.6-sol" }]),
    ).not.toThrow()
  })

  test("accepts OpenCode 1.18 location-enveloped discovery lists", () => {
    expect(() =>
      validatePreflightTargets(
        preflightTargets(plan()),
        { data: [{ id: "vercel" }] },
        { data: [{ providerID: "vercel", id: "openai/gpt-5.6-sol" }] },
      ),
    ).not.toThrow()
  })

  test("reports Vercel authentication guidance when its provider is disabled", () => {
    expect(() => validatePreflightTargets(preflightTargets(plan()), [{ id: "vercel", enabled: false }], [])).toThrow(
      "Missing provider credentials: vercel",
    )
    expect(() => validatePreflightTargets(preflightTargets(plan()), [{ id: "vercel", enabled: false }], [])).toThrow(
      "AI_GATEWAY_API_KEY",
    )
  })

  test("recognizes the current disabled provider field", () => {
    expect(() => validatePreflightTargets(preflightTargets(plan()), { data: [{ id: "vercel", disabled: true }] }, { data: [] })).toThrow(
      "Missing provider credentials: vercel",
    )
  })

  test("reports the logical and exact physical target when a model is unavailable", () => {
    const targets = preflightTargets(plan())

    expect(() => validatePreflightTargets(targets, [{ id: "vercel", enabled: true }], [])).toThrow("Model unavailable through Vercel AI Gateway")
    expect(() => validatePreflightTargets(targets, [{ id: "vercel", enabled: true }], [])).toThrow("logical: openai/gpt-5.6-sol")
    expect(() => validatePreflightTargets(targets, [{ id: "vercel", enabled: true }], [])).toThrow("target:  vercel/openai/gpt-5.6-sol")
  })
})
