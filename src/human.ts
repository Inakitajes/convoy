import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { stdin, stdout } from "node:process"

import { addAllAndCommit } from "./git"
import { recordLedgeredCommit } from "./finalization/ledger"
import type { CommitLedgerEntry } from "./finalization/types"
import { openClaudeInteractiveWindow, runInteractiveClaude } from "./claude-code"
import { openCodexInteractiveWindow, runInteractiveCodex } from "./codex-cli"
import { pipelineRunners } from "./run-plan"
import { stepRunnerFor, stepRunnerIds, type StepRunnerId } from "./step-runners"
import type { AuthenticationSelection } from "./runners/contracts"
import { log } from "./log"
import { openInteractiveOpencodeWindow, serverPasswordEnv } from "./opencode"
import { resolveOpencodeBin } from "./opencode-runtime"
import { noopProgress, type HumanReviewAction, type ProgressUI } from "./progress"
import type { PermissionGate } from "./permissions"
import { stepCommitMessageFactory } from "./step-commit"
import { createTerminalInput, type TerminalInput, TerminalInterrupt } from "./terminal-input"
import type { ServerAuth } from "./server-auth"
import type { RunOptions } from "./types"
import type { Workspace } from "./workspace"
import type { RunMetadataStore } from "./metadata"

type HumanReviewGateDeps = {
  openInteractiveOpencodeWindow: typeof openInteractiveOpencodeWindow
  runInteractiveOpencode: typeof runInteractiveOpencode
  openClaudeInteractiveWindow: typeof openClaudeInteractiveWindow
  runInteractiveClaude: typeof runInteractiveClaude
  openCodexInteractiveWindow: typeof openCodexInteractiveWindow
  runInteractiveCodex: typeof runInteractiveCodex
}

const defaultHumanReviewGateDeps: HumanReviewGateDeps = {
  openInteractiveOpencodeWindow,
  runInteractiveOpencode,
  openClaudeInteractiveWindow,
  runInteractiveClaude,
  openCodexInteractiveWindow,
  runInteractiveCodex,
}

/**
 * The harness a human iteration opens: the run's OpenCode server when it has
 * one, otherwise the CLI runner the plan runs on, under its reviewed
 * authentication (a run without OpenCode never boots it, so its iterations
 * never need it either).
 */
type IterationHarness = { kind: "opencode"; server: ServerAuth } | { kind: "cli"; runner: StepRunnerId }

type CliIteration = {
  open(deps: HumanReviewGateDeps, input: { targetDir: string; auth?: AuthenticationSelection; label: string }): ReturnType<typeof openClaudeInteractiveWindow>
  run(deps: HumanReviewGateDeps, input: { targetDir: string; auth?: AuthenticationSelection }): Promise<number>
}

/** The interactive client of each CLI runner, by runner id. */
const cliIterations: Partial<Record<StepRunnerId, CliIteration>> = {
  "claude-code": { open: (deps, input) => deps.openClaudeInteractiveWindow(input), run: (deps, input) => deps.runInteractiveClaude(input) },
  codex: { open: (deps, input) => deps.openCodexInteractiveWindow(input), run: (deps, input) => deps.runInteractiveCodex(input) },
}

/** The CLI runner a human iteration uses when the run has no OpenCode server: the plan's first one with an interactive client. */
function iterationRunner(options: RunOptions): StepRunnerId {
  const pipeline = options.plan?.pipeline ?? options.pipeline
  const used = pipeline ? pipelineRunners(pipeline) : new Set<StepRunnerId>()
  return stepRunnerIds.find((runner) => used.has(runner) && cliIterations[runner]) ?? "claude-code"
}

function harnessName(harness: IterationHarness): string {
  return harness.kind === "opencode" ? "OpenCode" : stepRunnerFor(harness.runner).displayName.replace(/ Code$/, "")
}

export async function runHumanReviewGate(
  workspace: Workspace,
  options: RunOptions,
  server: ServerAuth | undefined,
  progress: ProgressUI = noopProgress,
  permissions?: PermissionGate,
  stepName = "human-review",
  overrides: Partial<HumanReviewGateDeps> = {},
  metadata?: RunMetadataStore,
) {
  // Human steps are filtered out of new pipelines when --no-human-step / --no-human-review is
  // set; this guard covers resumed runs whose frozen pipeline still has one.
  if (!options.humanReview) {
    progress.phaseSkipped(stepName)
    log.warn(`[${stepName}] skipped by --no-human-step`)
    return
  }

  const askInTui = progress.askHumanReview?.bind(progress)
  if (!askInTui && (!stdin.isTTY || !stdout.isTTY)) {
    progress.phaseSkipped(stepName)
    log.warn(`[${stepName}] skipped because stdin/stdout are not interactive`)
    return
  }

  if (options.resumeRunID && (await humanReviewApproved(workspace, stepName))) {
    progress.phaseCompleted(stepName, "already approved in previous run")
    log.info(`[${stepName}] already approved in previous run; skipping on resume`)
    return
  }

  progress.phaseStarted(stepName, "waiting for manual action")

  const deps: HumanReviewGateDeps = { ...defaultHumanReviewGateDeps, ...overrides }
  let iterations = 0
  const harness: IterationHarness = server ? { kind: "opencode", server } : { kind: "cli", runner: iterationRunner(options) }
  const askAction = async () =>
    askInTui
      ? askInTui({ stepName, iterations })
      : askHumanAction({ prompt: `Human step: ${humanActionMenu(humanStepActions)} > `, allowed: humanStepActions })

  // Plain readline fallback still owns the terminal. The TUI path keeps the
  // dashboard active and resolves actions via ProgressUI.askHumanReview.
  if (!askInTui) progress.suspend()
  try {
    log.section(`${stepName} - manual review checkpoint`)
    let action = await askAction()

    for (;;) {
      if (action === "continue") {
        await commitHumanChanges(workspace, options, stepName, metadata)
        await writeHumanReviewReport(workspace, "approved", iterations, stepName, harness)
        progress.phaseCompleted(stepName, "approved")
        return
      }

      if (action === "iterate") {
        iterations++
        progress.phaseRunning(stepName, `interactive ${harnessName(harness)} iteration`)
        if (askInTui) {
          // The external client owns its own permission prompts. Keep
          // Convoy's dashboard gate paused until the user returns to this gate
          // and chooses the next action.
          permissions?.pause()
          try {
            const opened = await openExternalIteration(options, harness, progress, stepName, deps)
            if (opened) {
              action = await askAction()
              continue
            }
          } finally {
            permissions?.resume()
          }

          await runSuspendedInteractiveIteration(options, harness, progress, stepName, permissions, deps)
          await commitHumanChanges(workspace, options, stepName, metadata)
        } else {
          await runInteractiveIteration(options, harness, stepName, permissions, deps)
          await commitHumanChanges(workspace, options, stepName, metadata)
        }
        action = await askAction()
        continue
      }

      await writeHumanReviewReport(workspace, "aborted", iterations, stepName, harness)
      progress.phaseFailed(stepName, "aborted by user")
      throw new Error("aborted by human review")
    }
  } finally {
    if (!askInTui) progress.resume()
  }
}

async function humanReviewApproved(workspace: Workspace, stepName: string) {
  try {
    const report = await readFile(join(workspace.dir, "reports", `${stepName}.md`), "utf8")
    return /^- Result: approved$/m.test(report)
  } catch {
    return false
  }
}

export type HumanActionPrompt = {
  prompt: string
  allowed: ReadonlyArray<HumanReviewAction>
  /**
   * Serializes this readline fallback with the permission gate's so a --no-tui
   * parallel run never opens two prompts on stdin at once. The phase gate
   * passes the run's shared arbiter; the solo human-review gate leaves it unset.
   */
  terminalInput?: TerminalInput
}

/** One key per ReviewAction, shared by askHumanAction's prompt and dispatch. Retry and reset share "r"; a gate never allows both at once. */
const humanActionKeys: Record<HumanReviewAction, string> = {
  continue: "c",
  iterate: "o",
  abort: "a",
  retry: "r",
  reset: "r",
}

/** The words each key completes in the [k]ey prompt style ("[o]pen session"); every label starts with its key. */
const humanActionLabels: Record<HumanReviewAction, string> = {
  continue: "continue pipeline",
  iterate: "open session",
  abort: "abort",
  retry: "retry clean",
  reset: "reset and continue",
}

/** Extra words an action answers to, beyond its key and action name. */
const humanActionAliases: Partial<Record<HumanReviewAction, readonly string[]>> = {
  iterate: ["open", "opencode", "session"],
}

/** The actions a pipeline human step answers with. */
const humanStepActions = ["continue", "iterate", "abort"] as const

/**
 * The bracketed-key menu every readline gate shows:
 * "[r]etry clean, [o]pen session, [a]bort".
 */
export function humanActionMenu(allowed: ReadonlyArray<HumanReviewAction>): string {
  return allowed.map((action) => `[${humanActionKeys[action]}]${humanActionLabels[action].slice(1)}`).join(", ")
}

/**
 * Readline prompt for the phase gate in runner.ts, in the same "[k]ey" style
 * as the human-step prompt above. A failure puts the error on its own line so
 * the menu stays next to the cursor; the terminal wraps long errors for us.
 */
export function phaseGatePrompt(info: { stepName: string; kind: "interactive" | "failure" | "budget-gate"; error?: string; allowed: ReadonlyArray<HumanReviewAction> }): string {
  const menu = humanActionMenu(info.allowed)
  if (info.kind === "budget-gate") {
    return `Step "${info.stepName}" reached its step budget. Resetting starts another budget while keeping accumulated cost.\n${menu} > `
  }
  if (info.kind === "failure") {
    const reason = info.error ? `: ${info.error.replace(/\s+/g, " ").trim()}` : ""
    return `Step "${info.stepName}" failed${reason}\n${menu} > `
  }
  return `Interactive session on step "${info.stepName}": ${menu} > `
}

/**
 * General readline fallback for a human gate, resolved by the action set the
 * caller allows (pipeline human steps answer c/o/a; a failed step answers
 * r/o/a). Shared by runHumanReviewGate and the phase gate in runner.ts.
 *
 * The whole interaction loop runs under the shared terminal-input arbiter, so
 * a phase gate waiting on stdin and a live sibling's permission prompt can
 * never both read the same stdin in a --no-tui parallel run.
 */
export async function askHumanAction({ prompt, allowed, terminalInput }: HumanActionPrompt): Promise<HumanReviewAction> {
  const input = terminalInput ?? createTerminalInput()
  return input.withInput(async (ask) => {
    for (;;) {
      let answer: string
      try {
        answer = (await ask.ask(prompt)).trim().toLowerCase()
      } catch (error) {
        // Ctrl+C surfaces as TerminalInterrupt; map it to abort so the gate
        // shuts the run down instead of looping on a dead prompt.
        if (error instanceof TerminalInterrupt) {
          stdout.write("\n")
          log.warn("[human-step] Ctrl+C received; aborting")
          return "abort"
        }
        throw error
      }
      for (const action of allowed) {
        if (answer === humanActionKeys[action] || answer === action || humanActionAliases[action]?.includes(answer)) return action
      }
      const keys = allowed.map((action) => humanActionKeys[action])
      stdout.write(`Choose ${keys.length > 1 ? `${keys.slice(0, -1).join(", ")}, or ${keys[keys.length - 1]}` : keys[0]}.\n`)
    }
  })
}

async function openExternalIteration(
  options: RunOptions,
  harness: IterationHarness,
  progress: ProgressUI,
  stepName: string,
  deps: HumanReviewGateDeps,
) {
  const name = harnessName(harness)
  progress.phaseActivity(stepName, `opening ${name} iteration in a new window`, "system")
  try {
    const backend =
      harness.kind === "opencode"
        ? await deps.openInteractiveOpencodeWindow({
            url: harness.server.url,
            ...(harness.server.password ? { password: harness.server.password } : {}),
            targetDir: options.targetDir,
          })
        : await cliIterations[harness.runner]!.open(deps, {
            targetDir: options.targetDir,
            ...(options.runnerAuth?.[harness.runner] ? { auth: options.runnerAuth[harness.runner]! } : {}),
            label: `${stepRunnerFor(harness.runner).sessionName} ${stepName}`,
          })
    progress.phaseActivity(stepName, `${name} iteration opened in ${backend}; return here and press c to continue`, "system")
    return true
  } catch (error) {
    progress.phaseActivity(stepName, `couldn't open ${name} iteration: ${error instanceof Error ? error.message : String(error)}`, "error")
    return false
  }
}

async function runSuspendedInteractiveIteration(
  options: RunOptions,
  harness: IterationHarness,
  progress: ProgressUI,
  stepName: string,
  permissions: PermissionGate | undefined,
  deps: HumanReviewGateDeps,
) {
  progress.phaseActivity(stepName, `falling back to interactive ${harnessName(harness)} in this terminal`, "system")
  progress.suspend()
  try {
    await runInteractiveIteration(options, harness, stepName, permissions, deps)
  } finally {
    progress.resume()
  }
}

async function runInteractiveIteration(
  options: RunOptions,
  harness: IterationHarness,
  stepName: string,
  permissions: PermissionGate | undefined,
  deps: HumanReviewGateDeps,
) {
  // The interactive client answers its own permission prompts; Convoy's
  // gate must not race it for the same requests.
  permissions?.pause()
  try {
    if (harness.kind === "opencode") {
      await deps.runInteractiveOpencode(options, harness.server, stepName)
      return
    }
    const name = harnessName(harness)
    log.info(`[${stepName}] handing control to ${name} in ${options.targetDir}`)
    const code = await cliIterations[harness.runner]!.run(deps, {
      targetDir: options.targetDir,
      ...(options.runnerAuth?.[harness.runner] ? { auth: options.runnerAuth[harness.runner]! } : {}),
    })
    if (code !== 0) throw new Error(`[${stepName}] interactive ${name} exited with code ${code}`)
  } finally {
    permissions?.resume()
  }
}

async function runInteractiveOpencode(options: RunOptions, server: ServerAuth, stepName = "human") {
  // Same shape as the windowed path: `run --interactive` refuses to start
  // without a message, so connect the full TUI to the run's server instead.
  const args = [options.targetDir, "--server", server.url, "--continue"]

  log.info(`[${stepName}] handing control to OpenCode (connected to ${server.url})`)
  const proc = Bun.spawn([resolveOpencodeBin(), ...args], {
    cwd: options.targetDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...serverPasswordEnv(server.password) },
  })

  const code = await proc.exited
  if (code !== 0) throw new Error(`[${stepName}] interactive OpenCode exited with code ${code}`)
}

/**
 * Commits one human iteration (OpenCode or Claude) as the step's intermediate commit. The
 * message is composed inside the commit seam from the exact staged paths —
 * never the fixed `apply manual iteration` — and carries the active run's
 * `Convoy-Run` trailer (capability `step-commit-messages`). The commit is
 * ledgered into durable run metadata so automatic finalization can attribute
 * it to the run (task 1.3).
 */
async function commitHumanChanges(workspace: Workspace, options: RunOptions, stepName: string, metadata?: RunMetadataStore) {
  const record: ((entry: CommitLedgerEntry) => Promise<void>) | undefined = metadata
    ? (entry) => metadata.appendLedgerEntry(entry).catch((error) => log.warn(`couldn't persist commit ledger entry: ${String(error)}`))
    : undefined
  const commit = () =>
    addAllAndCommit(stepCommitMessageFactory({ workspace, step: stepName, mode: "human" }), options.targetDir)
  const committed = record
    ? await recordLedgeredCommit(record, { mode: "human", step: stepName, cwd: options.targetDir }, commit)
    : await commit()
  if (committed) log.info(`[${stepName}] committed manual changes (${workspace.runID})`)
}

async function writeHumanReviewReport(workspace: Workspace, result: "approved" | "aborted", iterations: number, stepName: string, harness: IterationHarness) {
  const reportPath = join(workspace.dir, "reports", `${stepName}.md`)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(
    reportPath,
    [
      "# human step",
      "",
      `- Result: ${result}`,
      `- Manual ${harnessName(harness)} iterations: ${iterations}`,
      "",
    ].join("\n"),
  )
}
