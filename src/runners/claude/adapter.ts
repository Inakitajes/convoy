/**
 * Claude execution adapter (change `runner-parity-opencode-v2`, tasks 5.1/5.2).
 *
 * Runs the operator's `claude` CLI headless and translates its stream-json into
 * the neutral `RunnerEvent` vocabulary and an `AttemptOutcome`. It owns the
 * child process, applies an isolated authentication overlay (subscription or an
 * explicit API key), and enforces the execution mode through tool/permission
 * flags. It never extracts credentials and never spends on its own.
 *
 * The invocation is built per attempt by `buildClaudeInvocation`. Attempts that
 * can raise an ask-level decision or mutate the checkout require a reviewed
 * `EnforcementPlan` (PreToolUse hook + permission host); without it they fail
 * closed. Read-only + auto is the only combination that may run without the
 * permission host.
 */

import { isAbsolute, relative } from "node:path"

import { describeClaudeEvent, ndjsonLines, newClaudeStreamState, type ClaudeSignal } from "../../claude-code"
import { externalAttachmentDirectories, withAttachmentSection } from "../agent-source"
import { resolveClaudeAuth } from "./auth"
import { assertEnforcementReady, EnforcementNotReadyError, type EnforcementPlan } from "./enforcement"
import { encodeClaudeMcpConfig, encodeClaudeSettings, permissionPromptArgs } from "./settings"

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
  /**
   * Mandatory enforcement (PreToolUse hook + permission host) for attempts that
   * can raise ask-level decisions or mutate the checkout. Attempts that require
   * it fail closed when it is absent (design D7).
   */
  enforcement?: EnforcementPlan
}

export type ClaudeRunner = ExecutionAdapter

const defaultBinary = "claude"

/** True when `path` is inside `root` (or is `root` itself). */
function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

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

/** The full argv (excluding the binary) plus isolated child env for one attempt. */
export type ClaudeInvocation = {
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * True when the attempt could raise an ask-level decision or mutate the
 * checkout, so mandatory enforcement (PreToolUse hook + permission host) is
 * required. Read-only + auto is the only combination that may run without it.
 */
export function enforcementRequired(request: ExecutionRequest): boolean {
  return request.approvals !== "auto" || request.mode !== "read-only"
}

/**
 * Builds one attempt's invocation from reviewed per-attempt settings. The auth
 * overlay is applied to the child env exactly as before. When enforcement is
 * supplied it is validated and passed through `--settings`, `--mcp-config`, and
 * `--permission-prompt-tool`; when it is required but absent, the attempt fails
 * closed instead of running with weaker (or no) enforcement. `--bare` is never
 * passed (subscription uses the operator login) and `--safe-mode` is never used
 * as a blanket replacement for reviewed settings.
 */
export function buildClaudeInvocation(
  request: ExecutionRequest,
  enforcement?: EnforcementPlan,
  options: { env?: NodeJS.ProcessEnv } = {},
): ClaudeInvocation {
  if (enforcement) {
    assertEnforcementReady(enforcement)
  } else if (enforcementRequired(request)) {
    throw new EnforcementNotReadyError(
      `Claude ${request.mode} attempt with "${request.approvals}" approvals requires mandatory enforcement ` +
        `(a PreToolUse hook plus an authenticated permission host); refusing to run without it.`,
    )
  }

  const baseEnv = options.env ?? process.env
  const resolution = resolveClaudeAuth({ selection: request.auth, env: baseEnv })
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  for (const key of resolution.unset) delete env[key]
  Object.assign(env, resolution.set)

  const args = buildClaudeArgs(request)
  if (enforcement) {
    args.push("--settings", encodeClaudeSettings(enforcement.settings))
    args.push("--mcp-config", encodeClaudeMcpConfig(enforcement.mcpConfig))
    args.push(...permissionPromptArgs(enforcement.permissionPromptTool))
  }

  return { args, env }
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
  const enforcement = options.enforcement

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

      let invocation: ClaudeInvocation
      try {
        invocation = buildClaudeInvocation(request, enforcement, { env: baseEnv })
      } catch (error) {
        const outcome: AttemptOutcome = { status: "failed", error: error instanceof Error ? error.message : String(error) }
        sink({ type: "terminal", runner: "claude-code", attempt: request.attempt, outcome })
        return outcome
      }

      const attachments = request.attachments ?? []
      const prompt = withAttachmentSection(request.prompt, attachments)
      const extraDirs = externalAttachmentDirectories(attachments, (path) => isWithin(path, request.checkout))

      const proc = spawn([binary, ...invocation.args, ...extraDirs.flatMap((dir) => ["--add-dir", dir])], {
        cwd: request.checkout,
        env: invocation.env,
        stdin: new Blob([prompt]),
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
