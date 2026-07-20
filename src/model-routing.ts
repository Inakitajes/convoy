import { splitModelVariant } from "./pipeline"

export const modelGateways = ["configured", "direct", "openrouter", "vercel"] as const
export type ModelGateway = (typeof modelGateways)[number]

export type ModelRoutingOverrides = Record<string, Partial<Record<ModelGateway, string>>>

export type ModelRoutingConfig = {
  gateway?: ModelGateway
  overrides: ModelRoutingOverrides
}

export type ResolvedModel = {
  configured: string
  logical: string
  gateway: ModelGateway
  providerID: string
  modelID: string
  variant?: string
  target: string
}

const gatewayProviders = new Set(["openrouter", "vercel"])
const directAliases: Record<string, string> = { "z-ai": "zai" }
const openRouterAliases: Record<string, string> = { zai: "z-ai" }
const safelyRoutableProviders = new Set(["openai", "anthropic", "moonshotai", "zai"])

export function isModelGateway(value: unknown): value is ModelGateway {
  return typeof value === "string" && modelGateways.includes(value as ModelGateway)
}

/** Single display label shared by the launcher, config editor, review, and errors. */
export function gatewayLabel(gateway: ModelGateway): string {
  return gateway === "vercel"
    ? "Vercel AI Gateway"
    : gateway === "openrouter"
      ? "OpenRouter"
      : gateway === "direct"
        ? "Direct"
        : "As configured"
}

/** Recover the provider-owned model identity from a direct or gateway-wrapped OpenCode model. */
export function logicalModel(value: string): { model: string; variant?: string } {
  const parsed = splitModelVariant(value)
  const parts = parsed.model.split("/")
  if (parts.length < 2) throw new Error(`model must look like provider/model[#variant], got "${value}"`)
  if (gatewayProviders.has(parts[0]!)) parts.shift()
  if (parts.length < 2) throw new Error(`gateway model must include its logical provider, got "${value}"`)
  if (parts.some((part) => !isSafeModelPart(part)) || (parsed.variant !== undefined && !isSafeModelPart(parsed.variant))) {
    throw new Error(`model must contain non-empty provider, model, and variant segments without whitespace or control characters, got "${value}"`)
  }
  parts[0] = directAliases[parts[0]!] ?? parts[0]!
  return { model: parts.join("/"), ...(parsed.variant ? { variant: parsed.variant } : {}) }
}

function isSafeModelPart(value: string) {
  return value.length > 0 && !/[\s/#\u0000-\u001f\u007f-\u009f]/u.test(value)
}

export function resolveModel(configured: string, gateway: ModelGateway, overrides: ModelRoutingOverrides = {}): ResolvedModel {
  const configuredParts = splitModelVariant(configured)
  const recovered = logicalModel(configured)
  const logical = recovered.model
  const logicalVariant = recovered.variant
  let variant = logicalVariant

  let physical: string
  if (gateway === "configured") {
    physical = configuredParts.model
  } else {
    const override = overrides[logical]?.[gateway]
    if (override) {
      const overrideParts = splitModelVariant(override)
      if (overrideParts.variant && logicalVariant && overrideParts.variant !== logicalVariant) {
        throw new Error(`modelRouting override for ${logical}.${gateway} must not replace variant #${logicalVariant}`)
      }
      physical = overrideParts.model
      // An override can select a provider-specific default variant when the
      // configured logical model does not name one. A caller-selected variant
      // still wins (and conflicting values above remain an error).
      variant ??= overrideParts.variant
    } else {
      const [provider, ...model] = logical.split("/")
      if (!provider || model.length === 0) throw unsafeConversion(configured, gateway)
      if (!safelyRoutableProviders.has(provider)) throw unsafeConversion(configured, gateway)
      if (gateway === "direct") physical = `${provider}/${model.join("/")}`
      else if (gateway === "openrouter") physical = `openrouter/${openRouterAliases[provider] ?? provider}/${model.join("/")}`
      else physical = `vercel/${provider}/${model.join("/")}`
    }
  }

  const [providerID, ...modelParts] = physical.split("/")
  const modelID = modelParts.join("/")
  if (!providerID || !modelID) throw unsafeConversion(configured, gateway)
  const target = `${physical}${variant ? `#${variant}` : ""}`
  return {
    configured,
    logical: `${logical}${logicalVariant ? `#${logicalVariant}` : ""}`,
    gateway,
    providerID,
    modelID,
    ...(variant ? { variant } : {}),
    target,
  }
}

function unsafeConversion(configured: string, gateway: ModelGateway) {
  return new Error(
    `cannot safely route model "${configured}" through ${gateway}; add modelRouting.overrides or select --gateway configured`,
  )
}
