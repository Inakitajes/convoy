import { spawn, type ChildProcess } from "node:child_process"
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

type AppProcess = ChildProcess
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
  // Human steps are filtered out of new pipelines when --no-human-review is
  // set; this guard covers resumed runs whose frozen pipeline still has one.
  if (!options.humanReview) {
    progress.phaseSkipped(stepName)
    log.warn(`[${stepName}] skipped by --no-human-review`)
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
  let app: AppProcess | undefined
  const inheritOutput = !askInTui
  const askAction = async () => (askInTui ? askInTui(humanReviewInfo(stepName, options, iterations, app)) : askHumanAction())

  // Plain readline fallback still owns the terminal. The TUI path keeps the
  // dashboard active and resolves actions via ProgressUI.askHumanReview.
  if (!askInTui) progress.suspend()
  try {
    log.section(`${stepName} - manual review checkpoint`)
    let action = await askAction()

    for (;;) {
      if (action === "continue") {
        await commitHumanChanges(options)
        await writeHumanReviewReport(workspace, options, "approved", iterations, stepName)
        progress.phaseCompleted(stepName, "approved")
        return
      }

      if (action === "prepare" || action === "rerun") {
        await stopApp(app)
        app = await prepareApp(options, progress, stepName, { inheritOutput })
        action = await askAction()
        continue
      }

      if (action === "iterate") {
        iterations++
        progress.phaseRunning(stepName, "interactive OpenCode iteration")
        if (askInTui) {
          // The external OpenCode TUI owns its own permission prompts. Keep
          // Archer's dashboard gate paused until the user returns to this gate
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

          await stopApp(app)
          app = undefined
          await runSuspendedInteractiveIteration(options, opencodeUrl, progress, stepName, permissions, deps.runInteractiveOpencode)
          await commitHumanChanges(options)
        } else {
          await stopApp(app)
          app = undefined
          await runInteractiveIteration(options, opencodeUrl, permissions, deps.runInteractiveOpencode)
          await commitHumanChanges(options)
        }
        action = await askAction()
        continue
      }

      await writeHumanReviewReport(workspace, options, "aborted", iterations, stepName)
      progress.phaseFailed(stepName, "aborted by user")
      throw new Error("aborted by human review")
    }
  } finally {
    await stopApp(app)
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

function humanReviewInfo(stepName: string, options: RunOptions, iterations: number, app: AppProcess | undefined) {
  return {
    stepName,
    iterations,
    appRunning: Boolean(app && app.exitCode === null && app.signalCode === null),
    appCommand: options.appRunCommand,
    emulatorID: options.emulatorID,
    interactiveModel: options.interactiveModel,
    interactiveVariant: options.interactiveVariant,
  }
}

async function prepareApp(options: RunOptions, progress: ProgressUI, stepName: string, io: { inheritOutput: boolean }): Promise<AppProcess | undefined> {
  progress.phaseRunning(stepName, "preparing app")
  await launchEmulator(options, io)
  progress.phaseRunning(stepName, "running app command")
  return startApp(options, progress, stepName, io)
}

async function launchEmulator(options: RunOptions, io: { inheritOutput: boolean }) {
  const emulatorID = options.emulatorID
  if (!emulatorID) {
    log.info("[human-review] no emulator configured; starting app command without launching one")
    return
  }

  log.info(`[human-review] launching emulator ${emulatorID}`)
  const proc = Bun.spawn(["flutter", "emulators", "--launch", emulatorID], {
    cwd: options.targetDir,
    stdin: "ignore",
    stdout: io.inheritOutput ? "inherit" : "ignore",
    stderr: io.inheritOutput ? "inherit" : "ignore",
    env: process.env,
  })
  const code = await proc.exited
  if (code !== 0) log.warn(`[human-review] emulator launch exited with code ${code}; start it manually if needed`)
}

function startApp(options: RunOptions, progress: ProgressUI, stepName: string, io: { inheritOutput: boolean }): AppProcess | undefined {
  if (!options.appRunCommand) {
    log.warn("[human-review] app launch disabled; start the app manually before continuing")
    progress.phaseActivity(stepName, "app launch disabled; start it manually", "info")
    return undefined
  }

  log.info(`[human-review] starting app: ${options.appRunCommand}`)
  // detached gives the shell its own process group, so stopApp can signal the
  // whole tree (pnpm/flutter spawn the real servers as grandchildren).
  return spawn("sh", ["-c", options.appRunCommand], {
    cwd: options.targetDir,
    stdio: io.inheritOutput ? ["ignore", "inherit", "inherit"] : ["ignore", "ignore", "ignore"],
    detached: true,
    env: process.env,
  })
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
      const answer = (await rl.question("Human review: [c]ontinue, [i]terate, [s]tart app, [r]erun app, [a]bort > ", {
        signal: controller.signal,
      }))
        .trim()
        .toLowerCase()
      if (answer === "c" || answer === "continue") return "continue" as const
      if (answer === "i" || answer === "iterate") return "iterate" as const
      if (answer === "s" || answer === "start" || answer === "prepare") return "prepare" as const
      if (answer === "r" || answer === "rerun") return "rerun" as const
      if (answer === "a" || answer === "abort") return "abort" as const
      stdout.write("Choose c, i, s, r, or a.\n")
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      stdout.write("\n")
      if (interrupted) {
        log.warn("[human-review] Ctrl+C received; aborting")
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
      model: options.interactiveModel,
      variant: options.interactiveVariant,
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
    await runInteractiveIteration(options, opencodeUrl, permissions, runInteractive)
  } finally {
    progress.resume()
  }
}

async function runInteractiveIteration(
  options: RunOptions,
  opencodeUrl: string,
  permissions?: PermissionGate,
  runInteractive: typeof runInteractiveOpencode = runInteractiveOpencode,
) {
  // The interactive OpenCode TUI answers its own permission prompts; Archer's
  // gate must not race it for the same requests.
  permissions?.pause()
  try {
    await runInteractive(options, opencodeUrl)
  } finally {
    permissions?.resume()
  }
}

async function runInteractiveOpencode(options: RunOptions, opencodeUrl: string) {
  const args = [
    "run",
    "--interactive",
    "--attach",
    opencodeUrl,
    "--dir",
    options.targetDir,
    "--model",
    options.interactiveModel,
  ]
  if (options.interactiveVariant) args.push("--variant", options.interactiveVariant)

  log.info(`[human-review] handing control to OpenCode (${options.interactiveModel}${options.interactiveVariant ? `#${options.interactiveVariant}` : ""})`)
  const proc = Bun.spawn(["opencode", ...args], {
    cwd: options.targetDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })

  const code = await proc.exited
  if (code !== 0) throw new Error(`[human-review] interactive OpenCode exited with code ${code}`)
}

async function commitHumanChanges(options: RunOptions) {
  const committed = await addAllAndCommit("archer(human-review): apply manual iteration", options.targetDir)
  if (committed) log.info("[human-review] committed manual changes")
}

async function writeHumanReviewReport(workspace: Workspace, options: RunOptions, result: "approved" | "aborted", iterations: number, stepName: string) {
  const reportPath = join(workspace.dir, "reports", `${stepName}.md`)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(
    reportPath,
    [
      "# human review",
      "",
      `- Result: ${result}`,
      `- Manual OpenCode iterations: ${iterations}`,
      `- App command: ${options.appRunCommand || "disabled"}`,
      `- Emulator: ${options.emulatorID || "not launched by Archer"}`,
      `- Interactive model: ${options.interactiveModel}${options.interactiveVariant ? `#${options.interactiveVariant}` : ""}`,
      "",
    ].join("\n"),
  )
}

async function stopApp(proc: AppProcess | undefined) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return

  const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)))
  killAppGroup(proc, "SIGTERM")
  const code = await Promise.race([exited, sleep(5_000).then(() => undefined)])
  if (code === undefined) {
    killAppGroup(proc, "SIGKILL")
    await exited
    return
  }
  if (code !== null && ![0, 130, 143].includes(code)) log.warn(`[human-review] stopped app process with code ${code}`)
}

// The app runs in its own process group (detached); signal the group so dev
// servers spawned by the wrapper shell die too, not just the shell.
function killAppGroup(proc: AppProcess, signal: NodeJS.Signals) {
  if (!proc.pid) return
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill(signal)
    } catch {
      // already gone
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
