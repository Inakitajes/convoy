import type { StepRunnerId } from "./step-runners"
import type { ModelGateway, ModelRoutingOverrides, ResolvedModel } from "./model-routing"

export type RunOptions = {
  prompt: string
  files: string[]
  onlySteps: string[]
  skipSteps: string[]
  resumeRunID: string
  keepRunDir: boolean
  modelOverride: string
  gateway?: ModelGateway
  gatewayExplicit?: boolean
  modelRoutingOverrides?: ModelRoutingOverrides
  /** The immutable, reviewed execution description. Legacy programmatic callers may omit it. */
  plan?: RunPlan
  planOnly?: boolean
  noConfirm?: boolean
  tui: boolean
  humanReview: boolean
  maxAttempts: number
  baseRef: string
  targetDir: string
  includeDirty: boolean
  /** Start with auto-accept enabled: ask-level permissions are allowed without prompting (denylist still applies). */
  yolo: boolean
  /** Start in smart auto-accept: an AI judge allows requests it deems safe and escalates risky ones. */
  smart: boolean
  /** Resolved model for the smart auto-accept judge (--smart-model → config → --model → defaults.model). */
  smartJudgeModel: string
  /** Resolved pipeline for new runs; resumed runs replay the pipeline frozen in their metadata. */
  pipeline: Pipeline
  /** Resolved agent registry (built-ins plus project agents) used to assemble the opencode config. */
  agents: AgentSpec[]
  /** Project additions to the bash policy; deny always wins over allow. */
  permissions: PermissionAdditions
  /** Shell hooks configured globally and/or per pipeline. */
  hooks: HooksConfig
}

export type PermissionAdditions = {
  allow: string[]
  deny: string[]
}

export type HookWhen = "success" | "failure" | "always"

export type HookCwd = "target" | "run"

export type HookSpec = {
  /** Optional display name; defaults to the command text. */
  name?: string
  /** Shell command executed through the user's shell (`$SHELL -lc`). */
  command: string
  /** Post-hooks only: run after successful pipelines, failed pipelines, or both. Defaults to success. */
  when?: HookWhen
  /** When true, a non-zero exit logs a warning but does not fail the run. */
  continueOnError?: boolean
  /** Optional timeout; timed-out hooks are terminated and treated as failures. */
  timeoutSeconds?: number
  /** Working directory for the hook. Defaults to the target repo. */
  cwd?: HookCwd
}

export type HookSet = {
  pre: HookSpec[]
  post: HookSpec[]
}

export type HooksConfig = HookSet & {
  /** Pipeline-specific hooks are appended to top-level hooks for matching pipeline names. */
  pipelines: Record<string, HookSet>
}

/**
 * An agent definition: who can run as a pipeline step. Built-ins ship with
 * convoy; projects add their own (prompt at .convoy/agents/<name>.md) or
 * override built-in model/temperature/readOnly from .convoy/config.yaml.
 */
export type AgentSpec = {
  name: string
  description: string
  /** Explicit model from project config; beats defaults.model. */
  model?: string
  /** Built-in preference (e.g. opus for design); loses to defaults.model. */
  defaultModel?: string
  temperature?: number
  /** When true, Convoy disables write/edit/bash tools for this agent. */
  readOnly?: boolean
  builtIn: boolean
}

/**
 * Which engine executes an agent step. The default (absent) is the OpenCode
 * SDK; "claude-code" spawns the user's local `claude` CLI instead — read-only
 * audit steps only, authenticated by whatever that install already uses
 * (subscription login or API key).
 */
export type StepRunner = Exclude<StepRunnerId, "opencode">

export type AgentStep = {
  type: "agent"
  name: string
  agentName: string
  description: string
  /** Empty string on claude-code steps that defer to the CLI's default model. */
  model: string
  variant?: string
  /** Frozen logical and physical OpenCode model. Absent only on legacy metadata and Claude Code steps. */
  resolvedModel?: ResolvedModel
  /** Absent for OpenCode (the default engine). */
  runner?: StepRunner
  inputFiles: readonly string[]
  inputDiff: boolean
  reportPath: string
  /** True when the underlying agent is configured as read-only, or forced read-only for parallel/multi-model execution. */
  readOnly?: boolean
  /** Per-step override; falls back to --max-attempts when absent. */
  maxAttempts?: number
  /** Shared by every step produced from the same top-level pipeline entry; the runner batches same-groupId steps to run concurrently. */
  groupId: string
  /** Pre-fan-out logical name; equals `name` unless this step was produced by a `models:` fan-out. */
  stepName: string
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

export type RunPlan = {
  prompt: { source: "inline" | "file" | "resume"; text: string }
  target: { directory: string; baseRef: string; worktree: boolean; dirty: boolean }
  pipeline: Pipeline
  modelRouting: { gateway: ModelGateway }
  smartJudge?: { model: ResolvedModel }
  /** Resolved branch-naming model for worktree runs: the AI naming call happens after confirmation with exactly this target. */
  branchNamer?: { model: ResolvedModel }
  hooks: HookSet
  attachments: string[]
  permissions: "interactive" | "smart" | "yolo"
  maxAttempts: number
  resume?: {
    runID: string
    /** Set when an explicit --gateway reroutes pending phases away from the run's frozen gateway. */
    gatewayOverride?: { original: ModelGateway; pending: ModelGateway }
  }
}
