/**
 * A JSON-RPC client for an owned `codex app-server` child over stdio (change
 * `add-codex-runner`, design D1).
 *
 * Convoy starts one app-server per attempt (or helper inference) as its own
 * child and never attaches to the operator's shared daemon. The client sends
 * requests and notifications, routes notifications to one listener, and
 * answers the server's own requests (approvals, MCP elicitations) through one
 * handler. A server request the handler cannot answer gets a JSON-RPC error,
 * so a turn never waits on a question nobody will answer.
 */

import { ndjsonLines } from "../../ndjson"
import { redactSecrets } from "../redaction"
import { asRecord, type JsonRpcId, type JsonRpcMessage } from "./protocol"

/** The child process the client drives; injectable so tests can script a server. */
export type CodexProcess = {
  stdin: { write(chunk: string): unknown; end(): unknown }
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  exitCode: number | null
  kill(signal?: NodeJS.Signals | number): void
}

export type CodexSpawn = (command: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => CodexProcess

export const defaultCodexSpawn: CodexSpawn = (command, options) =>
  Bun.spawn(command, { cwd: options.cwd, env: options.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as unknown as CodexProcess

export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`codex ${method} failed: ${message}`)
    this.name = "CodexRpcError"
  }
}

/** The server closed the connection before answering. */
export class CodexClosedError extends Error {
  constructor(detail: string) {
    super(`codex app-server exited${detail ? `: ${detail}` : ""}`)
    this.name = "CodexClosedError"
  }
}

export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>
export type NotificationHandler = (method: string, params: unknown) => void

export type CodexAppServerOptions = {
  binary?: string
  /** Extra arguments after `app-server` (feature switches, `-c` overrides). */
  args?: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  spawn?: CodexSpawn
  onNotification?: NotificationHandler
  onServerRequest?: ServerRequestHandler
  /** Receives every raw protocol line the server writes (the attempt's raw stream log). */
  onRawLine?: (line: string) => void
  /** How long a stopping child gets after SIGTERM before it is killed. */
  stopGraceMs?: number
  /** Client identity sent at `initialize`. */
  clientVersion?: string
}

export type CodexAppServer = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  notify(method: string, params?: unknown): void
  /** The `initialize` result (user agent, Codex home). */
  readonly info: Record<string, unknown>
  /** Resolves when the child exits; carries the stderr tail for diagnostics. */
  readonly closed: Promise<{ code: number; stderr: string }>
  /** Ends stdin, then SIGTERM, then SIGKILL after the grace. Idempotent. */
  close(): Promise<void>
}

/**
 * The Codex release an app-server reports at `initialize`: its user agent
 * leads with `<originator>/<version>`.
 */
export function codexVersionOf(info: Record<string, unknown>): string | undefined {
  const agent = typeof info.userAgent === "string" ? info.userAgent : ""
  return /^[^/\s]+\/(\d+\.\d+\.\d+)/.exec(agent)?.[1] ?? (agent || undefined)
}

const defaultStopGraceMs = 5_000
const stderrTailLines = 3

/** Starts the child, performs the `initialize` handshake, and returns a ready client. */
export async function startCodexAppServer(options: CodexAppServerOptions): Promise<CodexAppServer> {
  const spawn = options.spawn ?? defaultCodexSpawn
  const proc = spawn([options.binary ?? "codex", "app-server", ...(options.args ?? [])], { cwd: options.cwd, env: options.env })
  let nextId = 1
  const pending = new Map<JsonRpcId, { method: string; resolve(value: unknown): void; reject(error: Error): void }>()
  let closedError: Error | undefined

  const write = (message: JsonRpcMessage) => {
    if (closedError) return
    try {
      proc.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      // The reader notices the exit and rejects what is pending.
    }
  }

  const answer = async (id: JsonRpcId, method: string, params: unknown) => {
    if (!options.onServerRequest) {
      write({ id, error: { code: -32601, message: `Convoy does not handle ${method}` } })
      return
    }
    try {
      write({ id, result: await options.onServerRequest(method, params) })
    } catch (error) {
      write({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  const stderrText = new Response(proc.stderr).text().catch(() => "")
  const reader = (async () => {
    for await (const line of ndjsonLines(proc.stdout)) {
      options.onRawLine?.(line)
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line) as JsonRpcMessage
      } catch {
        continue
      }
      if (asRecord(message) === undefined) continue
      if (message.method !== undefined && message.id !== undefined) {
        void answer(message.id, message.method, message.params)
      } else if (message.method !== undefined) {
        options.onNotification?.(message.method, message.params)
      } else if (message.id !== undefined) {
        const waiter = pending.get(message.id)
        if (!waiter) continue
        pending.delete(message.id)
        if (message.error) waiter.reject(new CodexRpcError(waiter.method, message.error.code, redactSecrets(message.error.message ?? "unknown error")))
        else waiter.resolve(message.result)
      }
    }
  })().catch(() => {})

  const closed = (async () => {
    const [code] = await Promise.all([proc.exited, reader])
    const stderr = redactSecrets((await stderrText).trim().split("\n").slice(-stderrTailLines).join(" ").trim())
    closedError = new CodexClosedError(stderr || `status ${code}`)
    for (const waiter of pending.values()) waiter.reject(closedError)
    pending.clear()
    return { code, stderr }
  })()

  const request = <T>(method: string, params?: unknown): Promise<T> => {
    if (closedError) return Promise.reject(closedError)
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject })
      write({ id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  let stopping: Promise<void> | undefined
  const close = () => {
    stopping ??= (async () => {
      try {
        proc.stdin.end()
      } catch {
        // already closed
      }
      if (proc.exitCode === null) proc.kill("SIGTERM")
      const grace = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL")
      }, options.stopGraceMs ?? defaultStopGraceMs)
      grace.unref?.()
      await closed.catch(() => {})
      clearTimeout(grace)
    })()
    return stopping
  }

  let info: Record<string, unknown>
  try {
    info =
      asRecord(
        await request("initialize", {
          clientInfo: { name: "convoy", version: options.clientVersion ?? "0.0.0" },
          capabilities: { experimentalApi: true },
        }),
      ) ?? {}
    write({ method: "initialized" })
  } catch (error) {
    await close()
    throw error
  }

  return {
    request,
    notify: (method, params) => write({ method, ...(params !== undefined ? { params } : {}) }),
    info,
    closed,
    close,
  }
}
