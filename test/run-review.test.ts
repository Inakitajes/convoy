import { describe, expect, test } from "bun:test"

import { renderRunPlan, sanitizeReviewInline, sanitizeReviewText } from "../src/run-review"
import type { RunPlan } from "../src/types"

function samplePlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    prompt: { source: "inline", text: "Build a login page with email and password" },
    target: { directory: "/home/user/project", baseRef: "main", worktree: false, dirty: false },
    pipeline: {
      name: "implement",
      steps: [
        {
          type: "agent",
          name: "implementer",
          stepName: "implementer",
          groupId: "g1",
          agentName: "implementer",
          description: "Implement the feature",
          model: "openai/gpt-5",
          resolvedModel: {
            configured: "openai/gpt-5",
            logical: "openai/gpt-5",
            gateway: "vercel",
            providerID: "vercel",
            modelID: "openai/gpt-5",
            target: "vercel/openai/gpt-5",
          },
          inputFiles: ["prd.md"],
          inputDiff: true,
          reportPath: "reports/implementer.md",
          advisor: "default",
          advisorMaxCalls: 3,
          resolvedAdvisor: {
            configured: "anthropic/claude-opus-4",
            logical: "anthropic/claude-opus-4",
            gateway: "vercel",
            providerID: "vercel",
            modelID: "anthropic/claude-opus-4",
            target: "vercel/anthropic/claude-opus-4",
          },
        },
      ],
    },
    modelRouting: { gateway: "vercel" },
    hooks: { pre: [], post: [] },
    attachments: [],
    permissions: "interactive",
    ...overrides,
  }
}

describe("renderRunPlan", () => {
  test("renders a basic compact plan", () => {
    const plan = samplePlan()
    const output = renderRunPlan(plan, true)
    expect(output).toContain("Convoy run plan")
    expect(output).toContain("Prompt: inline")
    expect(output).toContain("Target:")
    expect(output).toContain("Pipeline: implement · 1 steps")
    expect(output).toContain("Gateway: Vercel AI Gateway")
  })

  test("renders a full plan with step details", () => {
    const plan = samplePlan()
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Review Convoy run")
    expect(output).toContain("1. implementer · OpenCode · writable")
    expect(output).toContain("Logical: openai/gpt-5")
    expect(output).toContain("Target:  vercel/openai/gpt-5")
    expect(output).toContain("Advisor: anthropic/claude-opus-4 → vercel/anthropic/claude-opus-4 · max 3 calls/attempt")
  })

  test("renders a human gate step", () => {
    const plan = samplePlan()
    plan.pipeline.steps = [
      {
        type: "human",
        name: "review-gate",
        description: "Manual review",
      },
    ]
    const output = renderRunPlan(plan, false)
    expect(output).toContain("1. review-gate · human gate")
  })

  test("renders hooks when present", () => {
    const plan = samplePlan()
    plan.hooks = {
      pre: [{ command: "echo hello", continueOnError: false }],
      post: [{ command: "echo done", when: "always", continueOnError: false }],
    }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Hooks:")
    expect(output).toContain("pre: echo hello")
    expect(output).toContain("post: echo done")
    expect(output).toContain("(always)")
  })

  test("renders attachments and permissions count", () => {
    const plan = samplePlan()
    plan.attachments = ["/tmp/screenshot.png"]
    plan.permissions = "interactive"
    const output = renderRunPlan(plan, false)
    expect(output).toContain("interactive permissions")
    expect(output).toContain("1 attachments")
  })

  test("renders the goal cycle consent envelope in compact and full plans", () => {
    // The headless review names the bounded loop the operator is consenting to:
    // iteration-zero measurement plus up to maxIterations improve/measure rounds,
    // the plateau, the brief recipient, and the authoritative score step.
    const plan = samplePlan({
      goal: {
        target: 85,
        maxIterations: 2,
        plateau: 3,
        briefRecipient: "fix",
        scoreProducer: "arbiter",
        improve: { steps: [] },
        measure: { steps: [] },
      },
    })

    const compact = renderRunPlan(plan, true)
    expect(compact).toContain("Goal cycle: target 85/100 · up to 3 measurements (2 improve rounds) · plateau 3")

    const full = renderRunPlan(plan, false)
    expect(full).toContain("Goal cycle: target 85/100 · up to 3 measurements (2 improve rounds) · plateau 3")
    expect(full).toContain("Improve: 0 steps · brief goes to fix")
    expect(full).toContain("Measure: 0 steps · authoritative score from arbiter")
  })

  test("renders a smart judge when present", () => {
    const plan = samplePlan()
    plan.smartJudge = {
      model: {
        configured: "anthropic/claude-haiku-4",
        logical: "anthropic/claude-haiku-4",
        gateway: "vercel",
        providerID: "vercel",
        modelID: "anthropic/claude-haiku-4",
        target: "vercel/anthropic/claude-haiku-4",
      },
    }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Judge:")
  })

  test("renders a read-only step", () => {
    const plan = samplePlan()
    const step = plan.pipeline.steps[0]
    if (step?.type === "agent") {
      step.readOnly = true
    }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("read-only")
  })

  test("renders resume gateway override when present", () => {
    const plan = samplePlan()
    plan.resume = {
      runID: "run-previous",
      gatewayOverride: {
        original: "configured",
        pending: "configured",
      },
    }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Resume gateway override:")
    expect(output).toContain("original: As configured")
    expect(output).toContain("pending phases: As configured")
  })

  test("renders an OpenRouter Nitro gateway with the throughput note and the plain target", () => {
    const plan = samplePlan()
    plan.modelRouting.gateway = "nitro"
    const step = plan.pipeline.steps[0]
    if (step?.type === "agent") {
      step.resolvedModel = {
        configured: "zai/glm-5.2#xhigh",
        logical: "zai/glm-5.2#xhigh",
        gateway: "nitro",
        providerID: "openrouter",
        modelID: "z-ai/glm-5.2",
        variant: "xhigh",
        target: "openrouter/z-ai/glm-5.2#xhigh",
      }
    }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Gateway: OpenRouter Nitro · every OpenRouter model routed by throughput")
    expect(output).toContain("Logical: zai/glm-5.2#xhigh")
    expect(output).toContain("Target:  openrouter/z-ai/glm-5.2#xhigh")
  })

  test("renders a nitro resume override copy", () => {
    const plan = samplePlan()
    plan.resume = { runID: "run-previous", gatewayOverride: { original: "openrouter", pending: "nitro" } }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("original: OpenRouter")
    expect(output).toContain("pending phases: OpenRouter Nitro")
  })

  test("renders full prompt when option is set", () => {
    const plan = samplePlan()
    plan.prompt = { source: "file", text: "Line 1\nLine 2\nLine 3" }
    const output = renderRunPlan(plan, false, { fullPrompt: true })
    expect(output).toContain("  Line 1")
    expect(output).toContain("  Line 2")
    expect(output).toContain("  Line 3")
  })

  test("renders worktree info when worktree mode is on", () => {
    const plan = samplePlan()
    plan.target.worktree = true
    plan.target.branch = "feat/login"
    const output = renderRunPlan(plan, true)
    expect(output).toContain("Worktree: yes · branch feat/login")
  })

  test("a worktree run with a selected change discloses that selection never narrows whole-branch scope (task 10.5)", () => {
    const plan = samplePlan()
    plan.target.worktree = true
    plan.target.branch = "feat/login"
    plan.openspec = { changeIds: ["add-login"], specFiles: ["specs/cli/spec.md"] }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Scope: the selected changes scope this run's diff and OpenSpec inputs")
    expect(output).toContain("they never narrow whole-branch publication or squash scope")
  })

  test("a non-worktree run or a run without a selected change omits the whole-branch scope line (task 10.5)", () => {
    const plain = renderRunPlan(samplePlan(), false)
    expect(plain).not.toContain("they never narrow whole-branch publication or squash scope")
    const worktreeNoChange = samplePlan()
    worktreeNoChange.target.worktree = true
    worktreeNoChange.openspec = { changeIds: [], specFiles: [] }
    expect(renderRunPlan(worktreeNoChange, false)).not.toContain("they never narrow whole-branch publication or squash scope")
  })

  test("renders worktree directory when present", () => {
    const plan = samplePlan()
    plan.target.worktreeDir = "/tmp/convoy-worktree/feat-login"
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Worktree directory: /tmp/convoy-worktree/feat-login")
  })

  test("renders dirty working tree info", () => {
    const plan = samplePlan()
    plan.target.dirty = true
    const output = renderRunPlan(plan, true)
    expect(output).toContain("include dirty")
  })

  test("handles plan without resolvedModel for an agent step", () => {
    const plan = samplePlan()
    const step = plan.pipeline.steps[0]
    if (step?.type === "agent") {
      step.resolvedModel = undefined
    }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Model:")
  })

  test("handles plan without advisor", () => {
    const plan = samplePlan()
    const step = plan.pipeline.steps[0]
    if (step?.type === "agent") {
      step.advisor = undefined
      step.resolvedAdvisor = undefined
    }
    const output = renderRunPlan(plan, false)
    expect(output).not.toContain("Advisor:")
  })

  test("sanitizes hostile plan fields while preserving prompt line breaks", () => {
    const plan = samplePlan()
    plan.prompt = { source: "inline", text: "First \u001b[31mred\u001b[0m\nSecond\u0000\tcolumn" }
    plan.target.directory = "/repo\u001b[2J\nforged\u0007\tpath"
    plan.target.baseRef = "main\nforged-ref\u001b[0m"
    plan.pipeline.name = "implement\nforged-pipeline\u0000"
    plan.hooks.pre = [{ command: "printf ok\nforged-hook\u001b[31m", continueOnError: false }]
    const step = plan.pipeline.steps[0]
    if (step?.type === "agent") step.name = "build\nforged-step\u0001\u001b[32m"

    const output = renderRunPlan(plan, false, { fullPrompt: true })

    expect(output).toContain("  First red")
    expect(output).toContain("  Second column")
    expect(output).toContain("Target: /repo forged path")
    expect(output).toContain("Diff base: main forged-ref")
    expect(output).toContain("Pipeline: implement forged-pipeline")
    expect(output).toContain("1. build forged-step · OpenCode · writable")
    expect(output).toContain("pre: printf ok forged-hook")
    expect(output).not.toMatch(/[\u001b\u0000\u0001\u0007\t]/)
    expect(output).not.toContain("\nforged-")
  })

  test("renders the historical PRD preview when the plan carries one", () => {
    const plan = samplePlan({
      prdHistory: {
        action: "attach",
        branch: "feat/history",
        found: { runID: "old", pipeline: "implement", branch: "feat/history", timestamp: Date.UTC(2026, 7, 17), file: "old.prd.md" },
      },
    })
    const output = renderRunPlan(plan, true)
    expect(output).toContain("PRD history: will attach implement PRD · 2026-08-17")
    expect(output).toContain("original intent for feat/history")
  })
})

describe("sanitizeReviewText", () => {
  test("strips ANSI escape sequences", () => {
    expect(sanitizeReviewText("hello\u001b[31m world")).toBe("hello world")
  })

  test("strips control characters", () => {
    expect(sanitizeReviewText("hello\u0000world")).toBe("helloworld")
  })

  test("replaces tabs with spaces", () => {
    expect(sanitizeReviewText("hello\tworld")).toBe("hello world")
  })
})

describe("sanitizeReviewInline", () => {
  test("strips ANSI and control chars and collapses whitespace", () => {
    expect(sanitizeReviewInline("  hello\u001b[31m   world  ")).toBe("hello world")
  })

  test("trims the result", () => {
    expect(sanitizeReviewInline("  spaced  out  ")).toBe("spaced out")
  })
})
