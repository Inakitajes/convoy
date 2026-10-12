import "./polyfills"

import { rmSync } from "node:fs"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

import { createOpencodeClient } from "./opencode-client"

import type { Config, OpencodeClient } from "./opencode-client"

import { launchManagedServer, type ManagedServer } from "./managed-server"
import { assertSupportedOpencodeRuntime, resolveOpencodeBin } from "./opencode-runtime"
import { log } from "./log"
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
  /** The V2 per-boot password the owned connection authenticates with. */
  password?: string
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
  /** The V2 per-boot password the owned connection authenticates with. */
  password?: string
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
  /**
   * Runtime compatibility gate (change `migrate-opencode-v2`, task 2.2).
   * Defaults to {@link assertSupportedOpencodeRuntime} and is skipped when a
   * `launch` seam is injected (a fake spawn has no real binary to probe).
   */
  assertRuntime?: () => Promise<unknown>
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
  password?: string
  targetDir: string
  sessionID: string
}): Promise<SessionWindowBackend> {
  return openServerClientWindow(
    [resolveOpencodeBin(), input.targetDir, "--server", input.url, "--session", input.sessionID],
    input.password,
    input.targetDir,
    "opencode session",
  )
}

// `run --interactive` needs a message and exits immediately without one, so
// the window connects the full TUI to the run's server instead; --continue
// resumes the run's latest session with its context.
export async function openInteractiveOpencodeWindow(input: {
  url: string
  password?: string
  targetDir: string
}): Promise<SessionWindowBackend> {
  return openServerClientWindow(
    [resolveOpencodeBin(), input.targetDir, "--server", input.url, "--continue"],
    input.password,
    input.targetDir,
    "opencode interactive",
  )
}

/**
 * The V2 client authenticates to a password-protected server through
 * OPENCODE_PASSWORD; a password in the --server URL is rejected (and echoed in
 * the error). For an in-process spawn it rides the child's environment.
 */
export function serverPasswordEnv(password: string | undefined): Record<string, string> | undefined {
  return password ? { OPENCODE_PASSWORD: password } : undefined
}

/**
 * The shell command that runs a server client in a window. A window's command
 * line is visible in `ps`, and Terminal.app types it into the user's shell
 * history, so the password never appears in it: it is staged in a one-shot
 * owner-only file that the command reads into the client's environment and
 * removes before the client starts.
 */
export async function serverClientCommand(argv: readonly string[], password: string | undefined): Promise<string> {
  return (await prepareServerClientCommand(argv, password)).command
}

async function prepareServerClientCommand(argv: readonly string[], password: string | undefined): Promise<{ command: string; discard(): Promise<void> }> {
  const client = argv.map(shellQuote).join(" ")
  if (!password) return { command: client, discard: async () => {} }
  const dir = await mkdtemp(join(tmpdir(), "convoy-client-auth-"))
  const file = join(dir, "password")
  await writeFile(file, password, { mode: 0o600 })
  stagedPasswordDirs.add(dir)
  // Wrapped in `sh -c` so it also runs when typed into a non-POSIX
  // interactive shell (Herdr). A re-run (up-arrow, a held pane) finds the
  // file gone and fails clearly instead of connecting without a password.
  const script = [
    `if [ ! -r ${shellQuote(file)} ]; then echo "convoy: this session's one-time password was already used; reopen the session from Convoy" >&2; exit 1; fi`,
    `OPENCODE_PASSWORD="$(cat ${shellQuote(file)})"`,
    `rm -rf ${shellQuote(dir)}`,
    "export OPENCODE_PASSWORD",
    `exec ${client}`,
  ].join("; ")
  return {
    command: `sh -c ${shellQuote(script)}`,
    discard: async () => {
      stagedPasswordDirs.delete(dir)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

// A staged password whose window never ran its command (a failed cd, a pane
// closed early) is removed when Convoy exits; it is useless once the run's
// server is gone anyway.
const stagedPasswordDirs = new Set<string>()
process.once("exit", () => {
  for (const dir of stagedPasswordDirs) rmSync(dir, { recursive: true, force: true })
})

async function openServerClientWindow(argv: readonly string[], password: string | undefined, targetDir: string, label: string): Promise<SessionWindowBackend> {
  const prepared = await prepareServerClientCommand(argv, password)
  try {
    return await openSessionCommand(prepared.command, targetDir, label)
  } catch (error) {
    // No window will ever read the staged password.
    await prepared.discard()
    throw error
  }
}

// Opens a standalone opencode TUI on a stored session — it starts its own
// server and reads the session from disk — for runs whose live server is gone
// (so `[o]` in a re-opened finished-run dashboard still works). --standalone
// keeps it off the user's background service, which V2 joins by default.
export async function openStoredSessionWindow(input: {
  targetDir: string
  sessionID: string
  runDir: string
}): Promise<SessionWindowBackend> {
  return openSessionCommand(
    [resolveOpencodeBin(), input.targetDir, "--standalone", "--session", input.sessionID].map(shellQuote).join(" "),
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
  const coreCommand = [resolveOpencodeBin(), input.targetDir, "--standalone", "--prompt", input.prompt].map(shellQuote).join(" ")
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

/**
 * Runs the runtime compatibility gate unless a test spawn seam is injected
 * (a fake launch has no real binary to probe). An explicit `assertRuntime`
 * seam always runs. A rejected gate fails the boot before any model work.
 */
async function assertOpencodeRuntime(deps?: Partial<StartOpencodeDeps>): Promise<void> {
  if (deps?.assertRuntime) {
    await deps.assertRuntime()
    return
  }
  if (!deps?.launch) {
    const info = await assertSupportedOpencodeRuntime()
    log.info(`[opencode] runtime ${info.executable} v${info.version} (supported V2)`)
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
  await assertOpencodeRuntime(options.deps)
  const server = await (options.deps?.launch ?? launchManagedServer)({
    command: resolveOpencodeBin(),
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
    ...(server.password ? { password: server.password } : {}),
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
  await assertOpencodeRuntime(deps)
  const port = await (deps?.getFreePort ?? freePort)()
  const lifetime = deps?.lifetime ?? "helper"
  const args = ["serve", "--hostname=127.0.0.1", `--port=${port}`]
  const logLevel = (config as { logLevel?: unknown } | undefined)?.logLevel
  if (typeof logLevel === "string" && logLevel) args.push(`--log-level=${logLevel}`)

  // The child's environment is built explicitly per launch (design D1): HERDR_*
  // keys are stripped from the copy handed to the child instead of mutating —
  // and restoring — the parent's process.env around an SDK call. A herdr
  // integration plugin would otherwise inherit HERDR_PANE_ID and claim the
  // pane as an "opencode" agent. OPENCODE_CONFIG_CONTENT is merged over the
  // user's global/project config; V2 normalizes its V1-shaped agent entries.
  const server = await (deps?.launch ?? launchManagedServer)({
    command: resolveOpencodeBin(),
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
    const client = (deps?.createClient ?? createOpencodeClient)({
      baseUrl: server.url,
      ...(server.password ? { password: server.password } : {}),
      fetch: fetchWithoutIdleTimeout as typeof fetch,
    })
    return {
      client,
      url: server.url,
      pid: server.pid,
      ...(server.password ? { password: server.password } : {}),
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
// server), so `convoy runs` can attach and mirror its event stream. The V2
// connection is authenticated with the server's per-boot password when known.
export function connectOpencode(url: string, password?: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl: url,
    ...(password ? { password } : {}),
    fetch: fetchWithoutIdleTimeout as typeof fetch,
  })
}

// Bun kills fetch sockets that stay quiet for 5 minutes by default; the SSE
// event stream must outlive that during long tool runs. Bun honors the
// non-standard `timeout: false` since 1.1; on older versions it's ignored,
// which is why no single request is ever relied on for a whole phase. The
// standard `(input, init)` signature is preserved so the V2 client's request
// options (including its authentication headers) are never dropped.
function fetchWithoutIdleTimeout(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, timeout: false } as RequestInit)
}

