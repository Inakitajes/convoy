import { splitModelVariant } from "./pipeline"

export const modelGateways = ["configured", "direct", "openrouter", "nitro", "vercel"] as const
export type ModelGateway = (typeof modelGateways)[number]

/**
 * The suffix older Convoy versions appended to nitro targets. OpenCode
 * resolves model ids against its own catalog before OpenRouter sees the
 * request, so a `:nitro`-suffixed id fails there with "Model not found" —
 * the nitro gateway therefore expresses throughput routing through provider
 * options injected into the run's OpenCode config (see agents.ts) and never
 * produces the suffix. The strip below keeps reading configs and frozen
 * plans written by those older versions.
 */
export const openRouterNitroSuffix = ":nitro"

/** Removes every trailing `:nitro` suffix; otherwise a no-op. */
export function stripOpenRouterNitro(value: string): string {
  while (value.endsWith(openRouterNitroSuffix)) value = value.slice(0, -openRouterNitroSuffix.length)
  return value
}

/**
 * The accepted gateway values joined for human error messages, e.g.
 * `"configured", "direct", "openrouter", "nitro", or "vercel"`. Derived from
 * the union so a sixth gateway cannot drift into a stale handwritten copy.
 */
export function modelGatewayChoices(): string {
  return modelGateways.map((gateway) => `"${gateway}"`).join(", ").replace(/, "([^"]+)"$/, ', or "$1"')
}

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
// OpenRouter dashes some provider names that models.dev spells solid; map both ways so a
// gateway-wrapped model recovers the same logical identity as its direct equivalent.
const directAliases: Record<string, string> = { "z-ai": "zai", "x-ai": "xai" }
const openRouterAliases: Record<string, string> = { zai: "z-ai", xai: "x-ai" }
const safelyRoutableProviders = new Set(["openai", "anthropic", "moonshotai", "zai", "xai", "deepseek"])

export function isModelGateway(value: unknown): value is ModelGateway {
  return typeof value === "string" && modelGateways.includes(value as ModelGateway)
}

const gatewayLabels: Record<ModelGateway, string> = {
  configured: "As configured",
  direct: "Direct",
  openrouter: "OpenRouter",
  nitro: "OpenRouter Nitro",
  vercel: "Vercel AI Gateway",
}

/** Single display label shared by the launcher, review, and errors. */
export function gatewayLabel(gateway: ModelGateway): string {
  return gatewayLabels[gateway]
}

// One-line reason shown beside each gateway wherever a picker lists them.
const gatewayHints: Record<ModelGateway, string> = {
  configured: "preserve pipeline model IDs literally",
  direct: "use the model owner's provider",
  openrouter: "route every model through OpenRouter",
  nitro: "use OpenRouter's highest-throughput providers",
  vercel: "route through Vercel's AI gateway",
}

/** The hint for one gateway in a picker list, next to its label. */
export function gatewayHint(gateway: ModelGateway): string {
  return gatewayHints[gateway]
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
  // `:nitro` is an OpenRouter routing alias, not part of the model's identity:
  // recover the unsuffixed logical model so override keys, vercel/direct
  // conversion, and preflight all keep working on the plain ID.
  return { model: stripOpenRouterNitro(parts.join("/")), ...(parsed.variant ? { variant: parsed.variant } : {}) }
}

function isSafeModelPart(value: string) {
  return value.length > 0 && !/[\s/#\u0000-\u001f\u007f-\u009f]/u.test(value)
}

type RoutableGateway = Exclude<ModelGateway, "configured">

export function resolveModel(configured: string, gateway: ModelGateway, overrides: ModelRoutingOverrides = {}): ResolvedModel {
  const configuredParts = splitModelVariant(configured)
  const recovered = logicalModel(configured)
  const logical = recovered.model
  const logicalVariant = recovered.variant
  let variant = logicalVariant

  let physical: string
  // Exhaustive on the ModelGateway union: no trailing `else` can silently
  // misroute a future gateway (the vercel-else trap the PRD forbids).
  switch (gateway) {
    case "configured":
      // Literal: a configured model may already carry `:nitro`; do not add or strip.
      physical = configuredParts.model
      break
    case "direct":
    case "openrouter":
    case "vercel":
    case "nitro": {
      const entry = overrides[logical]
      const override = entry?.[gateway]
      if (override) {
        const applied = overrideFor(logical, gateway, override, logicalVariant)
        physical = applied.model
        variant ??= applied.variant
      } else if (gateway === "nitro" && entry?.openrouter) {
        // Fall back to the plain openrouter override: throughput routing is
        // provider options injected per run, so nothing is appended to it.
        const applied = overrideFor(logical, "openrouter", entry.openrouter, logicalVariant)
        physical = applied.model
        variant ??= applied.variant
      } else {
        physical = autoWrap(gateway, configured, logical)
      }
      // Legacy nitro overrides and pre-throughput configs spell their targets
      // with a literal `:nitro`, which OpenCode's catalog can never resolve.
      // The nitro gateway strips it wherever it reappears.
      if (gateway === "nitro") physical = stripOpenRouterNitro(physical)
      break
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

/**
 * Applies an override target as-is (exactly like `openrouter:` / `vercel:`
 * today): the physical model is literal, but a variant conflict with the
 * configured logical model is still an error, and an override-only variant is
 * adopted when the configured model names none.
 */
function overrideFor(logical: string, key: string, target: string, logicalVariant?: string): { model: string; variant?: string } {
  const parts = splitModelVariant(target)
  if (parts.variant && logicalVariant && parts.variant !== logicalVariant) {
    throw new Error(`modelRouting override for ${logical}.${key} must not replace variant #${logicalVariant}`)
  }
  return parts
}

/**
 * The no-override physical for a routable gateway. `logical` is already the
 * unsuffixed logical model, so no gateway ever emits `:nitro`: nitro shares
 * openrouter's physical target and differs only in the throughput provider
 * options injected into the run's OpenCode config.
 */
function autoWrap(gateway: RoutableGateway, configured: string, logical: string): string {
  const [provider, ...model] = logical.split("/")
  if (!provider || model.length === 0) throw unsafeConversion(configured, gateway)
  if (!safelyRoutableProviders.has(provider)) throw unsafeConversion(configured, gateway)
  switch (gateway) {
    case "direct":
      return `${provider}/${model.join("/")}`
    case "openrouter":
    case "nitro":
      return `openrouter/${openRouterAliases[provider] ?? provider}/${model.join("/")}`
    case "vercel":
      return `vercel/${provider}/${model.join("/")}`
  }
}

function unsafeConversion(configured: string, gateway: ModelGateway) {
  return new Error(
    `cannot safely route model "${configured}" through ${gateway}; add modelRouting.overrides or select --gateway configured`,
  )
}
