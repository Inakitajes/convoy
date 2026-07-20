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
