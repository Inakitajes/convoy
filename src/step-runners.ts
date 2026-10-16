import { capabilityAvailable, resolveRunnerCapabilities, type CapabilityInput } from "./runners/capabilities"
import type { CapabilityId, RunnerCapabilities } from "./runners/contracts"

/** Canonical IDs for engines that execute pipeline agent steps. */
export type StepRunnerId = "opencode" | "claude-code"

export const stepRunnerIds: readonly StepRunnerId[] = ["opencode", "claude-code"]

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
  globalModelOverride: boolean
  /**
   * Whether the engine can host an advisor at the step's decision points.
   * Convoy's advisor is consulted through OpenCode's session and permission
   * APIs, so the plan-layer route is OpenCode-only until Claude's advisor
   * bridge is wired end to end (tasks 8.2/8.4). Declaring it here for a runner
   * whose route does not exist would silently drop the configured advisor.
   */
  advisor: boolean
}

export type StepRunnerDefinition = {
  id: StepRunnerId
  displayName: string
  sessionName: string
  capabilities: StepRunnerCapabilities
  modelLabel(model: string, variant?: string): string
}

export interface StepRunnerImpl<Input, Result> extends StepRunnerDefinition {
  executeAttempt(input: Input): Promise<Result>
}

export type StepRunnerModel = {
  providerID: string
  modelID: string
  variant?: string
  label: string
}

export const claudeCodeModelAliases = ["opus", "sonnet", "haiku"] as const

const claudeModelError =
  "runner claude-code executes Anthropic models: use a CLI alias (opus, sonnet, haiku), a claude-* ID, or anthropic/<id>"

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
    // An unqualified --model override keeps OpenCode-only interpretation; a
    // Claude override is runner-qualified (task 8.5, handled in run-plan.ts).
    globalModelOverride: id === "opencode",
    // The advisor route is OpenCode's bridge at the plan layer (see the type).
    advisor: id === "opencode",
  }
}

/** Why a capability is not fully available, formatted for a validation error. Empty when it is available. */
export function stepRunnerCapabilityReason(id: StepRunnerId, capabilityId: CapabilityId, input: CapabilityInput = {}): string {
  const entry = stepRunnerCapabilities(id, input).capabilities.find((candidate) => candidate.id === capabilityId)
  if (!entry || entry.availability === "available") return ""
  return `${entry.availability}: ${entry.reason}`
}

const definitions: Record<StepRunnerId, StepRunnerDefinition> = {
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    sessionName: "opencode",
    capabilities: resolveStepRunnerCapabilities("opencode"),
    modelLabel: (model, variant) => `${model}${variant ? `#${variant}` : ""}`,
  },
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    sessionName: "claude",
    capabilities: resolveStepRunnerCapabilities("claude-code"),
    modelLabel: (model) => `claude-code/${model || "default"}`,
  },
}

export function stepRunnerFor(id?: StepRunnerId): StepRunnerDefinition {
  return definitions[id ?? "opencode"]
}

export function createStepRunnerImpl<Input, Result>(id: StepRunnerId, executeAttempt: (input: Input) => Promise<Result>): StepRunnerImpl<Input, Result> {
  return { ...stepRunnerFor(id), executeAttempt }
}

export function isStepRunnerId(value: unknown): value is StepRunnerId {
  return value === "opencode" || value === "claude-code"
}

export function normalizeStepRunnerModel(id: StepRunnerId, raw: string): string {
  const value = raw.trim()
  if (id === "opencode") {
    parseOpenCodeModel(value)
    return value
  }

  // Claude's CLI selects a model by alias or full ID; a `#variant` is an
  // OpenCode concept and is rejected rather than silently dropped.
  if (value.includes("#")) throw new Error(`${claudeModelError}; Claude models do not take a #variant`)
  const normalized = value.startsWith("anthropic/") ? value.slice("anthropic/".length) : value
  if (claudeCodeModelAliases.includes(normalized as (typeof claudeCodeModelAliases)[number]) || /^claude-[^/#]+(?:-[^/#]+)*$/.test(normalized)) {
    return normalized
  }
  throw new Error(claudeModelError)
}

/**
 * A parsed run-wide model override. An unqualified value keeps OpenCode-only
 * interpretation (design D5): only `<runner>/<model>` scopes it to a runner, so
 * `claude-code/opus` selects a Claude CLI model while `anthropic/claude-opus-5`
 * stays an OpenCode target.
 */
export type ModelOverride = {
  scope?: StepRunnerId
  model: string
}

export function parseModelOverride(raw: string | undefined): ModelOverride {
  const value = raw?.trim() ?? ""
  if (!value) return { model: "" }
  for (const runner of stepRunnerIds) {
    if (value === runner) return { scope: runner, model: "" }
    if (!value.startsWith(`${runner}/`)) continue
    const model = value.slice(runner.length + 1)
    // `opencode` is also a provider: `opencode/<id>` is an OpenCode Zen model,
    // and only `opencode/<provider>/<model>` names the runner scope.
    if (runner === "opencode" && !model.includes("/")) return { model: value }
    return { scope: runner, model }
  }
  return { model: value }
}

/** True when a parsed override names this runner (an unqualified override is OpenCode-only). */
export function modelOverrideTargetsRunner(override: ModelOverride, id: StepRunnerId): boolean {
  if (!override.model) return false
  return override.scope === undefined ? id === "opencode" : override.scope === id
}

export function stepRunnerModel(id: StepRunnerId | undefined, model: string, variant?: string, globalOverride?: string): StepRunnerModel {
  const runner = stepRunnerFor(id)
  const override = parseModelOverride(globalOverride)
  if (modelOverrideTargetsRunner(override, runner.id)) {
    if (runner.id === "claude-code") {
      const normalized = normalizeStepRunnerModel("claude-code", override.model)
      return { providerID: runner.id, modelID: normalized, label: runner.modelLabel(normalized) }
    }
    const selected = parseOpenCodeModel(override.model)
    return { ...selected, label: runner.modelLabel(`${selected.providerID}/${selected.modelID}`, selected.variant) }
  }
  if (runner.id === "claude-code") {
    return { providerID: runner.id, modelID: model || "default", label: runner.modelLabel(model) }
  }
  const selected = parseOpenCodeModel(`${model}${variant ? `#${variant}` : ""}`)
  return { ...selected, label: runner.modelLabel(`${selected.providerID}/${selected.modelID}`, selected.variant) }
}

function parseOpenCodeModel(value: string): { providerID: string; modelID: string; variant?: string } {
  const variantIndex = value.indexOf("#")
  const model = variantIndex === -1 ? value : value.slice(0, variantIndex)
  const variant = variantIndex === -1 ? undefined : value.slice(variantIndex + 1)
  const [providerID, ...rest] = model.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID || (variantIndex !== -1 && !variant)) throw new Error(`model must look like provider/model[#variant], got "${value}"`)
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}
