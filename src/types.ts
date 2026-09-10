import type { AdvisorAuditPolicy } from "./advisor-events"
import type { LoopGuardSettings } from "./loop-guard"
import type { NotificationSettings } from "./notifications"
import type { OpenSpecBundle } from "./openspec"
import type { PrdHistoryPreview } from "./prd-history"

/**
 * The reviewed feature/contract/context association a feature-backed run
 * freezes into its plan (capability feature-lifecycle, design D4). Pure
 * data — defined here so plans and metadata stay dependency-light.
 */
export type FeaturePlanLink = {
  featureId: string
  repositoryId: string
  /** The association revision the review validated; execution refuses a stale one. */
  associationRevision: number
  contracts: readonly string[]
  /** The intended local base ref the feature recorded. */
  baseRef: string
  /** The verified implementation branch. */
  branch: string
  /** The verified checkout path, when resolved. */
  worktreeDir?: string
}
import type { AutoAccept, ProgressUI } from "./progress"
import type { StepRunnerId } from "./step-runners"
import type { ModelGateway, ModelRoutingOverrides, ResolvedModel } from "./model-routing"

export type RunOptions = {
  prompt: string
  /** Whether this run persists and attaches the project's git-ignored PRD history. */
  prdHistory: boolean
  /** Explicit OpenSpec change ids (`--change <id>`, repeatable), in review order; selection is explicit only. */
  changes?: string[]
  /** The explicit no-change run mode (`--manual`); zero selected changes is valid only through it. */
  manual?: boolean
  files: string[]
  onlySteps: string[]
  skipSteps: string[]
  resumeRunID: string
  keepRunDir: boolean
  modelOverride: string
  /** --advisor: forces this advising model on every advisor-capable step. Empty means "leave config alone". */
  advisorOverride: string
  /** --no-advisor: strips the advisor from every step, whatever config resolved. */
  advisorDisabled: boolean
  /** Content retention for advisor audit events; defaults to hash-only summary. */
  advisorAuditPolicy?: AdvisorAuditPolicy
  gateway?: ModelGateway
  gatewayExplicit?: boolean
  modelRoutingOverrides?: ModelRoutingOverrides
  /** The immutable, reviewed execution description. Legacy programmatic callers may omit it. */
  plan?: RunPlan
  planOnly?: boolean
  noConfirm?: boolean
  tui: boolean
  /** Explicit CLI override for desktop notifications; unset preserves the configured value. */
  notify?: boolean
  /** The merged `notifications:` config block; only the keys the user set. */
  notifications: Partial<NotificationSettings>
  humanReview: boolean
  /** Cap on agents running at once within a concurrent group (`parallel:` block or `models:` fan-out). Groups smaller than this are unaffected. Defaults to `defaultMaxConcurrentAgents` when unset. */
  maxConcurrentAgents?: number
  baseRef: string
  targetDir: string
  /**
   * Run on a fresh branch in its own worktree instead of the current tree. On by
   * default. Consumed before `run()` — the runner only ever sees the resulting
   * `targetDir` — so a resumed run, which continues in its recorded directory,
   * always resolves this to false.
   */
  worktree: boolean
  /** Pins the worktree branch name (`--branch`, or the name confirmed in the launcher) instead of asking the naming model. */
  branch?: string
  includeDirty: boolean
  /** Start with auto-accept enabled: ask-level permissions are allowed without prompting (denylist still applies). */
  yolo: boolean
  /** Start in smart auto-accept: an AI judge allows requests it deems safe and escalates risky ones. */
  smart: boolean
  /** Resolved model for the smart auto-accept judge (--smart-model → config → --model → defaults.model). */
  smartJudgeModel: string
  /**
   * A shared progress UI the caller owns (the goal loop's dashboard). When set,
   * the runner does not create or stop its own UI, does not hold the finish
   * screen, and hands the server/lease cleanup back via `RunResult.release`
   * instead of doing it in the finally.
   */
  progress?: ProgressUI
  /**
   * The shared auto-accept reference to use for the permission gate. When set,
   * the gate uses exactly this object (so a dashboard shift+tab toggle reaches
   * it); otherwise it derives one from `yolo`/`smart`.
   */
  autoAccept?: AutoAccept
  /** Resolved pipeline for new runs; resumed runs replay the pipeline frozen in their metadata. */
  pipeline: Pipeline
  /** Resolved agent registry (built-ins plus project agents) used to assemble the opencode config. */
  agents: AgentSpec[]
  /** Project additions to the bash policy; deny always wins over allow. */
  permissions: PermissionAdditions
  /** Shell hooks configured globally and/or per pipeline. */
  hooks: HooksConfig
  /**
   * Circuit breaker for an OpenCode phase that is repeating itself. Unset keys
   * keep the built-in defaults; `enabled: false` turns the whole guard off.
   */
  loopGuard?: LoopGuardSettings
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
  /**
   * Registry-only: this OpenCode agent has bash under the normal `bashPolicy`
   * (deny stays deny). Set by pipeline resolution when a step asks for
   * `verify: true`, never by the agent catalogue or `agents.<name>` config.
   * Ignored unless `readOnly` is true.
   */
  verify?: boolean
  /** Advising model for steps using this agent; beats defaults.advisor, loses to the step's own. */
  advisor?: string
  builtIn: boolean
}

/**
 * Which engine executes an agent step. The default (absent) is the OpenCode
 * SDK; "claude-code" spawns the user's local `claude` CLI instead — read-only
 * audit steps only, authenticated by whatever that install already uses
 * (subscription login or API key).
 */
export type StepRunner = Exclude<StepRunnerId, "opencode">

/** The report shape a phase must produce before Convoy accepts it as complete. */
export type DeliverableContract =
  | { kind: "none" }
  | { kind: "markdown-report" }
  | {
      kind: "quality-score-report"
      schemaVersion: 1
      /** Automatic retries after a missing or malformed machine-readable score. */
      retryOnMissingOrInvalid: 1
    }

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
  /**
   * Configured advising model (`provider/model[#variant]`) consulted at this
   * step's decision points. Absent means the step runs with no advisor, which
   * is the default: the advisor is opt-in per step.
   */
  advisor?: string
  advisorVariant?: string
  /** Frozen logical and physical advising model, routed through the run's gateway like `resolvedModel`. */
  resolvedAdvisor?: ResolvedModel
  /** Cap on advisor consultations per phase attempt; falls back to the built-in default when absent. */
  advisorMaxCalls?: number
  /** Absent for OpenCode (the default engine). */
  runner?: StepRunner
  inputFiles: readonly string[]
  inputDiff: boolean
  reportPath: string
  /**
   * The report contract resolved for this phase. Optional so run metadata from
   * before contracts were introduced remains readable and executable.
   */
  deliverableContract?: DeliverableContract
  /** True when the underlying agent is configured as read-only, or forced read-only for parallel/multi-model execution. */
  readOnly?: boolean
  /**
   * True when this read-only step may still run bash to verify its claims.
   * Comes from the step spec (`verify: true`), never from the agent catalogue.
   * Never set without `readOnly`. Dropped for `parallel:` / `models:` fan-outs.
   */
  verify?: boolean
  /** Attach the original branch PRD from the project history when available. */
  prdHistory?: boolean
  /** Shared by every step produced from the same top-level pipeline entry; the runner batches same-groupId steps to run concurrently. */
  groupId: string
  /** Pre-fan-out logical name; equals `name` unless this step was produced by a `models:` fan-out. */
  stepName: string
  /**
   * A per-step prompt suffix appended to this phase's instructions and no
   * other. Used by the goal loop to hand the goal-fixer the previous scoring
   * round's gaps without leaking them to the re-scorer (which must stay blind
   * to the previous score to avoid anchoring).
   */
  goalBrief?: string
}

export type HumanStep = {
  type: "human"
  name: string
  description: string
}

export type Step = AgentStep | HumanStep

/**
 * One improve/measure invocation resolved to concrete steps. Fragments are
 * resolved with an empty report namespace: their steps' `reports` selectors
 * and `inputFiles` only ever reference steps earlier in the same fragment.
 */
export type ResolvedPipelineFragment = {
  steps: AgentStep[]
}

/**
 * The frozen goal policy and its two resolved fragments. Produced once by
 * pipeline resolution, routed (models/advisors frozen) with the parent plan,
 * and the sole authority for goal execution — there is no separate goal-fix
 * pipeline and no run-time goal flag that can alter this.
 */
export type ResolvedGoalPlan = {
  target: number
  /** Cap on improvement rounds after iteration-zero measurement. */
  maxIterations: number
  /** Stop when an improvement round raises the score by fewer points than this. */
  plateau: number
  /** The improve step (by resolved name) that alone receives the sanitized score brief. */
  briefRecipient: string
  improve: ResolvedPipelineFragment
  measure: ResolvedPipelineFragment
  /** The measure step (by resolved name) whose deliverable contract is the authoritative machine-readable score. */
  scoreProducer: string
}

export type Pipeline = {
  name: string
  description?: string
  /** Per-pipeline cap on concurrent agents within a group; unset inherits the defaults/CLI chain. */
  maxConcurrentAgents?: number
  /**
   * The pipeline's terminal `goal` step, resolved: the target, stopping policy,
   * and the concrete improve/measure fragments. Absent when the pipeline has
   * no goal step and runs once as an ordinary pipeline.
   */
  goalPlan?: ResolvedGoalPlan
  /**
   * Prompt text used when the pipeline runs without an explicit prompt: the
   * TUI prefills its prompt field with it and the CLI falls back to it. Set on
   * concrete-action pipelines (review, ship, hunter); absent on pipelines where
   * the prompt IS the feature description (implement, fixer, ...).
   */
  defaultPrompt?: string
  /**
   * Alternative prompts the TUI can Tab-cycle through while the prompt field
   * is clean (empty or still holding a default). Empty or absent means no
   * suggestions.
   */
  suggestedPrompts?: string[]
  steps: Step[]
}

export type RunPlan = {
  prompt: { source: "inline" | "file" | "resume" | "retry" | "default"; text: string }
  target: {
    directory: string
    baseRef: string
    worktree: boolean
    dirty: boolean
    /** Worktree runs only: the branch name the user confirmed in the launcher's branch step. */
    branch?: string
    /** Worktree runs only: where that branch will be checked out. */
    worktreeDir?: string
  }
  /**
   * The frozen feature link (capability feature-lifecycle): the stable
   * identity, association revision, contract set, and verified context this
   * run was reviewed against. Execution revalidates it before starting, and
   * durable run metadata preserves it after cleanup (task 4.2/5.1).
   */
  feature?: FeaturePlanLink
  pipeline: Pipeline
  modelRouting: { gateway: ModelGateway }
  smartJudge?: { model: ResolvedModel }
  hooks: HookSet
  attachments: string[]
  /**
   * The frozen OpenSpec contract for this run, resolved before confirmation so
   * the plan preview can name the active change and the runner can attach its
   * spec bundle in place of the oldest historical PRD. Absent when the repo has
   * no `openspec/` (brownfield: exact today's behavior).
   */
  openspec?: OpenSpecBundle
  /**
   * Operator-facing preview of the checkout's historical PRD. Computed before
   * confirmation (never inside `buildRunPlan`) so the launcher and CLI review
   * can say whether scope will attach it. Absent when the caller did not load one.
   */
  prdHistory?: PrdHistoryPreview
  permissions: "interactive" | "smart" | "yolo"
  /**
   * The frozen goal cycle, when the pipeline declares a terminal goal step:
   * target, stopping policy, and the routed improve/measure fragments, frozen
   * with the plan so the operator consents to and preflights the complete
   * loop. Derived only from the pipeline; no run flag can create or alter it.
   */
  goal?: ResolvedGoalPlan
  resume?: {
    runID: string
    /** Set when an explicit --gateway reroutes pending phases away from the run's frozen gateway. */
    gatewayOverride?: { original: ModelGateway; pending: ModelGateway }
  }
}
