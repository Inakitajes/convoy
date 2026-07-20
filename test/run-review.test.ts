import { expect, test } from "bun:test"

import { renderRunPlan } from "../src/run-review"
import type { RunPlan } from "../src/types"

test("run review renders untrusted plan fields without terminal or layout injection", () => {
  const plan: RunPlan = {
    prompt: { source: "inline", text: "normal\u001b[31mprompt\nwith details" },
    target: { directory: "/repo\nStart run? [y/N] y", baseRef: "main\u001b]52;c;clipboard\u0007", worktree: false, dirty: false },
    pipeline: {
      name: "audit\nforged",
      steps: [
        {
          type: "agent",
          name: "security",
          stepName: "security",
          groupId: "g1",
          agentName: "security-auditor",
          description: "Security",
          model: "vercel/openai/gpt-new",
          resolvedModel: {
            configured: "openai/gpt-new",
            logical: "openai/gpt-new\nforged",
            gateway: "vercel",
            providerID: "vercel",
            modelID: "openai/gpt-new",
            target: "vercel/openai/gpt-new\u001b[2J",
          },
          inputFiles: ["prd.md"],
          inputDiff: false,
          reportPath: "reports/security.md",
        },
      ],
    },
    modelRouting: { gateway: "vercel" },
    hooks: { pre: [{ command: "bun test\nrm -rf /" }], post: [] },
    attachments: [],
    permissions: "interactive",
    maxAttempts: 1,
  }

  const rendered = renderRunPlan(plan)
  expect(rendered).not.toContain("\u001b")
  expect(rendered).toContain("/repo Start run? [y/N] y")
  expect(rendered).toContain("audit forged")
  expect(rendered).toContain("bun test rm -rf /")
})

test("review renders the exact target, worktree intent, and routed smart judge", () => {
  const plan: RunPlan = {
    prompt: { source: "file", text: "Audit the checkout flow" },
    target: { directory: "/repo", baseRef: "main", worktree: true, dirty: false },
    pipeline: {
      name: "audit",
      steps: [
        {
          type: "agent",
          name: "security",
          stepName: "security",
          groupId: "g1",
          agentName: "security-auditor",
          description: "Security audit",
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
          inputDiff: true,
          reportPath: "reports/security.md",
          maxAttempts: 3,
        },
      ],
    },
    modelRouting: { gateway: "vercel" },
    smartJudge: {
      model: {
        configured: "anthropic/claude-haiku-4.5",
        logical: "anthropic/claude-haiku-4.5",
        gateway: "vercel",
        providerID: "vercel",
        modelID: "anthropic/claude-haiku-4.5",
        target: "vercel/anthropic/claude-haiku-4.5",
      },
    },
    hooks: { pre: [{ command: "bun run lint" }], post: [] },
    attachments: ["docs/architecture.md"],
    permissions: "smart",
    maxAttempts: 2,
  }

  const detailed = renderRunPlan(plan)
  const compact = renderRunPlan(plan, true)

  expect(detailed).toContain("Worktree: yes (created after confirmation)")
  expect(detailed).toContain("Logical: openai/gpt-5.6-sol")
  expect(detailed).toContain("Target:  vercel/openai/gpt-5.6-sol")
  expect(detailed).toContain("Judge: vercel/anthropic/claude-haiku-4.5")
  expect(detailed).toContain("pre: bun run lint")
  expect(compact).toContain("Convoy run plan")
  expect(compact).not.toContain("Target:  vercel/openai/gpt-5.6-sol")
})

test("review marks a resume gateway override in every format and shows the routed branch namer", () => {
  const plan: RunPlan = {
    prompt: { source: "resume", text: "continue the work" },
    target: { directory: "/repo", baseRef: "main", worktree: true, dirty: false },
    pipeline: { name: "implement", steps: [] },
    modelRouting: { gateway: "openrouter" },
    branchNamer: {
      model: {
        configured: "anthropic/claude-haiku-4-5",
        logical: "anthropic/claude-haiku-4-5",
        gateway: "openrouter",
        providerID: "openrouter",
        modelID: "anthropic/claude-haiku-4-5",
        target: "openrouter/anthropic/claude-haiku-4-5",
      },
    },
    hooks: { pre: [], post: [] },
    attachments: [],
    permissions: "interactive",
    maxAttempts: 2,
    resume: { runID: "20260720-135802-5bbh", gatewayOverride: { original: "vercel", pending: "openrouter" } },
  }

  const detailed = renderRunPlan(plan)
  const compact = renderRunPlan(plan, true)

  expect(detailed).toContain("Resume gateway override:")
  expect(detailed).toContain("original: Vercel AI Gateway")
  expect(detailed).toContain("pending phases: OpenRouter")
  expect(compact).toContain("Resume gateway override:")
  expect(compact).toContain("pending phases: OpenRouter")

  expect(detailed).toContain("Branch naming: openrouter/anthropic/claude-haiku-4-5 (generated after confirmation)")
  expect(compact).not.toContain("Branch naming:")
})

test("review can expand the complete sanitized prompt for the launcher", () => {
  const plan: RunPlan = {
    prompt: { source: "inline", text: "first requirement\nsecond\trequirement\u001b[31m" },
    target: { directory: "/repo", baseRef: "main", worktree: false, dirty: false },
    pipeline: { name: "quick", steps: [] },
    modelRouting: { gateway: "configured" },
    hooks: { pre: [], post: [] },
    attachments: [],
    permissions: "interactive",
    maxAttempts: 1,
  }

  const excerpt = renderRunPlan(plan)
  const expanded = renderRunPlan(plan, false, { fullPrompt: true })

  expect(excerpt).toContain("first requirement second requirement")
  expect(expanded).toContain("  first requirement\n  second requirement")
  expect(expanded).not.toContain("\u001b")
})
