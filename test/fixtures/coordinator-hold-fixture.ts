/**
 * Isolated coordinator finish-hold regression fixture (change
 * fix-opencode-server-lifecycle, design D7).
 *
 * Runs the production `runCoordinateBoot` with the real signal scope installed
 * and a real managed `opencode serve` child. When the parent test sends a real
 * SIGTERM while the finish hold is parked, the coordinator must release the
 * hold, run the bounded owned-server stop, and observe the child's exit. The
 * outcome and child PID are recorded for the parent to assert.
 *
 * It never reads user OpenCode config, uses model credentials, or matches a
 * broad process scan.
 *
 * argv: <childScript> <storeDir> <recordPath> <holdingPath> <pidPath>
 */
import { mkdtemp, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { launchPayload, runCoordinateBoot, writePendingLaunch } from "../../src/coordinate"
import { launchManagedServer } from "../../src/managed-server"
import { createProcessRecordStore } from "../../src/process-records"
import type { RunOptions, RunPlan } from "../../src/types"

const [childScript, storeDir, recordPath, holdingPath, pidPath] = process.argv.slice(2)
if (!childScript || !storeDir || !recordPath || !holdingPath || !pidPath) {
  console.error("usage: coordinator-hold-fixture <childScript> <storeDir> <recordPath> <holdingPath> <pidPath>")
  process.exit(2)
}

// Scratch dirs live under the parent test's removable directory so a passing
// or failing run leaves no temp state behind.
const scratch = dirname(recordPath)
const runDir = await mkdtemp(join(scratch, "run-"))
const launchRoot = await mkdtemp(join(scratch, "launch-"))

const options: RunOptions = {
  prompt: "hold",
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
  notifications: {},
  humanReview: false,
  baseRef: "main",
  targetDir: runDir,
  worktree: false,
  includeDirty: false,
  yolo: false,
  smart: false,
  smartJudgeModel: "openai/gpt-5",
  pipeline: { name: "hold", steps: [] },
  agents: [],
  permissions: { allow: [], deny: [] },
  hooks: { pre: [], post: [], pipelines: {} },
}

const plan: RunPlan = {
  prompt: { source: "inline", text: "hold" },
  target: { directory: runDir, baseRef: "main", worktree: false, dirty: false },
  pipeline: { name: "hold", steps: [] },
  modelRouting: { gateway: "openrouter" },
  hooks: { pre: [], post: [] },
  attachments: [],
  permissions: "interactive",
}

const pending = await writePendingLaunch(launchPayload(options, plan), launchRoot)

let server: Awaited<ReturnType<typeof launchManagedServer>> | undefined

// The finish hold: record that the hold is parked, then never resolve. The
// parent test sends its signal after seeing the holding marker.
const hold = {
  autoAccept: { mode: "off" as "off" | "all" | "smart" },
  runFinished: async (): Promise<void> => {
    await writeFile(holdingPath, "holding")
    await new Promise<void>(() => {})
  },
}

const code = await runCoordinateBoot(pending.launchPath, pending.readyPath, {
  launchRoot,
  // The production `installSignals` (real SIGINT/SIGTERM/SIGHUP handlers) and
  // `startControlServer` are deliberately left at their defaults: this fixture
  // exercises the real wiring, not an injected one.
  createProgress: () => hold as never,
  run: async () => {
    server = await launchManagedServer({
      command: process.execPath,
      args: [childScript],
      cwd: runDir,
      env: {},
      lifetime: "helper",
      label: "hold fixture child",
      timeoutMs: 5_000,
      deps: { store: createProcessRecordStore(storeDir), policy: { graceMs: 2_000, forceObservationMs: 1_000 } },
    })
    await writeFile(pidPath, String(server.pid))
    return {
      runID: "20260101-000000-hold",
      dir: runDir,
      release: async () => {
        const outcome = await server!.stop()
        await writeFile(recordPath, JSON.stringify({ pid: server!.pid, outcome }))
      },
    }
  },
})

process.exit(code)
