/**
 * One-shot Claude inference for Convoy's helpers (change
 * `runner-parity-opencode-v2`, tasks 6.6, 7.4 and 8.4).
 *
 * The smart judge, the branch namer, the commit writer, and a Claude-routed
 * advisor each need a single bounded model answer, not an agentic attempt.
 * This runs the operator's Claude CLI headless for exactly that: one prompt,
 * a fixed system prompt, no session persistence, no MCP servers, and either
 * no tools or read-only ones. The auth overlay and effective-auth check are
 * the same the execution adapter applies, so a helper can never bill a
 * different source than the route that was reviewed, and a Claude-only
 * installation needs no OpenCode for any of them.
 */

import { withoutHerdrEnv } from "../../herdr"
import type { AuthenticationSelection, Usage } from "../contracts"
import { redactSecrets } from "../redaction"
import type { ClaudeProcess, ClaudeRunnerDeps } from "./adapter"
import { resolveClaudeAuth } from "./auth"
import { applyAuthOverlay, cliAuthProbe, validateEffectiveAuth, type EffectiveAuthProbe } from "./effective-auth"

export type ClaudeInferenceInput = {
  prompt: string
  system: string
  /** A Claude CLI alias or full id; empty or `default` keeps the CLI's own default. */
  model?: string
  auth: AuthenticationSelection
  /** The directory the CLI runs in (the checkout a read-only helper inspects). */
  cwd: string
  /** `none` for a pure classifier; `read-only` lets a helper read the checkout. */
  tools?: "none" | "read-only"
  timeoutMs?: number
  signal?: AbortSignal
}

export type ClaudeInferenceResult = { text: string; usage?: Usage; sessionId?: string }

export type ClaudeInferenceDeps = {
  spawn: ClaudeRunnerDeps["spawn"]
  probeAuth?: EffectiveAuthProbe
  env?: NodeJS.ProcessEnv
  binary?: string
}

const defaultTimeoutMs = 60_000

const defaultDeps: ClaudeInferenceDeps = {
  spawn: (command, options) => Bun.spawn(command, options) as unknown as ClaudeProcess,
}

export class ClaudeInferenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClaudeInferenceError"
  }
}

/** The CLI arguments (excluding the binary) for one helper inference. */
export function claudeInferenceArgs(input: Pick<ClaudeInferenceInput, "system" | "model" | "tools">): string[] {
  const args = ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--system-prompt", input.system]
  if (input.model && input.model !== "default") args.push("--model", input.model)
  // `--tools ""` removes every built-in tool: the answer can only be text.
  args.push("--tools", input.tools === "read-only" ? "Read,Glob,Grep" : "")
  args.push("--permission-mode", "dontAsk")
  return args
}

/** Reads the `--output-format json` result object; undefined when it is not one. */
export function parseInferenceResult(stdout: string): { isError: boolean; text: string; usage?: Usage; sessionId?: string } | undefined {
  const line = stdout.trim().split("\n").reverse().find((candidate) => candidate.trim().startsWith("{"))
  if (!line) return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (parsed.type !== "result") return undefined
  const usage = parsed.usage as Record<string, unknown> | undefined
  const number = (value: unknown) => (typeof value === "number" ? value : undefined)
  const tokens: Usage = {
    ...(number(usage?.input_tokens) !== undefined ? { input: number(usage?.input_tokens) } : {}),
    ...(number(usage?.output_tokens) !== undefined ? { output: number(usage?.output_tokens) } : {}),
    ...(number(usage?.cache_read_input_tokens) !== undefined ? { cacheRead: number(usage?.cache_read_input_tokens) } : {}),
    ...(number(usage?.cache_creation_input_tokens) !== undefined ? { cacheWrite: number(usage?.cache_creation_input_tokens) } : {}),
    ...(number(parsed.total_cost_usd) !== undefined ? { costEstimate: number(parsed.total_cost_usd) } : {}),
  }
  return {
    isError: parsed.is_error === true || (typeof parsed.subtype === "string" && parsed.subtype !== "success"),
    text: typeof parsed.result === "string" ? parsed.result : "",
    ...(Object.keys(tokens).length > 0 ? { usage: tokens } : {}),
    ...(typeof parsed.session_id === "string" ? { sessionId: parsed.session_id } : {}),
  }
}

/**
 * Runs one bounded inference and returns its text. Throws
 * `ClaudeInferenceError` when the route cannot be verified, the CLI fails,
 * times out, or answers with an error; callers decide their own fallback
 * (the judge fails closed, the namer and writer use their deterministic ones).
 */
export async function claudeInference(input: ClaudeInferenceInput, deps: Partial<ClaudeInferenceDeps> = {}): Promise<ClaudeInferenceResult> {
  const spawn = deps.spawn ?? defaultDeps.spawn
  const binary = deps.binary ?? "claude"
  const baseEnv = deps.env ?? process.env
  const resolution = (() => {
    try {
      return resolveClaudeAuth({ selection: input.auth, env: baseEnv })
    } catch (error) {
      throw new ClaudeInferenceError(error instanceof Error ? error.message : String(error))
    }
  })()
  const probe = deps.probeAuth ?? cliAuthProbe(spawn, binary, input.cwd)
  const effective = await validateEffectiveAuth({ resolution, probe, env: baseEnv })
  if (!effective.ok) throw new ClaudeInferenceError(effective.error)

  const env = applyAuthOverlay(withoutHerdrEnv(baseEnv), resolution)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("timed out")), input.timeoutMs ?? defaultTimeoutMs)
  const onParentAbort = () => controller.abort(input.signal?.reason)
  if (input.signal?.aborted) controller.abort(input.signal.reason)
  else input.signal?.addEventListener("abort", onParentAbort, { once: true })

  const proc = spawn([binary, ...claudeInferenceArgs(input)], { cwd: input.cwd, env, stdin: new Blob([input.prompt]), stdout: "pipe", stderr: "pipe" })
  const kill = () => proc.kill()
  controller.signal.addEventListener("abort", kill, { once: true })
  if (controller.signal.aborted) kill()
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      throw new ClaudeInferenceError(`claude inference ${reason instanceof Error && reason.message === "timed out" ? "timed out" : "was cancelled"}`)
    }
    const result = parseInferenceResult(stdout)
    if (!result) {
      const detail = redactSecrets(stderr.trim().split("\n").slice(-3).join(" "))
      throw new ClaudeInferenceError(`claude exited with status ${exitCode} without a result${detail ? `: ${detail}` : ""}`)
    }
    if (result.isError) throw new ClaudeInferenceError(`claude answered with an error: ${redactSecrets(result.text.slice(0, 200))}`)
    return { text: result.text.trim(), ...(result.usage ? { usage: result.usage } : {}), ...(result.sessionId ? { sessionId: result.sessionId } : {}) }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onParentAbort)
    controller.signal.removeEventListener("abort", kill)
    if (proc.exitCode === null) proc.kill()
  }
}
