import { capabilityAvailable, resolveRunnerCapabilities, type CapabilityInput } from "./runners/capabilities"
import type { CapabilityId, RunnerCapabilities } from "./runners/contracts"
import {
  isRegisteredRunnerId,
  normalizeQualifiedModel,
  qualifiedRunnerOf,
  runnerDescriptor,
  runnerIdChoices,
  runnerIds,
  type RegisteredRunnerId,
} from "./runners/descriptors"

/** Canonical IDs for engines that execute pipeline agent steps, from the runner descriptors. */
export type StepRunnerId = RegisteredRunnerId

export const stepRunnerIds: readonly StepRunnerId[] = runnerIds

/** The runner a step without its own (and without a run-wide default) runs on. */
export const defaultStepRunnerId = "opencode" satisfies StepRunnerId

/**
 * The static view of a runner's effective capabilities (design D4).
 *
 * These are *derived*, not brand booleans: each write/verify/fan-out/attach
 * flag is resolved from `resolveRunnerCapabilities` so a runner is excluded
 * only when the resolved runtime genuinely cannot support the behavior, and
 * never merely because of its name. `globalModelOverride` and `advisor` are
 * routing concerns rather than harness capabilities, so they stay explicit
 * below.
 */
export type StepRunnerCapabilities = {
  liveAttach: boolean
  takeover: boolean
  writeSteps: boolean
  /** Whether a read-only step can still be given bash to run tests and checks. */
  verifySteps: boolean
  modelFanout: boolean
  /** Whether an unqualified `--model` override applies (runners whose models are provider-qualified). */
  globalModelOverride: boolean
  /**
   * Whether the engine can host an advisor at the step's decision points
   * (OpenCode through its permission gate and plugin tools, the CLI runners
   * through Convoy's checkpoint and MCP tools). Derived from the runner's
   * `advisor-bridge` capability, so a runner whose bridge is unavailable
   * rejects an advisor instead of silently dropping it.
   */
  advisor: boolean
}

export type StepRunnerDefinition = {
  id: StepRunnerId
  displayName: string
  sessionName: string
  capabilities: StepRunnerCapabilities
  /** True when the runner's model references are runner-qualified (`<runner>/<model>`). */
  qualifiedModels: boolean
  modelLabel(model: string, variant?: string): string
}

export type StepRunnerModel = {
  providerID: string
  modelID: string
  variant?: string
  label: string
}

/** The described capabilities for a runner, resolved from runtime, auth, and enforcement health (design D4). */
export function stepRunnerCapabilities(id: StepRunnerId, input: CapabilityInput = {}): RunnerCapabilities {
  return resolveRunnerCapabilities(id, input)
}

/**
 * The `StepRunnerCapabilities` flags derived from the described capabilities.
 * The booleans are a convenience projection; the described form carries the
 * reason/remediation the config and plan errors quote.
 */
export function resolveStepRunnerCapabilities(id: StepRunnerId, input: CapabilityInput = {}): StepRunnerCapabilities {
  const caps = resolveRunnerCapabilities(id, input)
  return {
    liveAttach: capabilityAvailable(caps, "native-live-attach"),
    takeover: capabilityAvailable(caps, "explicit-handoff"),
    writeSteps: capabilityAvailable(caps, "write"),
    verifySteps: capabilityAvailable(caps, "verify"),
    modelFanout: capabilityAvailable(caps, "model-fanout"),
    // An unqualified --model override keeps provider-qualified interpretation;
    // a runner-qualified one (`codex/<model>`) scopes it to that runner.
    globalModelOverride: !runnerDescriptor(id).models.qualified,
    advisor: capabilityAvailable(caps, "advisor-bridge"),
  }
}

/** Why a capability is not fully available, formatted for a validation error. Empty when it is available. */
export function stepRunnerCapabilityReason(id: StepRunnerId, capabilityId: CapabilityId, input: CapabilityInput = {}): string {
  const entry = stepRunnerCapabilities(id, input).capabilities.find((candidate) => candidate.id === capabilityId)
  if (!entry || entry.availability === "available") return ""
  return `${entry.availability}: ${entry.reason}`
}

function definitionOf(id: StepRunnerId): StepRunnerDefinition {
  const descriptor = runnerDescriptor(id)
  const qualified = descriptor.models.qualified
  return {
    id,
    displayName: descriptor.displayName,
    sessionName: descriptor.sessionName,
    capabilities: resolveStepRunnerCapabilities(id),
    qualifiedModels: qualified,
    modelLabel: qualified
      ? (model, variant) => `${id}/${model || "default"}${variant ? `#${variant}` : ""}`
      : (model, variant) => `${model}${variant ? `#${variant}` : ""}`,
  }
}

const definitions = Object.fromEntries(runnerIds.map((id) => [id, definitionOf(id)])) as Record<StepRunnerId, StepRunnerDefinition>

export function stepRunnerFor(id?: StepRunnerId): StepRunnerDefinition {
  return definitions[id ?? defaultStepRunnerId]
}

export function isStepRunnerId(value: unknown): value is StepRunnerId {
  return isRegisteredRunnerId(value)
}

/** The registered runner IDs, quoted for an error message (`"opencode", "claude-code", or "codex"`). */
export function stepRunnerChoices(): string {
  return runnerIdChoices()
}

/**
 * The model reference a runner executes, in the form the plan stores: a
 * provider-qualified runner keeps `provider/model[#variant]`; a
 * runner-qualified one maps the canonical `provider/model` (or a bare ID or
 * alias) to its native model and keeps a supported `#variant`.
 */
export function normalizeStepRunnerModel(id: StepRunnerId, raw: string): string {
  const value = raw.trim()
  if (!runnerDescriptor(id).models.qualified) {
    parseProviderModel(value)
    return value
  }
  const normalized = normalizeQualifiedModel(id, value)
  if (!normalized.model) throw new Error(`runner ${id} needs a model, got "${value}"`)
  return `${normalized.model}${normalized.variant ? `#${normalized.variant}` : ""}`
}

/**
 * A parsed run-wide model override. An unqualified value keeps
 * provider-qualified interpretation (design D5): only `<runner>/<model>` scopes
 * it to a runner whose models are runner-qualified, so `claude-code/opus`
 * selects a Claude CLI model while `anthropic/claude-opus-5` stays an OpenCode
 * target. `opencode/<provider>/<model>` scopes to OpenCode explicitly, since
 * `opencode/<id>` alone is an OpenCode Zen model.
 */
export type ModelOverride = {
  scope?: StepRunnerId
  model: string
}

export function parseModelOverride(raw: string | undefined): ModelOverride {
  const value = raw?.trim() ?? ""
  if (!value) return { model: "" }
  if (isStepRunnerId(value)) return { scope: value, model: "" }
  const qualified = qualifiedRunnerOf(value)
  if (qualified) return { scope: qualified, model: value.slice(qualified.length + 1) }
  const head = value.split("/", 1)[0]
  if (isStepRunnerId(head)) {
    const model = value.slice(head.length + 1)
    if (model.includes("/")) return { scope: head, model }
  }
  return { model: value }
}

/** True when a parsed override names this runner (an unqualified override reaches provider-qualified runners). */
export function modelOverrideTargetsRunner(override: ModelOverride, id: StepRunnerId): boolean {
  if (!override.model) return false
  return override.scope === undefined ? !runnerDescriptor(id).models.qualified : override.scope === id
}

export function stepRunnerModel(id: StepRunnerId | undefined, model: string, variant?: string, globalOverride?: string): StepRunnerModel {
  const runner = stepRunnerFor(id)
  const override = parseModelOverride(globalOverride)
  if (runner.qualifiedModels) {
    const selected = modelOverrideTargetsRunner(override, runner.id)
      ? normalizeQualifiedModel(runner.id, override.model)
      : { model: model || "", ...(variant ? { variant } : {}) }
    const modelID = selected.model || "default"
    return { providerID: runner.id, modelID, ...(selected.variant ? { variant: selected.variant } : {}), label: runner.modelLabel(selected.model, selected.variant) }
  }
  const configured = modelOverrideTargetsRunner(override, runner.id) ? override.model : `${model}${variant ? `#${variant}` : ""}`
  const selected = parseProviderModel(configured)
  return { ...selected, label: runner.modelLabel(`${selected.providerID}/${selected.modelID}`, selected.variant) }
}

function parseProviderModel(value: string): { providerID: string; modelID: string; variant?: string } {
  const variantIndex = value.indexOf("#")
  const model = variantIndex === -1 ? value : value.slice(0, variantIndex)
  const variant = variantIndex === -1 ? undefined : value.slice(variantIndex + 1)
  const [providerID, ...rest] = model.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID || (variantIndex !== -1 && !variant)) throw new Error(`model must look like provider/model[#variant], got "${value}"`)
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

/**
 * A runner-qualified reference (`claude-code/opus`, `codex/gpt-5.5#high`)
 * split into its runner and native model, or undefined for a
 * provider-qualified one. This is the one spelling the plan uses for a helper,
 * judge or advisor route on a runner-qualified runner.
 */
export function qualifiedModelRoute(reference: string): { runner: StepRunnerId; model: string; variant?: string } | undefined {
  const runner = qualifiedRunnerOf(reference)
  if (!runner) return undefined
  const rest = reference.slice(runner.length + 1)
  const hash = rest.indexOf("#")
  return { runner, model: hash === -1 ? rest : rest.slice(0, hash), ...(hash === -1 ? {} : { variant: rest.slice(hash + 1) }) }
}

/**
 * The runner a reference names explicitly: a runner-qualified one
 * (`codex/gpt-5.5`), or a provider-qualified runner's id before a
 * provider-qualified model (`opencode/openai/gpt-5.5`; `opencode/<id>` alone
 * stays an OpenCode Zen model). Undefined when the reference names none.
 */
export function explicitRunnerOf(reference: string): StepRunnerId | undefined {
  const qualified = qualifiedRunnerOf(reference)
  if (qualified) return qualified
  const head = reference.split("/", 1)[0]
  return isStepRunnerId(head) && reference.slice(head.length + 1).includes("/") ? head : undefined
}

/** The runner a resolved model reference runs on: its qualifying runner, else the provider-qualified default. */
export function runnerOfModelReference(reference: { providerID: string } | string): StepRunnerId {
  const head = typeof reference === "string" ? reference : `${reference.providerID}/`
  return qualifiedRunnerOf(head) ?? defaultStepRunnerId
}
