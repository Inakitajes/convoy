import type { CodexProcess, CodexSpawn } from "../../src/runners/codex/app-server"
import type { JsonRpcMessage } from "../../src/runners/codex/protocol"

/**
 * A scripted `codex app-server` for tests: it answers the client's requests
 * through `handlers`, and a test drives the server side (notifications,
 * approval requests) through the returned `server`.
 */
export type FakeCodexServer = {
  notify(method: string, params?: unknown): void
  /** Sends a server request and resolves with the client's response message. */
  request(method: string, params?: unknown): Promise<JsonRpcMessage>
  /** Every message the client wrote, in order. */
  received: JsonRpcMessage[]
  exit(code?: number): void
}

export type FakeCodexHandler = (params: unknown, server: FakeCodexServer) => unknown | Promise<unknown>

export type FakeCodex = {
  spawn: CodexSpawn
  server: FakeCodexServer
  spawned: { command: string[]; env: NodeJS.ProcessEnv; cwd: string }[]
  requests(method: string): JsonRpcMessage[]
  killed: (NodeJS.Signals | number | undefined)[]
}

export const subscriptionAccount = { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true }

/** Handlers every attempt needs; a test overrides the ones it exercises. */
export function defaultCodexHandlers(overrides: Record<string, FakeCodexHandler> = {}): Record<string, FakeCodexHandler> {
  return {
    initialize: () => ({ userAgent: "convoy/0.163.0", codexHome: "/home/.codex" }),
    "account/read": () => subscriptionAccount,
    "config/read": () => ({ config: { mcp_servers: { operator_tools: { command: "true" } } } }),
    "thread/start": () => ({ thread: { id: "thread-1", model: "gpt-6.1-sol", reasoningEffort: "high" }, model: "gpt-6.1-sol", reasoningEffort: "high" }),
    "thread/resume": (params) => ({ thread: { id: (params as { threadId: string }).threadId, model: "gpt-6.1-sol" }, model: "gpt-6.1-sol" }),
    "turn/start": () => ({ turn: { id: "turn-1", status: "inProgress" } }),
    "turn/steer": () => ({ turnId: "turn-1" }),
    "turn/interrupt": () => ({}),
    "model/list": () => ({ data: [] }),
    ...overrides,
  }
}

export function fakeCodex(handlers: Record<string, FakeCodexHandler> = defaultCodexHandlers()): FakeCodex {
  const spawned: FakeCodex["spawned"] = []
  const killed: FakeCodex["killed"] = []
  const received: JsonRpcMessage[] = []
  const pending = new Map<string | number, (message: JsonRpcMessage) => void>()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let exitWith: ((code: number) => void) | undefined
  let exitCode: number | null = null
  let nextServerId = 0
  const encoder = new TextEncoder()
  const send = (message: JsonRpcMessage) => {
    if (exitCode !== null) return
    controller?.enqueue(encoder.encode(`${JSON.stringify(message)}\n`))
  }

  const server: FakeCodexServer = {
    notify: (method, params) => send({ method, ...(params !== undefined ? { params } : {}) }),
    request: (method, params) =>
      new Promise((resolve) => {
        const id = nextServerId++
        pending.set(id, resolve)
        send({ id, method, ...(params !== undefined ? { params } : {}) })
      }),
    received,
    exit(code = 0) {
      if (exitCode !== null) return
      exitCode = code
      try {
        controller?.close()
      } catch {
        // already closed
      }
      exitWith?.(code)
    },
  }

  const spawn: CodexSpawn = (command, options) => {
    spawned.push({ command, env: options.env, cwd: options.cwd })
    exitCode = null
    const exited = new Promise<number>((resolve) => (exitWith = resolve))
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
    const stderr = new ReadableStream<Uint8Array>({ start: (c) => c.close() })
    let buffer = ""
    const proc: CodexProcess = {
      stdin: {
        write(chunk: string) {
          buffer += chunk
          let index
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            if (!line.trim()) continue
            const message = JSON.parse(line) as JsonRpcMessage
            received.push(message)
            if (message.method !== undefined && message.id !== undefined) {
              const handler = handlers[message.method]
              const id = message.id
              if (!handler) {
                send({ id, error: { code: -32601, message: `no handler for ${message.method}` } })
                continue
              }
              void Promise.resolve(handler(message.params, server)).then(
                (result) => send({ id, result }),
                (error: unknown) => send({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }),
              )
            } else if (message.method === undefined && message.id !== undefined) {
              pending.get(message.id)?.(message)
              pending.delete(message.id)
            }
          }
          return true
        },
        end() {
          server.exit(0)
        },
      },
      stdout,
      stderr,
      exited,
      get exitCode() {
        return exitCode
      },
      kill(signal) {
        killed.push(signal)
        server.exit(143)
      },
    }
    return proc
  }

  return {
    spawn,
    server,
    spawned,
    killed,
    requests: (method) => received.filter((message) => message.method === method && message.id !== undefined),
  }
}

/** Completes the scripted turn with a final answer. */
export function completeTurn(server: FakeCodexServer, text = "Done.", status = "completed") {
  server.notify("item/completed", { item: { type: "agentMessage", id: "msg-final", text, phase: "final_answer" }, threadId: "thread-1", turnId: "turn-1" })
  server.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status, error: status === "failed" ? { message: "model error" } : null, items: [{ type: "agentMessage", id: "msg-final", text, phase: "final_answer" }] } })
}
