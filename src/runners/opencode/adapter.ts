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

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type {
  AttemptOutcome,
  ExecutionAdapter,
  ExecutionRequest,
  ModelReference,
  RunnerCapabilities,
  RunnerEvent,
  Usage,
} from "../contracts"
import { attemptKey } from "../contracts"
import { resolveEffectiveCapabilities } from "../capabilities"
import { opencodeDeclaration } from "../declarations"
import { bootOwnedServer, type OwnedServer } from "./boot"
import { reconstructFromMessages } from "./history"
import { mapOpencodeEvent } from "./log-events"
import { decideOpencodePermission } from "./permission"
import type { PolicyConfig } from "../policy"
import {
  planPluginRegistration,
  pluginFileNameForTool,
  pluginHealth,
  pluginIdForTool,
  requiredToolNames,
  type PluginRegistration,
  type PluginToolHealth,
  type PluginToolSpec,
} from "./plugin-tools"
import { assertSupportedOpencodeRuntime } from "./runtime"
import { openV2Terminal, type OpenV2TerminalDeps, type OpenV2TerminalInput } from "./terminal"
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
  /** Reviewed action policy for permission interception; defaults to write+auto. */
  policy?: PolicyConfig
  /** Rendered V2 config injected as `OPENCODE_CONFIG_CONTENT` (task 4.3). */
  configContent?: string
  /**
   * Ready-made v2 `plugins` entries merged into the injected config. `plugins`
   * belongs on the config `src/runners/opencode/config.ts` renders, but that
   * module is owned elsewhere; this adapter accepts the finished list instead
   * (task 4.5). The materialized per-run plugin directory is appended to it.
   */
  plugins?: readonly string[]
  /**
   * The run's own directory. Each run materializes its v2 plugin modules under
   * `<pluginBaseDir>/plugins`, so two runs never share a mutable tool module.
   */
  pluginBaseDir?: string
  /**
   * The Convoy report/advisor tools to expose through per-run v2 plugins. When
   * set, the adapter materializes them (not the legacy v1 tool shims) and
   * verifies their registration before any prompt is admitted.
   */
  pluginTools?: readonly PluginToolSpec[]
  deps?: {
    boot?: typeof bootOwnedServer
    checkRuntime?: typeof assertSupportedOpencodeRuntime
    /**
     * Registration-health probe for the required plugin tools. Defaults to
     * reading the server's plugin list. Fail closed: a probe that cannot verify
     * registration must report the tool as unregistered.
     */
    checkPluginHealth?: (required: readonly string[]) => Promise<readonly PluginToolHealth[]>
  }
}

/** Raised when a required Convoy tool did not register with the v2 runtime. */
export class PluginRegistrationError extends Error {
  readonly missing: readonly string[]

  constructor(missing: readonly string[], required: readonly string[]) {
    super(
      `opencode v2 plugin tools are not registered before prompting: ${missing.join(", ")} ` +
        `(required: ${required.join(", ")})`,
    )
    this.name = "PluginRegistrationError"
    this.missing = missing
  }
}

/**
 * Writes a planned registration to disk: a `0700` directory holding `0600`
 * module files. Materialization is per run because the directory is the run
 * root, so two runs never share a mutable tool shim.
 */
export async function materializePluginModules(registration: PluginRegistration): Promise<string[]> {
  await mkdir(registration.dir, { recursive: true, mode: 0o700 })
  const written: string[] = []
  for (const [fileName, source] of Object.entries(registration.files)) {
    const path = join(registration.dir, fileName)
    await writeFile(path, source, { mode: 0o600 })
    written.push(path)
  }
  return written
}

/**
 * Merges plugin entries into the injected config content. Accepts an opaque
 * ready-made JSON string (task 4.5); a non-JSON or non-object value fails closed
 * rather than silently clobbering the caller's configuration.
 */
export function mergePluginConfigContent(
  configContent: string | undefined,
  plugins: readonly string[],
): string | undefined {
  if (plugins.length === 0) return configContent
  let base: Record<string, unknown> = {}
  if (configContent) {
    let parsed: unknown
    try {
      parsed = JSON.parse(configContent)
    } catch {
      throw new Error("opencode configContent must be JSON to merge plugin entries")
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("opencode configContent must be a JSON object to merge plugin entries")
    }
    base = parsed as Record<string, unknown>
  }
  const existing = Array.isArray(base.plugins) ? (base.plugins as unknown[]) : []
  return JSON.stringify({ ...base, plugins: [...existing, ...plugins] })
}

/**
 * Fails closed unless every required tool has a positive registration
 * descriptor. A missing descriptor is treated exactly like a negative one so a
 * partial probe cannot be read as health.
 */
export function assertPluginToolsRegistered(
  required: readonly string[],
  descriptors: readonly PluginToolHealth[],
): void {
  const seen = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor.registered]))
  const health = pluginHealth(required.map((name) => ({ name, registered: seen.get(name) === true })))
  if (!health.ok) throw new PluginRegistrationError(health.missing, required)
}

/** Best-effort default probe: a plugin must be listed active, by id or file. */
async function probePluginHealth(
  client: OpencodeV2Client,
  directory: string,
  required: readonly string[],
  registration: PluginRegistration,
): Promise<PluginToolHealth[]> {
  let infos: Array<{ id?: string; source?: { type?: string; path?: string }; state?: { status?: string } }> = []
  try {
    const listed = await client.plugin.list({ location: { directory } })
    if (Array.isArray(listed?.data)) infos = listed.data as typeof infos
  } catch {
    // An unverifiable registration is not a healthy one.
    return required.map((name) => ({ name, registered: false }))
  }
  const active = infos.filter((info) => info.state?.status === "active")
  const activeIds = new Set(active.map((info) => info.id).filter((id): id is string => typeof id === "string"))
  const activePaths = new Set(
    active
      .filter((info) => info.source?.type === "local")
      .map((info) => info.source?.path)
      .filter((path): path is string => typeof path === "string"),
  )
  return required.map((name) => ({
    name,
    registered: activeIds.has(pluginIdForTool(name)) || activePaths.has(join(registration.dir, pluginFileNameForTool(name))),
  }))
}

/**
 * The app-callable terminal edge (task 4.6): opens a terminal for a run's owned
 * v2 server, staging the `0600` password file and keeping the password out of
 * argv. The `exec`/`stagePassword` seams let callers test the built command
 * without opening a window.
 */
export function openRunTerminal(input: OpenV2TerminalInput, deps?: OpenV2TerminalDeps): Promise<void> {
  return openV2Terminal(input, deps)
}

/** The execution adapter plus the lifecycle edge the composition root calls. */
export type OpencodeRunner = ExecutionAdapter & {
  close(): Promise<void>
  /** Agent names the runtime actually registered from the injected config. */
  registeredAgents(): Promise<string[]>
  /** Reconstructs a recorded session's transcript for late attachment. */
  backfillEvents(sessionId: string, attempt: number): Promise<RunnerEvent[]>
}

/** The capabilities this adapter advertises, resolved from its own declaration (task 1.7). */
export function opencodeCapabilities(version?: string): RunnerCapabilities {
  return resolveEffectiveCapabilities(opencodeDeclaration, version ? { version } : {})
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
  const policy: PolicyConfig = options.policy ?? { mode: "write", approvals: "auto" }
  const pluginSpecs = options.pluginTools ?? []
  if (pluginSpecs.length > 0 && !options.pluginBaseDir) {
    throw new Error("opencode runner: pluginBaseDir is required when pluginTools are provided")
  }
  const pluginRegistration =
    pluginSpecs.length > 0 ? planPluginRegistration(options.pluginBaseDir as string, pluginSpecs) : undefined
  const requiredTools = pluginRegistration ? requiredToolNames(pluginSpecs) : []
  const configContent = mergePluginConfigContent(options.configContent, [
    ...(options.plugins ?? []),
    ...(pluginRegistration ? [pluginRegistration.dir] : []),
  ])

  let serverPromise: Promise<OwnedServer> | undefined
  let client: OpencodeV2Client | undefined
  const activeSessions = new Map<string, string>()

  const ensureServer = async (): Promise<{ server: OwnedServer; client: OpencodeV2Client }> => {
    if (!serverPromise) {
      const checkRuntime = options.deps?.checkRuntime ?? assertSupportedOpencodeRuntime
      const boot = options.deps?.boot ?? bootOwnedServer
      serverPromise = (async () => {
        await checkRuntime()
        // Materialize this run's plugin modules before the server loads config,
        // then inject the directory through the config's `plugins` list. The
        // legacy v1 tool shims in Convoy's config dir are never used here.
        if (pluginRegistration) await materializePluginModules(pluginRegistration)
        const baseEnv = options.env ?? process.env
        const env = configContent
          ? { ...baseEnv, OPENCODE_CONFIG_CONTENT: configContent }
          : baseEnv
        return await boot({ cwd: options.cwd, env })
      })()
    }
    const server = await serverPromise
    client ??= createV2Client({ baseUrl: server.url, password: server.password })
    return { server, client }
  }

  // Required Convoy tools must actually register before a prompt is admitted;
  // otherwise the agent would silently run without its report/advisor tools.
  const ensurePluginToolsRegistered = async (c: OpencodeV2Client): Promise<void> => {
    if (!pluginRegistration) return
    const descriptors = options.deps?.checkPluginHealth
      ? await options.deps.checkPluginHealth(requiredTools)
      : await probePluginHealth(c, options.cwd, requiredTools, pluginRegistration)
    assertPluginToolsRegistered(requiredTools, descriptors)
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
      const attempt = request.identity.attempt
      let streamAbort: AbortController | undefined
      try {
        const { client: c } = await ensureServer()
        await ensurePluginToolsRegistered(c)
        const session =
          request.continueSession && request.continueSession.runner === "opencode"
            ? { id: request.continueSession.sessionId }
            : await createSession(c, { directory: request.checkout, title: `convoy ${request.identity.phaseName}` })
        activeSessions.set(attemptKey(request.identity), session.id)
        sink({ type: "session", runner: "opencode", attempt, session: { runner: "opencode", sessionId: session.id } })

        // Stream this attempt's live events (text/reasoning deltas, usage).
        // Terminal is derived from the recorded message below, so a streamed
        // execution outcome is not emitted twice.
        let sawText = false
        streamAbort = new AbortController()
        const streamTask = (async () => {
          try {
            for await (const event of subscribeEvents(c, streamAbort!.signal)) {
              const raw = event as {
                type?: string
                data?: { sessionID?: string; id?: string; action?: string; resources?: string[] }
              }
              // Mandatory interception: answer permission.asked for this attempt
              // through Convoy's policy instead of leaving it unanswered.
              if (raw.type === "permission.asked" && raw.data?.sessionID === session.id && raw.data.id && raw.data.action) {
                const decision = decideOpencodePermission(raw.data.action, raw.data.resources, policy)
                const reply = decision.effect === "deny" ? "reject" : "once"
                await (c.permission.reply as (input: unknown) => Promise<void>)({
                  sessionID: session.id,
                  requestID: raw.data.id,
                  reply,
                }).catch(() => undefined)
                sink({
                  type: "permission-settled",
                  runner: "opencode",
                  attempt,
                  requestId: raw.data.id,
                  decision: decision.effect === "deny" ? "deny" : "allow",
                })
                continue
              }
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
        activeSessions.delete(attemptKey(request.identity))
      }
    },

    async cancelAttempt(attempt) {
      const sessionId = activeSessions.get(attemptKey(attempt))
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
