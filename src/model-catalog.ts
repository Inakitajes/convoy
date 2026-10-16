import type { Provider } from "./opencode-client"

import { log } from "./log"
import { startOpencode } from "./opencode"

/** A selectable model for the config TUI's picker. `value` is what gets written to config. */
export type ModelChoice = {
  /** Canonical `provider/model` or `provider/model#variant`. */
  value: string
  /** Human-readable model name (with the variant in parentheses). */
  label: string
  providerID: string
  /** Non-"active" status (alpha/beta/deprecated), surfaced as a hint; undefined when active. */
  status?: string
  /** Context window in thousands of tokens, for the description line. */
  contextK?: number
}

const catalogTimeoutMs = 12_000
const modelsDevUrl = "https://models.dev/api.json"

let cached: ModelChoice[] | undefined

type ModelCatalogDeps = {
  startOpencode?: (
    config: Parameters<typeof startOpencode>[0],
    signal: AbortSignal,
  ) => Promise<{
    client: ProviderLister
    close(): void
  }>
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Pick<Response, "ok" | "status" | "json">>
  /** Overrides the provider warm-up bound (tests). */
  warmupMs?: number
}

/**
 * The models offered in the picker: first the OpenCode SDK (filtered to the
 * user's connected providers, with variants expanded), falling back to the full
 * models.dev catalog when the SDK can't answer (no auth / offline). Returns []
 * if both fail, since the picker always also accepts free-typed text. Cached
 * per process once a non-empty list is obtained.
 */
export async function listModels(targetDir: string, deps?: ModelCatalogDeps): Promise<ModelChoice[]> {
  if (!deps && cached) return cached

  const start = deps?.startOpencode ?? startOpencode
  const fetchCatalog = deps?.fetch ?? fetch

  const fromSdk = await safe(() => listModelsFromSdk(targetDir, start, deps?.warmupMs), "opencode SDK")
  if (fromSdk && fromSdk.length > 0) {
    if (!deps) cached = fromSdk
    return fromSdk
  }

  const fromDev = await safe(() => fetchModelsDevWith(fetchCatalog), "models.dev")
  if (fromDev && fromDev.length > 0) {
    if (!deps) cached = fromDev
    return fromDev
  }

  return []
}

type ProviderLister = {
  provider: {
    list(input: { directory: string }): Promise<{ error?: unknown; data?: { all: Provider[]; connected: string[] } }>
  }
}

/** How long a freshly booted server may take to load its configured providers. */
const catalogWarmupMs = 3_000
const catalogPollMs = 150

/**
 * The picker choices from a running server. A server answers before its
 * provider state has finished loading, so an empty catalog is re-read for a
 * short bounded warm-up instead of being taken as "no providers"; a server
 * that genuinely has none still answers [] once the warm-up elapses.
 */
export async function listServerModels(
  client: ProviderLister,
  directory: string,
  options: { warmupMs?: number; pollMs?: number } = {},
): Promise<ModelChoice[]> {
  const deadline = Date.now() + (options.warmupMs ?? catalogWarmupMs)
  for (;;) {
    const result = await client.provider.list({ directory })
    if (result.error || !result.data) throw new Error("opencode returned an error listing providers/models")
    const choices = toModelChoices(result.data.all, result.data.connected)
    if (choices.length > 0 || Date.now() >= deadline) return choices
    await Bun.sleep(options.pollMs ?? catalogPollMs)
  }
}

async function listModelsFromSdk(targetDir: string, start: NonNullable<ModelCatalogDeps["startOpencode"]>, warmupMs?: number): Promise<ModelChoice[]> {
  const handle = await start({}, AbortSignal.timeout(catalogTimeoutMs))
  try {
    return await listServerModels(handle.client, targetDir, warmupMs !== undefined ? { warmupMs } : {})
  } finally {
    // Await the bounded owned stop before returning: a helper that kept
    // running after its caller resolved is exactly the leak this fixes.
    await handle.close()
  }
}

/**
 * Pure transform from OpenCode's classic provider catalog to picker choices.
 * This is the same catalog consumed by session.prompt, so stored credentials,
 * custom providers, model IDs, and variants match what a run can actually use.
 */
export function toModelChoices(providers: readonly Provider[], connectedProviders: readonly string[]): ModelChoice[] {
  const connected = new Set(connectedProviders)
  const choices: ModelChoice[] = []
  const seen = new Set<string>()

  const push = (choice: ModelChoice) => {
    if (seen.has(choice.value)) return
    seen.add(choice.value)
    choices.push(choice)
  }

  for (const provider of providers) {
    if (!connected.has(provider.id)) continue
    for (const model of Object.values(provider.models)) {
      const base = `${model.providerID}/${model.id}`
      const status = model.status && model.status !== "active" ? model.status : undefined
      const contextK = model.limit?.context ? Math.round(model.limit.context / 1000) : undefined

      push({ value: base, label: model.name, providerID: model.providerID, ...(status ? { status } : {}), ...(contextK ? { contextK } : {}) })
      for (const variant of Object.keys(model.variants ?? {})) {
        push({
          value: `${base}#${variant}`,
          label: `${model.name} (${variant})`,
          providerID: model.providerID,
          ...(status ? { status } : {}),
          ...(contextK ? { contextK } : {}),
        })
      }
    }
  }
  return choices
}

type ModelsDevModel = { name?: string; limit?: { context?: number } }
type ModelsDevProvider = { models?: Record<string, ModelsDevModel> }

/** Fallback catalog from models.dev. No variants and no enabled-provider filter; the full public list. */
export async function fetchModelsDev(): Promise<ModelChoice[]> {
  return fetchModelsDevWith(fetch)
}

async function fetchModelsDevWith(fetchCatalog: NonNullable<ModelCatalogDeps["fetch"]>): Promise<ModelChoice[]> {
  const response = await fetchCatalog(modelsDevUrl, { signal: AbortSignal.timeout(catalogTimeoutMs) })
  if (!response.ok) throw new Error(`models.dev returned ${response.status}`)
  const data = (await response.json()) as Record<string, ModelsDevProvider>
  return parseModelsDev(data)
}

/** Pure transform of the models.dev payload, split out so it can be unit-tested with a fixture. */
export function parseModelsDev(data: Record<string, ModelsDevProvider>): ModelChoice[] {
  const choices: ModelChoice[] = []
  for (const [providerID, provider] of Object.entries(data)) {
    for (const [modelID, model] of Object.entries(provider?.models ?? {})) {
      const contextK = model?.limit?.context ? Math.round(model.limit.context / 1000) : undefined
      choices.push({ value: `${providerID}/${modelID}`, label: model?.name ?? modelID, providerID, ...(contextK ? { contextK } : {}) })
    }
  }
  choices.sort((a, b) => a.value.localeCompare(b.value))
  return choices
}

async function safe(fn: () => Promise<ModelChoice[]>, source: string): Promise<ModelChoice[] | undefined> {
  try {
    return await fn()
  } catch (error) {
    log.warn(`model catalog: ${source} unavailable (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
}
