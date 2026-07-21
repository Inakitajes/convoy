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
      validatePreflightTargets(preflightTargets(plan()), [{ id: "vercel", disabled: false }], [{ providerID: "vercel", id: "openai/gpt-5.6-sol" }]),
    ).not.toThrow()
  })

  test("reports Vercel authentication guidance when its provider is disabled", () => {
    expect(() => validatePreflightTargets(preflightTargets(plan()), [{ id: "vercel", disabled: true }], [])).toThrow(
      "Missing provider credentials: vercel",
    )
    expect(() => validatePreflightTargets(preflightTargets(plan()), [{ id: "vercel", disabled: true }], [])).toThrow(
      "AI_GATEWAY_API_KEY",
    )
  })

  test("reports the logical and exact physical target when a model is unavailable", () => {
    const targets = preflightTargets(plan())

    expect(() => validatePreflightTargets(targets, [{ id: "vercel", disabled: false }], [])).toThrow("Model unavailable through Vercel AI Gateway")
    expect(() => validatePreflightTargets(targets, [{ id: "vercel", disabled: false }], [])).toThrow("logical: openai/gpt-5.6-sol")
    expect(() => validatePreflightTargets(targets, [{ id: "vercel", disabled: false }], [])).toThrow("target:  vercel/openai/gpt-5.6-sol")
  })

  test("accepts a discovered model variant", () => {
    const targets = preflightTargets(plan())
    targets[0]!.variant = "xhigh"
    targets[0]!.target = "vercel/openai/gpt-5.6-sol#xhigh"

    expect(() =>
      validatePreflightTargets(
        targets,
        [{ id: "vercel", disabled: false }],
        [{ providerID: "vercel", id: "openai/gpt-5.6-sol", variants: [{ id: "xhigh" }] }],
      ),
    ).not.toThrow()
  })

  test("rejects a model variant absent from discovery", () => {
    const targets = preflightTargets(plan())
    targets[0]!.variant = "turbo"
    targets[0]!.target = "vercel/openai/gpt-5.6-sol#turbo"

    expect(() =>
      validatePreflightTargets(
        targets,
        [{ id: "vercel", disabled: false }],
        [{ providerID: "vercel", id: "openai/gpt-5.6-sol", variants: [{ id: "xhigh" }] }],
      ),
    ).toThrow("Model variant unavailable through Vercel AI Gateway")
  })
})
