import { describe, expect, test } from "bun:test"

import { runReviewLines } from "../src/review-tui"

import type { ModelGateway, ResolvedModel } from "../src/model-routing"
import type { AgentStep, RunPlan, Step } from "../src/types"

function plain(lines: ReturnType<typeof runReviewLines>): string[] {
  return lines.map((line) => line.chunks.map((chunk) => chunk.text).join(""))
}

function agentStep(partial: Partial<AgentStep> & Pick<AgentStep, "name" | "stepName" | "groupId">): AgentStep {
  return {
    type: "agent",
    agentName: partial.name,
    description: "",
    model: "openai/gpt-5.6-sol",
    inputFiles: [],
    inputDiff: false,
    reportPath: `reports/${partial.name}.md`,
    ...partial,
  }
}

function resolved(logical: string, target: string, gateway: ModelGateway = "configured"): ResolvedModel {
  const [providerID, ...rest] = target.split("/")
  return { configured: logical, logical, gateway, providerID: providerID!, modelID: rest.join("/"), target }
}

function planWith(steps: Step[], extra: Partial<RunPlan> = {}): RunPlan {
  return {
    prompt: { source: "inline", text: "ship the feature" },
    target: { directory: "/repo", baseRef: "main", worktree: false, dirty: false },
    pipeline: { name: "implement", steps },
    modelRouting: { gateway: "configured" },
    hooks: { pre: [], post: [] },
    attachments: [],
    permissions: "interactive",
    maxAttempts: 2,
    ...extra,
  }
}

describe("run review TUI", () => {
  test("collapses identical logical/target models and shows routed pairs with an arrow", () => {
    const plan = planWith([
      agentStep({ name: "implementer", stepName: "implementer", groupId: "g1", resolvedModel: resolved("openai/gpt-5.6-sol", "openai/gpt-5.6-sol") }),
      agentStep({ name: "design", stepName: "design", groupId: "g2", resolvedModel: resolved("zai/glm-5.2", "openrouter/z-ai/glm-5.2") }),
    ])

    const lines = plain(runReviewLines(plan, 100))

    expect(lines.some((line) => line.includes("implementer · writable · 2 attempts"))).toBe(true)
    const solRows = lines.filter((line) => line.includes("gpt-5.6-sol"))
    expect(solRows).toHaveLength(1)
    expect(solRows[0]).not.toContain("→")
    expect(lines.some((line) => line.includes("zai/glm-5.2 → openrouter/z-ai/glm-5.2"))).toBe(true)
  })

  test("groups concurrent steps under one node and labels human gates", () => {
    const plan = planWith([
      agentStep({ name: "clean-code", stepName: "clean-code", groupId: "audit", readOnly: true, resolvedModel: resolved("openai/gpt-5.6-sol", "openai/gpt-5.6-sol") }),
      agentStep({ name: "security", stepName: "security", groupId: "audit", readOnly: true, resolvedModel: resolved("anthropic/claude-opus-4-8", "anthropic/claude-opus-4-8") }),
      { type: "human", name: "approve", description: "" },
    ])

    const lines = plain(runReviewLines(plan, 100))

    expect(lines.some((line) => line.includes("pipeline implement · 3 steps · 2 read-only · 1 manual"))).toBe(true)
    expect(lines.some((line) => line.includes("parallel · 2 runs · read-only · 2 attempts"))).toBe(true)
    expect(lines.some((line) => line.includes("├─ clean-code"))).toBe(true)
    expect(lines.some((line) => line.includes("└─ security"))).toBe(true)
    expect(lines.some((line) => line.includes("approve · manual gate"))).toBe(true)
  })

  test("shows the claude code engine and its CLI model without a resolved target", () => {
    const plan = planWith([agentStep({ name: "security", stepName: "security", groupId: "g1", runner: "claude-code", model: "opus", readOnly: true })])

    const lines = plain(runReviewLines(plan, 100))

    expect(lines.some((line) => line.includes("security · claude code · read-only · 2 attempts"))).toBe(true)
    expect(lines.some((line) => line.includes("claude-code/opus"))).toBe(true)
  })

  test("renders hooks, runtime judge, worktree intent, branch namer, and resume overrides", () => {
    const plan = planWith([], {
      target: { directory: "/repo", baseRef: "develop", worktree: true, dirty: false },
      modelRouting: { gateway: "openrouter" },
      smartJudge: { model: resolved("openai/gpt-5.6-terra#xhigh", "openrouter/openai/gpt-5.6-terra#xhigh", "openrouter") },
      branchNamer: { model: resolved("anthropic/claude-haiku-4-5", "openrouter/anthropic/claude-haiku-4-5", "openrouter") },
      hooks: { pre: [{ command: "pnpm lint" }], post: [{ command: "./notify.sh", when: "always" }] },
      attachments: ["a.md", "b.md"],
      permissions: "smart",
      resume: { runID: "20260720-135802-5bbh", gatewayOverride: { original: "vercel", pending: "openrouter" } },
    })

    const lines = plain(runReviewLines(plan, 100))

    expect(lines.some((line) => line.includes("gateway  OpenRouter"))).toBe(true)
    expect(lines.some((line) => line.includes("resume override · original Vercel AI Gateway · pending phases OpenRouter"))).toBe(true)
    expect(lines.some((line) => line.includes("worktree and branch created after confirmation"))).toBe(true)
    expect(lines.some((line) => line.includes("branch named by openrouter/anthropic/claude-haiku-4-5 after confirmation"))).toBe(true)
    expect(lines.some((line) => line.includes("hooks    pre   · pnpm lint"))).toBe(true)
    expect(lines.some((line) => line.includes("post  · ./notify.sh · always"))).toBe(true)
    expect(lines.some((line) => line.includes("runtime  smart permissions · 2 attachments · judge openrouter/openai/gpt-5.6-terra#xhigh"))).toBe(true)
  })

  test("expands the full prompt with hard wrapping and collapses it back to an excerpt", () => {
    const long = `first ${"requirement ".repeat(30)}\nsecond line`
    const plan = planWith([], { prompt: { source: "inline", text: long } })

    const excerpt = plain(runReviewLines(plan, 60))
    const expanded = plain(runReviewLines(plan, 60, { fullPrompt: true }))

    expect(excerpt.filter((line) => line.includes("requirement"))).toHaveLength(1)
    expect(expanded.length).toBeGreaterThan(excerpt.length)
    expect(expanded.some((line) => line.includes("second line"))).toBe(true)
    expect(expanded.every((line) => line.length <= 60)).toBe(true)
  })

  test("sanitizes untrusted fields and keeps every row within the panel width", () => {
    const plan = planWith([], {
      prompt: { source: "inline", text: "do \u001b[31mthings\u0007" },
      target: { directory: "/repo\nforged", baseRef: "main", worktree: false, dirty: false },
      pipeline: {
        name: "impl\nevil",
        steps: [agentStep({ name: "evil\nstep", stepName: "evil", groupId: "g1", resolvedModel: resolved("openai/gpt-new", "openai/gpt-new") })],
      },
      hooks: { pre: [{ command: "rm -rf /\nwhoami" }], post: [] },
    })

    const width = 72
    const lines = plain(runReviewLines(plan, width, { fullPrompt: true }))

    for (const line of lines) {
      expect(line).not.toContain("\u001b")
      expect(line).not.toContain("\u0007")
      expect(line).not.toContain("\n")
      expect(line.length).toBeLessThanOrEqual(width)
    }
  })
})
