/**
 * Bounded real acceptance through the production engine path (change
 * `runner-parity-opencode-v2`, task 12.2).
 *
 * Run explicitly with `CONVOY_ACCEPT=1 bun run scripts/runner-acceptance.ts`.
 * Each case is a real `run()` of a one-step read-only pipeline in a disposable
 * Git checkout — preflight, attempt, report, finalization — on the cheapest
 * model: Claude Haiku on the operator's subscription, and the free
 * `nan/deepseek-v4-flash` on OpenCode. It prints each outcome and the report
 * it produced. Not part of the test suite: it spends.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readRunMetadata } from "../src/metadata"
import { builtInAgents } from "../src/pipeline"
import { preflightRunPlan } from "../src/preflight"
import { buildRunPlan } from "../src/run-plan"
import { run } from "../src/runner"
import type { AgentStep, RunOptions } from "../src/types"

if (process.env.CONVOY_ACCEPT !== "1") {
  console.error("refusing to spend: set CONVOY_ACCEPT=1 to run the bounded acceptance")
  process.exit(1)
}
// Spend bounds. A nested start means something re-ran this script (a hook or
// helper must re-invoke Convoy's entry, never its embedder), and the deadline
// stops a hung attempt from consuming quota unattended.
if (process.env.CONVOY_ACCEPT_ACTIVE === "1") {
  console.error("refusing a nested acceptance start: something re-ran this script")
  process.exit(1)
}
process.env.CONVOY_ACCEPT_ACTIVE = "1"
const deadlineMs = 8 * 60_000
setTimeout(() => {
  console.error(`acceptance exceeded ${deadlineMs / 60_000} minutes; aborting`)
  process.exit(1)
}, deadlineMs).unref()

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "ignore", stderr: "pipe" })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`)
}

function step(runner: AgentStep["runner"], model: string): AgentStep {
  return {
    type: "agent",
    name: "accept",
    agentName: "security-auditor",
    description: "Report, in one line, what this repository's README says.",
    model,
    ...(runner ? { runner } : {}),
    readOnly: true,
    inputFiles: [],
    inputDiff: false,
    reportPath: "reports/accept.md",
    groupId: "g-accept",
    stepName: "accept",
  }
}

function options(targetDir: string, acceptStep: AgentStep): RunOptions {
  return {
    prompt: "Read README.md and report its one line.",
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
    notifications: { enabled: false, terminalTitle: false },
    humanReview: false,
    baseRef: "HEAD",
    targetDir,
    worktree: false,
    includeDirty: false,
    yolo: true,
    smart: false,
    smartJudgeModel: "claude-code/haiku",
    // Acceptance accepts the subscription's account policy explicitly.
    runnerAuth: { "claude-code": { mode: "subscription", billingPolicy: "account-policy" } },
    pipeline: { name: "acceptance", steps: [acceptStep] },
    agents: [...builtInAgents],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
  }
}

async function acceptance(label: string, acceptStep: AgentStep): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-accept-"))
  try {
    await git(["init", "-q"], dir)
    await writeFile(join(dir, "README.md"), "CONVOY-ACCEPT\n")
    await git(["add", "-A"], dir)
    await git(["-c", "user.email=a@a", "-c", "user.name=a", "commit", "-qm", "base"], dir)
    const runOptions = options(dir, acceptStep)
    const plan = buildRunPlan(runOptions)
    await preflightRunPlan(plan)
    const result = await run({ ...runOptions, plan })
    const metadata = await readRunMetadata(join(result.dir, "metadata.json"))
    const report = await readFile(join(result.dir, "reports", "accept.md"), "utf8").catch(() => "")
    const phase = metadata?.phases.accept
    console.log(`${label}: status=${phase?.status} cost=${phase?.cost ?? "?"} session=${phase?.execution?.session?.sessionId ?? phase?.sessionID ?? "-"} server=${metadata?.server ? "yes" : "none"}`)
    console.log(`${label} report: ${JSON.stringify(report.trim().slice(0, 200))}`)
  } catch (error) {
    console.log(`${label}: FAILED ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await acceptance("claude-only", step("claude-code", "haiku"))
await acceptance("opencode", step(undefined, "nan/deepseek-v4-flash"))
