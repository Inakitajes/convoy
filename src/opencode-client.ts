/**
 * Convoy-owned OpenCode client boundary (change `migrate-opencode-v2`, design
 * D1: "One external V2 client boundary, not a second orchestration engine").
 *
 * Convoy's domain code talks to a small, stable set of operations. This module
 * is the single place that knows how those operations map onto the released
 * `@opencode/client` V2 contract:
 *
 *   - the connection is authenticated as HTTP Basic `opencode:<password>`
 *     (the per-boot credential the managed server prints), and
 *   - V2's resource shapes (`session.prompt` admission, paginated
 *     `message.list`, `session.interrupt`, `permission.reply`, server-wide
 *     `event.subscribe`, split provider/model inventories) are translated to the
 *     shapes Convoy's existing execution/history/connection helpers consume.
 *
 * The types here are Convoy-owned on purpose: they are the contract the domain
 * code depends on, so a future V2 protocol change lands in this file rather than
 * across every consumer. This is not a backend registry: there is exactly one
 * backend (the operator's local V2 runtime).
 *
 * NOTE: the wire mappings below are derived from the released V2 declarations.
 * They are exercised against a real isolated server by
 * `test/opencode-client.integration.test.ts`, and full prompt turns against a
 * scripted provider by `test/opencode-v2-runtime.integration.test.ts`; open
 * gaps are recorded in the migration design's parity matrix.
 */

import { OpenCode } from "@opencode/client"
import { ID as MessageID } from "@opencode/schema/session-message"

// ---------------------------------------------------------------------------
// Convoy-owned data types (the shapes the domain logic consumes)
// ---------------------------------------------------------------------------

export type PermissionActionConfig = "ask" | "allow" | "deny"

export type AgentConfig = {
  description?: string
  mode?: "primary" | "subagent" | "all"
  temperature?: number
  prompt?: string
  tools?: Record<string, boolean>
  permission?: Record<string, PermissionActionConfig | Record<string, PermissionActionConfig>>
  [key: string]: unknown
}

export type ProviderModelConfig = {
  id?: string
  options?: Record<string, unknown>
  limit?: { context?: number; output?: number }
  cost?: unknown
  [key: string]: unknown
}

export type ProviderConfig = {
  models?: Record<string, ProviderModelConfig>
  options?: Record<string, unknown>
  [key: string]: unknown
}

export type Config = {
  agent?: Record<string, AgentConfig>
  provider?: Record<string, ProviderConfig>
  permission?: Record<string, PermissionActionConfig | Record<string, PermissionActionConfig>>
  /** Absolute plugin package directories to load for this server (V2 `plugins`). */
  plugins?: string[]
  logLevel?: string
  [key: string]: unknown
}

export type Model = {
  id: string
  providerID: string
  name: string
  status?: string
  limit?: { context?: number; output?: number }
  variants?: Record<string, unknown>
  [key: string]: unknown
}

export type Provider = {
  id: string
  name?: string
  models: Record<string, Model>
  [key: string]: unknown
}

export type FilePartInput = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

export type TextPart = {
  type: "text"
  id?: string
  text: string
  synthetic?: boolean
  ignored?: boolean
}

export type ReasoningPart = {
  type: "reasoning"
  id?: string
  text: string
}

export type ToolState =
  | { status: "completed"; input: unknown; output: string; metadata?: unknown }
  | { status: "error"; input: unknown; error: string }
  | { status: "running"; input: unknown }
  | { status: "streaming"; input: string }
  | { status: "pending" }

export type ToolPart = {
  type: "tool"
  id?: string
  callID?: string
  tool: string
  state: ToolState
}

/** Parts Convoy does not render but must accept on the wire (V2 emits several). */
export type StepStartPart = { type: "step-start"; id?: string; [key: string]: unknown }
export type StepFinishPart = { type: "step-finish"; id?: string; [key: string]: unknown }

export type Part = TextPart | ReasoningPart | ToolPart | StepStartPart | StepFinishPart

export type AssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?: unknown
  parentID?: string
  modelID: string
  providerID: string
  mode?: string
  agent?: string
  path?: { cwd: string; root: string }
  cost: number
  tokens: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  variant?: string
  finish?: string
}

export type UserMessage = { id: string; sessionID: string; role: "user"; time: { created: number } }

export type SessionMessage = { info: AssistantMessage | UserMessage; parts: Part[] }

export type SessionStatus = { type: "idle" } | { type: "retry"; attempt: number; message: string } | { type: "busy" }

export type SessionInfo = { id: string; title?: string; [key: string]: unknown }
export type ModelRefInput = { providerID: string; modelID: string; variant?: string }

export type MessagePartInput = TextPart | FilePartInput

// ---------------------------------------------------------------------------
// Request/response shapes
// ---------------------------------------------------------------------------

export type RequestOptions = { signal?: AbortSignal }

/** The V1 SDK returned `{ data, error }`; the boundary preserves that shape. */
export type SdkResult<T> = { data?: T; error?: unknown }

export type SessionCreateInput = {
  directory?: string
  parentID?: string
  title?: string
  agent?: string
  model?: ModelRefInput
  metadata?: Record<string, unknown>
  /**
   * V2 session permission ruleset. V2 has no per-prompt `tools` map, so a
   * tool-less or read-only session must deny the actions at creation.
   */
  permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
}

export type SessionPromptAsyncInput = {
  sessionID: string
  directory?: string
  agent?: string
  model?: ModelRefInput
  variant?: string
  delivery?: "steer" | "queue"
  parts: MessagePartInput[]
}

export type SessionPromptInput = {
  sessionID: string
  directory?: string
  agent?: string
  model?: ModelRefInput
  variant?: string
  system?: string
  tools?: Record<string, boolean>
  parts: MessagePartInput[]
}

export type SessionMessagesInput = { sessionID: string; directory?: string }
export type SessionStatusInput = { directory?: string }
export type SessionGetInput = { sessionID: string }
export type SessionDeleteInput = { sessionID: string; directory?: string }
export type SessionAbortInput = { sessionID: string; directory?: string }
export type SessionCommandInput = { sessionID: string; directory?: string; command: string; arguments?: string }

export type ProviderListResult = { all: Provider[]; connected: string[] }

export type PermissionReplyChoice = "once" | "always" | "reject"
export type PermissionReplyInput = { sessionID: string; requestID: string; directory?: string; reply: PermissionReplyChoice; message?: string }

export type EventSubscribeInput = { directory?: string }

export type OpencodeClient = {
  session: {
    create(input: SessionCreateInput, options?: RequestOptions): Promise<SdkResult<SessionInfo>>
    list(input?: { directory?: string }, options?: RequestOptions): Promise<SdkResult<SessionInfo[]>>
    prompt(input: SessionPromptInput, options?: RequestOptions): Promise<SdkResult<{ info: AssistantMessage; parts: Part[] }>>
    promptAsync(input: SessionPromptAsyncInput, options?: RequestOptions): Promise<SdkResult<unknown>>
    messages(input: SessionMessagesInput, options?: RequestOptions): Promise<SdkResult<SessionMessage[]>>
    status(input?: SessionStatusInput, options?: RequestOptions): Promise<SdkResult<Record<string, SessionStatus>>>
    get(input: SessionGetInput, options?: RequestOptions): Promise<SdkResult<SessionInfo>>
    delete(input: SessionDeleteInput, options?: RequestOptions): Promise<SdkResult<unknown>>
    abort(input: SessionAbortInput, options?: RequestOptions): Promise<SdkResult<unknown>>
    command(input: SessionCommandInput, options?: RequestOptions): Promise<SdkResult<unknown>>
  }
  provider: {
    list(input?: { directory?: string }, options?: RequestOptions): Promise<SdkResult<ProviderListResult>>
  }
  permission: {
    reply(input: PermissionReplyInput, options?: RequestOptions): Promise<SdkResult<unknown>>
  }
  event: {
    subscribe(input?: EventSubscribeInput, options?: RequestOptions): Promise<{ stream: AsyncIterable<unknown> }>
  }
  command: {
    list(input?: { directory?: string }, options?: RequestOptions): Promise<SdkResult<Array<{ name?: string; trigger?: string }>>>
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type CreateOpencodeClientOptions = {
  baseUrl: string
  /** The per-boot HTTP Basic password printed by the managed V2 server. */
  password?: string
  fetch?: typeof fetch
}

/** The V2 connection authenticates as HTTP Basic `opencode:<password>`. */
export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`
}

/**
 * Translates Convoy's V1 `tools` map (`{ name: allowed }`) into V2's session
 * permission ruleset. V2 has no per-prompt `tools` field; tools are governed
 * by the session's rules, where the last match wins. The ruleset starts from
 * deny-all and re-allows only the tools marked true, so a tool the map does
 * not name (a `task` subagent, an MCP or plugin tool) is denied as well. V2's
 * `shell` is the counterpart of V1's `bash`, so the two move together.
 */
export function toolPermissions(tools: Record<string, boolean>): Array<{ action: string; resource: string; effect: "allow" | "deny" }> {
  const allowed = new Set<string>()
  for (const [name, enabled] of Object.entries(tools)) if (enabled && name !== "*") allowed.add(name)
  if (allowed.has("bash") || allowed.has("shell")) {
    allowed.add("bash")
    allowed.add("shell")
  }
  return [
    { action: "*", resource: "*", effect: "deny" as const },
    ...[...allowed].map((action) => ({ action, resource: "*", effect: "allow" as const })),
  ]
}

function toModelRef(model: ModelRefInput | undefined, variant?: string): { id: string; providerID: string; variant?: string } | undefined {
  if (!model) return undefined
  const selected = variant ?? model.variant
  return { id: model.modelID, providerID: model.providerID, ...(selected ? { variant: selected } : {}) }
}

function toLocation(directory: string | undefined): { directory: string } | undefined {
  return directory ? { directory } : undefined
}

/** Splits Convoy's message parts into V2's `{ text, files }` prompt payload. */
function toPromptPayload(parts: readonly MessagePartInput[], system?: string): { text: string; files: { uri: string; name?: string }[] } {
  const body = parts.filter((part): part is TextPart => part.type === "text").map((part) => part.text).join("\n")
  // V2's `session.prompt` has no `system` field; the instructions ride the user
  // turn so a judge/writer's system contract still reaches the model.
  const text = system ? `${system}\n\n${body}` : body
  const files = parts
    .filter((part): part is FilePartInput => part.type === "file")
    .map((part) => ({ uri: part.url, ...(part.filename ? { name: part.filename } : {}) }))
  return { text, files }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toolStateToConvoy(state: {
  status: string
  input?: unknown
  content?: readonly { type?: string; text?: string }[]
  error?: unknown
}): ToolState {
  if (state.status === "completed") {
    const output = (state.content ?? [])
      .map((item) => (typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n")
    return { status: "completed", input: state.input, output }
  }
  if (state.status === "error") return { status: "error", input: state.input, error: describe(state.error) }
  if (state.status === "running") return { status: "running", input: state.input }
  if (state.status === "streaming") return { status: "streaming", input: typeof state.input === "string" ? state.input : "" }
  return { status: "pending" }
}

export function createOpencodeClient(options: CreateOpencodeClientOptions): OpencodeClient {
  const headers: Record<string, string> = {}
  if (options.password) headers.authorization = basicAuthHeader(options.password)
  const client = OpenCode.make({ baseUrl: options.baseUrl, headers, ...(options.fetch ? { fetch: options.fetch } : {}) })

  return {
    session: {
      async create(input, opts) {
        try {
          const info = await client.session.create(
            {
              ...(toLocation(input.directory) ? { location: toLocation(input.directory) } : {}),
              ...(input.title ? { title: input.title } : {}),
              ...(input.agent ? { agent: input.agent } : {}),
              ...(toModelRef(input.model) ? { model: toModelRef(input.model) } : {}),
              ...(input.metadata ? { metadata: input.metadata as Record<string, never> } : {}),
              ...(input.permissions ? { permissions: input.permissions } : {}),
            },
            opts,
          )
          return { data: info }
        } catch (error) {
          return { error }
        }
      },
      async list(input, opts) {
        try {
          const res = await client.session.list({ directory: input?.directory }, opts)
          return { data: res.data }
        } catch (error) {
          return { error }
        }
      },
      async promptAsync(input, opts) {
        try {
          if (input.agent) await client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent }, opts)
          const model = toModelRef(input.model, input.variant)
          if (model) await client.session.switchModel({ sessionID: input.sessionID, model }, opts)
          const payload = toPromptPayload(input.parts)
          const id = await admitPrompt(client, { sessionID: input.sessionID, text: payload.text, files: payload.files, ...(input.delivery ? { delivery: input.delivery } : {}) }, opts)
          return { data: { id } }
        } catch (error) {
          return { error }
        }
      },
      async prompt(input, opts) {
        try {
          if (input.agent) await client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent }, opts)
          const model = toModelRef(input.model, input.variant)
          if (model) await client.session.switchModel({ sessionID: input.sessionID, model }, opts)
          const payload = toPromptPayload(input.parts, input.system)
          const id = await admitPrompt(client, { sessionID: input.sessionID, text: payload.text, files: payload.files }, opts)
          await waitForTurn(client, input.sessionID, id, opts)
          const messages = await listSessionMessages(client, input.sessionID, opts)
          // Only this turn's reply counts (history is oldest first): an earlier
          // turn's output can never stand in for a turn that produced none.
          const turn = messages.slice(messages.findIndex((message) => message.info.id === id) + 1)
          const last = messages.some((message) => message.info.id === id)
            ? [...turn].reverse().find((message) => message.info.role === "assistant")
            : undefined
          if (!last) throw new Error("opencode returned no assistant message for the prompt")
          return { data: { info: last.info as AssistantMessage, parts: last.parts } }
        } catch (error) {
          return { error }
        }
      },
      async messages(input, opts) {
        try {
          return { data: await listSessionMessages(client, input.sessionID, opts) }
        } catch (error) {
          return { error }
        }
      },
      async status(_input, opts) {
        try {
          const active = await client.session.active(opts)
          const out: Record<string, SessionStatus> = {}
          for (const sessionID of Object.keys(active)) out[sessionID] = { type: "busy" }
          return { data: out }
        } catch (error) {
          return { error }
        }
      },
      async get(input, opts) {
        try {
          return { data: await client.session.get({ sessionID: input.sessionID }, opts) }
        } catch (error) {
          return { error }
        }
      },
      async delete(input, opts) {
        try {
          await client.session.remove({ sessionID: input.sessionID }, opts)
          return { data: {} }
        } catch (error) {
          return { error }
        }
      },
      async abort(input, opts) {
        try {
          await client.session.interrupt({ sessionID: input.sessionID, resume: false }, opts)
          return { data: {} }
        } catch (error) {
          return { error }
        }
      },
      async command(input, opts) {
        try {
          await client.session.command({ sessionID: input.sessionID, name: input.command, text: input.arguments ?? "" }, opts)
          return { data: {} }
        } catch (error) {
          return { error }
        }
      },
    },
    provider: {
      async list(input, opts) {
        try {
          return { data: await settledProviderCatalog(client, input?.directory, opts) }
        } catch (error) {
          return { error }
        }
      },
    },
    permission: {
      async reply(input, opts) {
        try {
          await client.permission.reply(
            { sessionID: input.sessionID, requestID: input.requestID, decision: input.reply, ...(input.message ? { message: input.message } : {}) },
            opts,
          )
          return { data: {} }
        } catch (error) {
          return { error }
        }
      },
    },
    event: {
      async subscribe(_input, opts) {
        return { stream: client.event.subscribe({ ...(opts?.signal ? { signal: opts.signal } : {}) }) }
      },
    },
    command: {
      async list(input, opts) {
        try {
          const res = await client.command.list({ location: toLocation(input?.directory) }, opts)
          return { data: res.data.map((entry) => ({ name: entry.name })) }
        } catch (error) {
          return { error }
        }
      },
    },
  }
}

/** How long the catalog must stay unchanged before it counts as loaded, and the overall bound. */
const catalogStableMs = 500
const catalogDeadlineMs = 5_000

/**
 * V2 loads a location's provider/model catalog lazily and in stages (built-in
 * providers first, configured ones shortly after), so one early read can be
 * empty or partial. Re-read until two snapshots `catalogStableMs` apart agree,
 * bounded by `catalogDeadlineMs`, then return the last snapshot.
 */
async function settledProviderCatalog(
  client: ReturnType<typeof OpenCode.make>,
  directory: string | undefined,
  opts?: RequestOptions,
): Promise<ProviderListResult> {
  const deadline = Date.now() + catalogDeadlineMs
  let previous: string | undefined
  for (;;) {
    const catalog = await readProviderCatalog(client, directory, opts)
    const signature = JSON.stringify(catalog.all.map((provider) => [provider.id, Object.keys(provider.models).length]))
    if (signature === previous || Date.now() >= deadline) return catalog
    previous = signature
    await new Promise<void>((resolve) => setTimeout(resolve, catalogStableMs))
  }
}

async function readProviderCatalog(
  client: ReturnType<typeof OpenCode.make>,
  directory: string | undefined,
  opts?: RequestOptions,
): Promise<ProviderListResult> {
  const [providers, models] = await Promise.all([
    client.provider.list({ location: toLocation(directory) }, opts),
    client.model.list({ location: toLocation(directory) }, opts),
  ])
  const byProvider = new Map<string, Record<string, Model>>()
  for (const model of models.data) {
    const bucket = byProvider.get(model.providerID) ?? {}
    const variants = (model.variants ?? []).map((variant) => [variant.id, variant.settings ?? {}] as const)
    bucket[model.id] = {
      id: model.id,
      providerID: model.providerID,
      name: model.name ?? model.id,
      ...(model.status ? { status: model.status } : {}),
      ...(model.limit ? { limit: model.limit } : {}),
      ...(variants.length > 0 ? { variants: Object.fromEntries(variants) } : {}),
    }
    byProvider.set(model.providerID, bucket)
  }
  const all: Provider[] = providers.data.map((provider) => ({ id: provider.id, models: byProvider.get(provider.id) ?? {} }))
  const connected = providers.data.filter((provider) => provider.activation !== "disabled").map((provider) => provider.id)
  return { all, connected }
}

/**
 * Admits a prompt under a client-chosen message id and returns it. V2 admits
 * an id once, so when the response is lost the turn is reconciled by that
 * identity instead of being reported as failed, and a caller's retry can never
 * run the same turn twice.
 */
async function admitPrompt(
  client: ReturnType<typeof OpenCode.make>,
  prompt: { sessionID: string; text: string; files?: Parameters<ReturnType<typeof OpenCode.make>["session"]["prompt"]>[0]["files"]; delivery?: "steer" | "queue" },
  opts?: RequestOptions,
): Promise<string> {
  const id = MessageID.create()
  try {
    await client.session.prompt({ ...prompt, id }, opts)
  } catch (error) {
    const admitted = await client.session.message.get({ sessionID: prompt.sessionID, messageID: id }, opts).then(
      () => true,
      () => false,
    )
    if (!admitted) throw error
  }
  return id
}

const turnPollMs = 250

/**
 * Waits until the admitted turn has finished. V2's `wait` returns at once when
 * the turn has not started executing yet, so the turn counts as settled only
 * once history records an `idle` after the admitted message. Bounded by the
 * caller's signal, like every helper prompt.
 */
async function waitForTurn(client: ReturnType<typeof OpenCode.make>, sessionID: string, admittedID: string, opts?: RequestOptions): Promise<void> {
  for (;;) {
    await client.session.wait({ sessionID }, opts)
    const items = await listSessionItems(client, sessionID, opts)
    const admitted = items.findIndex((item) => item.id === admittedID)
    if (admitted !== -1 && items.slice(admitted + 1).some((item) => item.type === "idle")) return
    await pollDelay(opts?.signal)
  }
}

function pollDelay(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, turnPollMs)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Reads a session's full history, following V2's cursor pagination. */
async function listSessionMessages(
  client: ReturnType<typeof OpenCode.make>,
  sessionID: string,
  opts?: RequestOptions,
): Promise<SessionMessage[]> {
  const items = await listSessionItems(client, sessionID, opts)
  return items.filter((item) => item.type === "user" || item.type === "assistant").map((item) => mapMessageInfo(item, sessionID))
}

/** Every history item (messages and markers such as `idle`), oldest first. */
async function listSessionItems(
  client: ReturnType<typeof OpenCode.make>,
  sessionID: string,
  opts?: RequestOptions,
): Promise<V2MessageInfo[]> {
  const out: V2MessageInfo[] = []
  let cursor: string | undefined
  for (;;) {
    // V2 encodes the order/direction inside the opaque cursor; passing `order`
    // alongside a cursor is rejected (InvalidCursorError).
    const input = cursor ? { sessionID, cursor } : { sessionID, order: "asc" as const }
    const page = await client.message.list(input, opts)
    out.push(...(page.data as V2MessageInfo[]))
    const next = page.cursor?.next
    if (!next || next === cursor) break
    cursor = next
  }
  return out
}

type V2MessageInfo = {
  id: string
  type: string
  time: { created: number; completed?: number }
  model?: { id: string; providerID: string; variant?: string }
  agent?: string
  finish?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  error?: unknown
  text?: string
  content?: Array<{ type: string; id?: string; text?: string; name?: string; state?: never }>
}

function mapMessageInfo(info: unknown, sessionID: string): SessionMessage {
  const message = info as V2MessageInfo
  if (message.type === "assistant") {
    const model = message.model ?? { id: "unknown", providerID: "unknown" }
    return {
      info: {
        id: message.id,
        sessionID,
        role: "assistant",
        time: { created: message.time.created, ...(message.time.completed ? { completed: message.time.completed } : {}) },
        ...(message.error ? { error: message.error } : {}),
        ...(message.finish ? { finish: message.finish } : {}),
        modelID: model.id,
        providerID: model.providerID,
        ...(model.variant ? { variant: model.variant } : {}),
        ...(message.agent ? { agent: message.agent } : {}),
        cost: message.cost ?? 0,
        tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: (message.content ?? []).map(mapContentPart),
    }
  }
  return {
    info: { id: message.id, sessionID, role: "user", time: { created: message.time.created } },
    parts: typeof message.text === "string" ? [{ type: "text", text: message.text }] : [],
  }
}

function mapContentPart(content: { type: string; id?: string; text?: string; name?: string; state?: unknown }): Part {
  if (content.type === "reasoning") return { type: "reasoning", text: content.text ?? "" }
  if (content.type === "tool") {
    // V2's tool content `id` is the call id the live tool events carry.
    return {
      type: "tool",
      ...(content.id ? { callID: content.id } : {}),
      tool: content.name ?? "tool",
      state: toolStateToConvoy((content.state ?? { status: "pending" }) as never),
    }
  }
  return { type: "text", text: content.text ?? "" }
}
