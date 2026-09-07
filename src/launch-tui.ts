import { homedir } from "node:os"
import { basename } from "node:path"
import { resolve } from "node:path"
import { existsSync } from "node:fs"

import { BoxRenderable, StyledText, TextRenderable, bg, bold, createCliRenderer, decodePasteBytes, fg, stripAnsiSequences, t } from "@opentui/core"

import { defaultAdvisorMaxCalls } from "./advisor"
import { buildAgentRegistry, emptyHooksConfig, loadMergedConvoyConfig } from "./config"
import { currentBranch, dirtyFilesPreview, mainWorktreeDir, resolveWorktreeDefault, statusPorcelain } from "./git"
import { hooksForPipeline } from "./hooks"
import { openRouterLowBalance, startLimitsPoller } from "./limits"
import { builtInPipelines, defaultPipelineName, hasWritableStep, resolvePipeline } from "./pipeline"
import { stepRunnerFor } from "./step-runners"
import { gatewayHint, gatewayLabel, modelGateways, type ModelGateway } from "./model-routing"
import { consensusStep } from "./quality-score"
import { prdHistoryFile, prdHistoryPreviewCopy, readPrdHistoryIndex, resolvePrdHistoryPreview, type PrdHistoryEntry, type PrdHistoryPreview } from "./prd-history"
import { listOpenSpecChanges, loadOpenSpecBundle, openSpecPromptFor, type OpenSpecChangeSummary } from "./openspec"
import { runReviewLines } from "./review-tui"
import { chunksLength, clipChunks, displayWidth, fmtCountdown, formatMoney, hintsRow, joinLines, moreHintsMarker, padBetween, paletteForTerminal, plain, progressBar, raw, sectionLabel, setTheme, shortPath, spinnerFrame, terminalBackgroundHex, theme, truncate } from "./tui-theme"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { ConvoyConfig } from "./config"
import type { WorktreeDefault } from "./git"
import type { BoxOptions, CliRenderer, KeyEvent, PasteEvent, TextChunk } from "@opentui/core"
import type { LimitsSnapshot } from "./limits"
import type { AgentSpec, AgentStep, HookSet, HookSpec, ResolvedGoalPlan, RunOptions, RunPlan, Step } from "./types"
import type { Hint, PaletteColor } from "./tui-theme"

export type LaunchRunSelection = {
  targetDir: string
  prompt: string
  pipeline: string
  humanReview: boolean
  tui: boolean
  includeDirty: boolean
  keepRunDir: boolean
  yolo: boolean
  smart: boolean
  gateway: ModelGateway
  /** Worktree creation is intentionally deferred until after plan confirmation. */
  isolateWorktree?: boolean
  /** The branch confirmed in the branch step; the worktree is created with exactly this name. */
  branchName?: string
  /** Where that branch will be checked out. */
  worktreeDir?: string
  /** Empty repositories are initialized only after the review is confirmed. */
  initializeGit?: boolean
  /** OpenSpec change id picked in the prompt step; becomes `--change`. */
  change?: string
  /** A feature-scoped handoff: the plan's feature link resolves by this stable identity (work-context, D1/D2). */
  featureId?: string
  /** The feature's recorded intended base; set so base resolution uses the recorded base, not re-detection. */
  baseRef?: string
}

/**
 * A feature-scoped handoff (continue/apply) from the board or specs browser:
 * the pinned change plus the verified implementation context. When `featureId`
 * is present, the plan resolves its feature link by stable identity — never by
 * branch spelling — and freezes the association revision for execution-time
 * revalidation (run-launcher, task 4.4). The launcher loads its resources
 * (config, pipelines, history, specs, dirty state) from `worktreeDir` so a
 * feature checkout's configuration and contracts drive the review.
 */
export type LaunchFeaturePreset = {
  changeID: string
  worktreeDir: string
  branch: string
  featureId?: string
  associationRevision?: number
  contracts?: readonly string[]
  baseRef?: string
}

/** A branch name suggested for the run, plus where it came from so the step can say so. */
export type LaunchBranchProposal = {
  branch: string
  /** "declared" when the PRD already named the branch, "model" when the namer answered, "prompt" when it was derived locally, "fallback" for the timestamp. */
  source: "declared" | "model" | "prompt" | "fallback"
  /** Why the model call didn't produce the name; shown as a hint, never as a blocker. */
  error?: string
  /** The naming model that was asked, for attribution in the UI. */
  model?: string
}

/** Whether a candidate branch name can still be created, and where it would live. */
export type LaunchBranchCheck = {
  /** The name after sanitizing plus any collision suffix; may differ from what was passed in. */
  branch: string
  dir: string
  /** Set when the passed name was already taken and had to be suffixed. */
  suffixed?: boolean
}

export type LaunchNavigationSelection =
  | { action: "runs" }
  | { action: "config" }

export type LaunchRunPreparation = {
  /** The exact options and immutable plan that will be handed to the runner. */
  options: RunOptions
  plan: RunPlan
}

export type LaunchReviewedRun = LaunchRunPreparation & {
  action: "run"
  selection: LaunchRunSelection
}

/**
 * The review as prepared: the frozen preparation plus the fresh dirt reading
 * taken when it was prepared (D2/D6) — the review's warning and the
 * accept-time choice render from this, never from an earlier step's status.
 */
type PreparedReview = LaunchReviewedRun & {
  dirt: DirtReading & { preview: string }
}

export type LaunchRunTuiResult = LaunchReviewedRun | LaunchNavigationSelection | undefined

export type LaunchRunTuiOptions = {
  targetDir: string
  /**
   * A change id handed in pre-selected (the specs viewer's "apply this spec"
   * handoff). Pins that spec row from the start and suppresses the silent
   * auto-detect notice, exactly as if the operator had picked the row.
   */
  presetChange?: string
  /**
   * A feature-row "continue" or identity-carrying "apply" handoff: the change
   * is pinned and the run reuses the feature's existing worktree and branch —
   * no new worktree is created and the branch namer is never invoked (D7).
   */
  presetFeature?: LaunchFeaturePreset
  /** Resolves the run without effects so Review and the runner share one frozen plan. */
  prepareRun(selection: LaunchRunSelection): Promise<LaunchRunPreparation>
  /** Asks the naming model for a branch name. Injected so the launcher stays free of the worktree/opencode modules. */
  proposeBranchName(input: { prompt: string; guidance?: string }): Promise<LaunchBranchProposal>
  /** Sanitizes a candidate and reports where it would live, suffixing it when the name is taken. */
  checkBranchName(name: string): Promise<LaunchBranchCheck>
  /**
   * Reads `git status --porcelain` for the execution tree. Injected so tests
   * script dirt without fixture repos; the default wraps `statusPorcelain`
   * and resolves to "" on failure (the gate reports the real problem at
   * execution time).
   */
  readDirtyStatus?(dir: string): Promise<string>
}

/** Checkout-local history the launcher preloads so the notice can update as toggles change. */
export type LaunchHistoryContext = {
  enabled: boolean
  branch?: string
  entries: readonly PrdHistoryEntry[]
}

// One resolved step, flattened for the preview: `groupId` ties concurrent
// steps together (the runner batches same-groupId steps), and `stepName` is
// the pre-fan-out logical name shared by every `models:` variant. The tree in
// the detail pane reconstructs phases (groups) → agents (stepNames) → models
// from this, so it must survive resolution rather than collapse to a name.
type StepNode = {
  stepName: string
  /** Empty for human gates, which never run concurrently. */
  groupId: string
  kind: "agent" | "human"
  /** Short model label (e.g. "claude-opus-5"); empty for human gates. */
  modelLabel: string
  advisorLabel?: string
}

// One shell hook that would run around the selected pipeline, flattened for
// the preview: global hooks plus the pipeline's own, in execution order.
type HookNode = {
  stage: "pre" | "post"
  /** Display label: the hook's name, falling back to its command text. */
  label: string
  /** Post-hooks only: set when the hook deviates from the "success" default. */
  when?: "failure" | "always"
}

// The goal cycle a scored pipeline will run, flattened for the preview the
// way the review screen summarizes it: the stopping policy plus the improve
// and measure fragments as step trees, so the launcher shows the loop's full
// mutation/cost envelope before the operator ever leaves the pipeline list.
export type GoalPreview = {
  target: number
  maxIterations: number
  plateau: number
  /** The improve step that alone receives the sanitized score brief. */
  briefRecipient: string
  /** The measure step whose deliverable contract is the authoritative machine-readable score. */
  scoreProducer: string
  improve: StepNode[]
  measure: StepNode[]
}

export type PipelineChoice = {
  name: string
  description: string
  source: "built-in" | "configured"
  isDefault: boolean
  steps: StepNode[]
  hooks: HookNode[]
  valid: boolean
  advisedSteps: number
  /** Present when the pipeline declares a valid terminal goal step: the goal cycle the preview and review both summarize. */
  goal?: GoalPreview
  error?: string
  /** Prompt text to prefill when launching this pipeline without a prompt; undefined when the prompt stays mandatory. */
  defaultPrompt?: string
  /** Alternative prompts Tab can cycle through while the prompt field is clean. */
  suggestedPrompts?: string[]
  /** True when a resolved agent step will attach the branch's historical PRD. */
  attachesPrdHistory?: boolean
}

type ToggleKey = "humanReview" | "includeDirty" | "keepRunDir" | "tui" | "worktree"

/**
 * The permission modes the options step's selector cycles through, in its fixed
 * order. The names align with the run plan's `permissions` vocabulary, so the
 * mapping to `LaunchOptions.yolo/smart` (and everything downstream) stays in
 * one place.
 */
export const permissionModes = ["interactive", "yolo", "smart"] as const
export type PermissionMode = (typeof permissionModes)[number]

/** Advances one step along the selector's fixed cycle, wrapping back to Interactive. */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  return permissionModes[(permissionModes.indexOf(mode) + 1) % permissionModes.length]!
}

type ToggleSpec = {
  key: ToggleKey
  label: string
  flag: string
  description: string
}

type Mode = "pipelines" | "prompt" | "options" | "branch" | "review"

/** The two editable fields of the branch step. */
type BranchField = "name" | "guidance"

/**
 * The prompt field's clean/dirty state: whether its text came from a default or
 * suggestion (`fromDefault`), which default/suggestion it is currently showing
 * (`lastDefault`), and where the Tab suggestion cycle stands. Extracted as a
 * plain value so the prefill/swap/cycle decisions are unit-testable without a
 * renderer; `LaunchPicker` applies the returned states to its own fields.
 */
export type PromptFieldState = {
  prompt: string
  fromDefault: boolean
  lastDefault?: string
  suggestionIndex: number
  hasCycledSuggestions: boolean
}

export function emptyPromptField(): PromptFieldState {
  return { prompt: "", fromDefault: false, suggestionIndex: 0, hasCycledSuggestions: false }
}

/** A clean field holding a default or suggestion: still swappable and Tab-cycleable. */
function cleanPromptField(prompt: string): PromptFieldState {
  return { prompt, fromDefault: true, lastDefault: prompt, suggestionIndex: 0, hasCycledSuggestions: false }
}

/**
 * What opening the prompt step does to a clean field: an empty field adopts the
 * pipeline's defaultPrompt; any existing text (typed, or preserved from another
 * pipeline) is left untouched.
 */
export function prefillPromptField(state: PromptFieldState, defaultPrompt: string | undefined): PromptFieldState {
  if (state.prompt === "" && defaultPrompt) return cleanPromptField(defaultPrompt)
  return state
}

/**
 * What the field becomes after switching to a pipeline with the given default.
 * A clean field (empty, or still holding the previous default) adopts the new
 * default — or clears when the new pipeline has none. User-typed text is
 * preserved across the switch.
 */
export function promptAfterPipelineSwitch(state: PromptFieldState, nextDefaultPrompt: string | undefined): PromptFieldState {
  if (state.fromDefault && state.lastDefault !== undefined) {
    if (state.prompt === "" || state.prompt === state.lastDefault) {
      return nextDefaultPrompt ? cleanPromptField(nextDefaultPrompt) : emptyPromptField()
    }
    // The prompt was edited after a default was applied: it is user text now.
    return markPromptEdited(state)
  }
  if (state.prompt === "" && nextDefaultPrompt) return cleanPromptField(nextDefaultPrompt)
  return state
}

/** A user edit marks the field dirty: text is preserved but no longer swappable or cycleable. */
export function markPromptEdited(state: PromptFieldState): PromptFieldState {
  return { ...state, fromDefault: false, lastDefault: undefined, suggestionIndex: 0, hasCycledSuggestions: false }
}

/** Trims the submitted value without making an untouched generated prompt look user-edited. */
export function trimPromptField(state: PromptFieldState): PromptFieldState {
  const prompt = state.prompt.trim()
  return state.fromDefault && state.lastDefault === state.prompt ? { ...state, prompt, lastDefault: prompt } : { ...state, prompt }
}

/**
 * Tab while the field is clean (empty or holding a default/suggestion): the
 * next suggestedPrompt, wrapping around — the first press shows the first
 * suggestion, repeats advance. Returns undefined when Tab does nothing.
 */
export function nextPromptSuggestion(state: PromptFieldState, suggestions: readonly string[] | undefined): PromptFieldState | undefined {
  if (!suggestions || suggestions.length === 0) return undefined
  if (!state.fromDefault && state.prompt !== "") return undefined
  const index = state.hasCycledSuggestions ? (state.suggestionIndex + 1) % suggestions.length : 0
  const prompt = suggestions[index]!
  return { prompt, fromDefault: true, lastDefault: prompt, suggestionIndex: index, hasCycledSuggestions: true }
}

type Modal =
  | { kind: "message"; title: string; message: string; footer?: string }
  | { kind: "loading"; title: string; message: string; footer?: string }
  | { kind: "confirm"; title: string; message: string; footer?: string; onConfirm: () => void }
  | { kind: "gateway"; title: string; index: number }
  | { kind: "dirty"; title: string; message: string; preview?: string; footer?: string }

/** The gateway selector is always the first selectable row of the options step. */
const gatewayOptionIndex = 0

/** What the gateway row's description says: why you would touch it at all. */
const gatewayRowDescription = "Route every model through one provider without changing pipeline YAML."

/** The permission selector is the second selectable row: right after the gateway, before the toggles. */
const permissionOptionIndex = 1

/**
 * What each permission mode's row displays: the state's name, the flag it
 * resolves to (empty for Interactive), and the description line beneath the
 * row. Auto-accept and Smart keep the wording of the toggles they replace.
 */
const permissionModeSpecs: Record<PermissionMode, { name: string; flag: string; description: string }> = {
  interactive: {
    name: "Interactive",
    flag: "",
    description: "Prompt for every ask-level permission request.",
  },
  yolo: {
    name: "Auto-accept",
    flag: "--yolo",
    description: "Allow every ask-level permission request automatically. The hard denylist still applies.",
  },
  smart: {
    name: "Smart auto-accept",
    flag: "--smart",
    description: "An AI judge auto-allows safe ask-level permission requests and escalates risky ones.",
  },
}

const toggles: readonly ToggleSpec[] = [
  {
    key: "humanReview",
    label: "Human gates",
    flag: "--human-step / --no-human-step",
    description: "Keep manual checkpoints in pipelines that define them.",
  },
  {
    key: "includeDirty",
    label: "Include dirty tree",
    flag: "--include-dirty",
    description: "Include existing local changes in the first phase commit.",
  },
  {
    key: "keepRunDir",
    label: "Keep run directory",
    flag: "--keep-run-dir / --no-keep-run-dir",
    description: "Preserve the run workspace under ~/.convoy/runs after the run finishes.",
  },
  {
    key: "tui",
    label: "Progress dashboard",
    flag: "--tui / --no-tui",
    description: "Show the full-screen dashboard while the pipeline is running.",
  },
  {
    key: "worktree",
    label: "Isolate in a worktree",
    flag: "--worktree / --no-worktree",
    description:
      "Create a new branch + git worktree (named from your prompt) and run Convoy there, leaving the current branch untouched. When the run completes, its commits compact automatically into one conventional commit of your own.",
  },
]

/** One launcher read of the execution tree's dirt, interpreted against the run's shape. */
export type DirtReading = {
  /** Number of dirty porcelain entries in the execution tree. */
  files: number
  /** Whether that dirt can affect this run at all: a fresh isolated worktree starts clean, so source dirt is irrelevant. */
  matters: boolean
  /** Whether the run would refuse to start: dirt matters, exists, and was not explicitly included. */
  blocked: boolean
}

/**
 * The single predicate the launcher's dirt surfaces share — options notice,
 * toggle count, review warning, and the accept-time choice all derive from
 * this one function, so none of them can drift from what the post-review
 * `ensureRepoReady` gate would refuse: `matters` mirrors the gate's
 * `allowDirty` (a continue handoff executes inside the feature's own
 * worktree, so its dirt matters; a fresh isolated worktree starts clean), and
 * `blocked` mirrors its refusal rule exactly.
 */
export function dirtReading(
  porcelain: string,
  options: { presetFeature?: { worktreeDir: string } | undefined; worktree: boolean; includeDirty: boolean },
): DirtReading {
  const files = porcelain.split("\n").filter((line) => line.trim() !== "").length
  const matters = options.presetFeature ? true : !options.worktree
  return { files, matters, blocked: matters && files > 0 && !options.includeDirty }
}

/** The injected reader's default: the gate's own git call, resolving to "" when git can't answer. */
export async function defaultDirtyStatus(dir: string): Promise<string> {
  try {
    return await statusPorcelain(dir)
  } catch {
    return ""
  }
}

/** The terminal width at or below which the launcher stacks its two panels. */
export const compactLaunchMaxWidth = 84

/** The resources a launcher session is built from, resolved once per launch (task 1.3). */
export type LauncherResources = {
  config: ConvoyConfig | undefined
  choices: PipelineChoice[]
  worktree: { isolate: boolean; reason: string }
  history: LaunchHistoryContext
  specs: OpenSpecChangeSummary[]
  autoSpecIds: string[]
  insideWorktree?: InsideWorktree
}

/**
 * Resolves the launcher's resources before the picker opens (capability
 * run-launcher, task 1.3): work-scoped preparation loads configuration,
 * pipeline choices, prompt history, specs, and the auto-attach contract list
 * from the execution checkout — the feature worktree for a feature handoff,
 * the launch checkout otherwise — so review reflects the checkout the run
 * will execute in. The nested-isolation probe still watches the launcher's
 * own checkout, which is a property of where Convoy runs, not of the handoff.
 */
export async function loadLauncherResources(options: LaunchRunTuiOptions): Promise<LauncherResources> {
  const resourceDir = options.presetFeature?.worktreeDir ?? options.targetDir
  const config = await loadMergedConvoyConfig(resourceDir)
  const choices = pipelineChoices(config, buildAgentRegistry(config))

  // Unset config means "decide per branch": isolating is right on a trunk, but
  // on a branch you're already where the work should land.
  const worktree =
    config?.defaults.worktree === undefined
      ? await resolveWorktreeDefault(options.targetDir)
      : { isolate: config.defaults.worktree, reason: "set by defaults.worktree" }
  const history = await loadLaunchHistory(resourceDir, config?.defaults.prdHistory ?? true)
  const specs = await listOpenSpecChanges(resourceDir)
  // The change the run would attach without being asked: same selection order
  // the frozen plan applies (single change, branch match), minus the
  // diff-composed rule that needs the run's base ref. That is exactly the
  // information the notice owes the operator — which contract is about to
  // attach silently — while nothing here is authoritative: `--change` (a pick)
  // and the real resolution at launch both re-resolve against the full inputs.
  const autoSpecIds =
    specs.length > 0
      ? await loadOpenSpecBundle({ targetDir: resourceDir, branch: history.branch })
          .then((bundle) => (bundle ? [...bundle.changeIds] : []))
          .catch(() => [] as string[])
      : []
  const insideWorktree = await detectInsideWorktree(options.targetDir)
  return { config, choices, worktree, history, specs, autoSpecIds, ...(insideWorktree ? { insideWorktree } : {}) }
}

export async function launchRunTui(options: LaunchRunTuiOptions, route?: TuiRoute): Promise<LaunchRunTuiResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("convoy needs an interactive terminal to open the launcher")
  }

  const { config, choices, worktree, history, specs, autoSpecIds, insideWorktree } = await loadLauncherResources(options)

  if (route) {
    const scene = sceneForRoute(route, "convoy-launch-scene")!
    return new LaunchPicker(route.session.renderer, options.targetDir, choices, config?.modelRouting?.gateway ?? "configured", worktree, options, history, specs, autoSpecIds, options.presetChange, options.presetFeature, insideWorktree, scene).result
  }

  // No backgroundColor yet: the palette is only chosen after the terminal
  // answers the background query, so a light terminal never flashes dark.
  // No targetFps: it only applies while opentui's own loop runs, which convoy
  // never starts — frames come on demand, paced by the ticker below.
  const renderer = await createCliRenderer({ screenMode: "alternate-screen", consoleMode: "console-overlay", exitOnCtrlC: false })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new LaunchPicker(renderer, options.targetDir, choices, config?.modelRouting?.gateway ?? "configured", worktree, options, history, specs, autoSpecIds, options.presetChange, options.presetFeature, insideWorktree).result
}

/** Where the launcher is running inside a feature worktree, for the nested-isolation warning. */
export type InsideWorktree = {
  dir: string
  branch?: string
}

/**
 * The launcher runs inside a worktree when its checkout is not the repo's main
 * one — exactly the situation where enabling isolation would fork a new
 * worktree off this one's branch rather than off the base.
 */
export async function detectInsideWorktree(targetDir: string): Promise<InsideWorktree | undefined> {
  try {
    const main = await mainWorktreeDir(targetDir)
    if (!main || resolve(main) === resolve(targetDir)) return undefined
    const branch = await currentBranch(targetDir)
    return { dir: targetDir, ...(branch ? { branch } : {}) }
  } catch {
    return undefined
  }
}

async function loadLaunchHistory(targetDir: string, enabled: boolean): Promise<LaunchHistoryContext> {
  try {
    const entries = (await readPrdHistoryIndex(targetDir)).filter((entry) => {
      try {
        return existsSync(prdHistoryFile(targetDir, entry))
      } catch {
        return false
      }
    })
    return { enabled, entries, branch: await currentBranch(targetDir) }
  } catch {
    return { enabled, entries: [] }
  }
}

export function pipelineChoices(config: ConvoyConfig | undefined, agents: readonly AgentSpec[]): PipelineChoice[] {
  const configured = config?.pipelines ?? {}
  const defaultName = config?.defaults.pipeline ?? defaultPipelineName
  const hooksConfig = config?.hooks ?? emptyHooksConfig()
  const names = [...new Set([...Object.keys(builtInPipelines), ...Object.keys(configured)])].sort((a, b) => a.localeCompare(b))
  names.sort((a, b) => (a === defaultName ? -1 : b === defaultName ? 1 : 0))

  return names.map((name) => {
    const spec = configured[name] ?? builtInPipelines[name]!
    const source: PipelineChoice["source"] = configured[name] ? "configured" : "built-in"
    const hooks = hookNodes(hooksForPipeline(hooksConfig, name))
    try {
      const pipeline = resolvePipeline({
        name,
        spec,
        agents,
        defaultModel: config?.defaults.model,
        defaultAdvisor: config?.defaults.advisor,
        defaultAdvisorMaxCalls: config?.defaults.advisorMaxCalls,
      })
      return {
        name,
        description: spec.description ?? "No description",
        source,
        isDefault: name === defaultName,
        steps: pipeline.steps.map(stepNode),
        hooks,
        valid: true,
        advisedSteps: pipeline.steps.filter((step) => step.type === "agent" && Boolean(step.resolvedAdvisor ?? step.advisor)).length,
        // The goal cycle rides along when the pipeline declares a valid
        // terminal goal step — the resolver already validated its structure
        // and roles — so the preview can show the loop, not just the prefix.
        ...(pipeline.goalPlan ? { goal: goalPreview(pipeline.goalPlan) } : {}),
        defaultPrompt: pipeline.defaultPrompt,
        suggestedPrompts: pipeline.suggestedPrompts,
        attachesPrdHistory: pipeline.steps.some((step) => step.type === "agent" && step.prdHistory),
      }
    } catch (error) {
      return {
        name,
        description: spec.description ?? "No description",
        source,
        isDefault: name === defaultName,
        steps: [],
        hooks,
        valid: false,
        advisedSteps: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

function hookNodes(set: HookSet): HookNode[] {
  const node = (stage: HookNode["stage"]) => (hook: HookSpec): HookNode => ({
    stage,
    label: (hook.name ?? hook.command).replace(/\s+/g, " ").trim(),
    ...(stage === "post" && (hook.when === "failure" || hook.when === "always") ? { when: hook.when } : {}),
  })
  return [...set.pre.map(node("pre")), ...set.post.map(node("post"))]
}

function stepNode(step: Step): StepNode {
  if (step.type === "human") return { stepName: step.name, groupId: "", kind: "human", modelLabel: "", advisorLabel: "" }
  const advisor = step.resolvedAdvisor?.target ?? step.advisor
  const cap = step.advisorMaxCalls ?? defaultAdvisorMaxCalls
  return {
    stepName: step.stepName,
    groupId: step.groupId,
    kind: "agent",
    modelLabel: launcherStepModelLabel(step),
    advisorLabel: advisor ? `${shortModelLabel(advisor)} advisor ×${cap}` : "",
  }
}

/** Flattens a resolved goal plan into the preview shape: policy plus both fragments' step trees. */
function goalPreview(plan: ResolvedGoalPlan): GoalPreview {
  return {
    target: plan.target,
    maxIterations: plan.maxIterations,
    plateau: plan.plateau,
    briefRecipient: plan.briefRecipient,
    scoreProducer: plan.scoreProducer,
    improve: plan.improve.steps.map(stepNode),
    measure: plan.measure.steps.map(stepNode),
  }
}

export function launcherStepModelLabel(step: Pick<AgentStep, "model" | "variant" | "runner">): string {
  const runner = stepRunnerFor(step.runner)
  return runner.id === "opencode" ? shortModelLabel(step.model, step.variant) : runner.modelLabel(step.model)
}

/** Drops the provider path from a model id so the tree shows "claude-opus-5", not "anthropic/claude-opus-5#…". */
function shortModelLabel(model: string, variant?: string): string {
  const base = model.slice(model.lastIndexOf("/") + 1)
  return variant ? `${base} ${variant}` : base
}

export class LaunchPicker {
  readonly result: Promise<LaunchRunTuiResult>

  private resolveResult!: (selection: LaunchRunTuiResult) => void
  private finished = false
  private mode: Mode = "pipelines"
  private selected = 0
  private scroll = 0
  private prompt = ""
  private cursor = 0
  private promptScroll = 0
  private promptError = ""
  /** True while the prompt text came from a default or suggestion, not the user. */
  private promptFromDefault = false
  /** The default/suggestion currently in the field, for clean/dirty swap detection. */
  private lastDefaultPrompt?: string
  /** Index into the selected pipeline's suggestedPrompts the Tab cycle is showing. */
  private suggestionIndex = 0
  /** True once Tab has been used at all, so a repeat press advances past the first suggestion. */
  private hasCycledSuggestions = false
  /** True while the prompt step is showing the OpenSpec picker instead of the editor. */
  private promptChoosing = false
  /** 0 = Manual prompt; 1..n = specs[index - 1]. */
  private specIndex = 0
  private specScroll = 0
  /** The OpenSpec change id chosen as the contract; cleared on Manual prompt. */
  private selectedChangeId?: string

  private optionIndex = 0
  private optionScroll = 0
  private message = ""
  private modal?: Modal
  private prepared?: PreparedReview
  private reviewScroll = 0
  private reviewTotalLines = 0
  private reviewFullPrompt = false
  /**
   * The porcelain answer the options step last read, cached only to render the
   * notice synchronously — `matters`/`blocked` are re-derived from the live
   * toggles on every render, and the review never trusts it (D2).
   */
  private dirtPorcelain?: string

  // Branch step state. `branchDir` is the worktree path for the current name,
  // and `branchEdited` flips as soon as the user types: a proposed name may be
  // auto-suffixed on collision, a hand-written one never is.
  private branchName = ""
  /** The prompt the current name was proposed for, so editing the prompt re-names the branch. */
  private branchPrompt = ""
  private branchCursor = 0
  private branchGuidance = ""
  private branchGuidanceCursor = 0
  private branchField: BranchField = "name"
  private branchDir = ""
  private branchSource: LaunchBranchProposal["source"] | "manual" = "manual"
  private branchNote = ""
  private branchError = ""
  private branchChecking = false

  /**
   * The permission selector's state, replacing the old smart/yolo toggle pair.
   * Defaults to Auto-accept (--yolo): ask-level requests are allowed
   * automatically, the hard denylist still applies, and the review names the
   * flag before the run starts.
   */
  private permissionMode: PermissionMode = "yolo"

  private readonly toggleState: Record<ToggleKey, boolean> = {
    humanReview: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    includeDirty: false,
    keepRunDir: true,
    tui: Boolean(process.stdout.isTTY && process.stderr.isTTY),
    // Always overwritten in the constructor, from defaults.worktree or the branch.
    worktree: true,
  }

  private readonly ticker: ReturnType<typeof setInterval>
  // When the screen was last rebuilt, so the ticker can hold its old 250ms pace
  // while nothing is animating.
  private lastRenderAt = 0
  private readonly stopLimits: () => void
  /** @internal — tests inject snapshots directly instead of running the poller. */
  private limits?: LimitsSnapshot
  /** Whether the sidebar's usage meters are on, set by every render. */
  private usageVisible = false
  private readonly headerText: TextRenderable
  private readonly bodyBox: BoxRenderable
  private readonly leftBox: BoxRenderable
  private readonly pipelineText: TextRenderable
  private readonly pipelineBox: BoxRenderable
  private readonly usageText: TextRenderable
  private readonly usageBox: BoxRenderable
  private readonly detailText: TextRenderable
  private readonly detailBox: BoxRenderable
  private readonly footerText: TextRenderable
  private readonly overlay: BoxRenderable
  private readonly modalBox: BoxRenderable
  private readonly modalText: TextRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []
  private pipelineRows: (number | undefined)[] = []
  private optionRows: (number | undefined)[] = []

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.render()
  }

  private readonly handlePaste = (event: PasteEvent) => {
    if (this.mode !== "prompt" && this.mode !== "branch") return
    if (this.mode === "prompt" && this.promptChoosing) return
    event.preventDefault()
    event.stopPropagation()
    const text = sanitizePaste(stripAnsiSequences(decodePasteBytes(event.bytes)))
    if (!text) return
    if (this.mode === "branch") {
      // Branch fields are single-line; a pasted newline would desync the cursor.
      this.insertBranchText(text.replace(/\n+/g, " ").trim())
      return
    }
    this.insertPromptText(text)
    this.markPromptDirty()
    this.promptError = ""
    this.render()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.raw === "\u0003") {
      key.preventDefault()
      key.stopPropagation()
      this.scene?.requestInterrupt()
      this.finish(undefined)
      return
    }

    key.preventDefault()
    key.stopPropagation()
    const modal = this.modal
    if (modal) {
      if (modal.kind === "gateway") {
        // The gateway dropdown: a closed five-option list, so navigation
        // clamps the way the config editor's pickers do. Enter applies the
        // highlighted row; escape (or q) keeps the current gateway.
        if (key.name === "up" || key.name === "k") modal.index = Math.max(0, modal.index - 1)
        else if (key.name === "down" || key.name === "j") modal.index = Math.min(modelGateways.length - 1, modal.index + 1)
        else if (key.name === "return" || key.name === "linefeed") {
          this.gateway = modelGateways[modal.index]!
          this.modal = undefined
        } else if (key.name === "escape" || key.name === "q") {
          this.modal = undefined
        }
        this.render()
        return
      }
      if (modal.kind === "confirm") {
        if (key.name === "return" || key.name === "linefeed") {
          this.modal = undefined
          modal.onConfirm()
        } else if (key.name === "escape" || key.name === "q") {
          this.modal = undefined
          this.render()
        }
        return
      }
      // The dirty-tree choice (D4): [i] flips Include dirty tree with explicit
      // consent and re-prepares the review, [o] returns to the options step
      // with the session intact, and escape dismisses — staying in review,
      // where accepting again re-offers the choice.
      if (modal.kind === "dirty") {
        if (key.name === "i") {
          this.modal = undefined
          this.toggleState.includeDirty = true
          void this.prepareReview(this.currentChoice().name)
        } else if (key.name === "o") {
          this.modal = undefined
          this.mode = "options"
          void this.refreshDirt()
          this.render()
        } else if (key.name === "escape") {
          this.modal = undefined
          this.render()
        }
        return
      }
      // Only the message modal can be dismissed; loading blocks input until the async job finishes.
      if (modal.kind === "message" && (key.name === "return" || key.name === "linefeed" || key.name === "escape" || key.name === "space" || key.name === "q")) {
        this.modal = undefined
        this.render()
      }
      return
    }
    switch (this.mode) {
      case "pipelines":
        this.handlePipelineKey(key)
        break
      case "prompt":
        this.handlePromptKey(key)
        break
      case "options":
        this.handleOptionsKey(key)
        break
      case "branch":
        this.handleBranchKey(key)
        break
      case "review":
        this.handleReviewKey(key)
        break
    }
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly targetDir: string,
    private readonly choices: PipelineChoice[],
    private gateway: ModelGateway,
    private readonly worktreeDefault: WorktreeDefault,
    // Named `callbacks` rather than `hooks`: this file already uses "hooks" for the pipeline's shell hooks.
    private readonly callbacks: Pick<LaunchRunTuiOptions, "prepareRun" | "proposeBranchName" | "checkBranchName" | "readDirtyStatus">,
    private readonly history: LaunchHistoryContext = { enabled: true, entries: [] },
    private readonly specs: readonly OpenSpecChangeSummary[] = [],
    /** Active change ids the run would attach without an explicit pick; see launchRunTui. */
    private readonly autoSpecIds: readonly string[] = [],
    /** A change handed in pre-selected; applied before the first render. */
    presetChange?: string,
    /** A feature-row continue handoff: reuses the feature's worktree and branch (D7). */
    private readonly presetFeature?: LaunchFeaturePreset,
    /** Set when the launcher itself runs inside a worktree; drives the nested-isolation warning. */
    private readonly insideWorktree?: InsideWorktree,
    private readonly scene?: TuiScene,
  ) {
    this.toggleState.worktree = worktreeDefault.isolate
    // The preset pins the contract before anything renders, so the prompt step
    // opens with that row highlighted and the auto-detect notice stays quiet.
    // An unknown id is ignored — the launcher falls back to its normal flow.
    if (presetChange && specs.some((spec) => spec.id === presetChange)) {
      this.selectedChangeId = presetChange
    }
    // Continue reuses the feature's existing worktree and branch: isolation of
    // a NEW worktree is off (the run executes in the existing one), the branch
    // is frozen without asking the namer, and the pinned change rides along.
    if (presetFeature) {
      this.selectedChangeId = presetFeature.changeID
      this.toggleState.worktree = false
    }
    const defaultIndex = choices.findIndex((choice) => choice.isDefault)
    this.selected = defaultIndex >= 0 ? defaultIndex : 0
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })
    const mount = this.scene?.root ?? renderer.root

    const shell = new BoxRenderable(renderer, {
      id: "convoy-launch-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
    })

    // Minimal chrome (one bare header row, like home): the project label and
    // the target project anchor the launcher; no version rides the header.
    const header = new BoxRenderable(renderer, {
      id: "convoy-launch-header",
      height: 1,
      backgroundColor: theme.bg,
    })
    const headerText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", wrapMode: "none" })
    header.add(headerText)
    const body = new BoxRenderable(renderer, { id: "convoy-launch-body", width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 })

    const selectFromList = (event: { y: number; preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      // Review is deliberately a committed, read-only screen: use Escape to
      // return to Options instead of changing the pipeline behind its plan.
      if (this.modal || this.mode === "review") return
      const row = event.y - this.pipelineText.y
      const index = this.pipelineRows[row]
      if (index === undefined) return
      this.mode = "pipelines"
      this.promptError = ""
      this.selectPipeline(index)
    }

    const pipeline = this.panel({
      id: "convoy-launch-pipelines",
      height: "100%",
      width: this.pipelineWidth(),
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " pipelines ",
      titleAlignment: "left",
      onMouseDown: selectFromList,
    })
    pipeline.text.onMouseDown = selectFromList

    // The pipeline list and the subscription meters share the sidebar as a
    // column: pipelines grow to fill it and the meters sit pinned to the
    // bottom edge, instead of costing the setup header a whole row.
    const left = new BoxRenderable(renderer, {
      id: "convoy-launch-left",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      gap: 0,
    })
    const usage = this.panel({
      id: "convoy-launch-usage",
      width: "100%",
      height: 4,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " usage ",
      titleAlignment: "left",
      visible: false,
    })

    const selectOption = (event: { y: number; preventDefault(): void; stopPropagation(): void }) => {
      if (this.mode !== "options" || this.modal) return
      event.preventDefault()
      event.stopPropagation()
      const row = event.y - this.detailText.y
      const index = this.optionRows[row]
      if (index === undefined) return
      this.optionIndex = index
      this.toggleOption()
    }

    const scrollReview = (event: LauncherWheelEvent) => {
      if (this.mode !== "review" || this.modal) return
      const delta = wheelDelta(event)
      if (delta === 0) return
      event.preventDefault()
      event.stopPropagation()
      this.scrollReview(delta)
    }

    const detail = this.panel({
      id: "convoy-launch-detail",
      flexGrow: 1,
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " run setup ",
      titleAlignment: "left",
      onMouseDown: selectOption,
      onMouseScroll: scrollReview,
    })
    detail.text.onMouseDown = selectOption
    detail.text.onMouseScroll = scrollReview
    const footer = this.panel({ id: "convoy-launch-footer", height: 3, borderColor: theme.borderDim, backgroundColor: theme.bg })

    this.headerText = headerText
    this.bodyBox = body
    this.leftBox = left
    this.pipelineText = pipeline.text
    this.pipelineBox = pipeline.box
    this.usageText = usage.text
    this.usageBox = usage.box
    this.detailText = detail.text
    this.detailBox = detail.box
    this.footerText = footer.text

    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: header, background: "bg" },
      { box: pipeline.box, background: "bg", border: "borderDim" },
      { box: usage.box, background: "bg", border: "borderDim" },
      { box: detail.box, background: "bg", border: "borderDim" },
      { box: footer.box, background: "bg", border: "borderDim" },
    )

    left.add(pipeline.box)
    left.add(usage.box)
    body.add(left)
    body.add(detail.box)
    shell.add(header)
    shell.add(body)
    shell.add(footer.box)
    mount.add(shell)

    // Modals float over the whole canvas, matching config-tui/runs-tui: an
    // absolute overlay centers a rounded accent-bordered box painted on
    // theme.overlay so it masks the setup screen underneath.
    this.overlay = new BoxRenderable(renderer, {
      id: "convoy-launch-overlay",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      alignItems: "center",
      justifyContent: "center",
      visible: false,
    })
    this.modalBox = new BoxRenderable(renderer, {
      id: "convoy-launch-modal",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.overlay,
      titleAlignment: "left",
      paddingX: 2,
      paddingY: 1,
    })
    this.modalText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    this.modalBox.add(this.modalText)
    this.overlay.add(this.modalBox)
    mount.add(this.overlay)
    this.paletteTargets.push({ box: this.modalBox, background: "overlay", border: "accent" })

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.keyInput.on("paste", this.handlePaste)
    renderer.on("theme_mode", this.handleThemeMode)

    // Faster than the spinner's 100ms step while a loading modal is up, so its
    // rotation is painted frame by frame instead of sampled late; otherwise the
    // old 250ms clock/meters cadence.
    this.ticker = setInterval(() => {
      if (this.modal?.kind === "loading" || Date.now() - this.lastRenderAt >= 250) this.render()
    }, 80)
    this.stopLimits = startLimitsPoller((snapshot) => {
      this.limits = snapshot
    })
    this.render()
  }

  private handlePipelineKey(key: KeyEvent) {
    switch (key.name) {
      case "up":
      case "k":
        this.moveSelection(-1)
        return
      case "down":
      case "j":
        this.moveSelection(1)
        return
      case "pageup":
        this.moveSelection(-this.pipelineVisibleRows())
        return
      case "pagedown":
        this.moveSelection(this.pipelineVisibleRows())
        return
      case "home":
        this.moveSelection(-this.choices.length)
        return
      case "end":
        this.moveSelection(this.choices.length)
        return
      case "return":
      case "linefeed":
        this.openPrompt()
        return
      case "r":
        this.finish({ action: "runs" })
        return
      case "c":
        this.finish({ action: "config" })
        return
      case "q":
      case "escape":
        this.finish(undefined)
        return
    }
  }

  private handlePromptKey(key: KeyEvent) {
    if (this.promptChoosing) {
      this.handleContractKey(key)
      return
    }
    if (key.name === "escape") {
      if (this.specs.length > 0) {
        this.promptChoosing = true
        this.promptError = ""
        this.render()
        return
      }
      this.mode = "pipelines"
      this.promptError = ""
      this.render()
      return
    }
    const enterAction = promptEnterAction(key)
    if (enterAction === "newline") {
      this.insertPromptText("\n")
      this.markPromptDirty()
      this.promptError = ""
      this.render()
      return
    }
    if (enterAction === "submit") {
      if (!this.prompt.trim()) {
        this.promptError = "Write a prompt before continuing."
      } else {
        this.applyPromptFieldState(trimPromptField(this.promptFieldState()))
        this.cursor = this.prompt.length
        this.promptError = ""
        this.mode = "options"
        this.optionIndex = 0
        void this.refreshDirt()
      }
      this.render()
      return
    }
    if (key.name === "tab") {
      this.cycleSuggestion()
      return
    }
    if (key.name === "backspace" || (key.ctrl && key.name === "h")) {
      if (this.cursor > 0) {
        this.prompt = this.prompt.slice(0, this.cursor - 1) + this.prompt.slice(this.cursor)
        this.cursor -= 1
        this.markPromptDirty()
      }
      this.promptError = ""
      this.render()
      return
    }
    if (key.ctrl && key.name === "u") {
      this.prompt = ""
      this.cursor = 0
      this.markPromptDirty()
      this.promptError = ""
      this.render()
      return
    }
    if ((key.ctrl && key.name === "a") || key.name === "home") {
      this.cursor = 0
      this.render()
      return
    }
    if ((key.ctrl && key.name === "e") || key.name === "end") {
      this.cursor = this.prompt.length
      this.render()
      return
    }
    if (key.name === "left") {
      this.cursor = clamp(this.cursor - 1, 0, this.prompt.length)
      this.render()
      return
    }
    if (key.name === "right") {
      this.cursor = clamp(this.cursor + 1, 0, this.prompt.length)
      this.render()
      return
    }

    const text = typedText(key)
    if (text) {
      this.insertPromptText(text)
      this.markPromptDirty()
      this.promptError = ""
      this.render()
    }
  }

  /**
   * Tab while the prompt field is clean (empty or still holding a default or
   * previous suggestion) inserts the next suggestedPrompt, wrapping around.
   * The first press shows the first suggestion; repeats advance through the
   * list. A user-edited prompt is left alone.
   */
  private cycleSuggestion() {
    const choice = this.currentChoice()
    const next = nextPromptSuggestion(this.promptFieldState(), choice.suggestedPrompts)
    if (!next) return
    this.applyPromptFieldState(next)
    this.cursor = this.prompt.length
    this.promptError = ""
    this.render()
  }

  private handleContractKey(key: KeyEvent) {
    switch (key.name) {
      case "up":
      case "k":
        this.specIndex = clamp(this.specIndex - 1, 0, this.specs.length)
        this.render()
        return
      case "down":
      case "j":
        this.specIndex = clamp(this.specIndex + 1, 0, this.specs.length)
        this.render()
        return
      case "pageup":
        this.specIndex = clamp(this.specIndex - this.contractVisibleRows(), 0, this.specs.length)
        this.render()
        return
      case "pagedown":
        this.specIndex = clamp(this.specIndex + this.contractVisibleRows(), 0, this.specs.length)
        this.render()
        return
      case "home":
        this.specIndex = 0
        this.render()
        return
      case "end":
        this.specIndex = this.specs.length
        this.render()
        return
      case "return":
      case "linefeed":
        this.acceptContract()
        return
      case "q":
        this.finish(undefined)
        return
      case "escape":
        this.mode = "pipelines"
        this.promptError = ""
        this.render()
        return
    }
  }

  /**
   * Manual prompt (index 0) opens the editor. A spec row pins `change=<id>`
   * and injects a short canned prompt — the spec files are the contract.
   */
  private acceptContract() {
    if (this.specIndex === 0) {
      this.selectedChangeId = undefined
      this.promptChoosing = false
      if (this.promptFromDefault) {
        this.applyPromptFieldState(emptyPromptField())
        this.cursor = 0
      }
      this.promptError = ""
      this.render()
      return
    }
    const spec = this.specs[this.specIndex - 1]
    if (!spec) return
    this.selectedChangeId = spec.id
    this.applyPromptFieldState(cleanPromptField(openSpecPromptFor(this.currentChoice().name)))
    this.cursor = this.prompt.length
    this.promptError = ""
    this.mode = "options"
    this.optionIndex = 0
    void this.refreshDirt()
    this.render()
  }

  private insertPromptText(text: string) {
    this.prompt = this.prompt.slice(0, this.cursor) + text + this.prompt.slice(this.cursor)
    this.cursor += text.length
  }

  /** Marks the field as user-owned: the text is preserved across switches and Tab stops cycling. */
  private markPromptDirty() {
    const state = markPromptEdited(this.promptFieldState())
    this.applyPromptFieldState(state)
  }

  private promptFieldState(): PromptFieldState {
    return {
      prompt: this.prompt,
      fromDefault: this.promptFromDefault,
      lastDefault: this.lastDefaultPrompt,
      suggestionIndex: this.suggestionIndex,
      hasCycledSuggestions: this.hasCycledSuggestions,
    }
  }

  private applyPromptFieldState(state: PromptFieldState) {
    this.prompt = state.prompt
    this.promptFromDefault = state.fromDefault
    this.lastDefaultPrompt = state.lastDefault
    this.suggestionIndex = state.suggestionIndex
    this.hasCycledSuggestions = state.hasCycledSuggestions
  }

  private handleOptionsKey(key: KeyEvent) {
    switch (key.name) {
      case "up":
      case "k":
        this.moveOption(-1)
        return
      case "down":
      case "j":
        this.moveOption(1)
        return
      case " ":
      case "space":
        this.toggleOption()
        return
      case "left":
        if (this.optionIndex === gatewayOptionIndex) this.cycleGateway(-1)
        return
      case "right":
        if (this.optionIndex === gatewayOptionIndex) this.cycleGateway(1)
        return
      case "return":
      case "linefeed":
      case "s":
        this.startRun()
        return
      case "g":
        this.openGatewayPicker()
        return
      case "p":
      case "escape":
        this.mode = "prompt"
        if (this.specs.length > 0) {
          this.promptChoosing = true
          if (this.selectedChangeId) {
            const index = this.specs.findIndex((spec) => spec.id === this.selectedChangeId)
            this.specIndex = index >= 0 ? index + 1 : 0
          } else {
            this.specIndex = 0
          }
        }
        this.cursor = this.prompt.length
        this.render()
        return
      case "r":
        this.finish({ action: "runs" })
        return
      case "c":
        this.finish({ action: "config" })
        return
      case "q":
        this.finish(undefined)
        return
    }
  }

  private handleBranchKey(key: KeyEvent) {
    switch (branchActionForKey(key)) {
      case "next-field":
        this.branchField = this.branchField === "name" ? "guidance" : "name"
        this.render()
        return
      case "previous-field":
        this.branchField = this.branchField === "guidance" ? "name" : "guidance"
        this.render()
        return
      case "regenerate":
        void this.proposeBranch({ guidance: this.branchGuidance })
        return
      case "submit":
        // Enter on the hint box means "name it with this", which is the whole
        // point of the box when the prompt was too thin to name anything.
        if (this.branchField === "guidance" && this.branchGuidance.trim()) void this.proposeBranch({ guidance: this.branchGuidance })
        else void this.acceptBranch()
        return
      case "clear":
        this.setBranchField("")
        return
      case "line-start":
        this.setBranchCursor(0)
        return
      case "line-end":
        this.setBranchCursor(this.branchFieldValue().length)
        return
      case "cursor-left":
        this.setBranchCursor(this.branchFieldCursor() - 1)
        return
      case "cursor-right":
        this.setBranchCursor(this.branchFieldCursor() + 1)
        return
      case "delete-back": {
        const value = this.branchFieldValue()
        const at = this.branchFieldCursor()
        if (at > 0) this.setBranchField(value.slice(0, at - 1) + value.slice(at), at - 1)
        else this.render()
        return
      }
      case "back":
        this.mode = "options"
        this.branchError = ""
        void this.refreshDirt()
        this.render()
        return
    }

    const text = typedText(key)
    if (text) this.insertBranchText(text)
  }

  private branchFieldValue() {
    return this.branchField === "name" ? this.branchName : this.branchGuidance
  }

  private branchFieldCursor() {
    return this.branchField === "name" ? this.branchCursor : this.branchGuidanceCursor
  }

  private setBranchField(value: string, cursor = value.length) {
    if (this.branchField === "name") {
      this.branchName = value
      this.branchCursor = clamp(cursor, 0, value.length)
      // The typed name owns the outcome from here: no silent collision suffix,
      // and no conventional prefix forced onto it. The proposal's attribution
      // and its checked path no longer describe what's in the field.
      this.branchSource = "manual"
      this.branchDir = ""
      this.branchNote = ""
      this.branchError = ""
    } else {
      this.branchGuidance = value
      this.branchGuidanceCursor = clamp(cursor, 0, value.length)
    }
    this.render()
  }

  private setBranchCursor(cursor: number) {
    const value = this.branchFieldValue()
    if (this.branchField === "name") this.branchCursor = clamp(cursor, 0, value.length)
    else this.branchGuidanceCursor = clamp(cursor, 0, value.length)
    this.render()
  }

  private insertBranchText(text: string) {
    const value = this.branchFieldValue()
    const at = this.branchFieldCursor()
    this.setBranchField(value.slice(0, at) + text + value.slice(at), at + text.length)
  }

  private handleReviewKey(key: KeyEvent) {
    switch (reviewActionForKey(key)) {
      case "scroll-back":
        this.scrollReview(-1)
        return
      case "scroll-forward":
        this.scrollReview(1)
        return
      case "page-back":
        this.scrollReview(-this.reviewVisibleRows())
        return
      case "page-forward":
        this.scrollReview(this.reviewVisibleRows())
        return
      case "top":
        this.reviewScroll = 0
        this.render()
        return
      case "bottom":
        this.reviewScroll = Math.max(0, this.reviewTotalLines - this.reviewVisibleRows())
        this.render()
        return
      case "toggle-prompt":
        this.reviewFullPrompt = !this.reviewFullPrompt
        this.reviewScroll = 0
        this.render()
        return
      case "start":
        if (this.prepared) {
          // Unhandled dirt at accept time offers an explicit choice in-TUI
          // (D4) instead of letting the post-exit gate throw the session away.
          if (this.prepared.dirt.blocked) {
            this.openDirtyChoice(this.prepared.dirt)
            return
          }
          this.finish(this.prepared)
        }
        return
      case "back":
        this.prepared = undefined
        this.mode = this.toggleState.worktree ? "branch" : "options"
        this.reviewScroll = 0
        this.reviewTotalLines = 0
        if (this.mode === "options") void this.refreshDirt()
        this.render()
        return
      case "cancel":
        this.finish(undefined)
        return
    }
  }

  private scrollReview(delta: number) {
    const maxScroll = Math.max(0, this.reviewTotalLines - this.reviewVisibleRows())
    this.reviewScroll = clamp(this.reviewScroll + delta, 0, maxScroll)
    this.render()
  }

  private openPrompt() {
    const choice = this.currentChoice()
    if (!choice.valid) {
      this.message = `Pipeline "${choice.name}" is invalid: ${choice.error ?? "unknown error"}`
      this.render()
      return
    }
    this.message = ""
    this.mode = "prompt"
    this.promptScroll = 0
    if (this.specs.length > 0) {
      this.promptChoosing = true
      if (this.selectedChangeId) {
        const index = this.specs.findIndex((spec) => spec.id === this.selectedChangeId)
        this.specIndex = index >= 0 ? index + 1 : 0
      } else {
        this.specIndex = 0
      }
      this.render()
      return
    }
    // A clean field adopts the pipeline's default prompt on first open, so a
    // concrete-action pipeline launches without typing. An already-typed prompt
    // (returning from options, or a previous pipeline's preserved text) is kept.
    this.applyPromptFieldState(prefillPromptField(this.promptFieldState(), choice.defaultPrompt))
    this.cursor = this.prompt.length
    this.render()
  }

  private startRun() {
    const choice = this.currentChoice()
    if (!choice.valid) {
      this.message = `Pipeline "${choice.name}" is invalid: ${choice.error ?? "unknown error"}`
      this.render()
      return
    }
    // Worktree runs stop to agree on a branch name first; everything else goes
    // straight to the review as before.
    if (this.toggleState.worktree) {
      // A name already agreed for this exact prompt is kept; a rewritten prompt
      // gets a fresh proposal rather than a stale name.
      if (this.branchName && this.branchPrompt === this.prompt) {
        this.mode = "branch"
        this.render()
        return
      }
      void this.proposeBranch({})
      return
    }
    void this.prepareReview(choice.name)
  }

  /**
   * Asks for a name and lands on the branch step. A failure never blocks: the
   * step opens with whatever could be derived (or empty), so the user can type
   * the name or describe it and regenerate.
   */
  private async proposeBranch(input: { guidance?: string }) {
    this.mode = "branch"
    this.branchField = "name"
    this.modal = { kind: "loading", title: "naming the branch", message: "Asking the namer for a branch name…" }
    this.render()
    try {
      const proposal = await this.callbacks.proposeBranchName({ prompt: this.prompt, guidance: input.guidance?.trim() || undefined })
      const checked = await this.callbacks.checkBranchName(proposal.branch)
      if (!checked.branch) throw new Error("the proposed name had nothing usable in it")
      this.branchPrompt = this.prompt
      this.branchName = checked.branch
      this.branchCursor = checked.branch.length
      this.branchDir = checked.dir
      this.branchSource = proposal.source
      this.branchError = ""
      this.branchNote = branchProposalNote(proposal, checked)
    } catch (error) {
      this.branchName = ""
      this.branchCursor = 0
      this.branchDir = ""
      this.branchSource = "manual"
      this.branchNote = ""
      this.branchError = `Couldn't propose a name (${error instanceof Error ? error.message : String(error)}). Write one, or describe it below and press ctrl+R.`
      this.branchField = "guidance"
    } finally {
      this.modal = undefined
      this.render()
    }
  }

  /** Validates the current name and moves on to the review with it frozen in. */
  private async acceptBranch() {
    const typed = this.branchName.trim()
    if (!typed) {
      this.branchError = "Write a branch name, or describe it below and press ctrl+R."
      this.render()
      return
    }
    if (this.branchChecking) return
    this.branchChecking = true
    try {
      const checked = await this.callbacks.checkBranchName(typed)
      if (!checked.branch) {
        this.branchError = "That name has no usable characters for a git branch."
        this.render()
        return
      }
      // A hand-written name is never silently renamed: show the free name it
      // would become and let the next Enter confirm it.
      if (checked.suffixed && this.branchSource === "manual" && checked.branch !== typed) {
        this.branchName = checked.branch
        this.branchCursor = checked.branch.length
        this.branchDir = checked.dir
        this.branchError = `"${typed}" already exists — press enter again to use ${checked.branch}.`
        this.render()
        return
      }
      this.branchName = checked.branch
      this.branchCursor = checked.branch.length
      this.branchDir = checked.dir
      this.branchError = ""
      await this.prepareReview(this.currentChoice().name)
    } catch (error) {
      this.branchError = error instanceof Error ? error.message : String(error)
      this.render()
    } finally {
      this.branchChecking = false
    }
  }

  private async prepareReview(pipelineName: string) {
    this.modal = { kind: "loading", title: "preparing review", message: "Resolving the exact run plan…" }
    this.render()
    try {
      const { repoBootstrapStatus } = await import("./git")
      // Bootstrap probes the execution tree: for a feature handoff the run
      // executes in the feature worktree, so its readiness decides whether an
      // initialization step is offered — never the launch directory's.
      const status = await repoBootstrapStatus(this.executionDir())
      const selection = this.runSelection(pipelineName, status !== "ready")
      const preparation = await this.callbacks.prepareRun(selection)
      // The review rechecks the execution tree instead of trusting any status
      // cached from the options step (D2): the warning, the accept-time
      // choice, and the flags line all derive from this fresh read.
      const porcelain = await this.readDirtyStatus(this.executionDir())
      this.prepared = {
        action: "run",
        selection,
        ...preparation,
        dirt: {
          ...dirtReading(porcelain, {
            presetFeature: this.presetFeature,
            worktree: this.toggleState.worktree,
            includeDirty: this.toggleState.includeDirty,
          }),
          preview: dirtyFilesPreview(porcelain),
        },
      }
      this.mode = "review"
      this.reviewScroll = 0
      this.reviewTotalLines = 0
      this.reviewFullPrompt = false
      this.modal = undefined
      this.render()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.modal = { kind: "message", title: "can't prepare the review", message, footer: "esc dismiss · adjust options and try again" }
      this.render()
    }
  }

  /** The checkout the run would execute in: the feature's worktree for a continue handoff, the target checkout otherwise. */
  private executionDir(): string {
    return this.presetFeature?.worktreeDir ?? this.targetDir
  }

  /** The injected porcelain reader, defaulting to the gate's own git call. */
  private readDirtyStatus(dir: string): Promise<string> {
    return (this.callbacks.readDirtyStatus ?? defaultDirtyStatus)(dir)
  }

  /**
   * The cached porcelain answer interpreted against the current toggles via
   * the shared predicate: re-derived on every render, so flipping the worktree
   * or Include dirty tree toggles moves the notice and the count without
   * another git read.
   */
  private currentDirt(): DirtReading {
    return dirtReading(this.dirtPorcelain ?? "", {
      presetFeature: this.presetFeature,
      worktree: this.toggleState.worktree,
      includeDirty: this.toggleState.includeDirty,
    })
  }

  /** Reads the execution tree's dirt fresh, then repaints the open step with it (D2). */
  private async refreshDirt() {
    try {
      this.dirtPorcelain = await this.readDirtyStatus(this.executionDir())
    } catch {
      // The gate reports the real problem at execution time; the notice just stays quiet.
      this.dirtPorcelain = ""
    }
    this.render()
  }

  /** The accept-time dirty choice: include, back to options, or stay in review (D4). */
  private openDirtyChoice(dirt: DirtReading & { preview: string }) {
    const files = `${dirt.files} uncommitted file${dirt.files === 1 ? "" : "s"}`
    this.modal = {
      kind: "dirty",
      title: "uncommitted changes",
      message: `${files} — this run would refuse to start with them. Including them lands them in the first commit.`,
      preview: dirt.preview,
      footer: "i include · o options · esc stay",
    }
    this.render()
  }

  private runSelection(pipelineName: string, initializeGit = false): LaunchRunSelection {
    // A continue handoff executes inside the feature's existing worktree with
    // its branch frozen into the plan — no namer, no `ensureFreeBranchName`,
    // no new worktree (which is why `isolateWorktree` stays false).
    const targetDir = this.executionDir()
    const frozenBranch = this.presetFeature
      ? { branchName: this.presetFeature.branch, worktreeDir: this.presetFeature.worktreeDir }
      : this.toggleState.worktree && this.branchName
        ? { branchName: this.branchName, worktreeDir: this.branchDir }
        : undefined
    return {
      targetDir,
      prompt: this.prompt,
      pipeline: pipelineName,
      humanReview: this.toggleState.humanReview,
      tui: this.toggleState.tui,
      includeDirty: this.toggleState.includeDirty,
      keepRunDir: this.toggleState.keepRunDir,
      // The single permission mode maps onto the same pair of flags the old
      // toggles produced: never both, and neither for Interactive.
      yolo: this.permissionMode === "yolo",
      smart: this.permissionMode === "smart",
      gateway: this.gateway,
      isolateWorktree: this.toggleState.worktree,
      ...(frozenBranch ?? {}),
      // A feature-scoped handoff rides its stable identity and recorded base:
      // the plan's feature link resolves by identity (never branch spelling)
      // and base resolution uses the recorded intended base rather than
      // re-detecting one (work-context, D1/D2; the advisor's identity rule).
      ...(this.presetFeature?.featureId ? { featureId: this.presetFeature.featureId } : {}),
      ...(this.presetFeature?.baseRef ? { baseRef: this.presetFeature.baseRef } : {}),
      ...(initializeGit ? { initializeGit: true } : {}),
      ...(this.selectedChangeId ? { change: this.selectedChangeId } : {}),
    }
  }

  private toggleOption() {
    // The gateway row is a select, not a switch: activating it opens the
    // dropdown instead of flipping a boolean.
    if (this.optionIndex === gatewayOptionIndex) {
      this.openGatewayPicker()
      return
    }
    // The permission row is a tri-state selector: activation advances the
    // fixed cycle Interactive → Auto-accept → Smart auto-accept → Interactive.
    if (this.optionIndex === permissionOptionIndex) {
      this.permissionMode = nextPermissionMode(this.permissionMode)
      this.render()
      return
    }
    const key = toggles[this.optionIndex - 2]?.key
    if (!key) return
    const next = !this.toggleState[key]
    this.toggleState[key] = next
    // A fresh worktree is always clean, so includeDirty is meaningless there.
    if (key === "worktree" && next) this.toggleState.includeDirty = false
    if (key === "includeDirty" && next) this.toggleState.worktree = false
    this.render()
  }

  private moveSelection(delta: number) {
    const newIndex = clamp(this.selected + delta, 0, this.choices.length - 1)
    this.selectPipeline(newIndex)
  }

  /** Applies one pipeline selection consistently for keyboard and mouse input. */
  private selectPipeline(newIndex: number) {
    this.message = ""
    if (newIndex === this.selected) {
      this.render()
      return
    }
    this.selected = newIndex
    const newChoice = this.currentChoice()

    if (this.selectedChangeId) {
      this.applyPromptFieldState(cleanPromptField(openSpecPromptFor(newChoice.name)))
    } else {
      // Swap the default prompt cleanly when the field is empty or still holds
      // the previous pipeline's default; a user-typed prompt is preserved across
      // the switch so moving away and back never discards work.
      this.applyPromptFieldState(promptAfterPipelineSwitch(this.promptFieldState(), newChoice.defaultPrompt))
    }

    this.render()
  }

  private moveOption(delta: number) {
    this.optionIndex = clamp(this.optionIndex + delta, 0, this.optionCount() - 1)
    this.render()
  }

  /** Opens the gateway dropdown with the cursor on the current gateway. */
  private openGatewayPicker() {
    this.modal = { kind: "gateway", title: "model gateway", index: modelGateways.indexOf(this.gateway) }
    this.render()
  }

  /** Steps the gateway one entry along the list without opening the dropdown. */
  private cycleGateway(delta: number) {
    const next = clamp(modelGateways.indexOf(this.gateway) + delta, 0, modelGateways.length - 1)
    this.gateway = modelGateways[next]!
    this.render()
  }

  /** Number of selectable rows in the options step: the gateway selector, the permission selector, and the built-in toggles. */
  private optionCount(): number {
    return 2 + toggles.length
  }

  private currentChoice() {
    return this.choices[this.selected] ?? this.choices[0]!
  }

  private finish(selection: LaunchRunTuiResult) {
    if (this.finished) return
    this.finished = true
    clearInterval(this.ticker)
    this.stopLimits()
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.keyInput.off("paste", this.handlePaste)
    this.renderer.off("theme_mode", this.handleThemeMode)
    if (!this.scene && !this.renderer.isDestroyed) this.renderer.destroy()
    this.resolveResult(selection)
  }

  private applyPalette() {
    for (const target of this.paletteTargets) {
      target.box.backgroundColor = theme[target.background]
      if (target.border) target.box.borderColor = theme[target.border]
    }
  }

  private panel(options: BoxOptions) {
    const box = new BoxRenderable(this.renderer, {
      border: true,
      borderStyle: "rounded",
      paddingX: 1,
      paddingY: 0,
      ...options,
    })
    const text = new TextRenderable(this.renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    box.add(text)
    return { box, text }
  }

  private render() {
    if (this.finished || this.renderer.isDestroyed || this.scene?.isClosed) return
    this.lastRenderAt = Date.now()
    const innerWidth = Math.max(40, this.renderer.width - 6)
    const reviewing = this.mode === "review"
    const compact = this.usesCompactLayout()
    // The pipeline/usage sidebar and the Review step own the whole screen:
    // Review freezes the plan, and the list would only repeat it.
    this.leftBox.visible = !reviewing
    this.pipelineBox.visible = !reviewing
    const pipelineWidth = compact ? innerWidth + 4 : this.pipelineWidth()
    // In compact mode both panels occupy the shell's full inner width. Wide
    // screens retain the sidebar, but measure the detail panel from the actual
    // inner width rather than a fixed 40-column floor that could overflow.
    const detailWidth = reviewing || compact ? innerWidth : Math.max(34, innerWidth - pipelineWidth - 1)
    // The left column runs from the header's bottom edge to the footer's top,
    // so its height is the full shell less those two (1 row + 3 rows). The usage
    // panel pins to its bottom edge and the pipeline list fills the rest,
    // leaving no dead stripe under the meters.
    const bodyHeight = Math.max(8, this.renderer.height - 4)
    const usageHeight = 4
    const usageVisible = !compact && !reviewing && this.limits !== undefined && bodyHeight - usageHeight >= 6
    this.usageVisible = usageVisible
    this.usageBox.visible = usageVisible

    this.bodyBox.flexDirection = compact ? "column" : "row"
    // Stacked panels sit flush (the shell's own chrome has no gaps either);
    // keeping the row layout's 1-column gap here would spend a body row on a
    // blank separator above the setup panel and push its bottom border under
    // the footer.
    this.bodyBox.gap = compact ? 0 : 1
    if (compact) {
      const pipelineHeight = this.compactPipelineHeight(this.compactBodyHeight())
      this.leftBox.width = "100%"
      this.leftBox.height = pipelineHeight
      this.pipelineBox.width = "100%"
      this.pipelineBox.height = "100%"
      // Review owns the whole body (the sidebar is display:none, so it takes
      // no rows); otherwise the setup panel takes exactly the rows the
      // pipeline list leaves, so its bottom border always lands on the body's
      // last row instead of "auto"-sizing past it when the content runs long.
      this.detailBox.height = reviewing ? "100%" : Math.max(3, bodyHeight - pipelineHeight)
    } else {
      this.leftBox.width = pipelineWidth
      this.leftBox.height = bodyHeight
      this.pipelineBox.width = "100%"
      this.pipelineBox.height = usageVisible ? bodyHeight - usageHeight : bodyHeight
      this.detailBox.height = "100%"
    }
    this.detailBox.width = compact || reviewing ? "100%" : detailWidth
this.detailBox.title = reviewing ? " review " : " run setup "
     // The pipeline sidebar never borrows the accent: the steps are uniform,
     // dimmed containers, and the selected pipeline's own row carries the
     // focus marker. The accent marks Enter/Esc/navigation in the setup panel
     // during the prompt/options/branch steps (never in pipelines mode).
     this.pipelineBox.borderColor = theme.borderDim
     this.detailBox.borderColor = this.mode === "pipelines" ? theme.borderDim : theme.accent
    this.headerText.content = this.headerContent(innerWidth)
    // Panels reserve 4 cells of chrome (rounded border + paddingX:1 each side),
    // so lay out the rows against the inner text width — matching detailWidth
    // below. Passing the full box width made every right-aligned badge overflow
    // and wrap onto its own line.
    this.pipelineText.content = this.pipelineContent(pipelineWidth - 4)
    if (usageVisible) this.usageText.content = joinLines(this.usageContent(pipelineWidth - 4))
    this.detailText.content = this.detailContent(compact || reviewing ? innerWidth : detailWidth - 4)
    this.footerText.content = this.footerContent(innerWidth)
    this.renderModal()
    this.renderer.requestRender()
  }

  private renderModal() {
    const modal = this.modal
    this.overlay.visible = Boolean(modal)
    if (!modal) return
    const boxWidth = this.modalWidth()
    const width = boxWidth - 6
    const lines: StyledText[] = []

    this.modalBox.title = ` ${truncate(modal.title, boxWidth - 8)} `
    this.modalBox.borderColor = modal.kind === "message" || modal.kind === "dirty" ? theme.yellow : theme.accent

    if (modal.kind === "loading") {
      const frame = spinnerFrame(Date.now())
      lines.push(new StyledText([fg(theme.accent)(frame), raw("  "), fg(theme.text)(truncate(modal.message, width - 3))]))
    } else if (modal.kind === "gateway") {
      // A dropdown over the options panel: every gateway at once, the cursor
      // marked with ▸ and the applied value with ◆, mirroring the config
      // editor's pickers so the two dialogs read as the same control.
      for (const [index, gateway] of modelGateways.entries()) {
        const selected = index === modal.index
        const current = gateway === this.gateway
        const marker = selected ? fg(theme.accent)("▸ ") : raw("  ")
        const diamond = current ? fg(theme.accent)("◆ ") : fg(theme.dim)("◇ ")
        const label = gatewayLabel(gateway)
        const value = selected ? bold(fg(theme.text)(label)) : fg(theme.text)(label)
        const hint = gatewayHint(gateway)
        const hintChunk = hint ? fg(theme.faint)(`   ${truncate(hint, Math.max(8, width - label.length - 9))}`) : undefined
        lines.push(new StyledText(hintChunk ? [marker, diamond, value, hintChunk] : [marker, diamond, value]))
      }
    } else if (modal.kind === "dirty") {
      // Prose first, then the gate's own preview verbatim (D4): wrapWords
      // collapses whitespace, so the file list is rendered as its own lines.
      for (const line of wrapWords(modal.message, width)) lines.push(new StyledText([fg(theme.text)(line)]))
      if (modal.preview) {
        lines.push(plain(""))
        for (const previewLine of modal.preview.split("\n").filter(Boolean)) {
          lines.push(new StyledText([fg(theme.dim)(truncate(previewLine, width))]))
        }
      }
    } else {
      for (const line of wrapWords(modal.message, width)) lines.push(new StyledText([fg(theme.text)(line)]))
    }
    lines.push(plain(""))
    const footer =
      modal.kind === "gateway"
        ? "↑/↓ select · enter apply · esc cancel"
        : (modal.footer ??
          (modal.kind === "message" ? "press any key to dismiss" : modal.kind === "confirm" ? "enter confirm · esc cancel" : "please wait…"))
    lines.push(new StyledText([fg(theme.dim)(footer)]))

    this.modalBox.width = boxWidth
    this.modalBox.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }

  private modalWidth() {
    return clamp(this.renderer.width - 8, 34, 80)
  }

  // No version branding here: the launcher is convoy's own front door, so the
  // target project is the header's anchor, labeled like home and specs, with
  // the stage breadcrumb as the screen-local right segment.
  private headerContent(width: number) {
    const project = basename(this.targetDir) || this.targetDir
    const title: TextChunk[] = [fg(theme.faint)("project  "), bold(fg(theme.text)(truncate(project, Math.max(12, width - 34))))]
    // The branch step only exists for worktree runs, so the stage row grows and
    // shrinks with the toggle instead of showing a step that can't be reached.
    const steps: Array<{ label: string; mode: Mode }> = [
      { label: "pipeline", mode: "pipelines" },
      { label: "prompt", mode: "prompt" },
      { label: "options", mode: "options" },
      ...(this.toggleState.worktree ? [{ label: "branch", mode: "branch" as Mode }] : []),
      { label: "review", mode: "review" },
    ]
    const stage: TextChunk[] = []
    const currentStep = steps.find((step) => step.mode === this.mode)
    if (width < 60 && currentStep) {
      stage.push(bold(fg(theme.accent)(currentStep.label)))
    } else {
      for (const [index, step] of steps.entries()) {
        if (index > 0) stage.push(fg(theme.faint)(" → "))
        stage.push(this.mode === step.mode ? bold(fg(theme.accent)(step.label)) : fg(theme.dim)(step.label))
      }
    }
    const line1 = padBetween(title, stage, width)
    return joinLines([line1])
  }

  /**
   * The sidebar's subscription meters: the OpenRouter wallet on the first
   * line, the OpenAI window below it. Reuses the dashboard's color language
   * but drops detail before ever clipping a value mid-token.
   */
  private usageContent(width: number): StyledText[] {
    const lines: StyledText[] = []
    const now = Date.now()

    const openrouter = this.limits?.openrouter
    if (openrouter) {
      const value = openrouter.kind === "remaining" ? `${formatMoney(openrouter.amount)} left` : `${formatMoney(openrouter.amount)}/mo`
      const color = openrouter.kind === "remaining" && openrouter.amount < openRouterLowBalance ? theme.yellow : theme.text
      lines.push(new StyledText([fg(theme.dim)("OpenRouter "), fg(color)(value)]))
    } else {
      lines.push(new StyledText([fg(theme.dim)("OpenRouter "), fg(theme.faint)("not configured")]))
    }

    const gpt = this.limits?.gpt
    if (gpt) {
      const pct = Math.round(gpt.sessionPct)
      const barColor = pct >= 85 ? theme.red : pct >= 60 ? theme.yellow : theme.accent
      const pctChunk = fg(pct >= 60 ? barColor : theme.text)(`${pct}%`)
      // A compact gauge instead of the dashboard's full-width bar: the usage
      // panel only has a sidebar's worth of columns, so the meter is a short
      // block run and the resets/weekly tail yields before the bar shrinks.
      const bar: TextChunk[] = [fg(theme.dim)("OpenAI "), ...progressBar(pct / 100, 4, barColor), raw(" "), pctChunk]
      const tail: TextChunk[] = []
      if (gpt.sessionResetsAt !== undefined) tail.push(fg(theme.faint)(" resets "), fg(theme.dim)(fmtCountdown(gpt.sessionResetsAt, now)))
      if (gpt.weeklyPct !== undefined) {
        const wk = Math.round(gpt.weeklyPct)
        tail.push(fg(theme.faint)(" wk "), fg(wk >= 85 ? theme.red : wk >= 60 ? theme.yellow : theme.dim)(`${wk}%`))
      }
      // The weekly window goes before the countdown: neither is worth pushing
      // the bar past the sidebar's edge.
      let fitted = [...bar, ...tail]
      if (chunksLength(fitted) > width) fitted = [...bar, ...tail.slice(0, 2)]
      if (chunksLength(fitted) > width) fitted = bar
      lines.push(new StyledText(fitted))
    } else if (this.limits?.gptHint) {
      lines.push(new StyledText([fg(theme.dim)("OpenAI "), fg(theme.yellow)(truncate(this.limits.gptHint, width - 7))]))
    } else {
      lines.push(new StyledText([fg(theme.dim)("OpenAI "), fg(theme.faint)("not configured")]))
    }
    return lines
  }

  private pipelineContent(width: number) {
    const visible = this.pipelineVisibleRows()
    if (this.selected < this.scroll) this.scroll = this.selected
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1
    this.scroll = clamp(this.scroll, 0, Math.max(0, this.choices.length - visible))

    const rows: StyledText[] = []
    this.pipelineRows = []
    for (let index = this.scroll; index < Math.min(this.choices.length, this.scroll + visible); index++) {
      const selected = index === this.selected
      rows.push(pipelineRow(this.choices[index]!, selected, width))
      this.pipelineRows.push(index)
    }
    while (rows.length < visible) {
      rows.push(plain(""))
      this.pipelineRows.push(undefined)
    }
    return joinLines(rows)
  }

  private detailContent(width: number) {
    this.optionRows = []
    switch (this.mode) {
      case "pipelines":
        return this.pipelineDetail(width)
      case "prompt":
        return this.promptDetail(width)
      case "options":
        return this.optionsDetail(width)
      case "branch":
        return this.branchDetail(width)
      case "review":
        return this.reviewDetail(width)
    }
  }

  private pipelineDetail(width: number) {
    const choice = this.currentChoice()
    const lines: StyledText[] = []
    lines.push(t`${bold(fg(theme.text)(choice.name))}`)
    lines.push(new StyledText([fg(choice.source === "configured" ? theme.teal : theme.faint)(choice.source), choice.isDefault ? fg(theme.green)(" · default") : raw("")]))
    lines.push(plain(""))
    for (const line of wrapWords(choice.description, width)) lines.push(t`${fg(theme.dim)(line)}`)
    lines.push(plain(""))
    if (!choice.valid) {
      lines.push(t`${fg(theme.red)("invalid pipeline")}`)
      for (const line of wrapWords(choice.error ?? "unknown error", width)) lines.push(t`${fg(theme.dim)(line)}`)
    } else {
      lines.push(new StyledText([sectionLabel("steps")]))
      for (const line of stepTree(choice.steps, width)) lines.push(line)
      const agentSteps = choice.steps.filter((step) => step.kind === "agent").length
      lines.push(plain(""), t`${fg(theme.teal)(`Advisors: ${choice.advisedSteps}/${agentSteps} steps advised`)}`)
      // The pipeline preview continues where the prefix ends: a scored
      // pipeline's remaining shape is the goal loop, and this is the only
      // launcher surface that shows it before Review.
      if (choice.goal) {
        lines.push(plain(""))
        for (const line of goalLines(choice.goal, width)) lines.push(line)
      }
    }
    this.pushHistoryNotice(lines, width, "picker")
    this.pushOpenSpecNotice(lines, width)
    lines.push(plain(""))
    for (const line of hookLines(choice.hooks, width)) lines.push(line)
    if (this.message) {
      lines.push(plain(""))
      for (const line of wrapWords(this.message, width)) lines.push(t`${fg(theme.red)(line)}`)
    }
    return joinLines(lines)
  }

  private promptDetail(width: number) {
    if (this.promptChoosing) return this.contractDetail(width)
    const choice = this.currentChoice()
    const lines: StyledText[] = []
    lines.push(new StyledText([fg(theme.faint)("pipeline "), bold(fg(theme.text)(choice.name))]))
    lines.push(plain(""))
    // Wrap the instructions explicitly so the field budget below counts the
    // rows they actually take once the panel is too narrow for one line.
    const describeLines = wrapWords("Describe what Convoy should do. Paste freely; Shift+Enter adds a line.", width)
    for (const line of describeLines) lines.push(t`${fg(theme.dim)(line)}`)
    lines.push(plain(""))

    const fieldWidth = Math.max(10, width - 2)
    const contentWidth = Math.max(1, fieldWidth)
    // Rows the panel spends besides the field: the pipeline line, the blanks,
    // the instructions, and the trailing blank + hint. The field shrinks to
    // keep its own border inside the panel on short screens; the hint (which
    // repeats what the footer shows) is the first row the panel clips.
    const fixedRows = describeLines.length + 5
    const inputHeight = Math.max(3, Math.min(20, this.detailContentHeight() - fixedRows))
    const visibleRows = Math.max(1, inputHeight - 2)
    const wrapped = wrapPromptLines(this.prompt, contentWidth)
    const { row: cursorRow, col: cursorCol } = cursorPosition(this.prompt, this.cursor, contentWidth)

    if (cursorRow < this.promptScroll) this.promptScroll = cursorRow
    if (cursorRow >= this.promptScroll + visibleRows) this.promptScroll = cursorRow - visibleRows + 1
    this.promptScroll = clamp(this.promptScroll, 0, Math.max(0, wrapped.length - visibleRows))

    const start = this.promptScroll
    const end = Math.min(wrapped.length, start + visibleRows)
    const placeholder = "Add onboarding, fix bug #123, review current diff…"

    lines.push(new StyledText([fg(theme.faint)("┌" + "─".repeat(fieldWidth) + "┐")]))
    for (let r = start; r < end; r++) {
      const seg = wrapped[r] ?? ""
      const chunks: TextChunk[] = [fg(theme.faint)("│")]
      if (r === cursorRow) {
        if (!this.prompt && r === 0) {
          const placeholderText = truncate(placeholder, Math.max(0, fieldWidth - 1))
          chunks.push(cursorChunk(" "))
          chunks.push(fg(theme.faint)(placeholderText))
          chunks.push(fg(theme.faint)(" ".repeat(Math.max(0, fieldWidth - 1 - placeholderText.length)) + "│"))
        } else {
          const col = clamp(cursorCol, 0, Math.max(0, fieldWidth - 1))
          const before = seg.slice(0, col)
          const cursorCell = seg[col] ?? " "
          const after = seg.slice(col + 1)
          const used = before.length + 1 + after.length
          chunks.push(fg(theme.text)(before))
          chunks.push(cursorChunk(cursorCell))
          chunks.push(fg(theme.text)(after))
          chunks.push(fg(theme.faint)(" ".repeat(Math.max(0, fieldWidth - used)) + "│"))
        }
      } else {
        chunks.push(fg(this.prompt ? theme.text : theme.faint)(seg))
        chunks.push(fg(theme.faint)(" ".repeat(Math.max(0, fieldWidth - seg.length)) + "│"))
      }
      lines.push(new StyledText(chunks))
    }
    for (let r = end; r < start + visibleRows; r++) {
      lines.push(new StyledText([fg(theme.faint)("│"), fg(theme.faint)(" ".repeat(fieldWidth) + "│")]))
    }
    lines.push(new StyledText([fg(theme.faint)("└" + "─".repeat(fieldWidth) + "┘")]))

    if (this.promptError) {
      lines.push(plain(""))
      lines.push(t`${fg(theme.red)(this.promptError)}`)
    }
    lines.push(plain(""))
    const hint = "shift+enter newline · enter options · ←/→ move · ctrl+U clear · esc back"
    const suggestions = choice.suggestedPrompts
    // The accent slot carries one status: while Tab can cycle suggestions it
    // says how many, otherwise a multi-line prompt owns up to its height. The
    // row is clipped rather than wrapped, so a narrow panel degrades to an
    // ellipsis instead of spilling extra lines into the fixed-height box.
    const suggestionCount = suggestions?.length ?? 0
    const canCycleSuggestions = suggestionCount > 0 && (this.promptFromDefault || this.prompt === "")
    const status =
      canCycleSuggestions
        ? `tab: ${suggestionCount} suggestion${suggestionCount === 1 ? "" : "s"}`
        : wrapped.length > 1
          ? `${wrapped.length} lines`
          : ""
    // Suggestion discovery wins the left edge because this row is clipped in
    // ordinary-width terminals; putting the status last made Tab invisible.
    const hintChunks: TextChunk[] = canCycleSuggestions
      ? [fg(theme.accent)(status), fg(theme.faint)(" · "), fg(theme.faint)(hint)]
      : [fg(theme.faint)(hint)]
    if (!canCycleSuggestions && status) hintChunks.push(fg(theme.faint)(" · "), fg(theme.accent)(status))
    lines.push(new StyledText(clipChunks(hintChunks, width)))
    return joinLines(lines)
  }

  private contractDetail(width: number) {
    const choice = this.currentChoice()
    const lines: StyledText[] = []
    lines.push(new StyledText([fg(theme.faint)("pipeline "), bold(fg(theme.text)(choice.name))]))
    lines.push(plain(""))
    const intro = wrapWords("An OpenSpec change is the contract. Pick one, or write a prompt by hand.", width)
    for (const line of intro) lines.push(t`${fg(theme.dim)(line)}`)
    lines.push(plain(""))

    const rows = this.contractRows()
    const visible = this.contractVisibleRows()
    if (this.specIndex < this.specScroll) this.specScroll = this.specIndex
    if (this.specIndex >= this.specScroll + visible) this.specScroll = this.specIndex - visible + 1
    this.specScroll = clamp(this.specScroll, 0, Math.max(0, rows.length - visible))

    const end = Math.min(rows.length, this.specScroll + visible)
    for (let index = this.specScroll; index < end; index++) {
      const selected = index === this.specIndex
      const marker = selected ? fg(theme.accent)("▸ ") : raw("  ")
      const label = selected ? bold(fg(theme.text)(truncate(rows[index]!, Math.max(8, width - 2)))) : fg(theme.text)(truncate(rows[index]!, Math.max(8, width - 2)))
      lines.push(new StyledText([marker, label]))
    }
    return joinLines(lines)
  }

  private contractRows(): string[] {
    return ["Manual prompt", ...this.specs.map((spec) => (spec.title === spec.id ? spec.id : `${spec.id} — ${spec.title}`))]
  }

  private contractVisibleRows() {
    return Math.max(3, this.detailContentHeight() - 6)
  }

  private selectedSpec(): OpenSpecChangeSummary | undefined {
    return this.selectedChangeId ? this.specs.find((spec) => spec.id === this.selectedChangeId) : undefined
  }

  private optionsDetail(width: number) {
    const choice = this.currentChoice()
    const lines: StyledText[] = []
    lines.push(new StyledText([fg(theme.faint)("pipeline "), bold(fg(theme.text)(choice.name))]))
    lines.push(new StyledText([fg(theme.faint)("prompt   "), fg(theme.text)(truncate(this.prompt, Math.max(10, width - 9)))]))
    const spec = this.selectedSpec()
    if (spec) {
      const label = spec.title === spec.id ? spec.id : `${spec.id} · ${spec.title}`
      lines.push(new StyledText([sectionLabel("openspec "), fg(theme.teal)(truncate(label, Math.max(10, width - 9)))]))
    }
    // The continue handoff shows what is being reused, so "no new worktree"
    // is a visible fact of the options step rather than an assumption.
    if (this.presetFeature) {
      const label = `${this.presetFeature.branch} · ${shortPath(this.presetFeature.worktreeDir, Math.max(16, width - 36))} (existing worktree — no new branch or worktree)`
      lines.push(new StyledText([fg(theme.faint)("feature  "), fg(theme.teal)(truncate(label, Math.max(10, width - 9)))]))
    }
    this.pushOpenSpecNotice(lines, width)
    this.pushHistoryNotice(lines, width, "options")
    this.pushDirtNotice(lines, width)
    lines.push(plain(""))
    lines.push(new StyledText([fg(theme.dim)(truncate("Choose a gateway and toggle extra run parameters, then press Enter to review.", width))]))

    this.optionRows = Array(lines.length).fill(undefined)

    // The gateway selector leads the list: it reroutes every model in the run,
    // so it gets room of its own — a blank line above, a description below —
    // instead of a bare "gateway  … (g to change)" glued to the instruction.
    lines.push(plain(""))
    this.optionRows.push(undefined)
    const gatewaySelected = this.optionIndex === gatewayOptionIndex
    const gatewayMarker = gatewaySelected ? fg(theme.accent)("▸ ") : raw("  ")
    const gatewayCaret = gatewaySelected ? fg(theme.accent)(" ▾") : fg(theme.dim)(" ▾")
    lines.push(
      padBetween(
        [gatewayMarker, fg(theme.faint)("gateway  "), bold(fg(theme.text)(gatewayLabel(this.gateway))), gatewayCaret],
        [fg(theme.green)("--gateway")],
        width,
      ),
    )
    this.optionRows.push(gatewayOptionIndex)
    lines.push(new StyledText([raw("        "), fg(theme.dim)(truncate(gatewayRowDescription, Math.max(8, width - 8)))]))
    this.optionRows.push(gatewayOptionIndex)
    lines.push(plain(""))
    this.optionRows.push(undefined)

    // The permission selector follows the gateway row's precedent: a value row
    // (mode name as the value, the flag it resolves to on the right) with a
    // per-state description beneath — one deliberate control where the two
    // mutually exclusive auto-accept toggles used to sit.
    const permissionSpec = permissionModeSpecs[this.permissionMode]
    const permissionSelected = this.optionIndex === permissionOptionIndex
    const permissionMarker = permissionSelected ? fg(theme.accent)("▸ ") : raw("  ")
    const permissionValue = permissionSelected ? bold(fg(theme.text)(permissionSpec.name)) : fg(theme.text)(permissionSpec.name)
    const permissionFlag = permissionSpec.flag ? fg(theme.green)(permissionSpec.flag) : fg(theme.dim)("no auto-accept flag")
    lines.push(padBetween([permissionMarker, fg(theme.faint)("permissions  "), permissionValue], [permissionFlag], width))
    this.optionRows.push(permissionOptionIndex)
    lines.push(new StyledText([raw("        "), fg(theme.dim)(truncate(permissionSpec.description, Math.max(8, width - 8)))]))
    this.optionRows.push(permissionOptionIndex)
    lines.push(plain(""))
    this.optionRows.push(undefined)

    for (const [index, spec] of toggles.entries()) {
      const selected = index + 2 === this.optionIndex
      const enabled = this.toggleState[spec.key]
      const marker = selected ? fg(theme.accent)("▸ ") : raw("  ")
      const toggle = toggleSwitch(enabled)
      // While the execution tree's dirt is unhandled, the Include dirty tree
      // toggle carries the live count — the same number the notice names.
      // The count stays dim so the control name remains the row's primary weight.
      const dirt = spec.key === "includeDirty" ? this.currentDirt() : undefined
      const label = selected ? bold(fg(theme.text)(spec.label)) : fg(theme.text)(spec.label)
      const count = dirt?.blocked ? fg(theme.dim)(` (${dirt.files} uncommitted)`) : undefined
      const flag = fg(enabled ? theme.green : theme.dim)(spec.flag)
      lines.push(padBetween([marker, ...toggle, raw(" "), label, ...(count ? [count] : [])], [flag], width))
      this.optionRows.push(index + 2)
      // The worktree default depends on which branch you're on, so say why it
      // landed where it did — otherwise the checkbox looks like it moves on its own.
      const description =
        spec.key === "worktree"
          ? `Default ${this.worktreeDefault.isolate ? "on" : "off"}: ${this.worktreeDefault.reason}. ${spec.description}`
          : spec.description
      lines.push(new StyledText([raw("        "), fg(theme.dim)(truncate(description, Math.max(8, width - 8)))]))
      this.optionRows.push(index + 2)
      // Nested isolation is never blocked, only named: enabling a new worktree
      // while already inside one forks from this worktree's branch, and the
      // operator should do that deliberately (D7).
      if (spec.key === "worktree" && enabled && this.insideWorktree) {
        const dir = shortPath(this.insideWorktree.dir, Math.max(24, width - 40))
        const where = this.insideWorktree.branch ? `branch ${this.insideWorktree.branch} of worktree ${dir}` : `worktree ${dir}`
        const warning = `you are on ${where} — the new worktree forks from this branch; isolate only if you truly mean it`
        lines.push(new StyledText([raw("        "), fg(theme.yellow)(truncate(warning, Math.max(8, width - 8)))]))
        this.optionRows.push(index + 2)
      }
    }

    const flags = this.enabledFlags()
    lines.push(plain(""))
    this.optionRows.push(undefined)
    const flagsPrefix = "will run with "
    const flagsText = flags.length ? flags.join(" ") : "no extra flags"
    lines.push(new StyledText([fg(theme.faint)(flagsPrefix), fg(theme.text)(truncate(flagsText, Math.max(1, width - flagsPrefix.length)))]))
    this.optionRows.push(undefined)

    // The toggle list outgrows the panel in compact mode (and on short wide
    // screens), so window it the way the pipeline list does: the selected
    // toggle and its description stay in view instead of the selection
    // walking off the bottom of the panel.
    const visible = Math.max(1, this.detailContentHeight())
    const selectedRow = this.optionRows.findIndex((row) => row === this.optionIndex)
    if (selectedRow >= 0) {
      // The flags summary belongs to the last toggle: reaching it bottoms the
      // window out so the summary scrolls into view rather than staying clipped.
      const selectedEnd = this.optionIndex === this.optionCount() - 1 ? lines.length - 1 : selectedRow + 1
      if (selectedRow < this.optionScroll) this.optionScroll = selectedRow
      if (selectedEnd >= this.optionScroll + visible) this.optionScroll = selectedEnd - visible + 1
    }
    this.optionScroll = clamp(this.optionScroll, 0, Math.max(0, lines.length - visible))
    const windowed = lines.slice(this.optionScroll, this.optionScroll + visible)
    this.optionRows = this.optionRows.slice(this.optionScroll, this.optionScroll + visible)
    while (windowed.length < visible) {
      windowed.push(plain(""))
      this.optionRows.push(undefined)
    }
    return joinLines(windowed)
  }

  private branchDetail(width: number) {
    const lines: StyledText[] = []
    lines.push(new StyledText([fg(theme.faint)("pipeline "), bold(fg(theme.text)(this.currentChoice().name))]))
    lines.push(plain(""))
    // Wrapped explicitly so the focus-follow window below counts the rows the
    // introduction actually takes on narrow panels.
    for (const line of wrapWords("Name the branch and worktree for this run. Nothing is created until you confirm.", width)) {
      lines.push(t`${fg(theme.dim)(line)}`)
    }
    lines.push(plain(""))

    const fieldWidth = Math.max(10, Math.min(width - 2, 60))
    lines.push(new StyledText([fg(theme.faint)("branch")]))
    lines.push(...textField(this.branchName, this.branchCursor, fieldWidth, this.branchField === "name", "feat/short-name"))

    if (this.branchDir) {
      lines.push(new StyledText([fg(theme.faint)("worktree "), fg(theme.dim)(truncate(displayHome(this.branchDir), Math.max(8, width - 9)))]))
    } else if (this.branchName) {
      lines.push(new StyledText([fg(theme.faint)("worktree "), fg(theme.dim)("checked when you press enter")]))
    } else {
      lines.push(plain(""))
    }
    if (this.branchNote) lines.push(new StyledText([fg(theme.faint)(truncate(this.branchNote, width))]))
    else lines.push(plain(""))

    lines.push(plain(""))
    const guidanceRow = lines.length
    lines.push(new StyledText([fg(theme.faint)("hint "), fg(theme.dim)("optional — say how you want it named, then enter")]))
    lines.push(...textField(this.branchGuidance, this.branchGuidanceCursor, fieldWidth, this.branchField === "guidance", "e.g. name it after the budget limits"))

    if (this.branchError) {
      lines.push(plain(""))
      for (const line of wrapWords(this.branchError, width)) lines.push(t`${fg(theme.red)(line)}`)
    }

    // Both fields rarely fit at once in compact mode, so the window follows
    // the focused field: the name field shows the top of the form, and tabbing
    // to the guidance hint pulls its label and box into view.
    const visible = Math.max(1, this.detailContentHeight())
    if (lines.length <= visible) return joinLines(lines)
    const scroll =
      this.branchField === "guidance" ? clamp(guidanceRow + 4 - visible, 0, Math.max(0, lines.length - visible)) : 0
    return joinLines(lines.slice(scroll, scroll + visible))
  }

  private reviewDetail(width: number) {
    const prepared = this.prepared
    if (!prepared) return joinLines([t`${fg(theme.red)("Unable to load the run review.")}`])

    const reviewRows = runReviewLines(prepared.plan, width, { fullPrompt: this.reviewFullPrompt })
    // The fresh dirt reading from preparation (D2): warn only when the run
    // would actually refuse — the toggle on or a clean tree stays silent.
    // Same 9-cell label column as the rest of the review (and the options
    // notice), not a dashboard ⚠ banner.
    if (prepared.dirt.blocked) {
      const headline = `${prepared.dirt.files} uncommitted file${prepared.dirt.files === 1 ? "" : "s"} — this run would refuse them; include them or stash first`
      reviewRows.unshift(
        new StyledText([fg(theme.faint)("tree     "), fg(theme.yellow)(truncate(headline, Math.max(8, width - 9)))]),
        plain(""),
      )
    }
    const visible = this.reviewVisibleRows()
    const maxScroll = Math.max(0, reviewRows.length - visible)
    this.reviewScroll = clamp(this.reviewScroll, 0, maxScroll)
    this.reviewTotalLines = reviewRows.length

    const lines = reviewRows.slice(this.reviewScroll, this.reviewScroll + visible)
    while (lines.length < visible) lines.push(plain(""))
    return joinLines(lines)
  }

  private historyPreview(): PrdHistoryPreview {
    return resolvePrdHistoryPreview({
      enabled: this.history.enabled,
      isolateWorktree: this.toggleState.worktree,
      attachesHistory: Boolean(this.currentChoice().attachesPrdHistory),
      branch: this.history.branch,
      entries: this.history.entries,
      fileExists: () => true,
    })
  }

  /**
   * Picker stays quiet unless this checkout already has a PRD (browsing should
   * not nag on every empty review). Options always shows attach-capable outcomes,
   * including "none — will infer".
   */
  private pushHistoryNotice(lines: StyledText[], width: number, surface: "picker" | "options") {
    const preview = this.historyPreview()
    if (surface === "picker" && !preview.found) return
    const copy = prdHistoryPreviewCopy(preview)
    if (!copy) return
    const tone = copy.tone === "attach" ? theme.teal : copy.tone === "warn" ? theme.yellow : theme.dim
    lines.push(plain(""))
    lines.push(new StyledText([fg(theme.faint)("history  "), fg(tone)(truncate(copy.headline, Math.max(8, width - 9)))]))
    if (copy.detail) {
      lines.push(new StyledText([raw("         "), fg(theme.dim)(truncate(copy.detail, Math.max(8, width - 9)))]))
    }
  }

  /**
   * The OpenSpec counterpart of the history notice: which active change the run
   * will attach without being asked. Quiet when the checkout has no active
   * change, and when a pick exists the picked row already says it — the notice
   * exists for the silent path, which is exactly where an operator needs to be
   * told what is about to happen. Titles ride a detail line because the ids
   * alone must survive a narrow detail pane.
   */
  private pushOpenSpecNotice(lines: StyledText[], width: number) {
    if (this.specs.length === 0 || this.selectedChangeId) return
    const value = Math.max(8, width - 9)
    const auto = this.specs.filter((spec) => this.autoSpecIds.includes(spec.id))
    lines.push(plain(""))
    if (auto.length > 0) {
      const titled = auto.filter((spec) => spec.title !== spec.id)
      lines.push(new StyledText([sectionLabel("openspec "), fg(theme.teal)(truncate(`${auto.map((spec) => spec.id).join(", ")} · bundle attaches to every step`, value))]))
      if (titled.length > 0) {
        lines.push(new StyledText([raw("         "), fg(theme.dim)(truncate(titled.map((spec) => spec.title).join(" · "), value))]))
      }
      return
    }
    lines.push(new StyledText([sectionLabel("openspec "), fg(theme.dim)(truncate(`${this.specs.length} active changes · pick one when writing the prompt`, value))]))
  }

  /**
   * The dirt notice, the tree counterpart of the history and OpenSpec notices:
   * the execution tree holds uncommitted changes this run would refuse, so the
   * operator learns it while the Include dirty tree toggle is still one
   * keystroke away. Quiet when the tree is clean, when the toggle already
   * covers the dirt, or when the dirt doesn't matter (fresh worktree
   * isolation).
   */
  private pushDirtNotice(lines: StyledText[], width: number) {
    const dirt = this.currentDirt()
    if (!dirt.blocked) return
    const headline = `${dirt.files} file${dirt.files === 1 ? "" : "s"} uncommitted — enable 'Include dirty tree' or stash`
    lines.push(plain(""))
    lines.push(new StyledText([fg(theme.faint)("tree     "), fg(theme.yellow)(truncate(headline, Math.max(8, width - 9)))]))
  }

  private enabledFlags() {
    const flags = [`--pipeline ${this.currentChoice().name}`]
    flags.push(`--gateway ${this.gateway}`)
    const permissionFlag = permissionModeSpecs[this.permissionMode].flag
    if (permissionFlag) flags.push(permissionFlag)
    flags.push(this.toggleState.humanReview ? "--human-step" : "--no-human-step")
    if (this.toggleState.includeDirty) flags.push("--include-dirty")
    if (!this.toggleState.keepRunDir) flags.push("--no-keep-run-dir")
    flags.push(this.toggleState.tui ? "--tui" : "--no-tui")
    flags.push(this.toggleState.worktree ? "--worktree" : "--no-worktree")
    if (this.selectedChangeId) flags.push(`--change ${this.selectedChangeId}`)
    return flags
  }

  /**
   * One row per mode, shed by priority when the terminal is too narrow — the
   * shared helper appends a dim count so a shortened row still admits there are
   * keys it isn't showing. Priority 1 is whatever gets you back out.
   */
  private footerContent(width: number) {
    const row = (hints: Hint[], right: TextChunk[]) => hintsRow(hints, [right], width, { style: "spaced", overflow: moreHintsMarker })

    if (this.mode === "pipelines") {
      return row(
        [
          { keys: "↑/↓", label: "select", priority: 2, tone: "dim" },
          { keys: "enter", label: "prompt", priority: 3 },
          { keys: "r", label: "runs", priority: 4 },
          { keys: "c", label: "config", priority: 5 },
          { keys: "q", label: this.scene ? "back" : "quit", priority: 1 },
        ],
        [fg(theme.faint)(`${this.selected + 1}/${this.choices.length}`)],
      )
    }
    if (this.mode === "prompt") {
      if (this.promptChoosing) {
        return row(
          [
            { keys: "↑/↓", label: "select", priority: 2, tone: "dim" },
            { keys: "enter", label: this.specIndex === 0 ? "write prompt" : "options", priority: 3 },
            { keys: "esc", label: "back", priority: 1 },
          ],
          [fg(theme.faint)(`${this.specIndex + 1}/${this.specs.length + 1}`)],
        )
      }
      return row(
        [
          { keys: "type/paste", label: "", priority: 4, tone: "dim" },
          { keys: "shift+enter", label: "newline", priority: 3 },
          { keys: "enter", label: "options", priority: 2 },
          { keys: "esc", label: "back", priority: 1 },
        ],
        [fg(theme.faint)(`${this.prompt.length} char${this.prompt.length === 1 ? "" : "s"}`)],
      )
    }
    if (this.mode === "branch") {
      return row(
        [
          { keys: "enter", label: this.branchField === "guidance" ? "name it from the hint" : "review", priority: 2 },
          { keys: "tab", label: "field", priority: 3 },
          { keys: "ctrl+R", label: "rename", priority: 4 },
          { keys: "esc", label: "options", priority: 1 },
        ],
        [fg(theme.faint)(this.branchField === "name" ? "branch" : "hint")],
      )
    }
    if (this.mode === "review") {
      const end = Math.min(this.reviewScroll + this.reviewVisibleRows(), this.reviewTotalLines)
      return row(
        [
          { keys: "↑/↓", label: "scroll", priority: 3, tone: "dim" },
          { keys: "pgup/pgdn", label: "page", priority: 4 },
          { keys: "p", label: this.reviewFullPrompt ? "collapse prompt" : "expand prompt", priority: 5 },
          { keys: "enter/s", label: "start", priority: 2 },
          { keys: "esc", label: "options", priority: 1 },
          { keys: "q", label: "cancel", priority: 6 },
        ],
        [fg(theme.faint)(`${end}/${this.reviewTotalLines}`)],
      )
    }
    return row(
      [
        { keys: "↑/↓", label: "select", priority: 3, tone: "dim" },
        // The permission row is a tri-state selector, so space cycles it rather
        // than toggling — the footer names the behavior of the selected row.
        { keys: "space", label: this.optionIndex === permissionOptionIndex ? "cycle" : "toggle", priority: 2 },
        { keys: "g", label: "gateway", priority: 5 },
        { keys: "enter", label: "review", priority: 4 },
        { keys: "p", label: "prompt", priority: 6 },
        { keys: "q", label: this.scene ? "back" : "quit", priority: 1 },
      ],
      [fg(theme.faint)(`${this.optionIndex + 1}/${this.optionCount()}`)],
    )
  }

  // The pipeline sidebar is capped at one third of the inner width so the
  // prompt/options panel gets the bulk of the screen; clamped so very narrow
  // terminals still show enough of each pipeline name to disambiguate.
  private pipelineWidth() {
    const inner = Math.max(40, this.renderer.width - 6)
    return clamp(Math.floor(inner / 3), 22, 44)
  }

  private usesCompactLayout() {
    return this.renderer.width <= compactLaunchMaxWidth
  }

  // Enough rows to browse a short list without crowding out the selected
  // pipeline's setup form below it.
  private compactPipelineHeight(bodyHeight: number) {
    return Math.max(5, Math.min(9, Math.floor(bodyHeight * 0.35)))
  }

  private compactBodyHeight() {
    // Header (1), footer (3), and the detail panel's top/bottom borders (2).
    return Math.max(8, this.renderer.height - 6)
  }

  private pipelineVisibleRows() {
    if (this.usesCompactLayout()) return Math.max(1, this.compactPipelineHeight(this.compactBodyHeight()) - 2)
    // Wide: the sidebar shares its column with the usage meters when they're
    // on, so the list's visible rows shrink to match the box laid out in
    // render() — keeping pagination and click targets in sync with the panel.
    const bodyHeight = Math.max(8, this.renderer.height - 4)
    const rows = bodyHeight - (this.usageVisible ? 4 : 0) - 2
    return Math.max(3, rows)
  }

  private detailContentHeight() {
    if (!this.usesCompactLayout()) return this.listHeight()
    // compactBodyHeight already discounts the header, footer, and the detail
    // panel's own borders, so the setup panel's text budget is what remains
    // after the pipeline list's share — exactly the rows the stacked,
    // gap-free box shows.
    return Math.max(1, this.compactBodyHeight() - this.compactPipelineHeight(this.compactBodyHeight()))
  }

  private reviewVisibleRows() {
    // Review hides the pipeline panel and owns the whole body in both
    // layouts, so its budget is the full body height — not the detail panel's
    // compact share, which would leave the review half-empty.
    return this.usesCompactLayout() ? Math.max(3, this.compactBodyHeight()) : this.listHeight()
  }

  private listHeight() {
    // Header (1) + footer (3) + list panel borders (2).
    return Math.max(3, this.renderer.height - 6)
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

/** A boxed single-line input, styled like the prompt editor's field. */
function textField(value: string, cursor: number, width: number, focused: boolean, placeholder: string): StyledText[] {
  const border = focused ? theme.accent : theme.faint
  const inner = Math.max(1, width)
  // Scroll the window so the cursor stays visible in a value longer than the box.
  const start = Math.max(0, Math.min(cursor - inner + 1, Math.max(0, value.length - inner + 1)))
  const visible = value.slice(start, start + inner)
  const column = clamp(cursor - start, 0, inner - 1)

  const chunks: TextChunk[] = [fg(border)("│")]
  if (!value) {
    const text = truncate(placeholder, Math.max(0, inner - 1))
    if (focused) chunks.push(cursorChunk(" "), fg(theme.faint)(text), fg(theme.faint)(" ".repeat(Math.max(0, inner - 1 - text.length))))
    else chunks.push(fg(theme.faint)(text), raw(" ".repeat(Math.max(0, inner - text.length))))
  } else if (focused) {
    const before = visible.slice(0, column)
    const at = visible[column] ?? " "
    const after = visible.slice(column + 1)
    chunks.push(fg(theme.text)(before), cursorChunk(at), fg(theme.text)(after))
    chunks.push(raw(" ".repeat(Math.max(0, inner - before.length - 1 - after.length))))
  } else {
    chunks.push(fg(theme.text)(visible), raw(" ".repeat(Math.max(0, inner - visible.length))))
  }
  chunks.push(fg(border)("│"))

  return [
    new StyledText([fg(border)("┌" + "─".repeat(inner) + "┐")]),
    new StyledText(chunks),
    new StyledText([fg(border)("└" + "─".repeat(inner) + "┘")]),
  ]
}

/** Attribution line under the branch field: who proposed the name, and whether it had to move. */
export function branchProposalNote(proposal: LaunchBranchProposal, check: LaunchBranchCheck): string {
  const origin =
    proposal.source === "declared"
      ? "taken from the document"
      : proposal.source === "model"
        ? `proposed by ${proposal.model || "the naming model"}`
        : proposal.source === "prompt"
          ? "derived from your prompt (the naming model didn't answer)"
          : "generic name (nothing to derive it from)"
  return check.suffixed ? `${origin} · renamed, the original was taken` : origin
}

function displayHome(path: string): string {
  const home = homedir()
  if (path === home) return "~"
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

export type BranchAction =
  | "next-field"
  | "previous-field"
  | "regenerate"
  | "submit"
  | "clear"
  | "line-start"
  | "line-end"
  | "cursor-left"
  | "cursor-right"
  | "delete-back"
  | "back"

/**
 * Keyboard contract for the branch step. Plain letters are never bound here —
 * both fields are text inputs, so anything printable must reach them.
 */
export function branchActionForKey(key: Pick<KeyEvent, "name" | "ctrl" | "shift">): BranchAction | undefined {
  if (key.ctrl) {
    switch (key.name) {
      case "r":
        return "regenerate"
      case "u":
        return "clear"
      case "a":
        return "line-start"
      case "e":
        return "line-end"
      case "h":
        return "delete-back"
    }
    return undefined
  }
  switch (key.name) {
    case "tab":
      return key.shift ? "previous-field" : "next-field"
    // Some terminals report shift+tab as its own key rather than a modifier.
    case "backtab":
      return "previous-field"
    case "return":
    case "linefeed":
      return "submit"
    case "home":
      return "line-start"
    case "end":
      return "line-end"
    case "left":
      return "cursor-left"
    case "right":
      return "cursor-right"
    case "backspace":
      return "delete-back"
    case "escape":
      return "back"
  }
  return undefined
}

export type ReviewAction = "scroll-back" | "scroll-forward" | "page-back" | "page-forward" | "top" | "bottom" | "toggle-prompt" | "start" | "back" | "cancel"

/** Keyboard contract for the launcher's native Review step. */
export function reviewActionForKey(key: Pick<KeyEvent, "name" | "shift">): ReviewAction | undefined {
  switch (key.name) {
    case "up":
    case "k":
      return "scroll-back"
    case "down":
    case "j":
      return "scroll-forward"
    case "pageup":
      return "page-back"
    case "pagedown":
    case "space":
      return "page-forward"
    case "home":
      return "top"
    case "end":
      return "bottom"
    case "p":
      return "toggle-prompt"
    case "return":
    case "linefeed":
    case "s":
      return "start"
    case "escape":
      return "back"
    case "q":
      return "cancel"
  }
  return undefined
}

type LauncherWheelEvent = {
  scroll?: { direction: string; delta: number }
  preventDefault(): void
  stopPropagation(): void
}

function wheelDelta(event: LauncherWheelEvent): number {
  const scroll = event.scroll
  if (!scroll || (scroll.direction !== "up" && scroll.direction !== "down")) return 0
  const magnitude = Math.max(1, Math.round(scroll.delta || 1))
  return scroll.direction === "up" ? -magnitude : magnitude
}

// A slider-style toggle: the knob (●) sits on the right when on, left when
// off, over a colored track. The state label is padded to a fixed 3-cell
// column so the labels that follow stay aligned across on/off rows. Returns
// the chunks so the caller can splice them into the row's left column.
function toggleSwitch(enabled: boolean): TextChunk[] {
  if (enabled) {
    return [fg(theme.green)("━━●"), bold(fg(theme.green)(" on "))]
  }
  return [fg(theme.faint)("●━━"), fg(theme.dim)(" off")]
}

export function typedText(key: KeyEvent): string | undefined {
  if (key.ctrl) return undefined
  const name = key.name
  if (name === "space") return " "
  // Accept regular typing (single-char name) or an unrecognized multi-char
  // raw (plain-text paste from terminals without bracketed-paste support).
  // Named keys like arrows/delete carry printable-looking escape sequences
  // in `raw` and must not be inserted as text.
  if (name !== "" && name.length !== 1) return undefined
  const rawValue = key.raw
  if (typeof rawValue !== "string" || rawValue.length === 0) return undefined
  let out = ""
  for (const ch of rawValue) {
    const code = ch.codePointAt(0)!
    if (code >= 0x20 && code !== 0x7f) out += ch
  }
  return out || undefined
}

export function promptEnterAction(key: Pick<KeyEvent, "name" | "shift">): "newline" | "submit" | undefined {
  if (key.name !== "return" && key.name !== "linefeed") return undefined
  return key.shift ? "newline" : "submit"
}

function cursorChunk(text: string): TextChunk {
  return bg(theme.accent)(fg(theme.chipText)(text || " "))
}

export function sanitizePaste(text: string): string {
  // Normalize CR/CRLF to LF (preserving line breaks), collapse tabs to a
  // single space so they don't desync the wrap/cursor column math, and
  // strip any remaining control bytes that some terminals leak outside
  // bracketed-paste frames (ANSI escapes are already gone via
  // stripAnsiSequences above).
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}

export function wrapPromptLines(text: string, width: number): string[] {
  if (width < 1) return [""]
  const result: string[] = []
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      result.push("")
      continue
    }
    for (let i = 0; i < line.length; i += width) result.push(line.slice(i, i + width))
  }
  return result.length ? result : [""]
}

export function cursorPosition(text: string, cursor: number, width: number): { row: number; col: number } {
  let row = 0
  let col = 0
  const end = Math.min(cursor, text.length)
  for (let i = 0; i < end; i++) {
    const ch = text[i]!
    if (ch === "\n") {
      row += 1
      col = 0
      continue
    }
    if (col >= width) {
      row += 1
      col = 0
    }
    col += 1
  }
  return { row, col }
}

function wrapWords(text: string, width: number) {
  const words = text.replace(/\s+/g, " ").trim().split(" ")
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    if (!current) {
      current = word
      continue
    }
    if (current.length + 1 + word.length > width) {
      lines.push(current)
      current = word
    } else {
      current += ` ${word}`
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : [""]
}

// One row per pipeline: a selection dot, the name, and an optional
// right-aligned badge. The dot fills only for the selected row; default/custom
// state is carried by the badge so unselected dots stay visually uniform.
// Exported as a pure helper so the narrow-width badge threshold stays covered
// by a direct unit test, like stepTree and hookLines beside it.
export function pipelineRow(choice: PipelineChoice, selected: boolean, width: number): StyledText {
  const dot = choice.valid ? fg(selected ? theme.accent : theme.dim)(selected ? "●" : "○") : fg(theme.red)("!")
  const badgeText = width >= 30 && (choice.isDefault ? "default" : choice.source === "configured" ? "custom" : "")
  const badge: TextChunk[] = badgeText ? [fg(choice.isDefault ? theme.green : theme.teal)(badgeText)] : []
  // Prefix is dot (1) + space (1); reserve the badge plus a
  // 1-cell gap so a long name truncates instead of wrapping into the badge.
  const nameWidth = Math.max(3, width - 2 - (badgeText ? badgeText.length + 1 : 0))
  const name = truncate(choice.name, nameWidth)
  const label = selected ? bold(fg(theme.text)(name)) : fg(theme.text)(name)
  return padBetween([dot, raw(" "), label], badge, width)
}

// Renders the resolved steps as a tree that shows the run shape the old flat
// list hid: sequential phases stack as `○` nodes top-to-bottom, and any phase
// whose steps run concurrently — a `parallel:` block, or one agent fanned
// across `models:` — forks into branches. Phases come from `groupId` (same id
// = one concurrent batch), agents within a phase from `stepName`, and the
// leaves are the per-model variants.
export function stepTree(steps: readonly StepNode[], width: number): StyledText[] {
  type Agent = { stepName: string; models: string[] }
  type Phase = { kind: "agent" | "human"; groupId: string; agents: Agent[] }

  const phases: Phase[] = []
  for (const node of steps) {
    const last = phases[phases.length - 1]
    // Human gates never batch; each is its own phase. Agent steps join the
    // current phase only while the groupId holds (contiguous by construction).
    if (node.kind === "human" || !last || last.kind !== "agent" || last.groupId !== node.groupId) {
      phases.push({ kind: node.kind, groupId: node.groupId, agents: [{ stepName: node.stepName, models: node.modelLabel ? [relationshipLabel(node)] : [] }] })
      continue
    }
    const agent = last.agents.find((candidate) => candidate.stepName === node.stepName)
    if (agent) agent.models.push(relationshipLabel(node))
    else last.agents.push({ stepName: node.stepName, models: [relationshipLabel(node)] })
  }

  const lines: StyledText[] = []
  const fit = (text: string, used: number) => truncate(text, Math.max(6, width - used))

  for (const phase of phases) {
    if (phase.kind === "human") {
      lines.push(new StyledText([fg(theme.faint)("○ "), fg(theme.yellow)(fit(phase.agents[0]!.stepName, 2)), fg(theme.faint)("  · manual gate")]))
      continue
    }
    const total = phase.agents.reduce((sum, agent) => sum + agent.models.length, 0)

    // A lone single-model step is just a sequential leaf, but still show the
    // resolved model so non-multi-model pipelines are as explicit as fanned-out
    // ones.
    if (total === 1) {
      const agent = phase.agents[0]!
      const model = agent.models[0] ?? ""
      const stepName = fitNameWithModel(agent.stepName, model, width)
      const modelLabel = truncate(model, Math.max(1, width - 6 - stepName.length))
      lines.push(new StyledText([fg(theme.faint)("○ "), fg(theme.text)(stepName), fg(theme.faint)("  · "), fg(theme.dim)(modelLabel)]))
      continue
    }

    // One agent, many models: fan the models out under the step node.
    if (phase.agents.length === 1) {
      const agent = phase.agents[0]!
      const name = fit(agent.stepName, 2)
      lines.push(new StyledText([fg(theme.faint)("○ "), fg(theme.text)(name), fg(theme.faint)("  · "), fg(theme.faint)(truncate(`${agent.models.length} models`, Math.max(3, width - 6 - name.length)))]))
      pushModels(lines, agent.models, "  ", width)
      continue
    }

    // A parallel block: several agents run concurrently, each maybe fanned.
    const perAgent = phase.agents[0]!.models.length
    const uniform = perAgent > 1 && phase.agents.every((agent) => agent.models.length === perAgent)
    const annotation = uniform ? `${phase.agents.length} agents × ${perAgent} models` : `${phase.agents.length} agents`
    lines.push(new StyledText([fg(theme.faint)("○ "), fg(theme.text)("parallel"), fg(theme.faint)("  · "), fg(theme.faint)(truncate(annotation, Math.max(3, width - 14)))]))
    phase.agents.forEach((agent, index) => {
      const last = index === phase.agents.length - 1
      const elbow = last ? "└─ " : "├─ "
      if (agent.models.length === 1) {
        const stepName = fit(agent.stepName, 5)
        lines.push(new StyledText([fg(theme.faint)("  " + elbow), fg(theme.text)(stepName), raw("  "), fg(theme.dim)(fit(agent.models[0]!, 7 + stepName.length))]))
      } else {
        lines.push(new StyledText([fg(theme.faint)("  " + elbow), fg(theme.text)(fit(agent.stepName, 5))]))
        pushModels(lines, agent.models, last ? "     " : "  │  ", width)
      }
    })
  }
  return lines
}

function relationshipLabel(node: StepNode): string {
  return node.advisorLabel ? `${node.modelLabel} → ${node.advisorLabel}` : node.modelLabel
}

// Previews the shell hooks that wrap the selected pipeline — global hooks
// plus the pipeline's own — so the launcher shows whether a run has side
// effects configured before it starts. Mirrors the step tree's row shape:
// `○ <stage>  · <label>`, with an extra annotation for non-default post-hook
// `when` values. Stages pad to the same width so labels align across rows.
export function hookLines(hooks: readonly HookNode[], width: number): StyledText[] {
  if (hooks.length === 0) return [new StyledText([sectionLabel("hooks"), fg(theme.faint)("  · none")])]

  const lines: StyledText[] = [new StyledText([sectionLabel("hooks")])]
  for (const hook of hooks) {
    const stage = hook.stage.padEnd(4)
    const annotation = hook.when === "failure" ? "on failure" : hook.when === "always" ? "always" : ""
    const used = 2 + stage.length + 4 + (annotation ? annotation.length + 4 : 0)
    const label = truncate(hook.label, Math.max(6, width - used))
    const chunks: TextChunk[] = [fg(theme.faint)("○ "), fg(theme.teal)(stage), fg(theme.faint)("  · "), fg(theme.text)(label)]
    if (annotation) chunks.push(fg(theme.faint)("  · " + annotation))
    lines.push(new StyledText(chunks))
  }
  return lines
}

// Previews the selected scored pipeline's goal cycle as a scannable loop:
// a distinct section, three policy chips (target, improve-round cap, plateau),
// then measure and improve as subsections — teal fragment headers one indent
// in, their step trees one indent deeper still — measurement zero first,
// improve rounds that re-measure after. Exported pure, like stepTree and
// hookLines beside it, for direct unit tests.
export function goalLines(goal: GoalPreview, width: number): StyledText[] {
  const indent = "  "
  // Fragment headers sit at `indent`; their step trees one level deeper, so
  // the loop's fragments read as subsections of goal rather than peers of it.
  const child = indent + indent
  const inner = Math.max(1, width - indent.length)
  const target = `${goal.target}/100`
  const rounds = `↺ ≤${counted(goal.maxIterations, "round")}`
  const plateau = `plateau ${goal.plateau}`
  const sep = "  · "
  const policyWidth = displayWidth(target) + displayWidth(sep) + displayWidth(rounds) + displayWidth(sep) + displayWidth(plateau)
  const lines: StyledText[] = []
  if (policyWidth <= inner) {
    lines.push(new StyledText([sectionLabel("goal")]))
    lines.push(
      new StyledText([
        raw(indent),
        fg(theme.text)(target),
        fg(theme.faint)(sep),
        fg(theme.dim)(rounds),
        fg(theme.faint)(sep),
        fg(theme.dim)(plateau),
      ]),
    )
  } else {
    const compact = `${target} · ↺${goal.maxIterations} · p${goal.plateau}`
    lines.push(new StyledText([sectionLabel("goal"), fg(theme.faint)("  · "), fg(theme.faint)(truncate(compact, Math.max(0, width - 8)))]))
  }

  const fragment = (label: string, role: string, extra: string | undefined, steps: readonly StepNode[]) => {
    lines.push(fragmentHeader(indent, label, role, extra, width))
    // The fragment tree renders against the narrower child width so the
    // branch indent keeps every row inside the panel.
    for (const line of stepTree(steps, Math.max(1, width - child.length))) lines.push(new StyledText([raw(child), ...line.chunks]))
  }
  fragment("measure", `score ← ${goal.scoreProducer}`, undefined, goal.measure)
  fragment("improve", `brief → ${goal.briefRecipient}`, "then re-measure", goal.improve)
  return lines
}

function fragmentHeader(indent: string, label: string, role: string, extra: string | undefined, width: number): StyledText {
  const prefix = indent + label
  const clauses = extra ? [role, extra] : [role]
  const fits = (parts: string[]) => displayWidth(parts.length === 0 ? prefix : `${prefix}  · ${parts.join("  · ")}`) <= width
  let parts = clauses
  if (!fits(parts) && extra) parts = [extra]
  if (!fits(parts) && extra) parts = ["↺"]
  if (!fits(parts)) parts = role && fits([role]) ? [role] : []
  if (!fits(parts)) parts = []
  const chunks: TextChunk[] = [fg(theme.faint)(indent), fg(theme.teal)(label)]
  if (parts.length > 0) {
    // Join with the same "  · " the rest of the preview uses. `truncate`
    // would collapse those spaces, and `fits` already guaranteed the row.
    chunks.push(fg(theme.faint)("  · "), fg(theme.dim)(parts.join("  · ")))
  }
  return new StyledText(chunks)
}

function counted(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function fitNameWithModel(stepName: string, model: string, width: number) {
  const chrome = 6 // "○ " + "  · "
  const available = Math.max(1, width - chrome)
  const modelBudget = Math.min(model.length, Math.max(1, Math.floor(available / 2)))
  return truncate(stepName, Math.max(1, available - modelBudget))
}

// Model leaves under a step node; `prefix` carries the ancestor spine so the
// leaf connectors line up under the parent's branch.
function pushModels(lines: StyledText[], models: readonly string[], prefix: string, width: number) {
  models.forEach((model, index) => {
    const leaf = index === models.length - 1 ? "└ " : "├ "
    lines.push(new StyledText([fg(theme.faint)(prefix + leaf), fg(theme.dim)(truncate(model, Math.max(6, width - prefix.length - 2)))]))
  })
}
