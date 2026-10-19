import { describe, expect, test } from "bun:test"

import { preflightRunPlan } from "../src/preflight"
import { buildRunPlan } from "../src/run-plan"
import { claudeRouteSummary } from "../src/run-review"
import { PlanDependencyError } from "../src/runners/plan-dependencies"
import type { AgentStep, Pipeline, RunOptions } from "../src/types"

// Preflight sees the whole plan before any workspace exists: every runner it
// needs, the Claude route's billing decision, and its effective auth.

const claudeStep: AgentStep = {
  type: "agent",
  name: "review",
  agentName: "security-auditor",
  description: "review",
  model: "sonnet",
  runner: "claude-code",
  readOnly: true,
  inputFiles: [],
  inputDiff: false,
  reportPath: "reports/review.md",
  groupId: "g-review",
  stepName: "review",
}

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    prompt: "x",
    prdHistory: false,
    files: [],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "",
    keepRunDir: true,
    modelOverride: "",
    advisorOverride: "",
    advisorDisabled: false,
    tui: false,
    notify: false,
    notifications: {},
    humanReview: false,
    baseRef: "HEAD",
    targetDir: "/tmp",
    worktree: false,
    includeDirty: false,
    yolo: false,
    smart: false,
    smartJudgeModel: "claude-code/haiku",
    pipeline: { name: "claude", steps: [claudeStep] },
    agents: [],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
    ...overrides,
  }
}

const everything = { available: () => true, claudeAuthProbe: async () => ({ authMethod: "claude.ai" }) }

describe("Claude plan billing", () => {
  test("a Claude plan freezes its non-secret auth and an unverified billing decision", () => {
    const plan = buildRunPlan(options({ runnerAuth: { "claude-code": { mode: "subscription", billingPolicy: "account-policy" } } }))
    expect(plan.runnerAuth?.["claude-code"]).toMatchObject({ auth: { mode: "subscription", billingPolicy: "account-policy" }, billing: { policy: "account-policy", includedOnlyVerifiable: false, mayIncurCharges: true } })
    expect(claudeRouteSummary(plan.runnerAuth!["claude-code"]!)).toBe("subscription · account policy — usage credits or paid features may apply")
    // An OpenCode-only plan has no Claude route at all.
    expect(buildRunPlan(options({ pipeline: { name: "o", steps: [{ ...claudeStep, runner: undefined, model: "openai/gpt-5.5" }] }, smartJudgeModel: "openai/gpt-5.5" })).runnerAuth).toBeUndefined()
  })

  test("a reviewed subscription launch may proceed; an unattended one must state its policy", async () => {
    const plan = buildRunPlan(options())
    await expect(preflightRunPlan(plan, undefined, { ...everything, reviewed: true })).resolves.toBeUndefined()
    await expect(preflightRunPlan(plan, undefined, everything)).rejects.toThrow(/unattended launch must state its billing decision/)
    const consented = buildRunPlan(options({ runnerAuth: { "claude-code": { mode: "subscription", billingPolicy: "account-policy" } } }))
    await expect(preflightRunPlan(consented, undefined, everything)).resolves.toBeUndefined()
  })

  test("included-only is refused rather than promised", async () => {
    const plan = buildRunPlan(options({ runnerAuth: { "claude-code": { mode: "subscription", billingPolicy: "included-only" } } }))
    await expect(preflightRunPlan(plan, undefined, { ...everything, reviewed: true })).rejects.toThrow(/included-only was requested/)
  })

  test("a billing source other than the reviewed one fails before any work", async () => {
    const plan = buildRunPlan(options())
    await expect(preflightRunPlan(plan, undefined, { ...everything, reviewed: true, claudeAuthProbe: async () => ({ authMethod: "api_key_helper" }) })).rejects.toThrow(/not the operator's subscription login/)
  })
})

describe("plan dependencies", () => {
  test("a missing runner anywhere in the plan — a goal fragment's advisor included — fails at preflight", async () => {
    const pipeline: Pipeline = {
      name: "goal",
      steps: [claudeStep],
      goalPlan: {
        target: 90,
        maxIterations: 1,
        improve: { steps: [{ ...claudeStep, name: "fix", readOnly: false, advisor: "openai/gpt-5.5" }] },
        measure: { steps: [] },
      } as unknown as Pipeline["goalPlan"],
    }
    const plan = buildRunPlan(options({ pipeline, runnerAuth: { "claude-code": { mode: "subscription", billingPolicy: "account-policy" } } }))
    const run = preflightRunPlan(plan, undefined, { ...everything, available: (runner) => runner === "claude-code" })
    await expect(run).rejects.toBeInstanceOf(PlanDependencyError)
    await expect(run).rejects.toThrow("fix advisor (opencode)")
  })
})
