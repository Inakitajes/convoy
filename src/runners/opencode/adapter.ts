/**
 * OpenCode v2 execution adapter (change `runner-parity-opencode-v2`, design D1/D2).
 *
 * Implements the neutral `ExecutionAdapter` port on top of the v2 client
 * boundary. It owns its runtime (one owned server per adapter instance, booted
 * lazily and reused across attempts) and never leaks a vendor type to the core:
 * it translates requests into v2 calls and v2 messages into `RunnerEvent`s and an
 * `AttemptOutcome`.
 *
 * A prompt being admitted is NOT completion: the adapter waits for idle and then
 * reads the recorded assistant message, so a lost admission cannot be read as
 * success.
 */

import type {
  AttemptOutcome,
  Capability,
  ExecutionAdapter,
  ExecutionRequest,
  ModelReference,
  RunnerCapabilities,
  RunnerEvent,
  Usage,
} from "../contracts"
import { bootOwnedServer, type OwnedServer } from "./boot"
import { reconstructFromMessages } from "./history"
import { mapOpencodeEvent } from "./log-events"
import { assertSupportedOpencodeRuntime } from "./runtime"
import {
  createSession,
  createV2Client,
  interruptSession,
  listMessages,
  sendPrompt,
  subscribeEvents,
  waitForIdle,
  type OpencodeV2Client,
} from "./v2-client"

export type OpencodeRunnerOptions = {
  /** Root the owned server runs from (the run's checkout). */
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Rendered V2 config injected as `OPENCODE_CONFIG_CONTENT` (task 4.3). */
  configContent?: string
  deps?: {
    boot?: typeof bootOwnedServer
    checkRuntime?: typeof assertSupportedOpencodeRuntime
  }
}

/** The execution adapter plus the lifecycle edge the composition root calls. */
export type OpencodeRunner = ExecutionAdapter & {
  close(): Promise<void>
  /** Agent names the runtime actually registered from the injected config. */
  registeredAgents(): Promise<string[]>
  /** Reconstructs a recorded session's transcript for late attachment. */
  backfillEvents(sessionId: string, attempt: number): Promise<RunnerEvent[]>
}

/** The capabilities this adapter advertises (described, never bare booleans, D4). */
export function opencodeCapabilities(version?: string): RunnerCapabilities {
  const available: Capability["id"][] = [
    "read-only",
    "write",
    "verify",
    "model-fanout",
    "parallel",
    "approvals",
    "structured-deliverables",
    "advisor-bridge",
    "live-observation",
    "native-live-attach",
    "explicit-handoff",
    "post-exit-resume",
    "usage-reporting",
  ]
  return {
    runner: "opencode",
    ...(version ? { version } : {}),
    capabilities: available.map((id) => ({ id, availability: "available" as const })),
  }
}

/** Splits a Convoy model reference (`provider/model[#variant]`) into a v2 ModelRef. */
export function parseOpencodeModel(model: ModelReference): { providerID: string; modelID: string; variant?: string } {
  const [providerID, ...rest] = model.modelId.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) {
    throw new Error(`opencode model must look like provider/model[#variant], got "${model.modelId}"`)
  }
  return { providerID, modelID, ...(model.variant ? { variant: model.variant } : {}) }
}

type AssistantSummary = { text: string; tools: string[]; finish?: string; usage?: Usage; error?: string }

/** Extracts the assistant's text, tool markers, finish reason, and usage. */
export function summarizeAssistant(entry: unknown): AssistantSummary {
  const message = entry as {
    type?: unknown
    content?: unknown
    finish?: unknown
    cost?: unknown
    tokens?: unknown
    error?: unknown
  }
  let text = ""
  const tools: string[] = []
  if (Array.isArray(message.content)) {
    for (const part of message.content as { type?: unknown; text?: unknown; name?: unknown }[]) {
      if (part.type === "text" && typeof part.text === "string") text += part.text
      if (part.type === "tool" && typeof part.name === "string") tools.push(part.name)
    }
  }
  const tokens = message.tokens as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } | undefined
  const usage: Usage | undefined =
    tokens || typeof message.cost === "number"
      ? {
          ...(typeof tokens?.input === "number" ? { input: tokens.input } : {}),
          ...(typeof tokens?.output === "number" ? { output: tokens.output } : {}),
          ...(typeof tokens?.reasoning === "number" ? { reasoning: tokens.reasoning } : {}),
          ...(typeof tokens?.cache?.read === "number" ? { cacheRead: tokens.cache.read } : {}),
          ...(typeof tokens?.cache?.write === "number" ? { cacheWrite: tokens.cache.write } : {}),
          ...(typeof message.cost === "number" ? { costEstimate: message.cost } : {}),
        }
      : undefined
  const errorField = message.error as { message?: unknown } | undefined
  const errorMessage =
    errorField === undefined
      ? undefined
      : typeof errorField.message === "string" && errorField.message.length > 0
        ? errorField.message
        : "the assistant reported an error"
  return {
    text,
    tools,
    ...(typeof message.finish === "string" ? { finish: message.finish } : {}),
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
  }
}

export function createOpencodeRunner(options: OpencodeRunnerOptions): OpencodeRunner {
  let serverPromise: Promise<OwnedServer> | undefined
  let client: OpencodeV2Client | undefined
  const activeSessions = new Map<number, string>()

  const ensureServer = async (): Promise<{ server: OwnedServer; client: OpencodeV2Client }> => {
    if (!serverPromise) {
      const checkRuntime = options.deps?.checkRuntime ?? assertSupportedOpencodeRuntime
      const boot = options.deps?.boot ?? bootOwnedServer
      serverPromise = (async () => {
        await checkRuntime()
        const baseEnv = options.env ?? process.env
        const env = options.configContent
          ? { ...baseEnv, OPENCODE_CONFIG_CONTENT: options.configContent }
          : baseEnv
        return await boot({ cwd: options.cwd, env })
      })()
    }
    const server = await serverPromise
    client ??= createV2Client({ baseUrl: server.url, password: server.password })
    return { server, client }
  }

  return {
    id: "opencode",

    async capabilities() {
      return opencodeCapabilities()
    },

    async registeredAgents() {
      const { client: c } = await ensureServer()
      const input = { location: { directory: options.cwd } } as unknown as Parameters<OpencodeV2Client["config"]["get"]>[0]
      const documents = await c.config.get(input)
      if (!Array.isArray(documents)) return []
      const names = new Set<string>()
      for (const document of documents as Array<{ info?: { agents?: unknown; agent?: unknown } }>) {
        for (const key of ["agents", "agent"] as const) {
          const map = document.info?.[key]
          if (map && typeof map === "object") for (const name of Object.keys(map)) names.add(name)
        }
      }
      return [...names]
    },

    async backfillEvents(sessionId, attempt) {
      const { client: c } = await ensureServer()
      const messages = await listMessages(c, sessionId)
      return reconstructFromMessages(messages.data, attempt)
    },

    async executeAttempt(request: ExecutionRequest, sink: (event: RunnerEvent) => void): Promise<AttemptOutcome> {
      if (request.runner !== "opencode") {
        return { status: "failed", error: `opencode adapter received a ${request.runner} request` }
      }
      const attempt = request.attempt
      let streamAbort: AbortController | undefined
      try {
        const { client: c } = await ensureServer()
        const session =
          request.continueSession && request.continueSession.runner === "opencode"
            ? { id: request.continueSession.sessionId }
            : await createSession(c, { directory: request.checkout, title: `convoy ${request.phaseName}` })
        activeSessions.set(attempt, session.id)
        sink({ type: "session", runner: "opencode", attempt, session: { runner: "opencode", sessionId: session.id } })

        // Stream this attempt's live events (text/reasoning deltas, usage).
        // Terminal is derived from the recorded message below, so a streamed
        // execution outcome is not emitted twice.
        let sawText = false
        streamAbort = new AbortController()
        const streamTask = (async () => {
          try {
            for await (const event of subscribeEvents(c, streamAbort!.signal)) {
              const mapped = mapOpencodeEvent(event, attempt, session.id)
              if (!mapped || mapped.type === "terminal") continue
              if (mapped.type === "text") sawText = true
              sink(mapped)
            }
          } catch {
            // aborted or the stream ended; the outcome is derived below
          }
        })()

        await sendPrompt(c, {
          sessionID: session.id,
          text: request.prompt,
          model: parseOpencodeModel(request.agent.model),
        })
        await waitForIdle(c, session.id)
        streamAbort.abort()
        await streamTask.catch(() => undefined)

        const messages = await listMessages(c, session.id)
        const assistant = [...messages.data].reverse().find((entry) => (entry as { type?: unknown }).type === "assistant")
        if (!assistant) {
          return { status: "uncertain", session: { runner: "opencode", sessionId: session.id }, error: "no assistant message recorded" }
        }
        const summary = summarizeAssistant(assistant)
        // Fall back to the final message text only when nothing streamed live.
        if (summary.text && !sawText) sink({ type: "text", runner: "opencode", attempt, text: summary.text })
        for (const name of summary.tools) sink({ type: "tool", runner: "opencode", attempt, name })

        const outcome: AttemptOutcome = {
          status: summary.error ? "failed" : "completed",
          session: { runner: "opencode", sessionId: session.id },
          ...(summary.finish ? { finish: summary.finish } : {}),
          ...(summary.usage ? { usage: summary.usage } : {}),
          ...(summary.text ? { assistantText: summary.text } : {}),
          ...(summary.error ? { error: summary.error } : {}),
        }
        sink({ type: "terminal", runner: "opencode", attempt, outcome })
        return outcome
      } catch (error) {
        const outcome: AttemptOutcome = {
          status: request.signal.aborted ? "interrupted" : "failed",
          error: error instanceof Error ? error.message : String(error),
        }
        sink({ type: "terminal", runner: "opencode", attempt, outcome })
        return outcome
      } finally {
        streamAbort?.abort()
        activeSessions.delete(attempt)
      }
    },

    async cancelAttempt(attempt) {
      const sessionId = activeSessions.get(attempt.attempt)
      if (!sessionId || !client) return
      await interruptSession(client, sessionId).catch(() => undefined)
    },

    async close() {
      const server = await serverPromise?.catch(() => undefined)
      await server?.stop().catch(() => undefined)
      serverPromise = undefined
      client = undefined
    },
  }
}
