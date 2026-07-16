/** Canonical IDs for engines that execute pipeline agent steps. */
export type StepRunnerId = "opencode" | "claude-code"

export type StepRunnerCapabilities = {
  liveAttach: boolean
  takeover: boolean
  writeSteps: boolean
  modelFanout: boolean
  globalModelOverride: boolean
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

const definitions: Record<StepRunnerId, StepRunnerDefinition> = {
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    sessionName: "opencode",
    capabilities: {
      liveAttach: true,
      takeover: true,
      writeSteps: true,
      modelFanout: true,
      globalModelOverride: true,
    },
    modelLabel: (model, variant) => `${model}${variant ? `#${variant}` : ""}`,
  },
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    sessionName: "claude",
    capabilities: {
      liveAttach: false,
      takeover: false,
      writeSteps: false,
      modelFanout: false,
      globalModelOverride: false,
    },
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

  const normalized = value.startsWith("anthropic/") ? value.slice("anthropic/".length) : value
  if (claudeCodeModelAliases.includes(normalized as (typeof claudeCodeModelAliases)[number]) || /^claude-[^/#]+(?:-[^/#]+)*$/.test(normalized)) {
    return normalized
  }
  throw new Error(claudeModelError)
}

export function stepRunnerModel(id: StepRunnerId | undefined, model: string, variant?: string, globalOverride?: string): StepRunnerModel {
  const runner = stepRunnerFor(id)
  if (runner.capabilities.globalModelOverride && globalOverride) {
    const selected = parseOpenCodeModel(globalOverride)
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
