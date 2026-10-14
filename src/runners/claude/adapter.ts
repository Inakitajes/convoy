/**
 * Claude execution adapter (change `runner-parity-opencode-v2`, tasks 5.1/5.2).
 *
 * Runs the operator's `claude` CLI headless and translates its stream-json into
 * the neutral `RunnerEvent` vocabulary and an `AttemptOutcome`. It owns the
 * child process, applies an isolated authentication overlay (subscription or an
 * explicit API key), and enforces the execution mode through tool/permission
 * flags. It never extracts credentials and never spends on its own.
 *
 * Tool/permission mapping here is the baseline that group 6 hardens with
 * mandatory pre-action enforcement.
 */

import { describeClaudeEvent, ndjsonLines, newClaudeStreamState, type ClaudeSignal } from "../../claude-code"
import { resolveClaudeAuth } from "./auth"

import type { AttemptOutcome, ExecutionAdapter, ExecutionRequest, RunnerEvent, Usage } from "../contracts"
import type { ProgressTokens } from "../../progress"

export type ClaudeProcess = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  exitCode: number | null
  kill(): void
}

export type ClaudeRunnerDeps = {
  spawn(command: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdin: Blob; stdout: "pipe"; stderr: "pipe" }): ClaudeProcess
}

const defaultDeps: ClaudeRunnerDeps = {
  spawn: (command, options) => Bun.spawn(command, options) as unknown as ClaudeProcess,
}

export type ClaudeRunnerOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  binary?: string
  deps?: Partial<ClaudeRunnerDeps>
}

export type ClaudeRunner = ExecutionAdapter

const defaultBinary = "claude"

/** Tool and permission flags for an execution mode. */
export function modeFlags(mode: ExecutionRequest["mode"]): { tools?: string; permissionMode: string } {
  if (mode === "read-only") return { tools: "Read,Glob,Grep", permissionMode: "dontAsk" }
  if (mode === "verify") return { tools: "Read,Glob,Grep,Bash", permissionMode: "dontAsk" }
  return { permissionMode: "acceptEdits" }
}

/** The CLI arguments (excluding the binary) for one attempt. */
export function buildClaudeArgs(request: ExecutionRequest): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
  if (request.agent.instructions) args.push("--append-system-prompt", request.agent.instructions)
  const model = request.agent.model.modelId
  if (model && model !== "default") args.push("--model", model)
  const flags = modeFlags(request.mode)
  if (flags.tools) args.push("--tools", flags.tools)
  args.push("--permission-mode", flags.permissionMode)
  return args
}

/** ProgressTokens -> neutral Usage. */
export function usageFromTokens(tokens: ProgressTokens | undefined, cost?: number): Usage | undefined {
  if (!tokens && cost === undefined) return undefined
  return {
    ...(tokens ? { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite } : {}),
    ...(cost !== undefined ? { costEstimate: cost } : {}),
  }
}

/** Maps a `ClaudeSignal` to zero or more neutral events (session/text/tool). */
export function signalsToEvents(
  signal: ClaudeSignal,
  attempt: number,
): { events: RunnerEvent[]; outcome?: AttemptOutcome } {
  if (signal.type === "session") {
    return { events: [{ type: "session", runner: "claude-code", attempt, session: { runner: "claude-code", sessionId: signal.sessionID } }] }
  }
  if (signal.type === "message") {
    if (signal.message.channel === "reasoning") {
      return { events: [{ type: "reasoning", runner: "claude-code", attempt, text: signal.message.text }] }
    }
    if (signal.message.channel === "response") {
      return { events: [{ type: "text", runner: "claude-code", attempt, text: signal.message.text }] }
    }
    return { events: [{ type: "tool", runner: "claude-code", attempt, name: signal.message.channel, detail: signal.message.text }] }
  }
  if (signal.type === "activity") {
    return signal.kind === "tool" ? { events: [{ type: "tool", runner: "claude-code", attempt, name: signal.message }] } : { events: [] }
  }
  // result
  const outcome: AttemptOutcome = {
    status: signal.isError ? "failed" : "completed",
    ...(signal.text ? { assistantText: signal.text } : {}),
    ...(signal.subtype ? { finish: signal.subtype } : {}),
    ...(usageFromTokens(signal.tokens, signal.cost) ? { usage: usageFromTokens(signal.tokens, signal.cost) } : {}),
    ...(signal.isError ? { error: signal.text ? signal.text.slice(0, 300) : `claude finished with ${signal.subtype}` } : {}),
  }
  return { events: [{ type: "terminal", runner: "claude-code", attempt, outcome }], outcome }
}

export function createClaudeRunner(options: ClaudeRunnerOptions): ClaudeRunner {
  const spawn = options.deps?.spawn ?? defaultDeps.spawn
  const binary = options.binary ?? defaultBinary
  const baseEnv = options.env ?? process.env

  return {
    id: "claude-code",

    async capabilities() {
      // Described capabilities; group 6/7 tighten which are available by version
      // and enforcement health. Native live attach is not assumed.
      return {
        runner: "claude-code",
        capabilities: [
          { id: "read-only", availability: "available" },
          { id: "write", availability: "available" },
          { id: "verify", availability: "available" },
          { id: "post-exit-resume", availability: "available" },
          { id: "live-observation", availability: "available", semantics: "streamed to the coordinator; not a native terminal attach" },
          { id: "native-live-attach", availability: "unavailable", reason: "print mode has no attachable live session" },
        ],
      }
    },

    async executeAttempt(request: ExecutionRequest, sink: (event: RunnerEvent) => void): Promise<AttemptOutcome> {
      if (request.runner !== "claude-code") {
        return { status: "failed", error: `claude adapter received a ${request.runner} request` }
      }

      let auth
      try {
        auth = resolveClaudeAuth({ selection: request.auth, env: baseEnv })
      } catch (error) {
        const outcome: AttemptOutcome = { status: "failed", error: error instanceof Error ? error.message : String(error) }
        sink({ type: "terminal", runner: "claude-code", attempt: request.attempt, outcome })
        return outcome
      }

      const env: NodeJS.ProcessEnv = { ...baseEnv }
      for (const key of auth.unset) delete env[key]
      Object.assign(env, auth.set)

      const proc = spawn([binary, ...buildClaudeArgs(request)], {
        cwd: request.checkout,
        env,
        stdin: new Blob([request.prompt]),
        stdout: "pipe",
        stderr: "pipe",
      })

      const kill = () => proc.kill()
      request.signal.addEventListener("abort", kill, { once: true })
      if (request.signal.aborted) kill()

      const stderrPromise = new Response(proc.stderr).text()
      const state = newClaudeStreamState()
      let sessionId: string | undefined
      let outcome: AttemptOutcome | undefined

      try {
        for await (const line of ndjsonLines(proc.stdout)) {
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }
          for (const signal of describeClaudeEvent(parsed, state)) {
            if (signal.type === "session") sessionId = signal.sessionID
            const mapped = signalsToEvents(signal, request.attempt)
            for (const event of mapped.events) sink(event)
            if (mapped.outcome) outcome = mapped.outcome
          }
        }
        const [exitCode] = await Promise.all([proc.exited, stderrPromise])
        if (!outcome) {
          const result: AttemptOutcome = {
            status: request.signal.aborted ? "interrupted" : "failed",
            ...(sessionId ? { session: { runner: "claude-code", sessionId } } : {}),
            ...(request.signal.aborted ? {} : { error: `claude exited with status ${exitCode} before reporting a result` }),
          }
          sink({ type: "terminal", runner: "claude-code", attempt: request.attempt, outcome: result })
          return result
        }
        const final: AttemptOutcome = { ...outcome, ...(sessionId ? { session: { runner: "claude-code", sessionId } } : {}) }
        return final
      } catch (error) {
        const result: AttemptOutcome = {
          status: request.signal.aborted ? "interrupted" : "failed",
          ...(sessionId ? { session: { runner: "claude-code", sessionId } } : {}),
          error: error instanceof Error ? error.message : String(error),
        }
        sink({ type: "terminal", runner: "claude-code", attempt: request.attempt, outcome: result })
        return result
      } finally {
        request.signal.removeEventListener("abort", kill)
        if (proc.exitCode === null) proc.kill()
      }
    },

    async cancelAttempt() {
      // Cancellation is driven by the attempt's AbortSignal; nothing else to do.
    },
  }
}
