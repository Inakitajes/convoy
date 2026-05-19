import type { Phase } from "./types"

export const phases = [
  {
    name: "implementer",
    agentName: "implementer",
    model: "anthropic/claude-opus-4-7",
    description: "Implements the feature described in the PRD",
    inputFiles: ["prd.md"],
    inputDiff: false,
    reportPath: "reports/implementer.md",
  },
  {
    name: "patterns",
    agentName: "pattern-auditor",
    model: "anthropic/claude-opus-4-7",
    description: "Audits patterns and best practices, applies refactoring",
    inputFiles: ["prd.md", "reports/implementer.md"],
    inputDiff: true,
    reportPath: "reports/patterns.md",
  },
  {
    name: "security",
    agentName: "security-auditor",
    model: "anthropic/claude-sonnet-4-6",
    description: "Audits security and applies fixes",
    inputFiles: ["prd.md", "reports/patterns.md"],
    inputDiff: true,
    reportPath: "reports/security.md",
  },
  {
    name: "design",
    agentName: "design-polisher",
    model: "anthropic/claude-sonnet-4-6",
    description: "Polishes UI following the repo's design system",
    inputFiles: ["prd.md", "reports/security.md"],
    inputDiff: true,
    reportPath: "reports/design.md",
  },
  {
    name: "tests",
    agentName: "test-engineer",
    model: "anthropic/claude-sonnet-4-6",
    description: "Ensures unit tests green and designs Maestro flows for E2E",
    inputFiles: ["prd.md"],
    inputDiff: true,
    reportPath: "reports/tests.md",
  },
] as const satisfies readonly Phase[]

export type PhaseName = (typeof phases)[number]["name"]
export type AgentName = (typeof phases)[number]["agentName"]
