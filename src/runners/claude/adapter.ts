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

import { randomUUID } from "node:crypto"
import { isAbsolute, relative } from "node:path"

import { ClaudeRawStreamLog, claudeModelLabel, describeClaudeEvent, ndjsonLines, newClaudeStreamState, type ClaudeSignal } from "../../claude-code"
import { withoutHerdrEnv } from "../../herdr"
import { externalAttachmentDirectories, withAttachmentSection } from "../agent-source"
import { resolveClaudeAuth, type ClaudeAuthResolution } from "./auth"
import { bridgeFileEnv, stagePrivateFile, stagePrivateMcpConfig, startClaudeAttemptBridge, type ClaudeAttemptBridge, type ClaudeAttemptHandlers, type ConvoyToolName } from "../attempt-bridge"
import { cliAuthProbe, validateEffectiveAuth, type EffectiveAuthProbe } from "./effective-auth"

export { cliAuthProbe, toolReportSubmission }
import { assertEnforcementReady, EnforcementNotReadyError, type EnforcementPlan } from "./enforcement"
import { toolToIntent } from "./hook"
import { encodeClaudeMcpConfig, encodeClaudeSettings, permissionPromptArgs, withHookEnv, withServerEnv } from "./settings"

import { convoyToolHandlers, toolReportSubmission } from "../attempt-tools"
import type { AttemptOutcome, ExecutionAdapter, ExecutionRequest, ExecutionServices, RunnerEvent, Usage } from "../contracts"
import { resolveEffectiveCapabilities } from "../capabilities"
import { claudeDeclaration } from "../declarations"
import { runnerPolicyEnv } from "../policy"
import { redactSecrets } from "../redaction"
import type { ProgressTokens } from "../../progress"

export type ClaudeProcess = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  exitCode: number | null
  kill(signal?: NodeJS.Signals | number): void
}

export type ClaudeRunnerDeps = {
  spawn(command: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdin: Blob; stdout: "pipe"; stderr: "pipe" }): ClaudeProcess
  /** The effective-auth probe; defaults to `claude auth status --json` through `spawn`. */
  probeAuth?: EffectiveAuthProbe
  /** How long a cancelled child gets to exit on SIGTERM before it is killed. */
  stopGraceMs?: number
}

/** The bounded grace a cancelled Claude child gets before its forced stop (design D11). */
export const defaultStopGraceMs = 5_000

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

/** The permission category an operator recognizes from OpenCode's prompts. */
function approvalAction(tool: string): string {
  const intent = toolToIntent(tool)
  if (intent === "execute") return "bash"
  if (intent === "write") return "edit"
  return intent
}

/** The MCP tool names Convoy serves an attempt (`mcp__<server>__<tool>`), pre-allowed so no prompt intervenes. */
export const convoyMcpTools: Record<ConvoyToolName, readonly string[]> = { report: ["write_report"], advisor: ["advisor", "advisor_feedback"] }

function convoyToolNames(permissionPromptTool: string, tools: readonly ConvoyToolName[]): string[] {
  const prefix = permissionPromptTool.slice(0, permissionPromptTool.lastIndexOf("__") + 2)
  return tools.flatMap((tool) => convoyMcpTools[tool].map((name) => `${prefix}${name}`))
}

/** The bridge handlers one attempt's services provide: the operator gate plus Convoy's tools. */
function attemptHandlers(request: ExecutionRequest, services: ExecutionServices | undefined): ClaudeAttemptHandlers {
  const handlers: ClaudeAttemptHandlers = convoyToolHandlers(request, services)
  const approvals = services?.approvals
  if (approvals) {
    handlers.approve = async (ask) => {
      const decision = await approvals.decide({
        requestId: randomUUID(),
        tool: ask.tool,
        action: approvalAction(ask.tool),
        ...(ask.resource ? { resources: [ask.resource] } : {}),
      })
      return decision === "allow"
    }
  }
  return handlers
}

/** How many trailing stderr lines explain a child that exited without a result. */
const stderrTailLines = 3

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
  // Post-exit continuation: resume the exact recorded session (task 3.5/3.6).
  if (request.continueSession && request.continueSession.runner === "claude-code") {
    args.push("--resume", request.continueSession.sessionId)
  }
  return args
}

/** The full argv (excluding the binary) plus isolated child env for one attempt. */
export type ClaudeInvocation = {
  args: string[]
  env: NodeJS.ProcessEnv
  /** The reviewed auth overlay `env` was built from, for effective-auth validation. */
  auth: ClaudeAuthResolution
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
  // Headless Claude is an implementation detail of the Convoy pane. Letting it
  // inherit HERDR_PANE_ID makes Claude's SessionStart hook claim Convoy's pane
  // session identity, so isolate it exactly like the OpenCode child server.
  const env: NodeJS.ProcessEnv = withoutHerdrEnv(baseEnv)
  for (const key of resolution.unset) delete env[key]
  Object.assign(env, resolution.set)

  // The hook and the permission host are Claude's children, so they read the
  // attempt's reviewed policy from the environment Claude passes down. Without
  // a reviewed policy they still enforce the attempt's own mode and approvals,
  // never a more permissive default.
  env[runnerPolicyEnv] = JSON.stringify(request.policy ?? { mode: request.mode, approvals: request.approvals })

  const args = buildClaudeArgs(request)
  if (enforcement) {
    args.push("--settings", encodeClaudeSettings(enforcement.settings))
    args.push("--mcp-config", encodeClaudeMcpConfig(enforcement.mcpConfig))
    args.push(...permissionPromptArgs(enforcement.permissionPromptTool))
  }

  return { args, env, auth: resolution }
}

/** ProgressTokens -> neutral Usage. */
export function usageFromTokens(tokens: ProgressTokens | undefined, cost?: number): Usage | undefined {
  if (!tokens && cost === undefined) return undefined
  return {
    ...(tokens ? { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite } : {}),
    ...(cost !== undefined ? { costEstimate: cost } : {}),
  }
}

/**
 * Maps a `ClaudeSignal` to zero or more neutral events, rendering exactly what
 * the dashboard showed before the adapter: transcript messages keep their
 * channel and block id, activity keeps its kind, and the result reports its
 * usage. The terminal event is the caller's, sent once the outcome is final.
 */
export function signalsToEvents(
  signal: ClaudeSignal,
  attempt: number,
  /** The model label and session the dashboard attributes the usage to. */
  usageLabels: Pick<Usage, "model" | "sessionID"> = {},
): { events: RunnerEvent[]; outcome?: AttemptOutcome } {
  if (signal.type === "session") {
    return { events: [{ type: "session", runner: "claude-code", attempt, session: { runner: "claude-code", sessionId: signal.sessionID } }] }
  }
  if (signal.type === "message") {
    const { channel, text, partID } = signal.message
    const part = partID ? { partId: partID } : {}
    if (channel === "reasoning") return { events: [{ type: "reasoning", runner: "claude-code", attempt, text, ...part }] }
    if (channel === "response") return { events: [{ type: "text", runner: "claude-code", attempt, text, ...part }] }
    return { events: [{ type: "message", runner: "claude-code", attempt, channel, text, ...part }] }
  }
  if (signal.type === "activity") {
    return { events: [{ type: "activity", runner: "claude-code", attempt, message: signal.message, kind: signal.kind, ...(signal.pulse ? { pulse: true } : {}) }] }
  }
  // result
  const usage = usageFromTokens(signal.tokens, signal.cost)
  const outcome: AttemptOutcome = {
    status: signal.isError ? "failed" : "completed",
    ...(signal.text ? { assistantText: signal.text } : {}),
    ...(signal.subtype ? { finish: signal.subtype } : {}),
    ...(usage ? { usage } : {}),
    ...(signal.isError ? { error: signal.text ? signal.text.slice(0, 300) : `claude finished with ${signal.subtype}` } : {}),
  }
  const events: RunnerEvent[] = usage ? [{ type: "usage", runner: "claude-code", attempt, usage: { ...usage, ...usageLabels } }] : []
  return { events, outcome }
}

export function createClaudeRunner(options: ClaudeRunnerOptions): ClaudeRunner {
  const spawn = options.deps?.spawn ?? defaultDeps.spawn
  const binary = options.binary ?? defaultBinary
  const baseEnv = options.env ?? process.env
  const enforcement = options.enforcement

  /** Runs the CLI for one prepared invocation; the caller reports the terminal event. */
  async function runInvocation(
    request: ExecutionRequest,
    invocation: ClaudeInvocation,
    sink: (event: RunnerEvent) => void,
    services?: ExecutionServices,
  ): Promise<AttemptOutcome> {
    const attachments = request.attachments ?? []
    const prompt = withAttachmentSection(request.prompt, attachments)
    const extraDirs = externalAttachmentDirectories(attachments, (path) => isWithin(path, request.checkout))
    const modelId = request.agent.model.modelId
    const model = claudeModelLabel(modelId === "default" ? "" : modelId)

    const proc = spawn([binary, ...invocation.args, ...extraDirs.flatMap((dir) => ["--add-dir", dir])], {
      cwd: request.checkout,
      env: invocation.env,
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
    })

    // Cancellation is bounded: SIGTERM, then a forced stop of this owned child
    // if it has not exited within the grace, so an attempt never hangs on a
    // child that ignores the request (design D11).
    let escalation: ReturnType<typeof setTimeout> | undefined
    const kill = () => {
      proc.kill("SIGTERM")
      escalation ??= setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL")
      }, options.deps?.stopGraceMs ?? defaultStopGraceMs)
      escalation.unref?.()
    }
    request.signal.addEventListener("abort", kill, { once: true })
    if (request.signal.aborted) kill()

    // Drained immediately so a noisy hook cannot fill the pipe and deadlock the child.
    const stderrPromise = new Response(proc.stderr).text()
    const state = newClaudeStreamState()
    let sessionId: string | undefined
    let outcome: AttemptOutcome | undefined
    const session = () => (sessionId ? { session: { runner: "claude-code" as const, sessionId } } : {})
    const rawLog = request.streamLogPath ? new ClaudeRawStreamLog(request.streamLogPath, request.identity.phaseName) : undefined

    try {
      for await (const line of ndjsonLines(proc.stdout)) {
        await rawLog?.append(line)
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        for (const signal of describeClaudeEvent(parsed, state)) {
          if (signal.type === "session") sessionId = signal.sessionID
          const mapped = signalsToEvents(signal, request.identity.attempt, { model, ...(sessionId ? { sessionID: sessionId } : {}) })
          // Claude does not advertise loop control, so no loop observation is
          // forwarded: a decision could not be applied (task 3.5).
          for (const event of mapped.events) sink(event)
          if (mapped.outcome) outcome = mapped.outcome
        }
      }
      const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise])
      if (!outcome) {
        if (request.signal.aborted) return { status: "interrupted", ...session() }
        const detail = redactSecrets(stderr.trim().split("\n").slice(-stderrTailLines).join(" ").trim())
        return { status: "failed", ...session(), error: `claude exited with status ${exitCode} before reporting a result${detail ? `: ${detail}` : ""}` }
      }
      const final: AttemptOutcome = { ...outcome, ...session() }
      // Deliverable service: the final assistant text is the only report this
      // transport can carry, so it is submitted only for a contract that
      // expects a report — and a missing required report fails the attempt.
      // A `write_report` submission already accepted wins over the final text.
      if (services?.deliverables && final.status === "completed" && services.deliverables.expected.includes("report") && services.deliverables.candidate?.() === undefined) {
        const body = (final.assistantText ?? "").trim()
        if (body.length === 0) {
          return { ...final, status: "failed", error: "the deliverable contract expects a report but the attempt produced none" }
        }
        const submitted = await services.deliverables.submit({ kind: "report", body: final.assistantText! })
        if (!submitted.ok) {
          return { ...final, status: "failed", error: submitted.error }
        }
      }
      return final
    } catch (error) {
      return {
        status: request.signal.aborted ? "interrupted" : "failed",
        ...session(),
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      request.signal.removeEventListener("abort", kill)
      if (escalation) clearTimeout(escalation)
      if (proc.exitCode === null) proc.kill()
      await rawLog?.close()
    }
  }

  return {
    id: "claude-code",

    async capabilities() {
      // Resolved from the adapter's own declaration plus enforcement evidence
      // (task 1.7), so preflight and this adapter never disagree.
      return resolveEffectiveCapabilities(claudeDeclaration, { enforcementReady: enforcement !== undefined })
    },

    async executeAttempt(
      request: ExecutionRequest,
      sink: (event: RunnerEvent) => void,
      services?: ExecutionServices,
    ): Promise<AttemptOutcome> {
      if (request.runner !== "claude-code") {
        return { status: "failed", error: `claude adapter received a ${request.runner} request` }
      }
      // Exactly one terminal event per attempt, carrying the final outcome.
      const finish = (outcome: AttemptOutcome): AttemptOutcome => {
        sink({ type: "terminal", runner: "claude-code", attempt: request.identity.attempt, outcome })
        return outcome
      }

      let invocation: ClaudeInvocation
      try {
        invocation = buildClaudeInvocation(request, enforcement, { env: baseEnv })
      } catch (error) {
        return finish({ status: "failed", error: error instanceof Error ? error.message : String(error) })
      }

      // The overlay is only an intent: the billing source is whatever Claude
      // resolves under this exact environment, so a key helper or third-party
      // provider that would silently change billing refuses the attempt
      // before the agent runs (spec runner-authentication).
      const probe = options.deps?.probeAuth ?? cliAuthProbe(spawn, binary, request.checkout)
      const effective = await validateEffectiveAuth({ resolution: invocation.auth, probe, env: baseEnv })
      if (!effective.ok) {
        return finish({ status: "failed", error: `${effective.error} Set defaults.claudeAuth to choose Claude's billing source explicitly.` })
      }

      // The attempt's bridge serves its approvals and Convoy's own tools
      // (write_report, the advisor) to the permission host, and the
      // first-write checkpoint to the hook. Its address and token reach only
      // those two: the host through its own MCP `env` in a private staged
      // config, the hook through a private file it is pointed at — never
      // Claude's environment or argv, which the agent's tools can read.
      let bridge: ClaudeAttemptBridge | undefined
      const staged: { discard(): Promise<void> }[] = []
      try {
        const handlers = enforcement ? attemptHandlers(request, services) : {}
        if (enforcement && (handlers.approve || handlers.report || handlers.advisor)) {
          bridge = await startClaudeAttemptBridge(handlers)
          const mcp = await stagePrivateMcpConfig(withServerEnv(enforcement.mcpConfig, bridge.env))
          staged.push(mcp)
          invocation.args[invocation.args.indexOf("--mcp-config") + 1] = mcp.path
          if (handlers.advisor) {
            const file = await stagePrivateFile("bridge.json", JSON.stringify({ url: bridge.url, token: bridge.token }))
            staged.push(file)
            invocation.args[invocation.args.indexOf("--settings") + 1] = encodeClaudeSettings(withHookEnv(enforcement.settings, { [bridgeFileEnv]: file.path }))
          }
          invocation.args.push("--allowedTools", ...convoyToolNames(enforcement.permissionPromptTool, bridge.tools))
        }
        return finish(await runInvocation(request, invocation, sink, services))
      } finally {
        await bridge?.close()
        for (const file of staged) await file.discard()
      }
    },

    async cancelAttempt() {
      // Cancellation is driven by the attempt's AbortSignal; nothing else to do.
    },
  }
}
