/**
 * Owned OpenCode v2 server boot (change `runner-parity-opencode-v2`, task 4.2).
 *
 * Convoy spawns and owns one v2 `serve` child, reads its readiness URL and its
 * per-boot password from startup output, and stops it within a bounded,
 * observed budget (reusing the shared stop state machine). The child does NOT
 * inherit `OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD`: v2 would adopt either
 * and skip the password line readiness waits for.
 *
 * Ownership and shutdown re-use the existing shared stop machinery; this module
 * only knows how to start a v2 server and read what it prints.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { createServer } from "node:net"

import { childStopTarget, stopTarget, type StopOutcome, type StopPolicy } from "../../process-stop"

export type OwnedServer = {
  url: string
  /** Per-boot HTTP Basic password. Private: never log or persist publicly. */
  password: string
  pid: number
  /** Idempotent bounded stop; concurrent callers share one outcome. */
  stop(): Promise<StopOutcome>
  /** Last-resort synchronous SIGKILL edge. */
  forceStop(): void
}

export type SpawnChildFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export type BootOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  stopPolicy?: StopPolicy
  deps?: {
    spawn?: SpawnChildFn
    getFreePort?: () => Promise<number>
  }
}

export const defaultBootTimeoutMs = 30_000

/** Credential env vars a spawned v2 server must not inherit. */
export const strippedServerCredentialEnv = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"] as const

export class ServerBootError extends Error {
  readonly cleanup?: StopOutcome
  constructor(message: string, cleanup?: StopOutcome) {
    super(message)
    this.name = "ServerBootError"
    if (cleanup) this.cleanup = cleanup
  }
}

export type BootReadiness = { url: string; password: string }

/**
 * Extracts readiness evidence from one startup line. Returns the URL, the
 * password, both, or undefined for an unrelated line. A line that looks like
 * readiness but has no parseable URL is ignored (the caller still has the boot
 * timeout as its backstop).
 */
export function parseBootLine(line: string): Partial<BootReadiness> | undefined {
  const result: Partial<BootReadiness> = {}
  const url = line.match(/server listening on (https?:\/\/\S+)/)
  if (url?.[1]) result.url = url[1]
  const password = line.match(/server password (\S+)/)
  if (password?.[1]) result.password = password[1]
  return Object.keys(result).length > 0 ? result : undefined
}

export function sanitizeServerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of strippedServerCredentialEnv) delete next[key]
  return next
}

async function freePort(): Promise<number> {
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
 * Spawns and owns one `opencode serve` v2 child. Resolves once both the URL and
 * the password have been observed; rejects (after bounded cleanup) for spawn
 * error, early exit, timeout, or a malformed/absent readiness line.
 */
export async function bootOwnedServer(options: BootOptions): Promise<OwnedServer> {
  const spawnChild = options.deps?.spawn ?? (nodeSpawn as unknown as SpawnChildFn)
  const timeoutMs = options.timeoutMs ?? defaultBootTimeoutMs
  const port = await (options.deps?.getFreePort ?? freePort)()

  const child = spawnChild("opencode", ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd: options.cwd,
    env: sanitizeServerEnv(options.env ?? process.env),
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stopPromise: Promise<StopOutcome> | undefined
  const target = childStopTarget({ child: child as unknown as Parameters<typeof childStopTarget>[0]["child"], pid: child.pid ?? 0 })
  const stop = (): Promise<StopOutcome> => (stopPromise ??= stopTarget(target, options.stopPolicy))
  const forceStop = () => {
    try {
      if (child.pid) child.kill("SIGKILL")
    } catch {
      // best effort
    }
  }

  return await new Promise<OwnedServer>((resolve, reject) => {
    let settled = false
    let readiness: Partial<BootReadiness> = {}
    let tail = ""

    const cleanupAndReject = async (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const cleanup = await stop().catch((): StopOutcome => ({ status: "unresolved", reason: "stop threw" }))
      const suffix = tail.trim() ? `: ${tail.trim().slice(-600)}` : ""
      reject(new ServerBootError(`${message}${suffix}`, cleanup))
    }

    const onLine = (line: string) => {
      if (settled) return
      const parsed = parseBootLine(line)
      if (!parsed) return
      readiness = { ...readiness, ...parsed }
      if (readiness.url && readiness.password) {
        settled = true
        clearTimeout(timer)
        child.removeListener("exit", onExit)
        resolve({ url: readiness.url, password: readiness.password, pid: child.pid ?? 0, stop, forceStop })
      }
    }

    const consume = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return
      let buffer = ""
      stream.setEncoding("utf8")
      stream.on("data", (chunk: string) => {
        buffer += chunk
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          tail = (tail + line + "\n").slice(-4_000)
          onLine(line)
        }
      })
    }
    consume(child.stdout)
    consume(child.stderr)

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      void cleanupAndReject(`opencode server exited before it was ready (code ${code ?? "null"}${signal ? `, ${signal}` : ""})`)
    }
    child.once("exit", onExit)

    child.once("error", (error) => {
      void cleanupAndReject(`opencode server could not start: ${error instanceof Error ? error.message : String(error)}`)
    })

    const timer = setTimeout(() => {
      void cleanupAndReject(`opencode server did not report a readiness URL and password within ${timeoutMs}ms`)
    }, timeoutMs)
    timer.unref?.()
  })
}
