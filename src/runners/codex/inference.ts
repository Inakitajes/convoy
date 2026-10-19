/**
 * One-shot Codex inference for Convoy's helpers (change `add-codex-runner`,
 * design D8): the smart judge, the branch namer, the commit writer, and a
 * Codex-routed advisor each need a single bounded answer, not an agentic
 * attempt.
 *
 * Each call runs an ephemeral thread on an owned app-server under a read-only
 * sandbox with the operator's hooks, apps and MCP servers off. Every approval
 * request is declined, except — for a helper that may inspect the checkout —
 * a plain read-only command. Authentication is prepared and verified exactly
 * as for an attempt, so a helper never bills a different source than its
 * reviewed route, and a Codex-only installation needs no OpenCode for any of
 * them.
 */

import type { AuthenticationSelection, Usage } from "../contracts"
import { convoySecretsDir } from "../../workspace"
import { codexVersionProblem } from "../declarations"
import { evaluateAction, type PolicyConfig } from "../policy"
import { inspectionReads } from "./inspection"
import { redactSecrets } from "../redaction"
import { codexAppServerArgs, codexEffort, codexThreadConfig, configuredMcpServers, unreadableMcpServers, usageFromCodexTokens } from "./adapter"
import { codexVersionOf, startCodexAppServer, type CodexAppServer, type CodexSpawn } from "./app-server"
import { codexAccountMismatch, prepareCodexAuth, type CodexLogin } from "./auth"
import { asRecord, stringField, type TokenUsageBreakdown } from "./protocol"

export type CodexInferenceInput = {
  prompt: string
  system: string
  /** A Codex model ID; empty or `default` keeps Codex's own default. */
  model?: string
  /** Reasoning effort (`low`, `high`, …). */
  variant?: string
  auth: AuthenticationSelection
  cwd: string
  /** `none` for a pure classifier; `read-only` lets a helper run plain read commands in the checkout. */
  tools?: "none" | "read-only"
  timeoutMs?: number
  signal?: AbortSignal
}

export type CodexInferenceResult = { text: string; usage?: Usage; sessionId?: string }

export type CodexInferenceDeps = {
  spawn?: CodexSpawn
  login?: CodexLogin
  env?: NodeJS.ProcessEnv
  binary?: string
}

export class CodexInferenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodexInferenceError"
  }
}

const defaultTimeoutMs = 60_000

/**
 * True when a helper's command only inspects, and only within its checkout:
 * a short list of readers, no redirection or substitution, no path outside
 * `cwd` and never Convoy's private directory.
 */
export function isReadOnlyHelperCommand(command: string, cwd = process.cwd()): boolean {
  const reads = inspectionReads(command)
  if (!reads) return false
  const policy: PolicyConfig = { mode: "read-only", approvals: "auto", writeRoots: [cwd], readRoots: [], denyRoots: [convoySecretsDir()], cwd }
  return reads.every(
    (read) => evaluateAction({ tool: "shell", intent: "read", ...(read.path !== undefined ? { resource: read.path } : {}), ...(read.tree ? { scope: "tree" as const } : {}), cwd }, policy).effect === "allow",
  )
}

/**
 * Runs one bounded inference and returns its text. Throws
 * `CodexInferenceError` when the route cannot be verified, Codex fails,
 * times out, or ends the turn without an answer; callers decide their own
 * fallback (the judge fails closed, the namer and writer use their
 * deterministic ones).
 */
export async function codexInference(input: CodexInferenceInput, deps: CodexInferenceDeps = {}): Promise<CodexInferenceResult> {
  const binary = deps.binary ?? "codex"
  const auth = await prepareCodexAuth({ selection: input.auth, env: deps.env ?? process.env, binary, cwd: input.cwd, ...(deps.login ? { login: deps.login } : {}) }).catch((error: unknown) => {
    throw new CodexInferenceError(error instanceof Error ? error.message : String(error))
  })

  let threadId: string | undefined
  let turnId: string | undefined
  let finalText: string | undefined
  let lastText: string | undefined
  let usage: Usage | undefined
  let status: string | undefined
  let error: string | undefined
  let settle: (() => void) | undefined
  const done = new Promise<void>((resolve) => (settle = resolve))
  let server: CodexAppServer | undefined

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("timed out")), input.timeoutMs ?? defaultTimeoutMs)
  const onParentAbort = () => controller.abort(input.signal?.reason)
  if (input.signal?.aborted) controller.abort(input.signal.reason)
  else input.signal?.addEventListener("abort", onParentAbort, { once: true })
  const aborted = new Promise<void>((resolve) => {
    if (controller.signal.aborted) resolve()
    else controller.signal.addEventListener("abort", () => resolve(), { once: true })
  })

  try {
    server = await startCodexAppServer({
      binary,
      args: codexAppServerArgs(),
      cwd: input.cwd,
      env: auth.env,
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
      onServerRequest: async (method, params) => {
        if (method === "item/commandExecution/requestApproval") {
          const command = stringField(asRecord(params), "command") ?? ""
          return { decision: input.tools === "read-only" && isReadOnlyHelperCommand(command, input.cwd) ? "accept" : "decline" }
        }
        if (method === "item/fileChange/requestApproval") return { decision: "decline" }
        if (method === "mcpServer/elicitation/request") return { action: "decline", content: null }
        if (method === "item/tool/requestUserInput") return { answers: {} }
        if (method === "applyPatchApproval" || method === "execCommandApproval") return { decision: "denied" }
        throw new Error(`Convoy declines ${method}`)
      },
      onNotification: (method, params) => {
        const record = asRecord(params)
        if (method === "item/completed") {
          const item = asRecord(record?.item)
          if (stringField(item, "type") === "agentMessage") {
            const text = stringField(item, "text")
            if (text?.trim()) {
              lastText = text
              if (stringField(item, "phase") === "final_answer") finalText = text
            }
          }
        } else if (method === "thread/tokenUsage/updated") {
          usage = usageFromCodexTokens(asRecord(asRecord(record?.tokenUsage)?.total) as TokenUsageBreakdown | undefined) ?? usage
        } else if (method === "turn/completed") {
          const turn = asRecord(record?.turn)
          if (turnId && stringField(turn, "id") !== turnId) return
          status = stringField(turn, "status")
          error = stringField(asRecord(turn?.error), "message") ?? error
          settle?.()
        }
      },
    })

    const outdated = codexVersionProblem(codexVersionOf(server.info))
    if (outdated) throw new CodexInferenceError(`${outdated}; update Codex with \`codex update\``)
    const mismatch = codexAccountMismatch(auth.mode, await server.request("account/read", {}))
    if (mismatch) throw new CodexInferenceError(mismatch)
    const operatorServers = configuredMcpServers(await server.request("config/read", {}).catch(() => undefined))
    if (!operatorServers) throw new CodexInferenceError(unreadableMcpServers)
    const started = asRecord(
      await server.request("thread/start", {
        cwd: input.cwd,
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        ephemeral: true,
        serviceName: "convoy",
        developerInstructions: input.system,
        config: codexThreadConfig(operatorServers),
        ...(input.model && input.model !== "default" ? { model: input.model } : {}),
      }),
    )
    threadId = stringField(asRecord(started?.thread), "id")
    if (!threadId) throw new CodexInferenceError("codex started no thread")
    const effort = codexEffort(input.variant)
    const turn = asRecord(asRecord(await server.request("turn/start", { threadId, input: [{ type: "text", text: input.prompt }], ...(effort ? { effort } : {}) }))?.turn)
    turnId = stringField(turn, "id")

    const ended = await Promise.race([done.then(() => "done" as const), aborted.then(() => "aborted" as const), server.closed.then(() => "exited" as const)])
    if (ended === "aborted") {
      if (turnId) await server.request("turn/interrupt", { threadId, turnId }).catch(() => {})
      const reason = controller.signal.reason
      throw new CodexInferenceError(`codex inference ${reason instanceof Error && reason.message === "timed out" ? "timed out" : "was cancelled"}`)
    }
    if (ended === "exited") {
      const closed = await server.closed
      throw new CodexInferenceError(`codex exited with status ${closed.code} without an answer${closed.stderr ? `: ${closed.stderr}` : ""}`)
    }
    if (status !== "completed") throw new CodexInferenceError(`codex answered with an error: ${redactSecrets((error ?? status ?? "no status").slice(0, 200))}`)
    const text = (finalText ?? lastText ?? "").trim()
    return { text, ...(usage ? { usage } : {}), sessionId: threadId }
  } catch (caught) {
    if (caught instanceof CodexInferenceError) throw caught
    throw new CodexInferenceError(redactSecrets(caught instanceof Error ? caught.message : String(caught)))
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onParentAbort)
    await server?.close()
    await auth.discard()
  }
}
