import "./polyfills"

import { stat } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2"

import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2"

import { openSessionCommand, sessionShellCommand, shellQuote, type SessionWindowBackend } from "./terminal-host"
import { withoutHerdrEnv } from "./herdr"

export { openSessionCommand, sessionShellCommand, shellQuote }
export type { SessionWindowBackend }

export type OpencodeHandle = {
  client: OpencodeClient
  url: string
  close(): void
}

type StartOpencodeDeps = {
  getFreePort(): Promise<number>
  createServer(options: Parameters<typeof createOpencodeServer>[0]): Promise<{ url: string; close(): void }>
  createClient(options: Parameters<typeof createOpencodeClient>[0]): OpencodeClient
}

// Async on purpose: this is called from the TUI's render path, and a sync
// osascript call would freeze the dashboard while macOS opens the window.
// Inside Herdr or Zellij it creates a sibling pane. Elsewhere it prefers
// Ghostty when installed; Terminal.app is the fallback that always works on
// macOS. CONVOY_TERMINAL=herdr|zellij|ghostty|terminal forces a backend.
export async function openOpencodeSessionWindow(input: {
  url: string
  targetDir: string
  sessionID: string
}): Promise<SessionWindowBackend> {
  return openSessionCommand(
    ["opencode", "attach", input.url, "--dir", input.targetDir, "--session", input.sessionID].map(shellQuote).join(" "),
    input.targetDir,
    "opencode session",
  )
}

// `run --interactive` needs a message and exits immediately without one, so
// the window attaches the full TUI to the run's server instead; --continue
// resumes the run's latest session with its context.
export async function openInteractiveOpencodeWindow(input: {
  url: string
  targetDir: string
}): Promise<SessionWindowBackend> {
  const args = ["opencode", "attach", input.url, "--dir", input.targetDir, "--continue"]
  return openSessionCommand(args.map(shellQuote).join(" "), input.targetDir, "opencode interactive")
}

// Opens a standalone opencode TUI on a stored session — it starts its own
// server and reads the session from disk — for runs whose live server is gone
// (so `[o]` in a re-opened finished-run dashboard still works).
export async function openStoredSessionWindow(input: {
  targetDir: string
  sessionID: string
  runDir: string
}): Promise<SessionWindowBackend> {
  return openSessionCommand(
    ["opencode", input.targetDir, "--session", input.sessionID].map(shellQuote).join(" "),
    input.targetDir,
    "opencode session",
    runDirSessionEnv(input.runDir),
  )
}

// Opens a standalone opencode TUI on a brand-new session seeded with an
// initial prompt (--prompt submits it on startup). Standalone on purpose: the
// run's server dies when the finish screen closes, and this window must
// outlive convoy so the user can keep iterating.
export async function openIterateOpencodeWindow(input: {
  targetDir: string
  prompt: string
  runDir: string
}): Promise<SessionWindowBackend> {
  const coreCommand = ["opencode", input.targetDir, "--prompt", input.prompt].map(shellQuote).join(" ")
  return openSessionCommand(coreCommand, input.targetDir, "opencode iterate", runDirSessionEnv(input.runDir))
}

/**
 * Builds the compact OpenCode config granting read access to exactly the run
 * directory, so a standalone session window can read prd.md and report files
 * without prompting. Injected as OPENCODE_CONFIG_CONTENT because that loads
 * after the project opencode.json (so a project-level "*": "ask" cannot
 * override the narrower run-dir rule) and deep-merges with global + project
 * config. Only `external_directory` and `read` are added; there is no "*".
 */
export function runDirAccessConfig(runDir: string): string {
  const glob = join(runDir, "**")
  // Fail closed: an empty or relative run dir normalizes to "**" (allow every
  // external directory) and "/" — or any path normalizing to it — to "/**"
  // (the whole filesystem). Both would silently widen this run-scoped grant
  // into a universal read allow instead of prompting, so refuse them.
  if (!isAbsolute(glob) || glob === "/**") {
    throw new Error(`run dir must be an absolute directory, got: ${JSON.stringify(runDir)}`)
  }
  return JSON.stringify({
    permission: {
      external_directory: { [glob]: "allow" },
      read: { [glob]: "allow" },
    },
  })
}

/** The env pair the standalone openers pass on to openSessionCommand. */
function runDirSessionEnv(runDir: string): Record<string, string> {
  return { OPENCODE_CONFIG_CONTENT: runDirAccessConfig(runDir) }
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

/**
 * Boots a bounded OpenCode server rooted at an explicit checkout (capability
 * work-conversations, design D5): unlike `startOpencode`, which inherits
 * Convoy's cwd, this spawns the CLI with an explicit cwd so the server's
 * project scope is that checkout's repository. The URL is parsed from the
 * server's own startup output, and `close()` terminates the child; a boot
 * that fails or stalls within the timeout rejects instead of hanging.
 */
export async function bootOpencodeServerFrom(checkout: string, timeoutMs = 30_000): Promise<{ url: string; close(): void; pid: number }> {
  const { spawn } = await import("node:child_process")
  const port = await freePort()
  const child = spawn("opencode", ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd: checkout,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const url = await new Promise<string>((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`opencode server did not report a URL within ${timeoutMs}ms (stderr: ${stderr.trim().slice(0, 300)})`))
    }, timeoutMs)
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
      const match = stdout.match(/http:\/\/[^\s]+/)
      if (match) {
        clearTimeout(timer)
        resolve(match[0])
      }
    })
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`opencode server exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`))
    })
  })
  return {
    url,
    close() {
      child.kill("SIGTERM")
    },
    // The spawned server process — the conversation service's liveness anchor.
    pid: child.pid ?? 0,
  }
}

export async function startOpencode(
  config: Config,
  signal?: AbortSignal,
  deps?: Partial<StartOpencodeDeps>,
): Promise<OpencodeHandle> {
  const port = await (deps?.getFreePort ?? freePort)()
  // The SDK hands the server child Convoy's environment at spawn time, and
  // ServerOptions has no env override (confirmed against @opencode-ai/sdk).
  // A global `herdr integration install opencode` plugin would otherwise
  // inherit HERDR_PANE_ID and claim the pane as an "opencode" agent.
  //
  // This wrapper is synchronous: `finally` restores process.env when `fn`
  // returns, which for an async createOpencodeServer is when the Promise is
  // *created*, not when it settles. That is enough because @opencode-ai/sdk
  // spreads `{...process.env}` in launch()/cross-spawn before its first
  // `await`. Re-verify that on SDK upgrades — if spawn moves past an await,
  // the child would inherit the restored HERDR_* keys. Do not make this
  // helper async: awaiting would widen the global-mutation window.
  const server = await withProcessHerdrEnvStripped(() =>
    (deps?.createServer ?? createOpencodeServer)({
      hostname: "127.0.0.1",
      port,
      timeout: 30_000,
      signal,
      config,
    }),
  )
  const client = (deps?.createClient ?? createOpencodeClient)({ baseUrl: server.url, fetch: fetchWithoutIdleTimeout as typeof fetch })

  return {
    client,
    url: server.url,
    close: server.close,
  }
}

/**
 * Runs `fn` with every `HERDR_*` key removed from `process.env`, then restores
 * them when `fn` returns (not when a returned Promise settles). See the
 * call-site comment: the strip only covers the SDK's synchronous spawn.
 */
function withProcessHerdrEnvStripped<T>(fn: () => T): T {
  // Reuses the same filter as the reporter's env injection so the set of
  // stripped keys stays in one place. The kept object is a shallow copy of the
  // non-HERDR entries; any key absent from it is a HERDR_* key to save/delete.
  const kept = withoutHerdrEnv(process.env)
  const saved = new Map<string, string | undefined>()
  for (const key of Object.keys(process.env)) {
    if (!(key in kept)) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// A client for an opencode server already running elsewhere (a live run's
// server), so `convoy runs` can attach and mirror its event stream.
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

