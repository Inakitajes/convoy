import { stat } from "node:fs/promises"
import { homedir } from "node:os"

/**
 * The terminal host (capability work-conversations, design D4): generic
 * window/pane presentation and foreground child hosting, extracted from the
 * OpenCode adapter so a harness adapter describes *what* to launch while this
 * module owns *how* it takes the terminal. Herdr, Zellij, Ghostty, and
 * Terminal.app are presentation backends, not harnesses; the foreground child
 * always receives structured arguments with an explicit cwd.
 */


/**
 * The generic foreground host (design D4): suspends the caller's UI, starts an
 * interactive child with the terminal's own streams, awaits its exit, and
 * restores input ownership, rendering, and current dimensions in `finally` —
 * normal exit, non-zero exit, failure to spawn, and interruption all restore.
 * The child receives structured arguments (no shell string), so nothing is
 * re-parsed or re-quoted on the way in. Exit code is returned for outcome
 * reporting; the caller decides what a non-zero exit means.
 *
 * The child transiently owns the primary screen the alternate screen reveals.
 * The host clears it after suspending (before the child starts) and again after
 * the child exits (before resuming), so neither Convoy's teardown nor the
 * child's startup terminal queries and frame setup stay visible on the surface
 * Convoy later reveals.
 */
export async function runForegroundChild(input: {
  argv: readonly string[]
  cwd: string
  /** Suspends the owning TUI (renderer.suspend + input release). Never throws through. */
  suspend(): void
  /** Restores the owning TUI at the current dimensions. Runs even on failure. */
  resume(): void
  /** Environment for the child; defaults to the parent's. */
  env?: Record<string, string>
  /** Wipes the released primary screen; defaults to {@link clearPrimaryScreen}. Injected for tests. */
  clear?: () => void
}): Promise<number> {
  const clear = input.clear ?? clearPrimaryScreen
  input.suspend()
  try {
    clear()
    const proc = Bun.spawn([...input.argv], {
      cwd: input.cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: input.env ?? process.env,
    })
    return await proc.exited
  } finally {
    clear()
    input.resume()
  }
}

/**
 * Wipes the visible primary screen after the alternate screen is released, so a
 * foreground child's startup capability queries and leftovers never stay on the
 * surface Convoy reveals when it exits. The scrollback above the screen is
 * intentionally left intact (no `ESC[3J`).
 */
export function clearPrimaryScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H")
}

const SESSION_WINDOW_BACKENDS = ["herdr", "zellij", "ghostty", "terminal"] as const

export type SessionWindowBackend = (typeof SESSION_WINDOW_BACKENDS)[number]

/**
 * Opens a command in a Herdr or Zellij pane or a new macOS terminal window.
 * Shared with the claude-code runner. `label` names the pane and is ignored by
 * the window backends, which have no equivalent.
 */
export async function openSessionCommand(coreCommand: string, cwd?: string, label?: string, env?: Record<string, string>): Promise<SessionWindowBackend> {
  return openShellCommand(coreCommand, cwd, label, env)
}

async function openShellCommand(coreCommand: string, cwd?: string, label?: string, env?: Record<string, string>): Promise<SessionWindowBackend> {
  const forced = forcedBackend()
  // An explicit choice always wins, which leaves an escape hatch for users who
  // intentionally want a separate macOS window from inside a multiplexer.
  // Herdr's `pane run` types into an interactive shell, so it gets the core
  // command — not the PATH-export wrapper the exec backends need.
  if (forced === "herdr") {
    await openInHerdr(coreCommand, cwd, label, env)
    return "herdr"
  }
  // Herdr exports HERDR_ENV for every process in a session — truthy in JS, so
  // it needs no special handling; an empty value means the export was scrubbed
  // and is deliberately not treated as a live session. The binary is probed
  // because Convoy's own PATH is not necessarily the one that started the
  // session, and a macOS window still beats no session at all.
  //
  // Herdr often runs inside Zellij, so both env vars are set. The inner
  // multiplexer owns sibling panes: if we miss Herdr and call `zellij action
  // new-pane`, that talks to the outer session and hangs or opens a pane the
  // user cannot see. Never fall through to Zellij while HERDR_ENV is live.
  const insideHerdr = Boolean(process.env.HERDR_ENV)
  if (!forced && insideHerdr && Bun.which("herdr") !== null) {
    try {
      await openInHerdr(coreCommand, cwd, label, env)
      return "herdr"
    } catch (error) {
      if (process.platform !== "darwin") throw error
    }
  }
  const command = sessionShellCommand(coreCommand, cwd, process.env.PATH, env)
  if (forced === "zellij") {
    await openInZellij(command, cwd, label)
    return "zellij"
  }
  // Zellij exports ZELLIJ for every process in a session, usually as "0" —
  // truthy in JS, so it needs no special handling; an empty value means the
  // export was scrubbed and is deliberately not treated as a live session.
  // The binary is probed because Convoy's own PATH is not necessarily the one
  // that started the session, and a macOS window still beats no session at all.
  if (!forced && !insideHerdr && process.env.ZELLIJ && Bun.which("zellij") !== null) {
    try {
      await openInZellij(command, cwd, label)
      return "zellij"
    } catch (error) {
      // Best effort, mirroring the Ghostty fallback below: on macOS there are
      // two working window backends behind this. Elsewhere there is nothing.
      if (process.platform !== "darwin") throw error
    }
  }
  if (process.platform !== "darwin") {
    // Telling someone already inside Herdr or Zellij to run Convoy inside a
    // multiplexer would name the wrong cause: reaching here un-forced with the
    // env var set means the probe above failed to find the binary. A forced
    // window backend gets the plain message, since it never asked for a pane.
    const missing = !forced ? detectedMultiplexer() : undefined
    throw new Error(
      missing
        ? `couldn't find the ${missing} binary on PATH to open a session pane`
        : "opening a new terminal window is implemented for macOS only; run Convoy inside Herdr or Zellij to open a session pane",
    )
  }

  if (forced === "terminal") {
    await openInTerminalApp(command)
    return "terminal"
  }
  if (forced === "ghostty" || (await ghosttyInstalled())) {
    try {
      await openInGhostty(command)
      return "ghostty"
    } catch (error) {
      if (forced === "ghostty") throw error
      // Best effort: Ghostty's macOS CLI has no window/tab IPC, so launch
      // failures here are expected on some setups; Terminal always works.
    }
  }
  await openInTerminalApp(command)
  return "terminal"
}

/** Reads CONVOY_TERMINAL, rejecting values that would otherwise fail obscurely. */
function forcedBackend(): SessionWindowBackend | undefined {
  const raw = process.env.CONVOY_TERMINAL?.trim().toLowerCase()
  if (!raw) return undefined
  const backend = SESSION_WINDOW_BACKENDS.find((candidate) => candidate === raw)
  if (!backend) throw new Error(`CONVOY_TERMINAL=${raw} is not a known backend; use one of ${SESSION_WINDOW_BACKENDS.join(", ")}`)
  return backend
}

/** The multiplexer whose env var is live in this process, Herdr winning over Zellij. */
function detectedMultiplexer(): "herdr" | "zellij" | undefined {
  if (process.env.HERDR_ENV) return "herdr"
  if (process.env.ZELLIJ) return "zellij"
  return undefined
}

// `herdr pane split` always launches a login shell — there is no exec-a-command
// flag the way `zellij action new-pane -- sh -lc` has. --cwd / --env PATH=
// give that shell Convoy's directory and PATH; ZDOTDIR=/var/empty skips the
// user's zshrc (nvm, fvm, completions…) so the prompt appears immediately
// instead of two seconds later. Then we wait for any output (the prompt) and
// `pane run` types only the short command. Typing `export PATH=...` or `cd`
// would be visible keystrokes and, with retries, look like several commands.
async function openInHerdr(command: string, cwd?: string, label?: string, env?: Record<string, string>) {
  const path = process.env.PATH
  const splitArgs = [
    "herdr", "pane", "split", "--current", "--direction", "right",
    ...(cwd ? ["--cwd", cwd] : []),
    ...(path ? ["--env", `PATH=${path}`] : []),
    "--env", "ZDOTDIR=/var/empty",
    ...(env ? Object.entries(env).flatMap(([key, value]) => {
      assertEnvKey(key)
      return ["--env", `${key}=${value}`]
    }) : []),
    "--focus",
  ]
  const stdout = await spawnCapture(splitArgs)
  const paneId = herdrPaneIdFromSplitOutput(stdout)
  // Name the pane, matching the Zellij backend's named panes.
  if (label) await spawnChecked(["herdr", "pane", "rename", paneId, label])
  await waitForHerdrPanePrompt(paneId)
  await runInHerdrPaneWithRetry(paneId, command)
}

const HERDR_PROMPT_WAIT_MS = 1500
const HERDR_RUN_RETRIES = 3
const HERDR_RETRY_DELAY_MS = 100

// Split returns as soon as the pane exists, not when the shell has printed a
// prompt. `pane run` types into that PTY, so a run before the prompt lands
// either vanishes or gets retried as a second visible command.
async function waitForHerdrPanePrompt(paneId: string) {
  try {
    await spawnChecked([
      "herdr", "pane", "wait-output", paneId,
      "--regex", ".",
      "--timeout", String(HERDR_PROMPT_WAIT_MS),
    ])
  } catch {
    // Best effort: a slow shell still gets pane run below.
  }
}

// Retries only cover a run that failed before sending (pane not registered
// yet). After wait-output the first attempt should land; keep a short loop
// so a single missed prompt doesn't lose the session.
async function runInHerdrPaneWithRetry(paneId: string, command: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await spawnChecked(["herdr", "pane", "run", paneId, command])
      return
    } catch (error) {
      if (attempt >= HERDR_RUN_RETRIES) throw error
      await Bun.sleep(HERDR_RETRY_DELAY_MS * attempt)
    }
  }
}

// `herdr pane split` answers `{"result":{"pane":{"pane_id":"…"}}}`; failures
// come back as `{"error":{"message":"…"}}` so they propagate with a real cause
// (for example, no active session) instead of a generic spawn failure.
function herdrPaneIdFromSplitOutput(stdout: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error("herdr pane split returned unparseable output")
  }
  const response = parsed as { result?: { pane?: { pane_id?: string } }; error?: { message?: string } }
  if (response.error) throw new Error(response.error.message || "herdr pane split failed")
  const paneId = response.result?.pane?.pane_id
  if (!paneId) throw new Error("herdr pane split returned no pane_id")
  return paneId
}

// `zellij action new-pane` launches the command in the current session and
// focuses it, then exits 0 as soon as the pane exists — which says nothing
// about whether OpenCode started. So the pane is deliberately left to hold on
// exit (no --close-on-exit): a failed launch stays on screen with its exit
// code, and `Ctrl-c` closes it. --cwd gives Zellij the right pane metadata
// while the command's own `cd` stays the guard that stops a launch into a
// missing directory. `sh` suffices where Ghostty needs a `zsh` login shell,
// because sessionShellCommand re-exports the PATH Convoy inherited from the
// shell that started the Zellij session.
async function openInZellij(command: string, cwd?: string, label?: string) {
  const options = [...(label ? ["--name", label] : []), ...(cwd ? ["--cwd", cwd] : [])]
  await spawnChecked(["zellij", "action", "new-pane", ...options, "--", "sh", "-lc", command])
}

/** Builds the login-shell command, stopping before launch if setup or `cd` fails. */
export function sessionShellCommand(coreCommand: string, cwd?: string, path = process.env.PATH, env?: Record<string, string>): string {
  return [
    path ? `export PATH=${shellQuote(path)}:$PATH` : "",
    ...(env ? Object.entries(env).map(([key, value]) => {
      assertEnvKey(key)
      return `export ${key}=${shellQuote(value)}`
    }) : []),
    cwd ? `cd ${shellQuote(cwd)}` : "",
    coreCommand,
  ]
    .filter(Boolean)
    .join(" && ")
}

async function ghosttyInstalled() {
  const bundles = ["/Applications/Ghostty.app", `${homedir()}/Applications/Ghostty.app`]
  for (const bundle of bundles) {
    if (await exists(bundle)) return true
  }
  return Bun.which("ghostty") !== null
}

// `open -na` asks macOS to launch a new Ghostty instance; `-e` makes Ghostty
// run the command. A login shell keeps the user's PATH for `opencode`.
async function openInGhostty(command: string) {
  await spawnChecked(["open", "-na", "Ghostty", "--args", "-e", "zsh", "-lc", command])
}

async function openInTerminalApp(command: string) {
  const script = `tell application "Terminal"\nactivate\ndo script ${appleScriptString(command)}\nend tell`
  await spawnChecked(["osascript", "-e", script])
}

async function spawnChecked(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (status !== 0) throw new Error(stderr.trim() || `${cmd[0]} exited with status ${status}`)
}

/** Like spawnChecked, but returns stdout as text for commands that answer. */
async function spawnCapture(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (status !== 0) throw new Error(stderr.trim() || `${cmd[0]} exited with status ${status}`)
  return stdout
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Env keys ride shell `export` lines and herdr `--env` pairs, both of which
 * are re-parsed downstream — a key carrying shell metacharacters would inject
 * into the typed command. Only plain identifiers may pass through.
 */
function assertEnvKey(key: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`invalid environment variable name: ${JSON.stringify(key)}`)
  }
}

function appleScriptString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
