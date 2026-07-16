import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import { addAllAndCommit } from "./git"
import { log } from "./log"
import { openInteractiveOpencodeWindow } from "./opencode"
import { noopProgress, type HumanReviewAction, type ProgressUI } from "./progress"
import type { PermissionGate } from "./permissions"
import type { RunOptions } from "./types"
import type { Workspace } from "./workspace"

type HumanReviewGateDeps = {
  openInteractiveOpencodeWindow: typeof openInteractiveOpencodeWindow
  runInteractiveOpencode: typeof runInteractiveOpencode
}

const defaultHumanReviewGateDeps: HumanReviewGateDeps = { openInteractiveOpencodeWindow, runInteractiveOpencode }

export async function runHumanReviewGate(
  workspace: Workspace,
  options: RunOptions,
  opencodeUrl: string,
  progress: ProgressUI = noopProgress,
  permissions?: PermissionGate,
  stepName = "human-review",
  deps: HumanReviewGateDeps = defaultHumanReviewGateDeps,
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

  let iterations = 0
  const askAction = async () => (askInTui ? askInTui({ stepName, iterations }) : askHumanAction())

  // Plain readline fallback still owns the terminal. The TUI path keeps the
  // dashboard active and resolves actions via ProgressUI.askHumanReview.
  if (!askInTui) progress.suspend()
  try {
    log.section(`${stepName} - manual review checkpoint`)
    let action = await askAction()

    for (;;) {
      if (action === "continue") {
        await commitHumanChanges(options, stepName)
        await writeHumanReviewReport(workspace, "approved", iterations, stepName)
        progress.phaseCompleted(stepName, "approved")
        return
      }

      if (action === "iterate") {
        iterations++
        progress.phaseRunning(stepName, "interactive OpenCode iteration")
        if (askInTui) {
          // The external OpenCode TUI owns its own permission prompts. Keep
          // Convoy's dashboard gate paused until the user returns to this gate
          // and chooses the next action.
          permissions?.pause()
          try {
            const opened = await openExternalIteration(options, opencodeUrl, progress, stepName, deps.openInteractiveOpencodeWindow)
            if (opened) {
              action = await askAction()
              continue
            }
          } finally {
            permissions?.resume()
          }

          await runSuspendedInteractiveIteration(options, opencodeUrl, progress, stepName, permissions, deps.runInteractiveOpencode)
          await commitHumanChanges(options, stepName)
        } else {
          await runInteractiveIteration(options, opencodeUrl, stepName, permissions, deps.runInteractiveOpencode)
          await commitHumanChanges(options, stepName)
        }
        action = await askAction()
        continue
      }

      await writeHumanReviewReport(workspace, "aborted", iterations, stepName)
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

async function askHumanAction(): Promise<HumanReviewAction> {
  const rl = createInterface({ input: stdin, output: stdout })
  const controller = new AbortController()
  let interrupted = false
  // Raw-mode input never raises a process SIGINT; readline surfaces Ctrl+C
  // here instead, so without this listener the prompt would just hang.
  rl.on("SIGINT", () => {
    interrupted = true
    controller.abort()
  })

  try {
    for (;;) {
      const answer = (await rl.question("Human step: [c]ontinue pipeline, [o]pen OpenCode, [a]bort > ", {
        signal: controller.signal,
      }))
        .trim()
        .toLowerCase()
      if (answer === "c" || answer === "continue") return "continue" as const
      if (answer === "o" || answer === "open" || answer === "opencode") return "iterate" as const
      if (answer === "a" || answer === "abort") return "abort" as const
      stdout.write("Choose c, o, or a.\n")
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      stdout.write("\n")
      if (interrupted) {
        log.warn("[human-step] Ctrl+C received; aborting")
        return "abort"
      }
    }
    throw error
  } finally {
    rl.close()
  }
}

async function openExternalIteration(
  options: RunOptions,
  opencodeUrl: string,
  progress: ProgressUI,
  stepName: string,
  openWindow: typeof openInteractiveOpencodeWindow = openInteractiveOpencodeWindow,
) {
  progress.phaseActivity(stepName, "opening OpenCode iteration in a new window", "system")
  try {
    const backend = await openWindow({
      url: opencodeUrl,
      targetDir: options.targetDir,
    })
    progress.phaseActivity(stepName, `OpenCode iteration opened in ${backend}; return here and press c to continue`, "system")
    return true
  } catch (error) {
    progress.phaseActivity(stepName, `couldn't open OpenCode iteration: ${error instanceof Error ? error.message : String(error)}`, "error")
    return false
  }
}

async function runSuspendedInteractiveIteration(
  options: RunOptions,
  opencodeUrl: string,
  progress: ProgressUI,
  stepName: string,
  permissions?: PermissionGate,
  runInteractive: typeof runInteractiveOpencode = runInteractiveOpencode,
) {
  progress.phaseActivity(stepName, "falling back to interactive OpenCode in this terminal", "system")
  progress.suspend()
  try {
    await runInteractiveIteration(options, opencodeUrl, stepName, permissions, runInteractive)
  } finally {
    progress.resume()
  }
}

async function runInteractiveIteration(
  options: RunOptions,
  opencodeUrl: string,
  stepName: string,
  permissions?: PermissionGate,
  runInteractive: typeof runInteractiveOpencode = runInteractiveOpencode,
) {
  // The interactive OpenCode TUI answers its own permission prompts; Convoy's
  // gate must not race it for the same requests.
  permissions?.pause()
  try {
    await runInteractive(options, opencodeUrl, stepName)
  } finally {
    permissions?.resume()
  }
}

async function runInteractiveOpencode(options: RunOptions, opencodeUrl: string, stepName = "human") {
  // Same shape as the windowed path: `run --interactive` refuses to start
  // without a message, so attach the full TUI to the run's server instead.
  const args = ["attach", opencodeUrl, "--dir", options.targetDir, "--continue"]

  log.info(`[${stepName}] handing control to OpenCode (attached to ${opencodeUrl})`)
  const proc = Bun.spawn(["opencode", ...args], {
    cwd: options.targetDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })

  const code = await proc.exited
  if (code !== 0) throw new Error(`[${stepName}] interactive OpenCode exited with code ${code}`)
}

async function commitHumanChanges(options: RunOptions, stepName: string) {
  const committed = await addAllAndCommit(`convoy(${stepName}): apply manual iteration`, options.targetDir)
  if (committed) log.info(`[${stepName}] committed manual changes`)
}

async function writeHumanReviewReport(workspace: Workspace, result: "approved" | "aborted", iterations: number, stepName: string) {
  const reportPath = join(workspace.dir, "reports", `${stepName}.md`)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(
    reportPath,
    [
      "# human step",
      "",
      `- Result: ${result}`,
      `- Manual OpenCode iterations: ${iterations}`,
      "",
    ].join("\n"),
  )
}
