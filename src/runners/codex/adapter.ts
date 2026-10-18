/**
 * Codex execution adapter (change `add-codex-runner`).
 *
 * Runs one attempt on an owned `codex app-server` child and translates its
 * protocol into the neutral `RunnerEvent` vocabulary and an `AttemptOutcome`.
 *
 * Enforcement is in-band: every thread runs under `approvalPolicy:
 * untrusted`, so Codex asks before every command, file change and MCP call,
 * and this adapter answers each request with Convoy's policy and the run's
 * operator gate — one action at a time, never a session-wide or persistent
 * amendment. The Codex sandbox (read-only for read-only and verify attempts)
 * is defense in depth, not the guarantee: an approved write escapes it, so a
 * read-only attempt declines every write here.
 *
 * The operator's Codex setup is isolated per attempt: their hooks, apps and
 * other MCP servers are disabled, and only Convoy's own MCP host (serving
 * `write_report` and the advisor tools through the attempt bridge) is added.
 * Nothing is written to the operator's Codex configuration or credentials.
 */

import { randomUUID } from "node:crypto"

import { RawStreamLog } from "../../raw-stream-log"
import { withAttachmentSection } from "../agent-source"
import { stagePrivateFile, startAttemptBridge, toolsEnv, toolsUrlEnv, approvalTokenEnv, type AttemptBridge } from "../attempt-bridge"
import { convoyToolHandlers } from "../attempt-tools"
import { firstWriteMessage } from "../../advisor-runtime"
import { resolveEffectiveCapabilities } from "../capabilities"
import type { AttemptOutcome, ExecutionAdapter, ExecutionRequest, ExecutionServices, LoopDecision, RunnerEvent, Usage } from "../contracts"
import { codexDeclaration } from "../declarations"
import { evaluateAction, unwrapShellScript, type PolicyConfig, type PolicyDecision } from "../policy"
import { redactSecrets } from "../redaction"
import { startCodexAppServer, type CodexAppServer, type CodexSpawn } from "./app-server"
import { codexAccountMismatch, prepareCodexAuth, type CodexAuthEnvironment, type CodexLogin } from "./auth"
import { asRecord, stringField, type CodexItem, type CodexReasoningEffort, type CodexSandboxMode, type TokenUsageBreakdown } from "./protocol"

export const codexBinaryName = "codex"

/** The MCP server name Convoy's host is declared under. */
export const convoyMcpServer = "convoy"

/**
 * Codex features a Convoy attempt turns off: the operator's hooks would run
 * inside the run, and apps, browser and computer use add actions Convoy's
 * policy has no classification for.
 */
export const disabledCodexFeatures = ["hooks", "apps", "browser_use", "browser_use_external", "computer_use"] as const

/** Arguments after `codex app-server` for every Convoy-owned child. */
export function codexAppServerArgs(): string[] {
  return disabledCodexFeatures.flatMap((feature) => ["--disable", feature])
}

/** The Codex sandbox for a Convoy execution mode. */
export function codexSandbox(mode: ExecutionRequest["mode"]): CodexSandboxMode {
  return mode === "write" ? "workspace-write" : "read-only"
}

/**
 * The per-thread config overrides: every MCP server the operator configured
 * is disabled, and Convoy's host is declared when the attempt serves tools.
 * Advisor consultations can take minutes, so the host's tool timeout is long.
 */
export function codexThreadConfig(operatorServers: readonly string[], host?: { command: string; args: readonly string[] }): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const name of operatorServers) if (name !== convoyMcpServer) config[`mcp_servers.${name}.enabled`] = false
  if (host) {
    config[`mcp_servers.${convoyMcpServer}.command`] = host.command
    config[`mcp_servers.${convoyMcpServer}.args`] = [...host.args]
    config[`mcp_servers.${convoyMcpServer}.enabled`] = true
    config[`mcp_servers.${convoyMcpServer}.tool_timeout_sec`] = 3600
  }
  return config
}

/** The MCP servers the operator's Codex config declares, from `config/read`. */
export function configuredMcpServers(configResult: unknown): string[] {
  const servers = asRecord(asRecord(asRecord(configResult)?.config)?.mcp_servers)
  return servers ? Object.keys(servers) : []
}

/** Codex reasoning effort for a model variant, when it is one. */
export function codexEffort(variant: string | undefined): CodexReasoningEffort | undefined {
  return variant === "minimal" || variant === "low" || variant === "medium" || variant === "high" || variant === "xhigh" ? variant : undefined
}

/** Neutral usage from a Codex token breakdown. OpenAI counts cached input inside input and reasoning inside output. */
export function usageFromCodexTokens(tokens: TokenUsageBreakdown | undefined): Usage | undefined {
  if (!tokens) return undefined
  const cached = tokens.cachedInputTokens ?? 0
  const reasoning = tokens.reasoningOutputTokens ?? 0
  return {
    input: Math.max(0, (tokens.inputTokens ?? 0) - cached),
    output: Math.max(0, (tokens.outputTokens ?? 0) - reasoning),
    reasoning,
    cacheRead: cached,
    cacheWrite: tokens.cacheWriteInputTokens ?? 0,
  }
}

export type ApprovalVerdict = { accept: boolean; reason: string }

export type ApprovalContext = {
  policy: PolicyConfig
  services?: ExecutionServices
  /** True when the attempt consults an advisor (its tools and checkpoint are installed). */
  advised: boolean
  /** Delivers advice into the running turn; resolves false when it could not be delivered. */
  steer(text: string): Promise<boolean>
}

function decisionToVerdict(decision: PolicyDecision): ApprovalVerdict | undefined {
  if (decision.effect === "allow") return { accept: true, reason: decision.reason }
  if (decision.effect === "deny") return { accept: false, reason: decision.reason }
  return undefined
}

async function operatorVerdict(context: ApprovalContext, tool: string, action: string, resources: readonly string[], reason: string): Promise<ApprovalVerdict> {
  const approvals = context.services?.approvals
  if (!approvals) return { accept: false, reason: `no operator can approve this action (${reason})` }
  const outcome = await approvals.decide({ requestId: randomUUID(), tool, action, resources })
  return outcome === "allow" ? { accept: true, reason: "operator approved" } : { accept: false, reason: "operator did not approve" }
}

/** Decides one command approval request with Convoy's policy and, for an ask, the operator gate. */
export async function decideCommand(context: ApprovalContext, command: string, cwd: string | undefined): Promise<ApprovalVerdict> {
  const script = unwrapShellScript(command)
  const decision = evaluateAction({ tool: "shell", intent: "execute", resource: script, ...(cwd ? { cwd } : {}) }, context.policy, { advisorSatisfied: true })
  return decisionToVerdict(decision) ?? (await operatorVerdict(context, "shell", "bash", [script], decision.reason))
}

/**
 * Decides one file-change approval request. Every changed path must pass the
 * policy as a write. When the phase requires the advisor before its first
 * write, the first such change is held for one consultation: the advice is
 * steered into the turn and the change declined, so the agent re-applies it
 * with the advice in hand; a failed consultation releases the hold. A change
 * whose paths are unknown is declined.
 */
export async function decideFileChange(context: ApprovalContext, paths: readonly string[], cwd: string | undefined): Promise<ApprovalVerdict> {
  if (paths.length === 0) return { accept: false, reason: "the file change names no path Convoy can check" }
  const decisions = paths.map((path) => evaluateAction({ tool: "apply_patch", intent: "write", resource: path, ...(cwd ? { cwd } : {}) }, context.policy, { advisorSatisfied: true }))
  const denied = decisions.find((decision) => decision.effect === "deny")
  if (denied) return { accept: false, reason: denied.reason }

  if (context.policy.requireAdvisorBeforeWrite) {
    const advisor = context.advised ? context.services?.advisor : undefined
    if (!advisor) return { accept: false, reason: "no advisor checkpoint is reachable for this attempt" }
    if (!advisor.satisfied()) {
      const advice = await advisor.consult({ trigger: "first-write", question: "" }).catch(() => undefined)
      if (advice?.ok) {
        const delivered = await context.steer(firstWriteMessage(advice.text))
        if (delivered) {
          await advisor.delivered?.(advice.callId, "follow-up")
          return { accept: false, reason: "held for the advisor's first-write consultation" }
        }
      }
    }
  }

  if (decisions.every((decision) => decision.effect === "allow")) return { accept: true, reason: decisions[0]!.reason }
  return operatorVerdict(context, "apply_patch", "edit", paths, decisions.find((decision) => decision.effect === "ask")?.reason ?? "operator decides")
}

export type CodexRunnerDeps = {
  spawn?: CodexSpawn
  login?: CodexLogin
  stopGraceMs?: number
}

export type CodexRunnerOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  binary?: string
  deps?: CodexRunnerDeps
  /**
   * The argv that runs Convoy's MCP host (`convoy mcp`). Without it the
   * attempt serves no Convoy tools: reports fall back to the final message
   * and an advisor's checkpoint fails closed.
   */
  mcpHost?: readonly string[]
}

export type CodexRunner = ExecutionAdapter

/** The bridge file `convoy mcp --bridge-file` reads its address and token from. */
export const bridgeFileFlag = "--bridge-file"

type TurnState = {
  threadId?: string
  turnId?: string
  model?: string
  effort?: string
  usage?: Usage
  finalText?: string
  lastText?: string
  stop?: Extract<LoopDecision, { action: "stop" }>
  status?: string
  error?: string
  textChars: number
  reasoningChars: number
}

function itemPaths(item: CodexItem | undefined): string[] {
  return (item?.changes ?? []).map((change) => change.path).filter((path): path is string => typeof path === "string" && path.length > 0)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function formatChars(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

export function createCodexRunner(options: CodexRunnerOptions): CodexRunner {
  const binary = options.binary ?? codexBinaryName
  const baseEnv = options.env ?? process.env

  async function runAttempt(request: ExecutionRequest, sink: (event: RunnerEvent) => void, services: ExecutionServices | undefined, auth: CodexAuthEnvironment): Promise<AttemptOutcome> {
    const attempt = request.identity.attempt
    const emit = (event: RunnerEvent) => sink(event)
    const policy: PolicyConfig = request.policy ?? { mode: request.mode, approvals: request.approvals }
    const items = new Map<string, CodexItem>()
    const state: TurnState = { textChars: 0, reasoningChars: 0 }
    const rawLog = request.streamLogPath ? new RawStreamLog(request.streamLogPath, request.identity.phaseName) : undefined
    const loopGuard = services?.loopGuard
    let server: CodexAppServer | undefined
    let settleTurn: (() => void) | undefined
    const turnDone = new Promise<void>((resolve) => (settleTurn = resolve))

    const label = () => `codex/${state.model || request.agent.model.modelId || "default"}${state.effort ? `#${state.effort}` : ""}`
    const session = () => (state.threadId ? { session: { runner: "codex" as const, sessionId: state.threadId } } : {})

    const steer = async (text: string): Promise<boolean> => {
      if (!server || !state.threadId || !state.turnId) return false
      try {
        await server.request("turn/steer", { threadId: state.threadId, expectedTurnId: state.turnId, input: [{ type: "text", text }] })
        return true
      } catch {
        return false
      }
    }
    const interrupt = async () => {
      if (!server || !state.threadId || !state.turnId) return
      await server.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }).catch(() => {})
    }
    const applyLoopDecision = (decision: LoopDecision | undefined) => {
      if (!decision || decision.action === "continue") return
      if (decision.action === "nudge") {
        emit({ type: "activity", runner: "codex", attempt, message: `loop guard: ${decision.reason}`, kind: "error" })
        void steer(decision.reason)
        return
      }
      if (state.stop) return
      state.stop = decision
      emit({ type: "activity", runner: "codex", attempt, message: `loop guard stopped the step: ${decision.reason}`, kind: "error" })
      void interrupt()
    }

    const approvalContext: ApprovalContext = { policy, ...(services ? { services } : {}), advised: Boolean(request.advised), steer }

    const onServerRequest = async (method: string, params: unknown): Promise<unknown> => {
      const record = asRecord(params)
      switch (method) {
        case "item/commandExecution/requestApproval": {
          const command = stringField(record, "command") ?? ""
          const verdict = await decideCommand(approvalContext, command, stringField(record, "cwd") ?? request.checkout)
          if (!verdict.accept) emit({ type: "activity", runner: "codex", attempt, message: `denied: ${truncate(unwrapShellScript(command), 100)} (${verdict.reason})`, kind: "error" })
          return { decision: verdict.accept ? "accept" : "decline" }
        }
        case "item/fileChange/requestApproval": {
          const paths = itemPaths(items.get(stringField(record, "itemId") ?? ""))
          const verdict = await decideFileChange(approvalContext, paths, request.checkout)
          if (!verdict.accept) emit({ type: "activity", runner: "codex", attempt, message: `edit declined: ${verdict.reason}`, kind: "error" })
          return { decision: verdict.accept ? "accept" : "decline" }
        }
        case "mcpServer/elicitation/request":
          // Convoy's own tools are scoped and validated by the attempt bridge;
          // any other server's tool is an action the policy cannot classify.
          return stringField(record, "serverName") === convoyMcpServer ? { action: "accept", content: null } : { action: "decline", content: null }
        case "item/tool/requestUserInput":
          return { answers: {} }
        case "applyPatchApproval":
        case "execCommandApproval":
          return { decision: "denied" }
        default:
          throw new Error(`Convoy declines ${method}`)
      }
    }

    const onNotification = (method: string, params: unknown) => {
      const record = asRecord(params)
      if (method === "item/started" || method === "item/completed") {
        const item = asRecord(record?.item) as CodexItem | undefined
        if (!item || typeof item.id !== "string") return
        items.set(item.id, item)
        if (method === "item/started") onItemStarted(item)
        else onItemCompleted(item)
        return
      }
      switch (method) {
        case "turn/started": {
          const turn = asRecord(record?.turn)
          state.turnId ??= stringField(turn, "id")
          return
        }
        case "item/agentMessage/delta": {
          const delta = stringField(record, "delta") ?? ""
          if (!delta) return
          state.textChars += delta.length
          emit({ type: "text", runner: "codex", attempt, text: delta, partId: stringField(record, "itemId") ?? "message" })
          emit({ type: "activity", runner: "codex", attempt, message: `responding… (${formatChars(state.textChars)} chars)`, kind: "write", pulse: true })
          return
        }
        case "item/reasoning/summaryTextDelta":
        case "item/reasoning/textDelta": {
          const delta = stringField(record, "delta") ?? ""
          if (!delta) return
          state.reasoningChars += delta.length
          const index = record?.summaryIndex ?? record?.contentIndex ?? 0
          emit({ type: "reasoning", runner: "codex", attempt, text: delta, partId: `${stringField(record, "itemId") ?? "reasoning"}:${String(index)}` })
          emit({ type: "activity", runner: "codex", attempt, message: `thinking… (${formatChars(state.reasoningChars)} chars)`, kind: "think", pulse: true })
          return
        }
        case "thread/tokenUsage/updated": {
          const usage = usageFromCodexTokens(asRecord(asRecord(record?.tokenUsage)?.total) as TokenUsageBreakdown | undefined)
          if (!usage) return
          state.usage = usage
          emit({ type: "usage", runner: "codex", attempt, usage: { ...usage, model: label(), ...(state.threadId ? { sessionID: state.threadId } : {}) } })
          return
        }
        case "error": {
          const error = asRecord(record?.error)
          const message = stringField(error, "message")
          if (message && record?.willRetry !== true) state.error = redactSecrets(message)
          if (message) emit({ type: "activity", runner: "codex", attempt, message: `codex: ${truncate(redactSecrets(message), 160)}`, kind: "error" })
          return
        }
        case "turn/completed": {
          const turn = asRecord(record?.turn)
          if (state.turnId && stringField(turn, "id") !== state.turnId) return
          state.status = stringField(turn, "status")
          const error = stringField(asRecord(turn?.error), "message")
          if (error) state.error = redactSecrets(error)
          for (const item of Array.isArray(turn?.items) ? turn.items : []) {
            const entry = asRecord(item)
            if (stringField(entry, "type") === "agentMessage" && stringField(entry, "text")) state.finalText = stringField(entry, "text")
          }
          settleTurn?.()
          return
        }
        default:
          return
      }
    }

    const onItemStarted = (item: CodexItem) => {
      if (item.type === "commandExecution" && item.command) {
        const script = unwrapShellScript(item.command)
        emit({ type: "message", runner: "codex", attempt, channel: "bash", text: `$ ${script}` })
        emit({ type: "activity", runner: "codex", attempt, message: `bash: ${truncate(script, 120)}`, kind: "tool" })
        applyLoopDecision(loopGuard?.observe({ kind: "call", tool: "bash", args: { command: script }, callId: item.id }))
      } else if (item.type === "fileChange") {
        const paths = itemPaths(item)
        const line = `edit: ${paths.join(", ")}`
        emit({ type: "message", runner: "codex", attempt, channel: "tool", text: line })
        emit({ type: "activity", runner: "codex", attempt, message: truncate(line, 140), kind: "write" })
        applyLoopDecision(loopGuard?.observe({ kind: "call", tool: "edit", args: { paths }, callId: item.id }))
      } else if (item.type === "mcpToolCall") {
        const tool = `${item.server ?? "mcp"}.${item.tool ?? "tool"}`
        emit({ type: "message", runner: "codex", attempt, channel: "tool", text: `tool: ${tool}` })
        emit({ type: "activity", runner: "codex", attempt, message: `tool: ${tool}`, kind: "tool" })
        applyLoopDecision(loopGuard?.observe({ kind: "call", tool, args: item.arguments, callId: item.id }))
      }
    }

    const onItemCompleted = (item: CodexItem) => {
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        state.lastText = item.text
        if (item.phase === "final_answer") state.finalText = item.text
        applyLoopDecision(loopGuard?.observe({ kind: "step" }))
      } else if (item.type === "commandExecution" || item.type === "fileChange" || item.type === "mcpToolCall") {
        const failed = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0)
        applyLoopDecision(loopGuard?.observe({ kind: "result", callId: item.id, failed }))
      }
    }

    // Convoy's tools reach the agent through its MCP host, which reads the
    // attempt bridge's address and token from an owner-only private file:
    // never from argv or the agent's environment.
    let bridge: AttemptBridge | undefined
    const staged: { discard(): Promise<void> }[] = []
    try {
      const handlers = convoyToolHandlers(request, services)
      let host: { command: string; args: string[] } | undefined
      if (options.mcpHost && options.mcpHost.length > 0 && (handlers.report || handlers.advisor)) {
        bridge = await startAttemptBridge(handlers)
        const file = await stagePrivateFile(
          "bridge.json",
          JSON.stringify({ [toolsUrlEnv]: bridge.url, [approvalTokenEnv]: bridge.token, [toolsEnv]: bridge.tools.join(",") }),
          "codex-mcp",
        )
        staged.push(file)
        host = { command: options.mcpHost[0]!, args: [...options.mcpHost.slice(1), bridgeFileFlag, file.path] }
      }

      server = await startCodexAppServer({
        binary,
        args: codexAppServerArgs(),
        cwd: request.checkout,
        env: auth.env,
        ...(options.deps?.spawn ? { spawn: options.deps.spawn } : {}),
        ...(options.deps?.stopGraceMs !== undefined ? { stopGraceMs: options.deps.stopGraceMs } : {}),
        onNotification,
        onServerRequest,
        ...(rawLog ? { onRawLine: (line: string) => void rawLog.append(line) } : {}),
      })

      // The overlay is only an intent: the billing source is the account
      // Codex resolved under this exact environment.
      const mismatch = codexAccountMismatch(auth.mode, await server.request("account/read", {}))
      if (mismatch) return { status: "failed", error: `${mismatch} Set runners.codex.auth to choose Codex's billing source explicitly.` }

      const operatorServers = configuredMcpServers(await server.request("config/read", {}).catch(() => undefined))
      const threadParams = {
        cwd: request.checkout,
        approvalPolicy: "untrusted",
        sandbox: codexSandbox(request.mode),
        config: codexThreadConfig(operatorServers, host),
        serviceName: "convoy",
        ...(request.agent.model.modelId && request.agent.model.modelId !== "default" ? { model: request.agent.model.modelId } : {}),
        ...(request.agent.instructions ? { developerInstructions: request.agent.instructions } : {}),
      }
      const resumed = request.continueSession?.runner === "codex" ? request.continueSession.sessionId : undefined
      const started = asRecord(resumed ? await server.request("thread/resume", { threadId: resumed, ...threadParams }) : await server.request("thread/start", threadParams))
      const thread = asRecord(started?.thread)
      state.threadId = stringField(thread, "id") ?? resumed
      state.model = stringField(started, "model") ?? stringField(thread, "model")
      if (!state.threadId) return { status: "failed", error: "codex started no thread" }
      emit({ type: "session", runner: "codex", attempt, session: { runner: "codex", sessionId: state.threadId } })

      const effort = codexEffort(request.agent.model.effort ?? request.agent.model.variant)
      state.effort = effort ?? stringField(started, "reasoningEffort") ?? stringField(thread, "reasoningEffort")
      const prompt = withAttachmentSection(request.prompt, request.attachments ?? [])
      const turn = asRecord(asRecord(await server.request("turn/start", { threadId: state.threadId, input: [{ type: "text", text: prompt }], ...(effort ? { effort } : {}) }))?.turn)
      state.turnId ??= stringField(turn, "id")

      const aborted = new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve()
        else request.signal.addEventListener("abort", () => resolve(), { once: true })
      })
      const exited = server.closed.then(() => "exited" as const)
      const ended = await Promise.race([turnDone.then(() => "completed" as const), aborted.then(() => "aborted" as const), exited])
      if (ended === "aborted") {
        await interrupt()
        return { status: "interrupted", ...session(), ...(state.usage ? { usage: state.usage } : {}) }
      }
      if (ended === "exited") {
        const closed = await server.closed
        return { status: "failed", ...session(), error: `codex app-server exited before the turn finished${closed.stderr ? `: ${closed.stderr}` : ` (status ${closed.code})`}` }
      }

      const assistantText = state.finalText ?? state.lastText
      const base = { ...session(), ...(state.usage ? { usage: state.usage } : {}), ...(assistantText ? { assistantText } : {}), ...(state.status ? { finish: state.status } : {}) }
      if (state.stop) return { ...base, status: "failed", error: `loop guard: ${state.stop.reason}` }
      if (state.status === "interrupted") return { ...base, status: "interrupted" }
      if (state.status !== "completed") return { ...base, status: "failed", error: state.error ?? `codex turn ended ${state.status ?? "without a status"}` }

      // The final agent message is the fallback report for a contract that
      // expects one, as with Claude; an accepted write_report submission wins.
      const deliverables = services?.deliverables
      if (deliverables && deliverables.expected.includes("report") && deliverables.candidate?.() === undefined) {
        const body = (assistantText ?? "").trim()
        if (!body) return { ...base, status: "failed", error: "the deliverable contract expects a report but the attempt produced none" }
        const submitted = await deliverables.submit({ kind: "report", body: assistantText! })
        if (!submitted.ok) return { ...base, status: "failed", error: submitted.error }
      }
      return { ...base, status: "completed" }
    } catch (error) {
      return {
        status: request.signal.aborted ? "interrupted" : "failed",
        ...session(),
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      }
    } finally {
      await server?.close()
      await bridge?.close()
      for (const file of staged) await file.discard()
      await rawLog?.close()
    }
  }

  return {
    id: "codex",

    async capabilities() {
      return resolveEffectiveCapabilities(codexDeclaration, { enforcementReady: options.mcpHost !== undefined && options.mcpHost.length > 0 })
    },

    async executeAttempt(request: ExecutionRequest, sink: (event: RunnerEvent) => void, services?: ExecutionServices): Promise<AttemptOutcome> {
      const finish = (outcome: AttemptOutcome): AttemptOutcome => {
        sink({ type: "terminal", runner: "codex", attempt: request.identity.attempt, outcome })
        return outcome
      }
      if (request.runner !== "codex") return finish({ status: "failed", error: `codex adapter received a ${request.runner} request` })
      let auth: CodexAuthEnvironment
      try {
        auth = await prepareCodexAuth({ selection: request.auth, env: baseEnv, binary, cwd: request.checkout, ...(options.deps?.login ? { login: options.deps.login } : {}) })
      } catch (error) {
        return finish({ status: "failed", error: error instanceof Error ? error.message : String(error) })
      }
      try {
        return finish(await runAttempt(request, sink, services, auth))
      } finally {
        await auth.discard()
      }
    },

    async cancelAttempt() {
      // Cancellation is driven by the attempt's AbortSignal.
    },
  }
}
