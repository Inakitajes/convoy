import { normalizeStepRunnerModel, stepRunnerFor } from "./step-runners"
import { defaultGoalMaxIterations, defaultGoalPlateau } from "./quality-score"
import type { AgentSpec, AgentStep, DeliverableContract, HumanStep, Pipeline, ResolvedGoalPlan, ResolvedPipelineFragment, Step, StepRunner } from "./types"

export const defaultGptModel = "openai/gpt-5.6-terra"
export const defaultGptVariant = "xhigh"
export const defaultOpusModel = "anthropic/claude-opus-5"

const fallbackModel = `${defaultGptModel}#${defaultGptVariant}`

/** Lower-case replacement: GLM 5.2 remains the hunter pipeline's cheap track; the audits of `implement` now run on GLM 5.3 high. */
const glmModel = "openrouter/z-ai/glm-5.2"
/** GLM 5.3 with reasoning raised: the audit phases of `implement`, the cheap scorer legs, and the low-cost tracks of `hunter`/`hunter-max`. */
const glm53HighModel = "openrouter/z-ai/glm-5.3#high"
/** Opus reached through OpenRouter, so the hunter fan-outs share one provider across every track. */
const opusViaOpenRouter = "openrouter/anthropic/claude-opus-5"
/** Grok 4.6 high: the default design and adversarial pass, and the second leg of every review/ship fan-out. */
const grokModel = "openrouter/x-ai/grok-4.6#high"
const kimiModel = "openrouter/moonshotai/kimi-k3"
/** DeepSeek V4 Flash 0731 on OpenRouter: the cheap implementer for `implement-lite`, review-lite's report, and ship's goal fixer. */
const deepseekModel = "openrouter/deepseek/deepseek-v4-flash-0731"
/** DeepSeek V4 Flash on OpenRouter with reasoning raised: same model the user's `modelRouting.overrides` maps local NaN to. */
const deepseekHighModel = `${deepseekModel}#high`
/** GPT 5.6 Sol: the advisor `implement` consults, and at xhigh the consensus reporter for the review/ship/hunter pipelines. */
const solModel = "openai/gpt-5.6-sol"
const solXhighModel = `${solModel}#xhigh`
/** GLM 5.3 Flash with reasoning raised: the low-cost code-writer for `implement-lite` and the design/fixer legs of the goal pipelines. */
const glm53FlashHighModel = "openrouter/z-ai/glm-5.3-flash#high"
/** GPT 6 Astra at extra high: the advisor the goal pipelines (full-cycle/astra) and the fixer consult where Grok or Sol used to advise. */
const astraXhighModel = "openai/gpt-6-astra#xhigh"

// Per-step models the built-in `implement` pipeline pins. Exported so `convoy init`'s
// inlined copy of that pipeline stays in sync with the built-in it claims to mirror.
export const defaultImplementerModel = fallbackModel
/** The model `implement`'s implementer consults at its decision points. */
export const defaultImplementAdvisorModel = solXhighModel
export const defaultImplementAuditModel = glm53HighModel
export const defaultImplementReviewModel = grokModel
export const defaultAdversarialModel = grokModel
/** The model the implement pipelines' closing run recap runs on. */
export const defaultRunReportModel = deepseekHighModel

/** The six specialty audit tracks shared by `hunter` and `hunter-max`; each maps to a `hunter-<track>` agent. */
const hunterTracks = ["correctness", "memory", "performance", "security", "reliability", "supply-chain"] as const

/** Legacy reserved step keyword: pauses the pipeline for a manual human gate. */
export const humanReviewStep = "human-review"
export const humanStepType = "human"
const humanReviewDescription = "Manual review checkpoint"
const humanStepDescription = "Human checkpoint"

export const builtInAgents: readonly AgentSpec[] = [
  {
    name: "implementer",
    description: "Implements the feature described in the PRD respecting repo patterns",
    defaultModel: fallbackModel,
    builtIn: true,
  },
  {
    name: "pattern-auditor",
    description: "Audits patterns and best practices, applies refactoring without changing behavior",
    defaultModel: fallbackModel,
    builtIn: true,
  },
  {
    name: "security-auditor",
    description: "Audits the new implementation for security issues and fixes them",
    defaultModel: fallbackModel,
    builtIn: true,
  },
  {
    name: "design-polisher",
    description: "Polishes new UI following the repo's design system, without redesigning",
    defaultModel: grokModel,
    temperature: 0.2,
    builtIn: true,
  },
  {
    name: "test-engineer",
    description: "Ensures automated tests and relevant E2E coverage",
    defaultModel: fallbackModel,
    builtIn: true,
  },
  {
    name: "adversarial-reviewer",
    description: "Final adversarial reviewer before PR creation",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    builtIn: true,
  },
  // Review pipelines: shared audit agents. The triage/fix/validate trio below is
  // no longer wired into a built-in, but stays in the catalogue for the project
  // pipelines that compose an audit-then-apply run of their own.
  {
    name: "review-scope",
    description: "Audit-only collector for branch scope and repository patterns",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    // Pipelines that want this step to run the repo's checks set verify: true
    // on the step (review / review-lite / review-cc), not on this catalogue entry.
    builtIn: true,
  },
  {
    name: "bug-auditor",
    description: "Audit-only reviewer for bugs, regressions, and functional risks",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "clean-code-auditor",
    description: "Audit-only reviewer for pattern alignment and maintainability risks",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "security-reviewer",
    description: "Audit-only reviewer for security, privacy, and operational risks",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "review-adversary",
    description: "Adversarial reviewer that validates and filters audit findings before fixes",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "review-fixer",
    description: "Applies only triaged review fixes without adding new scope",
    defaultModel: fallbackModel,
    temperature: 0.1,
    builtIn: true,
  },
  {
    name: "review-validator",
    description: "Final no-edit validator for applied review fixes",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "review-report",
    description: "Synthesizes parallel audits into one prioritized, report-only findings summary",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  // ship: bring the branch up to date before anything reviews it.
  {
    name: "sync-with-base",
    description:
      "Merges the advanced base branch into the current branch, resolving real and semantic conflicts while preserving both the branch's behaviour and the incoming base changes",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    builtIn: true,
  },
  // Final-review stage over the whole PR: unused by the built-ins, kept for
  // project pipelines that want a triage/fix/validate tail after implementation.
  {
    name: "implementation-triage",
    description: "Synthesizes parallel pattern/security/adversarial findings into one action plan",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "implementation-final-review",
    description: "Final audit-only adversarial review of the whole PR; classifies blocking vs non-blocking findings",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "implementation-fixer",
    description: "Applies only the blocking findings from the final review",
    defaultModel: fallbackModel,
    temperature: 0.1,
    builtIn: true,
  },
  {
    name: "implementation-validator",
    description: "Final no-edit validator for applied blocking-finding fixes",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  // fixer: supplied findings turned into proven regression tests, minimal fixes, and an audited outcome report.
  {
    name: "fixer-test-author",
    description: "Creates or identifies focused regression tests for supplied findings and proves which ones fail before a production fix",
    defaultModel: fallbackModel,
    temperature: 0.1,
    builtIn: true,
  },
  {
    name: "fixer-implementer",
    description: "Applies minimal production fixes only for findings proven by the Fixer reproduction phase",
    defaultModel: fallbackModel,
    temperature: 0.1,
    builtIn: true,
  },
  {
    name: "fixer-validator",
    description: "Independently reruns the proofs, checks for regressions, and reports the final per-finding outcome",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  // hunter / hunter-max: six specialty audit tracks fanned across models, then one consensus report.
  {
    name: "hunter-correctness",
    description: "Finds concrete functional, logic, state-management, and concurrency defects",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "hunter-memory",
    description: "Finds memory leaks, retained state, unbounded growth, and resource lifecycle defects",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "hunter-performance",
    description: "Finds concrete performance, latency, throughput, and scalability defects",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "hunter-security",
    description: "Finds exploitable application-security and privacy vulnerabilities",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "hunter-reliability",
    description: "Finds resilience, partial-failure, recovery, and data-integrity defects",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "hunter-supply-chain",
    description: "Finds dependency, build, CI/CD, infrastructure, and supply-chain security defects",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "hunter-report",
    description: "Validates, deduplicates, attributes, prioritizes, and counts every balanced Hunter finding",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "hunter-max-report",
    description: "Validates, deduplicates, attributes, prioritizes, and counts every five-model Hunter Max finding",
    defaultModel: fallbackModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  // Quality scoring: independent measurement against a fixed rubric, with a
  // separate consensus step that verifies the scorers' claims by running the
  // checks itself (the Gauntlet Loop's "never let the builder grade itself",
  // plus a fresh critic that inspects the real artifact rather than a summary).
  {
    name: "quality-scorer",
    description: "Scores an implementation against the quality rubric: six weighted dimensions, absolute severity, evidence-cited, machine-readable output",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  {
    name: "quality-score-report",
    description: "Consolidates independent quality-scorer reports into one consensus score, verifies the load-bearing claims by running the checks, and emits the authoritative machine-readable score",
    defaultModel: defaultOpusModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
  // Goal loop: the directed-fix agent. Its phase brief carries the previous
  // scoring round's gaps, and its only job is closing exactly those.
  {
    name: "goal-fixer",
    description: "Applies exactly the gaps the previous quality-scorer round reported, without adding new scope",
    defaultModel: fallbackModel,
    temperature: 0.1,
    builtIn: true,
  },
  // The run's table of contents. `implement` ends in six reports and a
  // mechanical SUMMARY.md dump; this agent distills them into the one page a
  // human actually reads first. Read-only and extractive by contract: it may
  // only restate what the phase reports already said, never add findings.
  {
    name: "run-reporter",
    description: "Extractive one-page recap of the run: what each phase reported and what to read next",
    defaultModel: deepseekHighModel,
    temperature: 0.1,
    readOnly: true,
    builtIn: true,
  },
]

/** Short names accepted in pipeline steps for the built-in agents. */
export const agentAliases: Record<string, string> = {
  patterns: "pattern-auditor",
  security: "security-auditor",
  design: "design-polisher",
  tests: "test-engineer",
  adversarial: "adversarial-reviewer",
  "run-report": "run-reporter",
}

/**
 * A pipeline as written in config: a list of steps referencing agents by name
 * (or alias), plus human gate steps. Strings are shorthand for
 * `{ agent: <string> }`, except the legacy `human-review` string which remains
 * a shorthand for a human gate.
 */
export type AgentStepSpec = {
  agent: string
  name?: string
  model?: string
  /** Fans this step out into one concurrent, forced-read-only invocation per model. Mutually exclusive with `model`. */
  models?: string[]
  /** Execution engine. Default is OpenCode; "claude-code" spawns the local `claude` CLI (read-only audit steps only). */
  runner?: "opencode" | StepRunner
  /**
   * Advising model consulted at this step's decision points, or `false` to run
   * without one even when a broader default sets it. Absent inherits the
   * agent's advisor, then defaults.advisor; absent everywhere means no advisor.
   */
  advisor?: string | false
  /** Cap on advisor consultations per phase attempt. */
  advisorMaxCalls?: number
  /** Which previous step reports to attach: the nearest group (default), all of them, none, or an explicit list of step names. */
  reports?: "previous" | "all" | "none" | string[]
  /** Attach the cumulative diff against the base branch. Defaults to true except for the first agent step. */
  diff?: boolean
  /**
   * Give this read-only step bash under the normal `bashPolicy` (deny stays
   * deny) so it can run tests and checks. Ignored unless the agent is
   * read-only, and dropped for `parallel:` / `models:` fan-outs.
   */
  verify?: boolean
  /** Attach the original branch PRD from the project's history when available. */
  prdHistory?: boolean
  /**
   * Overrides the deliverable contract inferred from the agent: the only way
   * an arbitrarily named agent can produce the machine-readable quality score
   * a measure fragment must end in. Validation reads this contract, never the
   * agent or step name.
   */
  deliverable?: "quality-score" | "markdown"
}

/** The improve fragment: a writable directed-fix subflow that names its brief recipient by step name. */
export type GoalImproveSpec = {
  /** Exactly one improve agent step must carry this (explicit or derived) name; it alone receives the score brief. */
  briefStep: string
  steps: StepSpec[]
}

/** The measure fragment: a read-only scoring subflow ending in one quality-score deliverable. */
export type GoalMeasureSpec = {
  steps: StepSpec[]
}

/**
 * The terminal control node that exclusively enables goal execution. Target is
 * required (1–100); maxIterations/plateau default to three. Placement and
 * fragment roles are validated by pipeline resolution, not by agent names.
 */
export type GoalStepSpec = {
  goal: {
    target: number
    maxIterations?: number
    plateau?: number
    improve: GoalImproveSpec
    measure: GoalMeasureSpec
  }
}

export type StepSpec = string | AgentStepSpec | HumanStepSpec | ParallelStepSpec | GoalStepSpec

export function isGoalStepSpec(raw: StepSpec): raw is GoalStepSpec {
  return typeof raw === "object" && raw !== null && !isParallelSpec(raw) && "goal" in raw
}

export type HumanStepSpec = {
  type: typeof humanStepType
  /** Optional step/report name. Defaults to `human`, `human-2`, etc. */
  name?: string
  /** Optional dashboard/report description. */
  description?: string
}

/** A group of steps that run concurrently, forced read-only. No nesting, no human members. */
export type ParallelStepSpec = {
  parallel: (string | AgentStepSpec)[]
}

export type PipelineSpec = {
  description?: string
  /**
   * Cap on agents running at once within a concurrent group (`parallel:` block
   * or `models:` fan-out) for this pipeline only. Beats `defaults.maxConcurrentAgents`;
   * loses to the `--max-concurrent` CLI flag. Unset inherits the defaults chain.
   */
  maxConcurrentAgents?: number
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
  steps: StepSpec[]
}

/** Suffix reserved for convoy's synthesized forced-read-only agent variants; project agents can't use it. */
export const readOnlyAgentSuffix = "__ro"

/** Suffix reserved for a verifying step that shares its agent with a non-verifying use in the same pipeline. */
export const verifyAgentSuffix = "__verify"

/** The pipeline run when none is selected (no -p flag and no defaults.pipeline). */
export const defaultPipelineName = "full-cycle"

export const builtInPipelines: Record<string, PipelineSpec> = {
  // The audits are pinned to GLM 5.3 high rather than left to inherit the run's
  // model: they read a diff that already exists, which is the work GLM does at
  // parity with the expensive models, so the budget belongs in the phase that
  // writes (Terra xhigh, advised) and the one that judges (Grok 4.6 high).
  //
  // The advisor←executor pattern is the default, aimed at the one phase that
  // earns it: Terra xhigh writes the code and consults Sol xhigh at its decision
  // points, pairing the two GPT 5.6 variants that disagree most usefully. Every
  // other phase runs unadvised, so the implementation step is where the second
  // opinion is spent. Measurement deliberately lives in `ship`, not here: this
  // pipeline's job is a first draft worth shaping by hand, and grading a draft
  // you already intend to rework buys nothing.
  implement: {
    description: "Advised implementation on Terra xhigh consulting Sol, then pattern/security audits, design polish, tests, adversarial review, and a one-page run recap",
    steps: [
      { agent: "implementer", model: defaultImplementerModel, advisor: defaultImplementAdvisorModel, reports: "none" },
      // `false` rather than an absent key: absent would inherit a project's
      // defaults.advisor and quietly re-advise these phases.
      { agent: "patterns", model: defaultImplementAuditModel, advisor: false },
      { agent: "security", model: defaultImplementAuditModel, advisor: false },
      { agent: "design", model: defaultImplementReviewModel, advisor: false },
      { agent: "tests", model: defaultImplementAuditModel, advisor: false, reports: "none" },
      { agent: "adversarial", model: defaultAdversarialModel, advisor: false, reports: "all" },
      // The recap is an index, not an audit: read-only, no diff (the diff is
      // what tempts a summarizer into re-reviewing), every report attached, and
      // the cheapest model in the roster — all the substance already exists in
      // the reports it distills.
      { agent: "run-report", model: defaultRunReportModel, advisor: false, reports: "all", diff: false },
    ],
  },
  // implement's shape on low-cost models, advisor included: the second opinion
  // is what makes a cheap implementer worth running, so it is the last thing to
  // drop. DeepSeek V4 Flash (OpenRouter) writes instead of GLM, and Grok advises
  // rather than a second GLM: the cross-vendor disagreement costs no new provider.
  "implement-lite": {
    description:
      "Advised lite: GLM 5.3 Flash implements consulting Grok 4.6; patterns, security and tests audit on DeepSeek V4 Flash advised by GLM 5.3 high. Design stays on Grok 4.6 unadvised and adversarial on GLM 5.3. Closes with an extractive one-page run recap (run-report).",
    steps: [
      { agent: "implementer", model: glm53FlashHighModel, advisor: grokModel, reports: "none" },
      { agent: "patterns", model: deepseekHighModel, advisor: glm53HighModel },
      { agent: "security", model: deepseekHighModel, advisor: glm53HighModel },
      { agent: "design", model: grokModel, advisor: false },
      { agent: "tests", model: deepseekHighModel, advisor: glm53HighModel, reports: "none" },
      { agent: "adversarial", model: glm53HighModel, advisor: false, reports: "all" },
      { agent: "run-report", model: deepseekHighModel, advisor: false, reports: "all", diff: false },
    ],
  },
  // Full Cycle: implement-lite's writing phases (implementer, patterns, security,
  // design, tests), closed by the terminal goal step that owns the whole loop:
  // it measures FIRST (two independent quality-scorers + a verified consensus),
  // and only under 90 does it iterate — the fixer applies exactly the reported
  // gaps, re-scores, and stops at 90, after 3 fix iterations, or on a 3-round
  // score plateau. All scoring lives inside the goal step's measure fragment, so
  // the initial score and every re-score run through the same declared panel.
  "full-cycle": {
    description:
      "Full Cycle: implement-lite's writing phases, then a terminal goal step that measures with two independent quality-scorers and a verified consensus, and drives fix iterations until the score clears 90.",
    steps: [
      { agent: "implementer", model: glm53FlashHighModel, advisor: grokModel, reports: "none" },
      { agent: "patterns", model: deepseekHighModel, advisor: glm53HighModel },
      { agent: "security", model: deepseekHighModel, advisor: glm53HighModel },
      { agent: "design", model: grokModel, advisor: false },
      { agent: "tests", model: deepseekHighModel, advisor: glm53HighModel, reports: "none" },
      {
        goal: {
          target: 90,
          improve: {
            briefStep: "fix",
            steps: [
              // The directed fixer: applies exactly the gaps the previous
              // scoring round reported, which arrive as its per-step brief.
              { agent: "goal-fixer", name: "fix", model: deepseekHighModel, advisor: grokModel, reports: "none", diff: true, prdHistory: true },
            ],
          },
          measure: {
            steps: [
              {
                parallel: [
                  // The re-scorers stay blind to the previous score: no reports
                  // at all (they grade the artifact, not the run's history), but
                  // they still get the original PRD via prdHistory and the
                  // current diff for the rubric's `prd` dimension.
                  { agent: "quality-scorer", name: "score", models: [grokModel, glm53HighModel], reports: "none", diff: true, prdHistory: true },
                ],
              },
              // The consensus sees only the fresh scorer reports, never the
              // fixer's, so its measurement cannot anchor on the number it is
              // reconciling; the original PRD is attached so disagreements on
              // the `prd` dimension can be judged against the requirements.
              { agent: "quality-score-report", name: "score-report", model: glm53HighModel, reports: ["score"], verify: true, diff: true, prdHistory: true },
            ],
          },
        },
      },
    ],
  },
  // Astra: full-cycle's shape, but the advisor is Astra 6 (GPT-6) in extra-high
  // mode wherever full-cycle used Grok 4.6 (implementer and goal fixer), and the
  // design phase joins the advised set on GLM 5.3 Flash. The fixer runs on GLM
  // 5.3 Flash (instead of DeepSeek) advised by Astra 6, with up to 5 fix rounds.
  // Scoring (measure fragment) is unchanged.
  astra: {
    description:
      "Astra: full-cycle's writing phases, then a terminal goal step that measures with two independent quality-scorers and a verified consensus, and drives fix iterations until the score clears 90. Advisor is Astra 6 (extra high) wherever full-cycle used Grok 4.6; design is advised on GLM 5.3 Flash; the fixer runs on GLM 5.3 Flash advised by Astra 6 with up to 5 fix rounds.",
    steps: [
      { agent: "implementer", model: glm53FlashHighModel, advisor: astraXhighModel, reports: "none" },
      { agent: "patterns", model: deepseekHighModel, advisor: glm53HighModel },
      { agent: "security", model: deepseekHighModel, advisor: glm53HighModel },
      { agent: "design", model: glm53FlashHighModel, advisor: astraXhighModel },
      { agent: "tests", model: deepseekHighModel, advisor: glm53HighModel, reports: "none" },
      {
        goal: {
          target: 90,
          maxIterations: 5,
          improve: {
            briefStep: "fix",
            steps: [
              // The directed fixer, on GLM 5.3 Flash advised by Astra 6 (extra
              // high). It alone receives the score brief (by step name). diff:
              // true is load-bearing: as the fragment's first step it would
              // otherwise default to no diff.
              { agent: "goal-fixer", name: "fix", model: glm53FlashHighModel, advisor: astraXhighModel, reports: "none", diff: true, prdHistory: true },
            ],
          },
          measure: {
            steps: [
              {
                parallel: [
                  // The scorers stay blind to any previous round: no reports at
                  // all, but the original PRD via prdHistory and the current
                  // diff for the rubric's `prd` dimension. Kept as-is (Grok 4.6
                  // + GLM 5.3 high).
                  { agent: "quality-scorer", name: "score", models: [grokModel, glm53HighModel], reports: "none", diff: true, prdHistory: true },
                ],
              },
              // The consensus sees only the fresh scorer reports, never the
              // fixer's, so its measurement cannot anchor on the number it is
              // reconciling.
              { agent: "quality-score-report", name: "score-report", model: glm53HighModel, reports: ["score"], verify: true, diff: true, prdHistory: true },
            ],
          },
        },
      },
    ],
  },
  // Report-only review + the measurement layer: after the parallel audits, two
  // independent quality-scorers grade the same diff against the rubric and a
  // consensus step reconciles and verifies. The score block is the deliverable
  // alongside the findings report — a review that ends in a findings list ends
  // in an open-ended question, so every review here also ends in a number.
  review: {
    description:
      "Report-only PR review plus a verified quality score: scope, parallel bug/clean-code/security audits across two models, a prioritized findings report, then two independent quality-scorers and a consensus step. Makes no changes.",
    defaultPrompt: "Review the current branch against its base and report prioritized findings with a verified quality score.",
    suggestedPrompts: ["Review the open PR for this branch", "Review only the last commit's diff"],
    steps: [
      { agent: "review-scope", name: "scope", model: grokModel, reports: "none", diff: true, verify: true, prdHistory: true },
      {
        parallel: [
          { agent: "clean-code-auditor", name: "clean-code", models: [fallbackModel, grokModel], reports: ["scope"] },
          { agent: "security-reviewer", name: "security", models: [fallbackModel, grokModel], reports: ["scope"] },
          { agent: "bug-auditor", name: "bugs", models: [fallbackModel, grokModel], reports: ["scope"] },
        ],
      },
      { agent: "review-report", name: "report", model: grokModel, reports: "all" },
      {
        parallel: [
          { agent: "quality-scorer", name: "score", models: [solXhighModel, grokModel], reports: "all", prdHistory: true },
        ],
      },
      { agent: "quality-score-report", name: "score-report", model: solXhighModel, reports: "all", verify: true, prdHistory: true },
    ],
  },
  // review's shape on low-cost models. The scorer models are pinned rather
  // than left to the agent defaults precisely because those defaults are Opus:
  // omitting them here would quietly reintroduce the cost this pipeline exists
  // to avoid. GLM 5.3 scopes and reconciles the score, DeepSeek V4 Flash 0731
  // writes the report, and the fan-outs pair GLM 5.3 with Grok 4.6.
  "review-lite": {
    description:
      "Report-only PR review on ultra-cheap models: scope, parallel audits (DeepSeek V4 Flash + GLM 5.3 Flash) and report on flash models; the scoring uses GLM 5.3 high + Grok 4.6 high and the score consensus stays on GLM 5.3 high. Makes no changes.",
    defaultPrompt: "Review the current branch against its base and report prioritized findings with a verified quality score.",
    suggestedPrompts: ["Review the open PR for this branch", "Review only the last commit's diff"],
    steps: [
      { agent: "review-scope", name: "scope", model: deepseekHighModel, reports: "none", diff: true, verify: true, prdHistory: true },
      {
        parallel: [
          { agent: "clean-code-auditor", name: "clean-code", models: [deepseekHighModel, glm53FlashHighModel], reports: ["scope"] },
          { agent: "security-reviewer", name: "security", models: [deepseekHighModel, glm53FlashHighModel], reports: ["scope"] },
          { agent: "bug-auditor", name: "bugs", models: [deepseekHighModel, glm53FlashHighModel], reports: ["scope"] },
        ],
      },
      { agent: "review-report", name: "report", model: deepseekHighModel, reports: "all" },
      {
        parallel: [
          { agent: "quality-scorer", name: "score", models: [glm53HighModel, grokModel], reports: "all", prdHistory: true },
        ],
      },
      { agent: "quality-score-report", name: "score-report", model: glm53HighModel, reports: "all", verify: true, prdHistory: true },
    ],
  },
  // The close of the process: the branch is synced with its base, reviewed and
  // fixed, recapped, then driven to the quality bar. Sync lands the advanced
  // base first, so the review and the scorers grade the branch as it will
  // actually merge rather than a diff that no longer describes what lands.
  //
  // The review prefix is report-only (scope, clean-code/security/bugs audits
  // across two cheap models, and a prioritized report), then an adversarial
  // triage validates the findings and a fixer applies only the accepted ones;
  // run-report distills the prefix into the recap the PR body reads. The
  // terminal goal step owns the measurement loop: measure first, and — because
  // the goal is declared here rather than left to the caller — the
  // improve/re-score cycle runs on its own until the score clears 90.
  //
  // The improve/measure fragments are internal to this pipeline: never
  // selectable, and resolved with an empty report namespace so every
  // measurement is independent of the round before it.
  //
  // Every phase runs on OpenRouter models (never a machine-local provider
  // alias like `nan/…`), so the built-in works on any authenticated install.
  //
  // Two things it expects from config rather than shipping itself, because both
  // are machine-local. Conflict resolution needs `git merge*`, `git add*` and
  // `git checkout --ours*|--theirs*` in `permissions.allow` — without them those
  // commands fall through to "ask" rather than failing. And fetching the base
  // beforehand or opening the PR afterwards belongs in `hooks.pipelines.ship`
  // (the post-hook can call `convoy publish` for the run-aware PR text), since
  // Convoy never runs remote git itself.
  ship: {
    description:
      "Sync the branch with its base, review it (clean-code/security/bugs audits plus a prioritized report), adversarially triage and fix the accepted findings, then measure and iterate until it clears 90/100",
    defaultPrompt: "Sync this branch with its base, review and fix it to the quality bar, then open the pull request.",
    suggestedPrompts: ["Review and fix the open PR for this branch", "Review and fix only the last commit's diff"],
    steps: [
      { agent: "sync-with-base", name: "sync", model: deepseekHighModel, reports: "none" },
      // Report-only review prefix: scope the diff, run the three audits across
      // two cheap models each, and synthesize one prioritized findings report.
      { agent: "review-scope", name: "scope", model: deepseekHighModel, reports: "none", diff: true, verify: true, prdHistory: true },
      {
        parallel: [
          { agent: "clean-code-auditor", name: "clean-code", models: [deepseekHighModel, glm53FlashHighModel], reports: ["scope"] },
          { agent: "security-reviewer", name: "security", models: [deepseekHighModel, glm53FlashHighModel], reports: ["scope"] },
          { agent: "bug-auditor", name: "bugs", models: [deepseekHighModel, glm53FlashHighModel], reports: ["scope"] },
        ],
      },
      { agent: "review-report", name: "report", model: deepseekHighModel, reports: "all" },
      // Audit-then-apply: the adversary validates the findings and produces the
      // correction plan; the fixer is the only prefix phase that writes.
      { agent: "review-adversary", name: "triage", model: glm53HighModel, reports: "all", diff: true },
      { agent: "review-fixer", name: "fixes", model: deepseekHighModel, advisor: astraXhighModel, reports: ["triage"], diff: true },
      // The recap the PR body reads; read-only and extractive by contract.
      { agent: "run-report", name: "run-report", model: defaultRunReportModel, advisor: false, reports: "all", diff: false },
      // The terminal goal step owns the measurement loop: measure first and
      // only iterate below target, closing exactly the reported gaps.
      {
        goal: {
          target: 90,
          maxIterations: 5,
          improve: {
            briefStep: "fix",
            steps: [
              // The directed fixer: applies exactly the gaps the previous
              // scoring round reported, which arrive as its per-step brief.
              { agent: "goal-fixer", name: "fix", model: deepseekHighModel, advisor: astraXhighModel, reports: "none", diff: true, prdHistory: true },
            ],
          },
          measure: {
            steps: [
              {
                parallel: [
                  // The re-scorers must stay blind to the previous score: the
                  // fixer's report restates it, so the scorer steps receive no
                  // reports at all (they grade the artifact, not the round's
                  // history). They still get the original PRD via prdHistory
                  // and the current diff: the rubric's `prd` dimension (30% of
                  // the score) cannot be graded without them.
                  { agent: "quality-scorer", name: "score", models: [grokModel, glm53HighModel], reports: "none", diff: true, prdHistory: true },
                ],
              },
              // The consensus sees only the fresh scorer reports, never the
              // fixer's, so its measurement cannot anchor on the number it is
              // reconciling; the original PRD is attached so disagreements on
              // the `prd` dimension can be judged against the actual
              // requirements.
              { agent: "quality-score-report", name: "score-report", model: glm53HighModel, reports: ["score"], verify: true, diff: true, prdHistory: true },
            ],
          },
        },
      },
    ],
  },
  // The follow-up to a report-only run: feed it the findings (as the prompt or an
  // attachment) and every one of them ends with a traceable verdict. The three
  // working phases carry the cost; the reporter only re-reads reports that already
  // exist, so it runs on the cheapest GPT 5.6 rather than the most capable model.
  // The two phases that write get an advisor, because both make a judgement call
  // that is expensive to get wrong and cheap to check: whether a finding is
  // genuinely reproducible, and how small the fix can be. Validation runs
  // unadvised — it reruns the proofs itself, which is a stronger check than a
  // second opinion on the reasoning.
  fixer: {
    description: "Turn supplied findings into proven regression tests, targeted fixes, and an independently rerun final report",
    steps: [
      { agent: "fixer-test-author", name: "reproduction", model: fallbackModel, advisor: astraXhighModel, reports: "none", diff: true },
      { agent: "fixer-implementer", name: "fixes", model: fallbackModel, advisor: astraXhighModel, reports: ["reproduction"] },
      { agent: "fixer-validator", name: "validation", model: fallbackModel, reports: ["reproduction", "fixes"], verify: true },
    ],
  },
  "review-cc": {
    description:
      "Report-only PR review: Terra scope, parallel audits on Terra + Claude Code (subscription), then one prioritized findings report. Makes no changes.",
    defaultPrompt: "Review the current branch against its base and report prioritized findings.",
    suggestedPrompts: ["Review the open PR for this branch", "Review only the last commit's diff"],
    steps: [
      { agent: "review-scope", name: "scope", model: fallbackModel, reports: "none", diff: true, verify: true, prdHistory: true },
      {
        parallel: [
          { agent: "clean-code-auditor", name: "clean-code", model: fallbackModel, reports: ["scope"] },
          { agent: "clean-code-auditor", name: "clean-code-cc", model: "opus", runner: "claude-code", reports: ["scope"] },
          { agent: "security-reviewer", name: "security", model: fallbackModel, reports: ["scope"] },
          { agent: "security-reviewer", name: "security-cc", model: "opus", runner: "claude-code", reports: ["scope"] },
          { agent: "bug-auditor", name: "bugs", model: fallbackModel, reports: ["scope"] },
          { agent: "bug-auditor", name: "bugs-cc", model: "opus", runner: "claude-code", reports: ["scope"] },
        ],
      },
      { agent: "review-report", name: "report", model: solXhighModel, reports: "all" },
    ],
  },
  hunter: {
    description:
      "Balanced report-only audit: Terra plus one specialty model on each of six audit tracks, followed by a Sol xhigh consensus report. Makes no changes.",
    defaultPrompt: "Audit this branch across correctness, memory, performance, security, reliability, and supply-chain tracks.",
    suggestedPrompts: ["Audit the entire repository", "Audit only files changed since the base"],
    steps: [
      {
        parallel: [
          { agent: "hunter-correctness", models: [fallbackModel, glm53HighModel], reports: "none", diff: true },
          { agent: "hunter-memory", models: [fallbackModel, grokModel], reports: "none", diff: true },
          { agent: "hunter-performance", models: [fallbackModel, grokModel], reports: "none", diff: true },
          { agent: "hunter-security", models: [fallbackModel, kimiModel], reports: "none", diff: true },
          { agent: "hunter-reliability", models: [fallbackModel, glmModel], reports: "none", diff: true },
          { agent: "hunter-supply-chain", models: [fallbackModel, glmModel], reports: "none", diff: true },
        ],
      },
      { agent: "hunter-report", model: solXhighModel, reports: "previous", diff: true },
    ],
  },
  "hunter-max": {
    description:
      "Maximum-coverage report-only audit: all five API models on each of six audit tracks, followed by a Sol xhigh consensus report. Makes no changes.",
    defaultPrompt: "Audit this branch across correctness, memory, performance, security, reliability, and supply-chain tracks with maximum coverage.",
    suggestedPrompts: ["Audit the entire repository", "Audit only files changed since the base"],
    steps: [
      { parallel: hunterMaxTracks() },
      { agent: "hunter-max-report", model: solXhighModel, reports: "previous", diff: true },
    ],
  },
}

/** Every hunter-max track runs the same five-model fan-out, so build the six steps instead of repeating the list. */
function hunterMaxTracks(): AgentStepSpec[] {
  return hunterTracks.map((track) => ({
    agent: `hunter-${track}`,
    models: [fallbackModel, opusViaOpenRouter, glm53HighModel, kimiModel, grokModel],
    reports: "none",
    diff: true,
  }))
}

/** Splits the `provider/model#variant` shorthand used everywhere a model is configured. */
export function splitModelVariant(value: string): { model: string; variant?: string } {
  const index = value.indexOf("#")
  if (index === -1) return { model: value }
  const model = value.slice(0, index)
  const variant = value.slice(index + 1)
  if (!model || !variant) throw new Error(`invalid model: ${value}`)
  return { model, variant }
}

export type ResolvePipelineInput = {
  name: string
  spec: PipelineSpec
  agents: readonly AgentSpec[]
  /** Project-wide defaults.model; beats built-in agent preferences, loses to step/agent models. */
  defaultModel?: string
  /** Project-wide defaults.advisor; loses to step/agent advisors. Absent everywhere means no advisor. */
  defaultAdvisor?: string
  /** Project-wide defaults.advisorMaxCalls; loses to the step's own. */
  defaultAdvisorMaxCalls?: number
}

/**
 * Turns a pipeline spec into concrete steps: resolves agent aliases, derives
 * step names and report paths, applies the model precedence chain
 * (step > agent > defaults.model > built-in preference > gpt default) and the
 * parallel advisor chain (step > agent > defaults.advisor, with no built-in
 * fallback so the advisor stays opt-in), and wires each step's inputs
 * (prd + previous reports + diff) by convention.
 *
 * Steps inside the same `parallel:` block, or produced by fanning one step
 * out across `models:`, share a `groupId` and are always forced read-only —
 * the runner batches same-groupId steps to run concurrently, and since none
 * of them can touch the working tree, they can't step on each other. Their
 * `inputFiles` are resolved against the steps that finished before their
 * group started, never against groupmates running concurrently with them.
 */
export function resolvePipeline(input: ResolvePipelineInput): Pipeline {
  const steps: Step[] = []
  const agentSteps: AgentStep[] = []
  const names = new Set<string>()
  let legacyHumanCount = 0
  let genericHumanCount = 0
  const mixedVerify = mixedVerifyAgents(input.spec.steps, input.agents)

  // The terminal goal node: at most one, and only ever the pipeline's final
  // entry. Everything before it is the ordinary prefix.
  const goalIndex = input.spec.steps.findIndex(isGoalStepSpec)
  if (goalIndex !== -1) {
    if (input.spec.steps.some((raw, index) => index !== goalIndex && isGoalStepSpec(raw))) {
      throw new Error(`pipeline "${input.name}" has more than one goal step; a pipeline can carry at most one, and it must be the final step`)
    }
    if (goalIndex !== input.spec.steps.length - 1) {
      throw new Error(`pipeline "${input.name}": step ${goalIndex + 1} is a goal step, but goal steps must be the pipeline's final step (nothing may follow them)`)
    }
  }
  const goalSpec: GoalStepSpec | undefined = goalIndex === -1 ? undefined : (input.spec.steps[goalIndex] as GoalStepSpec)
  const ordinarySteps = goalSpec ? input.spec.steps.filter((_, index) => index !== goalIndex) : input.spec.steps

  const claimAgentName = (name: string, position: string) => {
    if (name === humanReviewStep || name.startsWith(`${humanReviewStep}-`)) {
      throw new Error(`pipeline "${input.name}": step ${position} can't use the reserved name "${name}"`)
    }
    claimStepName(name, position)
  }

  const claimStepName = (name: string, position: string) => {
    if (!isSafeStepName(name)) {
      throw new Error(
        `pipeline "${input.name}": step ${position} name "${name}" must be a filesystem-safe identifier using letters, numbers, hyphens, or underscores`,
      )
    }
    if (names.has(name)) {
      throw new Error(`pipeline "${input.name}": duplicate step name "${name}"; set an explicit name: on one of them`)
    }
    names.add(name)
  }

  for (const [index, raw] of ordinarySteps.entries()) {
    const position = String(index + 1)
    const groupId = `g${index + 1}`

    if (isParallelSpec(raw)) {
      if (raw.parallel.length === 0) {
        throw new Error(`pipeline "${input.name}": step ${position} is an empty parallel block`)
      }
      for (const inner of raw.parallel) {
        if (typeof inner === "object" && inner !== null && "parallel" in inner) {
          throw new Error(`pipeline "${input.name}": step ${position} can't nest a parallel block inside another`)
        }
        if (isGoalStepSpec(inner as StepSpec)) {
          throw new Error(`pipeline "${input.name}": step ${position} can't nest a goal step inside a parallel block`)
        }
      }
      const members = raw.parallel.flatMap((inner, innerIndex) => {
        if (asHumanStepSpec(inner as StepSpec)) {
          throw new Error(`pipeline "${input.name}": step ${position}.${innerIndex + 1} can't use a human step inside a parallel block`)
        }
        return resolveAgentStepSpec(inner, {
          input,
          position: `${position}.${innerIndex + 1}`,
          groupId,
          forcedReadOnly: true,
          priorSteps: agentSteps,
          claimName: claimAgentName,
          mixedVerify,
        })
      })
      steps.push(...members)
      agentSteps.push(...members)
      continue
    }

    const humanSpec = asHumanStepSpec(raw)
    if (humanSpec) {
      const isLegacy = "agent" in humanSpec
      const defaultName = isLegacy ? humanReviewStep : humanStepType
      let name = humanSpec.name
      if (!name) {
        if (isLegacy) legacyHumanCount++
        else genericHumanCount++
        const index = isLegacy ? legacyHumanCount : genericHumanCount
        name = index === 1 ? defaultName : `${defaultName}-${index}`
      }
      claimStepName(name, position)
      const description = humanSpec.description ?? (isLegacy ? humanReviewDescription : humanStepDescription)
      const step: HumanStep = { type: "human", name, description }
      steps.push(step)
      continue
    }

    const spec: AgentStepSpec = typeof raw === "string" ? { agent: raw } : (raw as AgentStepSpec)

    const members = resolveAgentStepSpec(spec, {
      input,
      position,
      groupId,
      forcedReadOnly: Boolean(spec.models && spec.models.length > 0),
      priorSteps: agentSteps,
      claimName: claimAgentName,
      mixedVerify,
    })
    steps.push(...members)
    agentSteps.push(...members)
  }

  if (agentSteps.length === 0) {
    throw new Error(`pipeline "${input.name}" has no agent steps`)
  }

  const goalPlan = goalSpec ? resolveGoalStep(input, goalSpec.goal) : undefined

  return {
    name: input.name,
    ...(input.spec.description ? { description: input.spec.description } : {}),
    ...(input.spec.maxConcurrentAgents !== undefined ? { maxConcurrentAgents: input.spec.maxConcurrentAgents } : {}),
    ...(goalPlan ? { goalPlan } : {}),
    ...(input.spec.defaultPrompt ? { defaultPrompt: input.spec.defaultPrompt } : {}),
    ...(input.spec.suggestedPrompts?.length ? { suggestedPrompts: input.spec.suggestedPrompts } : {}),
    steps,
  }
}

/**
 * Validates and resolves one terminal goal step's policy and its two
 * fragments. Validation uses declared structure and deliverable contracts —
 * never reserved agent or step names — so a custom goal pipeline needs no
 * `goal-fixer`, `score-report`, or `goal-fix` name anywhere.
 */
function resolveGoalStep(input: ResolvePipelineInput, goal: GoalStepSpec["goal"]): ResolvedGoalPlan {
  if (typeof goal.target !== "number" || !Number.isInteger(goal.target) || goal.target < 1 || goal.target > 100) {
    throw new Error(`pipeline "${input.name}": goal.target must be an integer from 1 through 100`)
  }
  const maxIterations = goal.maxIterations ?? defaultGoalMaxIterations
  const plateau = goal.plateau ?? defaultGoalPlateau
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`pipeline "${input.name}": goal.maxIterations must be a positive integer (got ${JSON.stringify(goal.maxIterations)})`)
  }
  if (!Number.isInteger(plateau) || plateau < 1) {
    throw new Error(`pipeline "${input.name}": goal.plateau must be a positive integer (got ${JSON.stringify(goal.plateau)})`)
  }

  const improve = resolveFragment(input, "goal.improve", "improve", goal.improve.steps)
  const measure = resolveFragment(input, "goal.measure", "measure", goal.measure.steps)

  if (improve.length === 0) {
    throw new Error(`pipeline "${input.name}": goal.improve.steps must be a non-empty list`)
  }
  if (measure.length === 0) {
    throw new Error(`pipeline "${input.name}": goal.measure.steps must be a non-empty list`)
  }

  // The brief recipient is resolved by configured step reference: exactly one
  // improve agent step must carry the briefStep name.
  const recipients = improve.filter((step) => step.stepName === goal.improve.briefStep)
  if (recipients.length !== 1) {
    const known = improve.map((step) => step.stepName).join(", ")
    throw new Error(
      recipients.length === 0
        ? `pipeline "${input.name}": goal.improve.briefStep "${goal.improve.briefStep}" does not name an improve step (improve steps: ${known})`
        : `pipeline "${input.name}": goal.improve.briefStep "${goal.improve.briefStep}" matches ${recipients.length} improve steps; exactly one is required`,
    )
  }

  if (!improve.some((step) => !step.readOnly)) {
    throw new Error(`pipeline "${input.name}": goal.improve must contain at least one step able to modify the repository`)
  }

  const writableMeasure = measure.filter((step) => !step.readOnly)
  if (writableMeasure.length > 0) {
    throw new Error(
      `pipeline "${input.name}": goal.measure must be read-only; ${writableMeasure.map((step) => `"${step.name}"`).join(", ")} can modify the repository`,
    )
  }

  // The authoritative score: exactly one machine-readable quality-score
  // deliverable, and it must be the fragment's final step.
  const scoring = measure.filter((step) => step.deliverableContract?.kind === "quality-score-report")
  const finalStep = measure[measure.length - 1]
  if (scoring.length !== 1 || scoring[0] !== finalStep) {
    throw new Error(
      `pipeline "${input.name}": goal.measure must end in exactly one step whose deliverable contract is a machine-readable quality score (found ${scoring.length};${scoring.length === 1 ? " it is not the final step" : " set deliverable: quality-score on the final step"})`,
    )
  }

  return {
    target: goal.target,
    maxIterations,
    plateau,
    briefRecipient: recipients[0]!.name,
    improve: { steps: improve },
    measure: { steps: measure },
    scoreProducer: finalStep.name,
  }
}

/**
 * Resolves one goal fragment: the same step mechanics as a pipeline (aliases,
 * model precedence, fan-outs, parallel groups, advisors) but with a fresh
 * name registry and an empty report namespace, so a fragment's `reports`
 * selectors and inputs only ever reference steps earlier in the same
 * fragment — never prefix, previous rounds, or other invocations.
 */
function resolveFragment(
  input: ResolvePipelineInput,
  label: string,
  groupIdPrefix: string,
  rawSteps: readonly StepSpec[],
): AgentStep[] {
  const fragmentInput: ResolveStepInput = {
    name: input.name,
    agents: input.agents,
    ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
    ...(input.defaultAdvisor !== undefined ? { defaultAdvisor: input.defaultAdvisor } : {}),
    ...(input.defaultAdvisorMaxCalls !== undefined ? { defaultAdvisorMaxCalls: input.defaultAdvisorMaxCalls } : {}),
  }
  const names = new Set<string>()
  const claimName = (name: string, position: string) => {
    if (name === humanReviewStep || name.startsWith(`${humanReviewStep}-`)) {
      throw new Error(`pipeline "${input.name}": ${label} step ${position} can't use the reserved name "${name}"`)
    }
    if (!isSafeStepName(name)) {
      throw new Error(
        `pipeline "${input.name}": ${label} step ${position} name "${name}" must be a filesystem-safe identifier using letters, numbers, hyphens, or underscores`,
      )
    }
    if (names.has(name)) {
      throw new Error(`pipeline "${input.name}": duplicate ${label} step name "${name}"; set an explicit name: on one of them`)
    }
    names.add(name)
  }

  const steps: AgentStep[] = []
  for (const [index, raw] of rawSteps.entries()) {
    const position = `${label}.${index + 1}`
    const groupId = `${groupIdPrefix}-g${index + 1}`

    if (isGoalStepSpec(raw)) {
      throw new Error(`pipeline "${input.name}": ${label} step ${index + 1} can't nest a goal step inside a goal fragment`)
    }
    if (asHumanStepSpec(raw)) {
      throw new Error(`pipeline "${input.name}": ${label} step ${index + 1} can't use a human step inside a goal fragment`)
    }

    if (isParallelSpec(raw)) {
      if (raw.parallel.length === 0) {
        throw new Error(`pipeline "${input.name}": ${label} step ${index + 1} is an empty parallel block`)
      }
      for (const [innerIndex, inner] of raw.parallel.entries()) {
        if (typeof inner === "object" && inner !== null && "parallel" in inner) {
          throw new Error(`pipeline "${input.name}": ${label} step ${index + 1} can't nest a parallel block inside another`)
        }
        if (isGoalStepSpec(inner as StepSpec)) {
          throw new Error(`pipeline "${input.name}": ${label} step ${index + 1} can't nest a goal step inside a parallel block`)
        }
        if (asHumanStepSpec(inner as StepSpec)) {
          throw new Error(`pipeline "${input.name}": ${label} step ${index + 1}.${innerIndex + 1} can't use a human step inside a parallel block`)
        }
      }
      const members = raw.parallel.flatMap((inner, innerIndex) =>
        resolveAgentStepSpec(inner, {
          input: fragmentInput,
          position: `${position}.${innerIndex + 1}`,
          groupId,
          forcedReadOnly: true,
          priorSteps: steps,
          claimName,
          mixedVerify: mixedVerifyAgents(rawSteps, input.agents),
        }),
      )
      steps.push(...members)
      continue
    }

    const spec: AgentStepSpec = typeof raw === "string" ? { agent: raw } : (raw as AgentStepSpec)
    const members = resolveAgentStepSpec(spec, {
      input: fragmentInput,
      position,
      groupId,
      forcedReadOnly: Boolean(spec.models && spec.models.length > 0),
      priorSteps: steps,
      claimName,
      mixedVerify: mixedVerifyAgents(rawSteps, input.agents),
    })
    steps.push(...members)
  }
  return steps
}

export function isParallelSpec(raw: StepSpec): raw is ParallelStepSpec {
  return typeof raw === "object" && raw !== null && "parallel" in raw
}

export function isHumanStepSpec(raw: StepSpec): raw is HumanStepSpec {
  return typeof raw === "object" && raw !== null && "type" in raw && raw.type === humanStepType
}

const safeStepNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function isSafeStepName(name: string): boolean {
  return safeStepNamePattern.test(name)
}

type LegacyHumanStepSpec = { agent: typeof humanReviewStep; name?: string; description?: string }

function asHumanStepSpec(raw: StepSpec): HumanStepSpec | LegacyHumanStepSpec | undefined {
  if (raw === humanReviewStep) return { agent: humanReviewStep }
  if (isHumanStepSpec(raw)) return raw
  if (typeof raw === "object" && raw !== null && !isParallelSpec(raw) && "agent" in raw && raw.agent === humanReviewStep) {
    return {
      agent: humanReviewStep,
      ...(raw.name !== undefined ? { name: raw.name } : {}),
    }
  }
  return undefined
}

type ResolveStepInput = Pick<ResolvePipelineInput, "name" | "agents" | "defaultModel" | "defaultAdvisor" | "defaultAdvisorMaxCalls">

type ResolveStepContext = {
  input: ResolveStepInput
  /** Human-readable position for error messages; may be dotted (e.g. "3.2") inside a parallel block. */
  position: string
  groupId: string
  /** True when every variant of this step must be forced read-only (inside a parallel block, or fanned out across models). */
  forcedReadOnly: boolean
  /** Steps that finished resolving before this step's group started; never includes groupmates. */
  priorSteps: readonly AgentStep[]
  claimName: (name: string, position: string) => void
  /**
   * Agents that this pipeline uses both as a verifying step and as a
   * non-verifying step. Verifying uses of those agents get a `__verify`
   * registry name so bash does not leak into the other use.
   */
  mixedVerify: ReadonlySet<string>
}

/** Resolves one step spec into one or more AgentSteps: more than one only when `models:` fans it out. */
function resolveAgentStepSpec(raw: string | AgentStepSpec, ctx: ResolveStepContext): AgentStep[] {
  const spec = typeof raw === "string" ? { agent: raw } : raw

  if (spec.agent === humanReviewStep) {
    throw new Error(`pipeline "${ctx.input.name}": step ${ctx.position} can't use "human-review" inside a parallel block`)
  }

  const agent = findAgent(spec.agent, ctx.input.agents)
  if (!agent) {
    const known = [...ctx.input.agents.map((candidate) => candidate.name), ...Object.keys(agentAliases), humanReviewStep]
    throw new Error(`pipeline "${ctx.input.name}": step ${ctx.position} references unknown agent "${spec.agent}" (known: ${known.join(", ")})`)
  }

  const baseName = spec.name ?? spec.agent
  if (spec.models !== undefined && spec.model !== undefined) {
    throw new Error(`pipeline "${ctx.input.name}": step ${ctx.position} ("${baseName}") can't set both "model" and "models"`)
  }
  if (spec.models !== undefined && spec.models.length < 2) {
    throw new Error(`pipeline "${ctx.input.name}": step ${ctx.position} ("${baseName}")'s "models" needs at least 2 entries; use "model" for a single one`)
  }

  const models = spec.models
  const forced = ctx.forcedReadOnly || Boolean(models)
  // Bash comes from the step, not the agent catalogue. Forced steps
  // (parallel:/models:) drop it so concurrent runs do not fight over one tree.
  const verify = Boolean(spec.verify && agent.readOnly && !forced)

  const runnerDefinition = stepRunnerFor(spec.runner)
  // "opencode" is accepted for symmetry but resolves to the default (no runner field).
  const runner: StepRunner | undefined = runnerDefinition.id === "claude-code" ? "claude-code" : undefined
  if (!runnerDefinition.capabilities.modelFanout && spec.models !== undefined) {
    throw new Error(
      `pipeline "${ctx.input.name}": step ${ctx.position} ("${baseName}") can't combine runner: ${runnerDefinition.id} with a "models" fan-out; give the step a single model (or none for the CLI default)`,
    )
  }
  if (!runnerDefinition.capabilities.writeSteps && !ctx.forcedReadOnly && !agent.readOnly) {
    throw new Error(
      `pipeline "${ctx.input.name}": step ${ctx.position} ("${baseName}") uses runner: ${runnerDefinition.id}, which currently supports read-only audit steps only — agent "${agent.name}" can modify the repo`,
    )
  }
  if (!runnerDefinition.capabilities.verifySteps && verify) {
    throw new Error(
      `pipeline "${ctx.input.name}": step ${ctx.position} ("${baseName}") uses runner: ${runnerDefinition.id}, which can't run commands — this step has verify: true and needs bash to check its claims`,
    )
  }

  // The advisor chain mirrors the model chain, with two differences: there is no
  // built-in fallback (absent everywhere means no advisor, so cost never changes
  // for a config that doesn't ask for one), and `false` cuts the chain so a step
  // can opt out of a broader default.
  const advisorConfigured = spec.advisor === false ? undefined : (spec.advisor ?? agent.advisor ?? ctx.input.defaultAdvisor)
  // An advisor named ON the step is a hard error against a runner that can't do
  // it; one merely inherited from the agent or defaults is dropped, so a global
  // default stays usable in pipelines that mix runners.
  if (advisorConfigured && !runnerDefinition.capabilities.advisor) {
    if (spec.advisor !== undefined) {
      throw new Error(
        `pipeline "${ctx.input.name}": step ${ctx.position} ("${baseName}") sets an advisor, which runner: ${runnerDefinition.id} does not support; remove it or drop the runner`,
      )
    }
  }
  const advisor = runnerDefinition.capabilities.advisor ? advisorConfigured : undefined
  const advisorMaxCalls = advisor ? (spec.advisorMaxCalls ?? ctx.input.defaultAdvisorMaxCalls) : undefined
  if (spec.advisorMaxCalls !== undefined && !advisor) {
    throw new Error(
      `pipeline "${ctx.input.name}": step ${ctx.position} ("${baseName}") sets advisorMaxCalls without an advisor; add advisor: <model> or remove the cap`,
    )
  }

  // Runners without global override support own their model namespace and use
  // an empty string for their own configured default.
  const variants = runnerDefinition.capabilities.globalModelOverride
    ? (models ?? [spec.model ?? agent.model ?? ctx.input.defaultModel ?? agent.defaultModel ?? fallbackModel])
    : [spec.model ? normalizeStepRunnerModel(runnerDefinition.id, spec.model) : ""]
  // Agent configs are registered per agent name. A verifying step that shares
  // its agent with a non-verifying use in this pipeline needs its own variant
  // so bash does not leak. Forced writable steps still get `__ro`.
  const agentName = verify
    ? ctx.mixedVerify.has(agent.name)
      ? `${agent.name}${verifyAgentSuffix}`
      : agent.name
    : forced && !agent.readOnly
      ? `${agent.name}${readOnlyAgentSuffix}`
      : agent.name

  return variants.map((modelValue, variantIndex) => {
    const name = models ? `${baseName}__${slugifyModel(modelValue)}` : baseName
    ctx.claimName(name, models ? `${ctx.position}[${variantIndex + 1}]` : ctx.position)

    const { model, variant } = runner ? { model: modelValue, variant: undefined } : splitModelVariant(modelValue)
    const advisorParts = advisor ? splitModelVariant(advisor) : undefined
    const step: AgentStep = {
      type: "agent",
      name,
      stepName: baseName,
      groupId: ctx.groupId,
      agentName,
      description: agent.description,
      model,
      ...(variant ? { variant } : {}),
      ...(advisorParts ? { advisor: advisorParts.model } : {}),
      ...(advisorParts?.variant ? { advisorVariant: advisorParts.variant } : {}),
      ...(advisorMaxCalls !== undefined ? { advisorMaxCalls } : {}),
      ...(runner ? { runner } : {}),
      inputFiles: ["prd.md", ...reportInputs(ctx.input.name, name, spec.reports ?? "previous", ctx.priorSteps)],
      inputDiff: spec.diff ?? ctx.priorSteps.length > 0,
      reportPath: `reports/${name}.md`,
      deliverableContract: explicitDeliverableContract(spec, agent.name, Boolean(forced || agent.readOnly)),
      ...(forced || agent.readOnly ? { readOnly: true } : {}),
      ...(verify ? { verify: true } : {}),
      ...(spec.prdHistory ? { prdHistory: true } : {}),
    }
    return step
  })
}

/** The contract a newly resolved quality-score-report step must satisfy. */
export const qualityScoreDeliverableContract: DeliverableContract = {
  kind: "quality-score-report",
  schemaVersion: 1,
  retryOnMissingOrInvalid: 1,
}

/** Infers the report contract from agent identity. Every agent persists a report. */
export function defaultDeliverableContract(agentName: string, _readOnly: boolean): DeliverableContract {
  if (agentName === "quality-score-report") return qualityScoreDeliverableContract
  return { kind: "markdown-report" }
}

/**
 * A step's deliverable contract: the step's explicit `deliverable:` override
 * when set (the only way an arbitrarily named agent can produce the
 * machine-readable score a measure fragment must end in), otherwise the
 * contract inferred from the agent identity.
 */
function explicitDeliverableContract(spec: AgentStepSpec, agentName: string, readOnly: boolean): DeliverableContract {
  if (spec.deliverable === "quality-score") return qualityScoreDeliverableContract
  if (spec.deliverable === "markdown") return { kind: "markdown-report" }
  return defaultDeliverableContract(agentName, readOnly)
}

/**
 * Resolves a phase's report contract, including metadata created before
 * deliverable contracts were persisted in resolved pipelines.
 */
export function deliverableContractForPhase(phase: Pick<AgentStep, "agentName" | "readOnly" | "deliverableContract">): DeliverableContract {
  return phase.deliverableContract ?? defaultDeliverableContract(phase.agentName, Boolean(phase.readOnly))
}

function findAgent(ref: string, agents: readonly AgentSpec[]): AgentSpec | undefined {
  const name = agentAliases[ref] ?? ref
  return agents.find((agent) => agent.name === name)
}

function reportInputs(pipelineName: string, stepName: string, mode: "previous" | "all" | "none" | string[], previous: readonly AgentStep[]): string[] {
  if (mode === "none") return []
  if (mode === "previous") {
    const lastGroupId = previous[previous.length - 1]?.groupId
    if (lastGroupId === undefined) return []
    return previous.filter((step) => step.groupId === lastGroupId).map((step) => step.reportPath)
  }
  if (mode === "all") return previous.map((step) => step.reportPath)

  // A name can match every model variant of a fanned-out step (by its shared
  // stepName) as well as one specific variant (by its full disambiguated name).
  return mode.flatMap((name) => {
    const matches = previous.filter((candidate) => candidate.name === name || candidate.stepName === name)
    if (matches.length === 0) {
      throw new Error(`pipeline "${pipelineName}": step "${stepName}" wants the report of "${name}", which is not an earlier agent step`)
    }
    return matches.map((step) => step.reportPath)
  })
}

/** Turns a `provider/model#variant` string into a filesystem/identifier-safe slug, used to disambiguate a step fanned out across `models:`. */
export function slugifyModel(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

/**
 * Builds the forced-read-only agent variants a resolved pipeline references:
 * steps whose `agentName` was suffixed by `resolvePipeline` because their
 * base agent isn't already read-only. Register these alongside the normal
 * agent registry so the OpenCode server config has a matching entry for each.
 */
export function synthesizeReadOnlyAgents(pipeline: Pipeline, baseAgents: readonly AgentSpec[]): AgentSpec[] {
  const synthesized = new Map<string, AgentSpec>()
  for (const step of [...pipeline.steps, ...goalFragmentSteps(pipeline)]) {
    if (step.type !== "agent" || !step.agentName.endsWith(readOnlyAgentSuffix)) continue
    if (synthesized.has(step.agentName)) continue
    const baseName = step.agentName.slice(0, -readOnlyAgentSuffix.length)
    const base = baseAgents.find((agent) => agent.name === baseName)
    if (!base) {
      throw new Error(`pipeline "${pipeline.name}": step "${step.name}" needs forced-read-only agent "${step.agentName}", but base agent "${baseName}" is not defined`)
    }
    synthesized.set(step.agentName, { ...base, name: step.agentName, readOnly: true, verify: false })
  }
  return [...synthesized.values()]
}

/**
 * Builds the verifying-step agent variants a resolved pipeline references:
 * steps whose `agentName` was suffixed `__verify` because the same agent is
 * also used without bash in this pipeline. The copy is read-only + verify.
 */
export function synthesizeVerifyingAgents(pipeline: Pipeline, baseAgents: readonly AgentSpec[]): AgentSpec[] {
  const synthesized = new Map<string, AgentSpec>()
  for (const step of [...pipeline.steps, ...goalFragmentSteps(pipeline)]) {
    if (step.type !== "agent" || !step.agentName.endsWith(verifyAgentSuffix)) continue
    if (synthesized.has(step.agentName)) continue
    const baseName = step.agentName.slice(0, -verifyAgentSuffix.length)
    const base = baseAgents.find((agent) => agent.name === baseName)
    if (!base) {
      throw new Error(`pipeline "${pipeline.name}": step "${step.name}" needs verifying agent "${step.agentName}", but base agent "${baseName}" is not defined`)
    }
    synthesized.set(step.agentName, { ...base, name: step.agentName, readOnly: true, verify: true })
  }
  return [...synthesized.values()]
}

/**
 * Agent registry for one run: catalogue agents, with `verify` set on any
 * name a verifying step uses as-is, plus the `__ro` / `__verify` variants
 * the resolved pipeline points at.
 */
export function agentsForPipeline(pipeline: Pipeline, baseAgents: readonly AgentSpec[]): AgentSpec[] {
  const verifyingNames = new Set(
    pipeline.steps.filter((step): step is AgentStep => step.type === "agent" && Boolean(step.verify)).map((step) => step.agentName),
  )
  return [
    ...baseAgents.map((agent) => (verifyingNames.has(agent.name) ? { ...agent, verify: true } : agent)),
    ...synthesizeReadOnlyAgents(pipeline, baseAgents),
    ...synthesizeVerifyingAgents(pipeline, baseAgents),
  ]
}

/**
 * Agents this pipeline uses both as a verifying step and as a non-verifying
 * step. The verifying uses need a distinct OpenCode registry name.
 */
function mixedVerifyAgents(steps: readonly StepSpec[], agents: readonly AgentSpec[]): Set<string> {
  const verifying = new Set<string>()
  const nonVerifying = new Set<string>()
  const walk = (list: readonly StepSpec[], forced: boolean) => {
    for (const raw of list) {
      if (isParallelSpec(raw)) {
        walk(raw.parallel, true)
        continue
      }
      if (asHumanStepSpec(raw)) continue
      if (typeof raw === "string") {
        const named = findAgent(raw, agents)
        if (named) nonVerifying.add(named.name)
        continue
      }
      if (!("agent" in raw)) continue
      const spec = raw
      const agent = findAgent(spec.agent, agents)
      if (!agent) continue
      const forcedHere = forced || Boolean(spec.models && spec.models.length > 0)
      if (spec.verify && agent.readOnly && !forcedHere) verifying.add(agent.name)
      else nonVerifying.add(agent.name)
    }
  }
  walk(steps, false)
  return new Set([...verifying].filter((name) => nonVerifying.has(name)))
}

/** Step names valid for --only/--skip in this pipeline: each step's full name plus, for fanned-out steps, their shared logical name. */
export function stepNames(pipeline: Pipeline): string[] {
  return pipeline.steps.map((step) => step.name)
}

/** The concrete steps of a pipeline's goal fragments (improve then measure); empty when the pipeline has no goal step. */
export function goalFragmentSteps(pipeline: Pipeline): AgentStep[] {
  const plan = pipeline.goalPlan
  if (!plan) return []
  return [...plan.improve.steps, ...plan.measure.steps]
}

export function validateStepFilters(pipeline: Pipeline, filters: { onlySteps: string[]; skipSteps: string[] }) {
  const valid = new Set(stepNames(pipeline))
  for (const step of pipeline.steps) {
    if (step.type === "agent") valid.add(step.stepName)
  }
  // Internal goal phases are outside the filter namespace: naming one must
  // fail instead of partially compiling a loop, even when the name would also
  // match a prefix step.
  const goalSteps = goalFragmentSteps(pipeline)
  for (const [flag, names] of [
    ["--only", filters.onlySteps],
    ["--skip", filters.skipSteps],
  ] as const) {
    for (const name of names) {
      const target = goalSteps.find((step) => step.name === name || step.stepName === name)
      if (target) {
        throw new Error(
          `${flag}: "${name}" is a goal ${goalPlanFragmentOf(pipeline, target)} phase and cannot be filtered; goal measurement and improvement are mandatory invariants of pipeline "${pipeline.name}"`,
        )
      }
      if (valid.has(name)) continue
      // Human gates may already be filtered out (--no-human-step/--no-human-review, no TTY);
      // referencing them must not turn into a typo error.
      if (name === humanReviewStep || name.startsWith(`${humanReviewStep}-`)) continue
      throw new Error(`${flag}: unknown step "${name}" in pipeline "${pipeline.name}" (valid: ${[...valid].join(", ")})`)
    }
  }
  // A filter that would prevent mandatory goal measurement: --only must leave
  // the prefix runnable, but the goal cycle itself is never filterable —
  // naming no prefix step while a goal step exists means only goal control was
  // requested, which cannot execute.
  if (pipeline.goalPlan && filters.onlySteps.length > 0 && filters.onlySteps.every((name) => !valid.has(name))) {
    throw new Error(`--only: none of the requested steps belong to pipeline "${pipeline.name}" (valid: ${[...valid].join(", ")})`)
  }
}

/** Which fragment (improve or measure) a goal step belongs to, for filter diagnostics. */
function goalPlanFragmentOf(pipeline: Pipeline, step: AgentStep): string {
  return pipeline.goalPlan?.improve.steps.includes(step) ? "improve" : "measure"
}

/** Whether a pipeline contains any agent step that may edit the repository (a writable, non-read-only step). */
export function hasWritableStep(pipeline: Pipeline): boolean {
  return pipeline.steps.some((step) => step.type === "agent" && !step.readOnly)
}

export function defaultPipeline(): Pipeline {
  return resolvePipeline({ name: defaultPipelineName, spec: builtInPipelines[defaultPipelineName]!, agents: builtInAgents })
}
