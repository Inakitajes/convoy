import { log } from "./log"
import { startOpencode } from "./opencode"
import { providerDiscovery, type DiscoveredModel, type DiscoveredProvider } from "./opencode-discovery"

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

/**
 * The models offered in the picker: first the OpenCode SDK (filtered to the
 * user's enabled providers, with variants expanded), falling back to the full
 * models.dev catalog when the SDK can't answer (no auth / offline). Returns []
 * if both fail, since the picker always also accepts free-typed text. Cached
 * per process once a non-empty list is obtained.
 */
export async function listModels(targetDir: string): Promise<ModelChoice[]> {
  if (cached) return cached

  const fromSdk = await safe(() => listModelsFromSdk(targetDir), "opencode SDK")
  if (fromSdk && fromSdk.length > 0) return (cached = fromSdk)

  const fromDev = await safe(() => fetchModelsDev(), "models.dev")
  if (fromDev && fromDev.length > 0) return (cached = fromDev)

  return []
}

async function listModelsFromSdk(targetDir: string): Promise<ModelChoice[]> {
  const handle = await startOpencode({}, AbortSignal.timeout(catalogTimeoutMs))
  try {
    const result = await handle.client.provider.list({ directory: targetDir })
    if (result.error) throw new Error("opencode returned an error listing providers/models")
    const discovery = providerDiscovery(result.data)
    return toModelChoices(discovery.providers, discovery.models)
  } finally {
    handle.close()
  }
}

/**
 * Pure transform from the SDK's provider/model lists to picker choices. Keeps
 * only models whose provider is enabled, preserves the SDK's release-date order,
 * and expands each model into its base entry plus one per variant.
 */
export function toModelChoices(providers: readonly DiscoveredProvider[], models: readonly DiscoveredModel[]): ModelChoice[] {
  const available = new Set(providers.filter((provider) => provider.disabled !== true).map((provider) => provider.id))
  const choices: ModelChoice[] = []
  const seen = new Set<string>()

  const push = (choice: ModelChoice) => {
    if (seen.has(choice.value)) return
    seen.add(choice.value)
    choices.push(choice)
  }

  for (const model of models) {
    if (!available.has(model.providerID)) continue
    const base = `${model.providerID}/${model.id}`
    const status = model.status && model.status !== "active" ? model.status : undefined
    const contextK = model.limit?.context ? Math.round(model.limit.context / 1000) : undefined

    push({ value: base, label: model.name, providerID: model.providerID, ...(status ? { status } : {}), ...(contextK ? { contextK } : {}) })
    for (const variant of model.variants ?? []) {
      push({
        value: `${base}#${variant.id}`,
        label: `${model.name} (${variant.id})`,
        providerID: model.providerID,
        ...(status ? { status } : {}),
        ...(contextK ? { contextK } : {}),
      })
    }
  }
  return choices
}

type ModelsDevModel = { name?: string; limit?: { context?: number } }
type ModelsDevProvider = { models?: Record<string, ModelsDevModel> }

/** Fallback catalog from models.dev. No variants and no enabled-provider filter; the full public list. */
export async function fetchModelsDev(): Promise<ModelChoice[]> {
  const response = await fetch(modelsDevUrl, { signal: AbortSignal.timeout(catalogTimeoutMs) })
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
