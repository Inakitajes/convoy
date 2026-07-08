import "./polyfills"

import { stat } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"

import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2"

import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2"

export type OpencodeHandle = {
  client: OpencodeClient
  url: string
  close(): void
}

export async function startOpencode(config: Config, signal?: AbortSignal): Promise<OpencodeHandle> {
  const port = await freePort()
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port,
    timeout: 30_000,
    signal,
    config,
  })
  const client = createOpencodeClient({ baseUrl: server.url, fetch: fetchWithoutIdleTimeout as typeof fetch })

  return {
    client,
    url: server.url,
    close: server.close,
  }
}

// A client for an opencode server already running elsewhere (a live run's
// server), so `archer runs` can attach and mirror its event stream.
export function connectOpencode(url: string): OpencodeClient {
  return createOpencodeClient({ baseUrl: url, fetch: fetchWithoutIdleTimeout as typeof fetch })
}

// Bun kills fetch sockets that stay quiet for 5 minutes by default; the SSE
// event stream must outlive that during long tool runs. Bun honors the
// non-standard `timeout: false` since 1.1; on older versions it's ignored,
// which is why no single request is ever relied on for a whole phase.
function fetchWithoutIdleTimeout(request: Request) {
  return fetch(request, { timeout: false } as RequestInit)
}

export type SessionWindowBackend = "ghostty" | "terminal"

// Async on purpose: this is called from the TUI's render path, and a sync
// osascript call would freeze the dashboard while macOS opens the window.
// Prefers Ghostty when installed; Terminal.app is the fallback that always
// works on macOS. ARCHER_TERMINAL=ghostty|terminal forces a backend.
export async function openOpencodeSessionWindow(input: {
  url: string
  targetDir: string
  sessionID: string
}): Promise<SessionWindowBackend> {
  return openSessionCommand(
    ["opencode", "attach", input.url, "--dir", input.targetDir, "--session", input.sessionID].map(shellQuote).join(" "),
  )
}

export async function openInteractiveOpencodeWindow(input: {
  url: string
  targetDir: string
  model: string
  variant?: string
}): Promise<SessionWindowBackend> {
  const args = ["opencode", "run", "--interactive", "--attach", input.url, "--dir", input.targetDir, "--model", input.model]
  if (input.variant) args.push("--variant", input.variant)
  return openSessionCommand(args.map(shellQuote).join(" "))
}

// Opens a standalone opencode TUI on a stored session — it starts its own
// server and reads the session from disk — for runs whose live server is gone
// (so `[o]` in a re-opened finished-run dashboard still works).
export async function openStoredSessionWindow(input: {
  targetDir: string
  sessionID: string
}): Promise<SessionWindowBackend> {
  return openSessionCommand(["opencode", input.targetDir, "--session", input.sessionID].map(shellQuote).join(" "))
}

async function openSessionCommand(coreCommand: string): Promise<SessionWindowBackend> {
  if (process.platform !== "darwin") {
    throw new Error("opening a new OpenCode terminal window is currently implemented for macOS only")
  }

  // A login shell keeps the user's PATH for `opencode`.
  const command = [process.env.PATH ? `export PATH=${shellQuote(process.env.PATH)}:$PATH` : "", coreCommand]
    .filter(Boolean)
    .join("; ")

  const forced = process.env.ARCHER_TERMINAL?.toLowerCase()
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

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("couldn't find a free port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function appleScriptString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
