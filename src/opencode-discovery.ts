import type { Provider } from "@opencode-ai/sdk/v2"

const minimumOpenCodeVersion = "1.18.4"

export type DiscoveredProvider = { id: string; disabled: boolean }
export type DiscoveredModel = {
  providerID: string
  id: string
  name: string
  status?: string
  limit?: { context?: number }
  variants: { id: string }[]
}

type ProviderDiscoveryPayload = {
  all: Provider[]
  connected: string[]
}

/** Normalizes OpenCode's provider catalog and credential state for Convoy consumers. */
export function providerDiscovery(payload: ProviderDiscoveryPayload | undefined): {
  providers: DiscoveredProvider[]
  models: DiscoveredModel[]
} {
  if (!payload || !Array.isArray(payload.all) || !Array.isArray(payload.connected)) {
    throw new Error(`Cannot read OpenCode providers: OpenCode ${minimumOpenCodeVersion} or newer is required`)
  }

  const connected = new Set(payload.connected)
  return {
    providers: payload.all.map((provider) => ({ id: provider.id, disabled: !connected.has(provider.id) })),
    models: payload.all.flatMap((provider) =>
      Object.entries(provider.models).map(([modelID, model]) => ({
        providerID: provider.id,
        id: modelID,
        name: model.name,
        status: model.status,
        limit: model.limit,
        variants: Object.keys(model.variants ?? {}).map((id) => ({ id })),
      })),
    ),
  }
}
