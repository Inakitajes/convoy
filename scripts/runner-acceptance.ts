/**
 * Bounded real acceptance for the runner adapters (change
 * `runner-parity-opencode-v2`, task 12.2).
 *
 * Run explicitly with `CONVOY_ACCEPT=1 bun run scripts/runner-acceptance.ts`.
 * It uses the cheapest Claude model for a single tiny write turn and the free
 * `nan/deepseek-v4-flash` for OpenCode, in a disposable scratch directory, and
 * prints the observed outcomes and cost. Not part of the test suite.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { composeRunners, buildEnforcementPlan } from "../src/runners/compose"
import type { AttemptOutcome, ExecutionRequest } from "../src/runners/contracts"

if (process.env.CONVOY_ACCEPT !== "1") {
  console.error("refusing to spend: set CONVOY_ACCEPT=1 to run the bounded acceptance")
  process.exit(1)
}

const dir = await mkdtemp(join(tmpdir(), "convoy-accept-"))
const hookPath = join(dir, "hook.sh")
const mcpPath = join(dir, "mcp.ts")
const hookLog = join(dir, "hook.log")

await writeFile(
  hookPath,
  `#!/bin/bash\ninput=$(cat)\necho "$input" >> "${hookLog}"\nprintf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'\n`,
  { mode: 0o700 },
)
await writeFile(
  mcpPath,
  `import { serveMcpPermissionStdio } from "${join(import.meta.dir, "..", "src", "runners", "claude", "mcp-stdio")}"\nawait serveMcpPermissionStdio({ resolve: async () => ({ decision: "allow" }) }, { input: Bun.stdin.stream(), write: (line) => process.stdout.write(line + "\\n") })\n`,
)

const enforcement = buildEnforcementPlan({
  hookCommand: hookPath,
  permissionCommand: "bun",
  permissionArgs: [mcpPath],
})

const composition = composeRunners({ cwd: dir, env: process.env, enforcement })

const base = {
  runId: "acceptance",
  phaseName: "acceptance",
  attempt: 1,
  checkout: dir,
  auth: { mode: "subscription" as const },
  approvals: "auto" as const,
  signal: new AbortController().signal,
}

function report(label: string, outcome: AttemptOutcome): void {
  console.log(`${label}: status=${outcome.status} session=${outcome.session?.sessionId ?? "-"} cost=${outcome.usage?.costEstimate ?? "?"} error=${outcome.error ?? "-"}`)
}

try {
  // Claude: a single tiny write turn under subscription, with enforcement.
  const claudeRequest: ExecutionRequest = {
    ...base,
    runner: "claude-code",
    mode: "write",
    agent: { name: "implementer", mode: "write", model: { runner: "claude-code", modelId: "haiku" } },
    prompt: "Create a file named out.txt in the current directory containing exactly the single line: CLAUDE-ACCEPT",
  }
  const claude = await composition.registry.require("claude-code").execution.executeAttempt(claudeRequest, () => {})
  report("claude", claude)

  // OpenCode: one free turn on the authorized model.
  const opencodeRequest: ExecutionRequest = {
    ...base,
    attempt: 2,
    runner: "opencode",
    mode: "write",
    agent: { name: "implementer", mode: "write", model: { runner: "opencode", modelId: "nan/deepseek-v4-flash" } },
    prompt: "Reply with exactly the word: OPENCODE-ACCEPT",
  }
  const opencode = await composition.registry.require("opencode").execution.executeAttempt(opencodeRequest, () => {})
  report("opencode", opencode)

  const hookFired = await readFile(hookLog, "utf8").then((text) => text.includes("PreToolUse")).catch(() => false)
  const written = await readFile(join(dir, "out.txt"), "utf8").catch(() => "")
  console.log(`hook-fired=${hookFired} claude-wrote-out.txt=${JSON.stringify(written.trim())}`)
} finally {
  await composition.close()
  await rm(dir, { recursive: true, force: true })
}
