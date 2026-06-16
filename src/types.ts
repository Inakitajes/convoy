export type RunOptions = {
  prompt: string
  files: string[]
  onlySteps: string[]
  skipSteps: string[]
  resumeRunID: string
  keepRunDir: boolean
  modelOverride: string
  tui: boolean
  humanReview: boolean
  emulatorID: string
  appRunCommand: string
  interactiveModel: string
  interactiveVariant: string
  maxAttempts: number
  baseRef: string
  targetDir: string
  includeDirty: boolean
  /** Start with auto-accept enabled: ask-level permissions are allowed without prompting (denylist still applies). */
  yolo: boolean
  /** Resolved pipeline for new runs; resumed runs replay the pipeline frozen in their metadata. */
  pipeline: Pipeline
  /** Resolved agent registry (built-ins plus project agents) used to assemble the opencode config. */
  agents: AgentSpec[]
  /** Project additions to the bash policy; deny always wins over allow. */
  permissions: PermissionAdditions
}

export type PermissionAdditions = {
  allow: string[]
  deny: string[]
}

/**
 * An agent definition: who can run as a pipeline step. Built-ins ship with
 * archer; projects add their own (prompt at .archer/agents/<name>.md) or
 * config files override built-in model/temperature.
 */
export type AgentSpec = {
  name: string
  description: string
  /** Explicit model from project config; beats defaults.model. */
  model?: string
  /** Built-in preference (e.g. opus for design); loses to defaults.model. */
  defaultModel?: string
  temperature?: number
  builtIn: boolean
}

export type AgentStep = {
  type: "agent"
  name: string
  agentName: string
  description: string
  model: string
  variant?: string
  inputFiles: readonly string[]
  inputDiff: boolean
  reportPath: string
  /** Per-step override; falls back to --max-attempts when absent. */
  maxAttempts?: number
}

export type HumanStep = {
  type: "human"
  name: string
  description: string
}

export type Step = AgentStep | HumanStep

export type Pipeline = {
  name: string
  description?: string
  steps: Step[]
}
