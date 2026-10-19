import { toolPermissions, type AssistantMessage, type Config, type OpencodeClient, type Part } from "./opencode-client"

import { builtInPrompts } from "./built-in-prompts"
import { log } from "./log"
import { writeReportToolName } from "./report"
import type { AuthenticationSelection, Usage } from "./runners/contracts"
import { helperInferenceFor, type HelperInferenceSeams } from "./runners/helper-inference"
import { isStepRunnerId, runnerOfModelReference, stepRunnerFor } from "./step-runners"

/**
 * The advisor←executor pattern, emulated over OpenCode's own APIs.
 *
 * A step's executor owns the loop, the tools, and the deliverable. At its
 * decision points it consults a stronger advising model that runs OUTSIDE that
 * loop: a single stateless prompt with every tool disabled, over the executor's
 * verbatim transcript. Only the advice text re-enters the executor's context —
 * never the advisor's reasoning — so intention is never re-serialized across a
 * handoff boundary, which is the failure mode that makes plan-then-execute
 * pipelines lose the plan.
 *
 * Two properties are load-bearing and easy to break:
 *
 * 1. The advisor never gets tools. With tools it becomes an orchestrator and the
 *    cost argument inverts — the whole point is that the expensive model emits
 *    hundreds of tokens, not the deliverable.
 * 2. Failure degrades, it never fails the phase. An unavailable advisor returns
 *    guidance saying so, and the executor carries on.
 */

/**
 * Default cap on consultations per phase attempt.
 *
 * Deliberately high enough to never bind in practice. The reference pattern's
 * `max_uses` is a small number because it assumes one decision worth advising;
 * a Convoy phase is a whole implementation session, and a low cap silently turns
 * the advisor off partway through — the executor keeps working, unadvised, which
 * is the failure mode the feature exists to prevent, and the one hardest to
 * notice from the outside.
 *
 * The budget stays finite so the runtime keeps its cost ceiling, its
 * `advisor.budget_exhausted` event, and its `used/max` counters. Anyone who
 * actually wants a tight leash sets `advisorMaxCalls` on the step or in
 * `defaults`, which both outrank this.
 */
export const defaultAdvisorMaxCalls = 1000

/**
 * Name of the custom tool the executor calls to consult its advisor on demand.
 *
 * Lives here rather than beside the agent config or the bridge because all three
 * have to agree on it: OpenCode derives a custom tool's name from its filename,
 * so the file the bridge writes, the agent's tool map, and the advisor session's
 * own tool blocklist are the same string or the feature silently half-works.
 */
export const advisorToolName = "advisor"
/** Tool used by the executor to explicitly record what it did with delivered advice. */
export const advisorFeedbackToolName = "advisor_feedback"

/**
 * Hard cap on advisor output tokens. OpenCode's prompt API takes no per-call
 * limit, but its effective cap is `min(model.limit.output, OUTPUT_TOKEN_MAX)`,
 * and `limit.output` is declarable per model in the config Convoy already
 * injects — so the cap is applied by consulting a synthetic alias of the
 * advising model (see advisorProviderOverride) rather than the model itself.
 *
 * Unlike the reference pattern's `max_tokens`, this budget covers reasoning
 * tokens too, so it is deliberately looser than the 2048 that pattern suggests.
 */
export const defaultAdvisorMaxTokens = 2048

/** Prefix of the synthetic capped model IDs. Distinct so advisor spend is separable in the usage logs. */
const advisorModelPrefix = "convoy-advisor-"

const defaultTimeoutMs = 120_000
/** Transcript budget. Well inside every supported advisor's context, and truncation keeps both ends. */
const maxTranscriptChars = 120_000
const maxToolOutputChars = 2_000

export type AdvisorReason = "first-write" | "completion" | "on-demand"

export type AdvisorErrorCode = "max_uses_exceeded" | "prompt_too_long" | "execution_time_exceeded" | "unavailable"

export type AdvisorUsage = {
  cost: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  model: string
}

export type AdvisorResult =
  | { kind: "advice"; text: string; usage?: AdvisorUsage }
  | { kind: "error"; code: AdvisorErrorCode; message: string }

export type ModelSelection = { providerID: string; modelID: string; variant?: string }

export type ConsultAdvisorInput = {
  /**
   * The run's OpenCode server: reads an OpenCode executor's transcript and
   * hosts an OpenCode advising model's throwaway session. Not needed when the
   * transcript is supplied and the advising model runs on a CLI runner.
   */
  client?: OpencodeClient
  /**
   * The executor's transcript, already rendered, for an executor whose session
   * does not live on the OpenCode server (Claude, Codex): recorded by Convoy from the
   * attempt's normalized events.
   */
  transcript?: string
  /** The reviewed authentication a CLI-routed advising model (`claude-code/<model>`, `codex/<model>`) consults under. */
  auth?: AuthenticationSelection
  /** Test seams for the CLI runners. */
  inferenceSeams?: HelperInferenceSeams
  /** The executor session whose transcript the advisor reads. */
  sessionID: string
  directory: string
  /** The advising model, already routed. Passed as the capped synthetic alias. */
  model: ModelSelection
  reason: AdvisorReason
  /** Free-text question appended to the transcript; the completion checkpoint asks a different thing than the first-write one. */
  question?: string
  /** Soft word ceiling requested of the advisor, complementing the hard token cap. */
  brevityWords?: number
  signal?: AbortSignal
  timeoutMs?: number
  /** Observability seam: receives the exact bounded transcript sent to the advisor. */
  onTranscript?: (transcript: string) => void
}

/**
 * Runs one consultation. Resolves to an error variant rather than throwing:
 * every caller is on a path where the phase must continue regardless.
 */
export async function consultAdvisor(input: ConsultAdvisorInput): Promise<AdvisorResult> {
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("advisor timed out")), timeoutMs)
  const onParentAbort = () => controller.abort(input.signal?.reason)
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason)
    else input.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  let advisorSessionID: string | undefined
  const client = input.client
  try {
    const transcript =
      input.transcript !== undefined
        ? clampMiddle(input.transcript, maxTranscriptChars)
        : await readTranscript(requireClient(client, "read the executor's transcript"), input.sessionID, input.directory, controller.signal)
    input.onTranscript?.(transcript)

    const infer = helperInferenceFor(runnerOfModelReference(input.model), input.inferenceSeams)
    if (infer) {
      // Same contract as the OpenCode path: one stateless, tool-less answer
      // over the transcript, reasoning never re-entering the executor.
      const answer = await infer({
        prompt: buildAdvisorPrompt(transcript, input),
        system: builtInPrompts["advisor-system"],
        model: input.model.modelID,
        ...(input.model.variant ? { variant: input.model.variant } : {}),
        auth: input.auth ?? { mode: "subscription" },
        cwd: input.directory,
        tools: "none",
        timeoutMs,
        signal: controller.signal,
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(message.endsWith("timed out") ? "advisor timed out" : message)
      })
      if (!answer.text) throw new Error("advisor returned an empty answer")
      return { kind: "advice", text: clampEnd(answer.text, maxAdviceChars), usage: cliUsageOf(answer.usage, input.model) }
    }

    const server = requireClient(client, "host the advising model")
    const session = await server.session.create(
      { directory: input.directory, title: `convoy advisor (${input.reason})`, permissions: toolPermissions(advisorTools()) },
      { signal: controller.signal },
    )
    if (session.error || !session.data?.id) throw new Error("advisor couldn't open a session")
    advisorSessionID = session.data.id

    const response = await server.session.prompt(
      {
        sessionID: advisorSessionID,
        directory: input.directory,
        model: { providerID: input.model.providerID, modelID: input.model.modelID },
        ...(input.model.variant ? { variant: input.model.variant } : {}),
        system: builtInPrompts["advisor-system"],
        tools: advisorTools(),
        parts: [{ type: "text", text: buildAdvisorPrompt(transcript, input) }],
      },
      { signal: controller.signal },
    )
    if (response.error || !response.data) throw new Error("advisor returned no answer")

    // Reasoning parts are dropped here: only the advice enters the executor's context.
    const text = collectText(response.data.parts)
    if (!text) throw new Error("advisor returned an empty answer")

    return { kind: "advice", text, usage: usageOf(response.data.info) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = errorCodeFor(message)
    // Provider errors can include request/response details. Keep diagnostics in
    // the private audit event (under its configured retention policy), not the
    // process log that may be collected or shared separately.
    log.warn(`[advisor] consultation failed (${input.reason}, ${code}), continuing without advice`)
    return { kind: "error", code, message }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onParentAbort)
    if (advisorSessionID && client) {
      try {
        await client.session.delete({ sessionID: advisorSessionID, directory: input.directory })
      } catch {
        // Throwaway session in an ephemeral workspace; deletion is best effort.
      }
    }
  }
}

/** True when the advising model runs on a CLI runner (a `claude-code/<model>` or `codex/<model>` route). */
export function isCliAdvisor(model: { providerID: string }): boolean {
  return helperInferenceFor(runnerOfModelReference(model)) !== undefined
}

function requireClient(client: OpencodeClient | undefined, purpose: string): OpencodeClient {
  if (!client) throw new Error(`no OpenCode server is running to ${purpose}`)
  return client
}

/**
 * The CLI runners take no output cap, so the advice is bounded here instead: the
 * brevity request keeps it short, and this keeps a runaway answer from flooding
 * the executor's context.
 */
const maxAdviceChars = 8_000

function cliUsageOf(usage: Usage | undefined, model: ModelSelection): AdvisorUsage {
  return {
    cost: usage?.costEstimate ?? 0,
    tokens: { input: usage?.input ?? 0, output: usage?.output ?? 0, reasoning: usage?.reasoning ?? 0, cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0 },
    model: stepRunnerFor(runnerOfModelReference(model)).modelLabel(model.modelID, model.variant),
  }
}

/**
 * Every tool off: the advisor advises, it never acts.
 *
 * The leading wildcard is what makes this hold for tools Convoy doesn't know
 * about — Convoy's own `advisor` tool (a recursive consultation), and anything
 * an MCP server or the user's OpenCode config dir contributes. An enumerated
 * denylist can only ever cover the built-ins, and an advisor that quietly gains
 * a tool inverts the pattern's whole cost argument. Older servers that ignore the
 * wildcard still get the explicit entries below it.
 */
export function advisorTools(): Record<string, boolean> {
  return {
    "*": false,
    read: false,
    write: false,
    edit: false,
    bash: false,
    glob: false,
    grep: false,
    list: false,
    task: false,
    webfetch: false,
    websearch: false,
    todoread: false,
    todowrite: false,
    skill: false,
    [advisorToolName]: false,
    [advisorFeedbackToolName]: false,
    [writeReportToolName]: false,
  }
}

/** What the executor is told when a consultation could not produce advice. Never blank: silence reads as approval. */
export function advisorFallbackText(result: Extract<AdvisorResult, { kind: "error" }>): string {
  const detail =
    result.code === "max_uses_exceeded"
      ? "this phase has used its advisor budget"
      : result.code === "prompt_too_long"
        ? "the transcript no longer fits the advisor's context"
        : result.code === "execution_time_exceeded"
          ? "the advisor timed out"
          : "the advisor is unavailable"
  return `No advice this time — ${detail}. Continue on your own judgement; this is not a failure of your phase.`
}

function errorCodeFor(message: string): AdvisorErrorCode {
  const lower = message.toLowerCase()
  if (lower.includes("timed out") || lower.includes("timeout")) return "execution_time_exceeded"
  if (lower.includes("context") || lower.includes("too long") || lower.includes("token")) return "prompt_too_long"
  return "unavailable"
}

function usageOf(info: AssistantMessage): AdvisorUsage {
  return {
    cost: info.cost,
    tokens: {
      input: info.tokens.input,
      output: info.tokens.output,
      reasoning: info.tokens.reasoning,
      cacheRead: info.tokens.cache.read,
      cacheWrite: info.tokens.cache.write,
    },
    model: `${info.providerID}/${info.modelID}`,
  }
}

function collectText(parts: readonly Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

async function readTranscript(client: OpencodeClient, sessionID: string, directory: string, signal: AbortSignal): Promise<string> {
  const response = await client.session.messages({ sessionID, directory }, { signal })
  if (response.error || !response.data) throw new Error("advisor couldn't read the executor's transcript")
  return renderTranscript(response.data)
}

export type TranscriptMessage = { info: { role: string }; parts: readonly Part[] }

/**
 * Renders the executor's messages as the cited transcript the advisor reads.
 * Tool calls keep their input and a truncated output, because the advisor's
 * whole advantage is seeing what the executor actually observed rather than a
 * summary of it. The executor's own reasoning is included — it is exactly the
 * about-to-go-wrong thinking an advisor is there to catch.
 */
export function renderTranscript(messages: readonly TranscriptMessage[], limit = maxTranscriptChars): string {
  const blocks: string[] = []

  for (const message of messages) {
    const role = message.info.role === "user" ? "USER" : "ASSISTANT"
    for (const part of message.parts) {
      const rendered = renderPart(part)
      if (rendered) blocks.push(`### ${role}\n${rendered}`)
    }
  }

  if (blocks.length === 0) return "(the executor's transcript is empty)"
  return clampMiddle(blocks.join("\n\n"), limit)
}

function renderPart(part: Part): string | undefined {
  if (part.type === "text") return part.text.trim() || undefined
  if (part.type === "reasoning") return part.text.trim() ? `[reasoning] ${part.text.trim()}` : undefined
  if (part.type === "tool") return renderToolPart(part)
  return undefined
}

function renderToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  const state = part.state
  const input = "input" in state && state.input ? ` ${JSON.stringify(state.input)}` : ""
  const header = `[tool ${part.tool}]${clampEnd(input, 600)}`
  if (state.status === "completed") return `${header}\n→ ${clampEnd(state.output.trim(), maxToolOutputChars)}`
  if (state.status === "error") return `${header}\n→ ERROR: ${clampEnd(state.error.trim(), maxToolOutputChars)}`
  return `${header}\n→ (${state.status})`
}

function clampEnd(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}… [${value.length - max} more chars]`
}

/**
 * Truncates from the middle. The task lives at the start and the current state
 * at the end; the middle of a long tool-call run is the most droppable part.
 */
export function clampMiddle(value: string, max: number): string {
  if (value.length <= max) return value
  const half = Math.floor((max - 80) / 2)
  if (half <= 0) return value.slice(0, max)
  const dropped = value.length - half * 2
  return `${value.slice(0, half)}\n\n… [${dropped} characters of transcript omitted from the middle] …\n\n${value.slice(-half)}`
}

const reasonQuestions: Record<AdvisorReason, string> = {
  "first-write": "I am about to make my first change to the repository. Is this the right change to make, and is this the right way to make it?",
  completion: completionQuestion(false),
  "on-demand": "What should I do next?",
}

/**
 * What the closing checkpoint asks. A read-only phase gets a different question
 * because its deliverable is the report itself: "is the phase done" and "is the
 * report right" are the same question there, and asking the generic one invites
 * advice about work a phase that cannot write was never going to do.
 */
export function completionQuestion(readOnly: boolean): string {
  return readOnly
    ? "I believe this audit phase is complete and the report above is my final answer. Is anything missing, wrong, or unsupported by what I actually examined?"
    : "I believe this phase is complete. Is it? If not, what specifically is missing or wrong?"
}

export function buildAdvisorPrompt(transcript: string, input: Pick<ConsultAdvisorInput, "reason" | "question" | "brevityWords">): string {
  const words = input.brevityWords ?? 80
  return [
    "Here is the complete transcript of the executor you are advising.",
    "",
    "<transcript>",
    transcript,
    "</transcript>",
    "",
    input.question?.trim() || reasonQuestions[input.reason],
    "",
    // Second person, in the user message: instructions addressed TO the advisor
    // are followed far more reliably than third-person descriptions of it.
    `(Advisor: keep your guidance under ${words} words — I need a focused starting point, not a comprehensive plan.)`,
  ].join("\n")
}

/**
 * What a resolved pipeline needs from the OpenCode config for its advisors.
 *
 * `agents` is a set rather than a map because the advising model is looked up per
 * phase at call time; the config only decides whether an agent has the tool, the
 * timing block, and the gated first write at all. An agent used by both an
 * advised and an unadvised step therefore carries the machinery in both, and the
 * unadvised phase simply answers that it has no advisor configured.
 */
export type AdvisorPipelineNeeds = {
  agents: Set<string>
  models: ModelSelection[]
}

export function advisorNeedsOf(steps: readonly { type: string; agentName?: string; runner?: string; resolvedAdvisor?: { providerID: string; modelID: string } }[]): AdvisorPipelineNeeds {
  const agents = new Set<string>()
  const models = new Map<string, ModelSelection>()

  for (const step of steps) {
    if (step.type !== "agent" || !step.resolvedAdvisor || !step.agentName) continue
    // Only an OpenCode executor carries the advisor tool in OpenCode's agent
    // config; a CLI executor reaches its advisor through Convoy's MCP tool.
    if (!stepRunnerFor(isStepRunnerId(step.runner) ? step.runner : undefined).qualifiedModels) agents.add(step.agentName)
    const { providerID, modelID } = step.resolvedAdvisor
    // Only an OpenCode advising model needs a capped alias in the run config.
    if (!isCliAdvisor(step.resolvedAdvisor)) models.set(`${providerID}/${modelID}`, { providerID, modelID })
  }
  return { agents, models: [...models.values()] }
}

/** The advising model a phase consults: the routed model, reached through its capped alias. */
export function advisorSelectionFor(step: { resolvedAdvisor?: { providerID: string; modelID: string; variant?: string } }): ModelSelection | undefined {
  if (!step.resolvedAdvisor) return undefined
  const { providerID, modelID, variant } = step.resolvedAdvisor
  // The capped alias exists only in the run's OpenCode config; a CLI runner's model is consulted as itself.
  if (isCliAdvisor(step.resolvedAdvisor)) return { providerID, modelID, ...(variant ? { variant } : {}) }
  return { providerID, modelID: advisorModelID(modelID), ...(variant ? { variant } : {}) }
}

/** The synthetic model ID an advising model is consulted through. */
export function advisorModelID(modelID: string): string {
  return `${advisorModelPrefix}${modelID}`
}

export function isAdvisorModelID(modelID: string): boolean {
  return modelID.startsWith(advisorModelPrefix)
}

/**
 * Context window declared on the aliases. Deliberately generous: an alias must
 * declare a complete `limit` (a partial one makes OpenCode drop the provider's
 * whole model list, silently), yet Convoy has no catalog on hand when it builds
 * the config. Over-declaring is safe here and under-declaring is not — the only
 * thing this figure drives is overflow and compaction bookkeeping, which a
 * single bounded advisor prompt never reaches, while a figure below the real
 * window would shrink a large-context advisor for no reason.
 */
const advisorContextWindow = 1_000_000

/**
 * Declares capped aliases of every advising model a run uses, to be merged into
 * the `provider` block of the OpenCode config Convoy injects.
 *
 * The alias names the real upstream model in `id`, and OpenCode resolves
 * everything else — credentials, routing, provider options, and crucially the
 * per-token costs — from that, so advisor spend is reported accurately while
 * only `limit.output` differs. Capping the real model entry instead would also
 * cap any executor step that happens to share the model.
 */
export function advisorProviderOverride(models: readonly ModelSelection[], maxTokens = defaultAdvisorMaxTokens): NonNullable<Config["provider"]> {
  const provider: NonNullable<Config["provider"]> = {}

  for (const model of models) {
    if (isAdvisorModelID(model.modelID)) continue
    const entry = (provider[model.providerID] ??= {})
    const entryModels = (entry.models ??= {})
    entryModels[advisorModelID(model.modelID)] = {
      id: model.modelID,
      name: `Convoy advisor · ${model.modelID}`,
      limit: { context: advisorContextWindow, output: maxTokens },
    }
  }
  return provider
}
