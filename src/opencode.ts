import "./polyfills"

import { stat } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

import { createOpencodeClient } from "@opencode-ai/sdk/v2"

import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2"

import { launchManagedServer, type ManagedServer } from "./managed-server"
import type { IdentityProbe, LifetimeClass, ProcessIdentity } from "./process-identity"
import type { ProcessRecordStore } from "./process-records"
import type { StopOutcome, StopPolicy } from "./process-stop"
import { openSessionCommand, sessionShellCommand, shellQuote, type SessionWindowBackend } from "./terminal-host"
import { withoutHerdrEnv } from "./herdr"

export { openSessionCommand, sessionShellCommand, shellQuote }
export type { SessionWindowBackend }

/**
 * A live Convoy-owned OpenCode server. `stop()` is the only way to release it:
 * it is idempotent, bounded, and resolves with an observed outcome (or an
 * honest `unresolved`), never with "the signal was delivered". `close()` is
 * the historical spelling of the same call, kept so existing call sites read
 * naturally while every owned `finally` now awaits it.
 */
export type OpencodeHandle = {
  client: OpencodeClient
  url: string
  pid: number
  /** Recorded child incarnation when the platform could observe one. */
  identity?: ProcessIdentity
  /** Id of the durable run/helper record that owns this child (design D6). */
  recordId?: string
  stop(): Promise<StopOutcome>
  /** Last-resort synchronous SIGKILL edge used by a repeated abort/deadline. */
  forceStop(): void
  close(): Promise<StopOutcome>
}

/** A bounded per-call server boot (conversation helpers, CLI discovery). */
export type BootedOpencodeServer = {
  url: string
  pid: number
  identity?: ProcessIdentity
  /** Id of the durable helper record that owns this child (design D6). */
  recordId?: string
  stop(): Promise<StopOutcome>
  forceStop(): void
  close(): Promise<StopOutcome>
}

type StartOpencodeDeps = {
  getFreePort(): Promise<number>
  createClient(options: Parameters<typeof createOpencodeClient>[0]): OpencodeClient
  /** Test seam: replaces the real owned spawn. */
  launch(options: Parameters<typeof launchManagedServer>[0]): Promise<ManagedServer>
  /** Lifetime class; the executor's run server is `run`, helpers default to `helper`. */
  lifetime?: LifetimeClass
  /** Run id recorded on the lifetime record so an orphan can be tied to its run (design D6). */
  runId?: string
  probe?: IdentityProbe
  store?: ProcessRecordStore
  /**
   * Stop policy for the owned helper. A resolver lets a helper under a
   * coordinator draw from that coordinator's remaining shutdown budget (design
   * D2) instead of a fresh standalone allowance.
   */
  stopPolicy?: StopPolicy | (() => StopPolicy)
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
 * work-conversations, design D5). Unlike `startOpencode`, which inherits
 * Convoy's cwd, this spawns the CLI with an explicit cwd so the server's
 * project scope is that checkout's repository. The URL is parsed from the
 * server's own startup output, ownership is published before readiness, and
 * `close()` performs a bounded observed stop; a boot that fails or stalls
 * within the timeout rejects instead of hanging.
 *
 * Lifetime defaults to `helper` (a short-lived per-call server). An
 * independently persistent authoring service passes `authoring-service`, which
 * is deliberately excluded from orphan reconciliation.
 */
export async function bootOpencodeServerFrom(
  checkout: string,
  timeoutMs = 30_000,
  options: { lifetime?: LifetimeClass; deps?: Partial<StartOpencodeDeps> } = {},
): Promise<BootedOpencodeServer> {
  const lifetime = options.lifetime ?? "helper"
  const server = await (options.deps?.launch ?? launchManagedServer)({
    command: "opencode",
    args: ["serve", "--hostname=127.0.0.1", `--port=${await (options.deps?.getFreePort ?? freePort)()}`],
    cwd: checkout,
    env: withoutHerdrEnv(process.env),
    lifetime,
    label: lifetime === "authoring-service" ? "opencode authoring service" : "opencode helper",
    timeoutMs,
    deps: {
      ...(options.deps?.probe ? { probe: options.deps.probe } : {}),
      ...(options.deps?.stopPolicy ? { policy: options.deps.stopPolicy } : {}),
    },
  })
  return {
    url: server.url,
    pid: server.pid,
    ...(server.identity ? { identity: server.identity } : {}),
    ...(server.recordId ? { recordId: server.recordId } : {}),
    stop: server.stop,
    forceStop: server.forceStop,
    close: server.stop,
  }
}

export async function startOpencode(
  config: Config,
  signal?: AbortSignal,
  deps?: Partial<StartOpencodeDeps>,
): Promise<OpencodeHandle> {
  const port = await (deps?.getFreePort ?? freePort)()
  const lifetime = deps?.lifetime ?? "helper"
  const args = ["serve", "--hostname=127.0.0.1", `--port=${port}`]
  const logLevel = (config as { logLevel?: unknown } | undefined)?.logLevel
  if (typeof logLevel === "string" && logLevel) args.push(`--log-level=${logLevel}`)

  // The child's environment is built explicitly per launch (design D1): HERDR_*
  // keys are stripped from the copy handed to the child instead of mutating —
  // and restoring — the parent's process.env around an SDK call. A herdr
  // integration plugin would otherwise inherit HERDR_PANE_ID and claim the
  // pane as an "opencode" agent. OPENCODE_CONFIG_CONTENT matches the SDK's own
  // injection so project/global config keeps deep-merging identically.
  const server = await (deps?.launch ?? launchManagedServer)({
    command: "opencode",
    args,
    cwd: process.cwd(),
    env: { ...withoutHerdrEnv(process.env), OPENCODE_CONFIG_CONTENT: JSON.stringify(config ?? {}) },
    lifetime,
    label: lifetime === "run" ? "opencode run server" : "opencode helper",
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
    ...(deps?.runId ? { runId: deps.runId } : {}),
    deps: {
      ...(deps?.probe ? { probe: deps.probe } : {}),
      ...(deps?.store ? { store: deps.store } : {}),
      ...(deps?.stopPolicy ? { policy: deps.stopPolicy } : {}),
    },
  })

  try {
    const client = (deps?.createClient ?? createOpencodeClient)({ baseUrl: server.url, fetch: fetchWithoutIdleTimeout as typeof fetch })
    return {
      client,
      url: server.url,
      pid: server.pid,
      ...(server.identity ? { identity: server.identity } : {}),
      ...(server.recordId ? { recordId: server.recordId } : {}),
      stop: server.stop,
      forceStop: server.forceStop,
      close: server.stop,
    }
  } catch (error) {
    // Never hand out a live child without a client: fail closed and confirm
    // the bounded stop before surfacing the construction failure.
    const cleanup = await server.stop()
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`opencode server client construction failed: ${reason} (cleanup: ${cleanup.status === "stopped" ? cleanup.via : `unresolved — ${cleanup.reason}`})`)
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

