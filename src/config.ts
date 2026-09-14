import { statSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { projectAgentPromptPath } from "./agents"
import { builtInPrompts } from "./built-in-prompts"
import { log } from "./log"
import { type LoopGuardSettings } from "./loop-guard"
import {
  agentAliases,
  builtInAgents,
  builtInPipelines,
  defaultGptModel,
  defaultGptVariant,
  defaultImplementAdvisorModel,
  defaultImplementAuditModel,
  defaultImplementerModel,
  defaultImplementReviewModel,
  defaultRunReportModel,
  defaultPipelineName,
  humanStepType,
  humanReviewStep,
  isHumanStepSpec,
  isGoalStepSpec,
  isSafeStepName,
  readOnlyAgentSuffix,
  resolvePipeline,
  verifyAgentSuffix,
  type AgentStepSpec,
  type HumanStepSpec,
  type PipelineSpec,
  type StepSpec,
} from "./pipeline"
import { isStepRunnerId, normalizeStepRunnerModel, stepRunnerFor, type StepRunnerId } from "./step-runners"
import type { NotificationSettings } from "./notifications"
import type { AdvisorAuditPolicy } from "./advisor-events"
import type { AgentSpec, HookSet, HookSpec, HooksConfig, HookWhen, PermissionAdditions } from "./types"
import { isModelGateway, logicalModel, modelGatewayChoices, modelGateways, type ModelRoutingConfig, type ModelRoutingOverrides } from "./model-routing"
import { convoyHome, convoyRoot, globalConfigPath } from "./workspace"

/**
 * Project configuration loaded from .convoy/config.yaml. Everything is
 * optional: the file only declares what differs from convoy's defaults.
 */
export type ConvoyConfig = {
  defaults: ConvoyDefaults
  agents: Record<string, ConfigAgent>
  pipelines: Record<string, PipelineSpec>
  permissions: PermissionAdditions
  hooks: HooksConfig
  attachments: string[]
  /** Only the keys the user set; the rest fall back to defaultNotificationSettings. */
  notifications: Partial<NotificationSettings>
  modelRouting?: ModelRoutingConfig
  /**
   * Circuit breaker for an OpenCode phase that is repeating itself. Unset keys
   * keep the built-in defaults; `enabled: false` turns the whole guard off.
   */
  loopGuard?: LoopGuardSettings
  /** Terminal-experience tweaks; only keys the user set take effect. */
  ui?: UiConfig
}

/** TUI motion preferences; see the loading-transition capability. */
export type UiConfig = {
  /**
   * Motion for the home session's loading transition: "auto" (the default)
   * probes the OS reduce-motion setting, "on" always renders a static frame,
   * "off" always animates. The CONVOY_REDUCED_MOTION environment variable
   * outranks this.
   */
  reducedMotion?: "auto" | "on" | "off"
}

export type ConvoyDefaults = {
  model?: string
  /** Cap on agents running concurrently within a group; unset means the built-in default. */
  maxConcurrentAgents?: number
  baseRef?: string
  pipeline?: string
  /** Model for the smart auto-accept judge; falls back to the run's model when unset. */
  autoAcceptJudgeModel?: string
  /** Model that names worktree branches; falls back to the built-in cheap default when unset. */
  branchNameModel?: string
  /** Model that writes the conventional commit message for automatic run compaction and close's squash-merge; falls back to the built-in cheap default. */
  commitMessageModel?: string
  /**
   * Force worktree isolation on (true) or off (false) for every run. Unset is
   * not "on": it decides per branch, isolating only when HEAD sits on a trunk.
   */
  worktree?: boolean
  /**
   * Where isolated worktrees are created, as a path template with optional
   * `{repo}` and `{branch}` placeholders and a leading `~` for home (e.g.
   * `~/dev/worktrees/{repo}/{branch}`). Unset means the built-in
   * `~/.convoy/worktrees/<branch-slug>`; a convention the repo documents for
   * itself outranks this, and an unusable location falls back to the next one.
   */
  worktreeLocation?: string
  /** Persist and attach the git-ignored original PRD history; defaults to true. */
  prdHistory?: boolean
  /** Advising model for every step that doesn't set its own; unset means no advisor anywhere. */
  advisor?: string
  /** Cap on advisor consultations per phase attempt, for steps that don't set their own. */
  advisorMaxCalls?: number
  /** Advisor content retained in events/advisor.jsonl. Hash-only by default. */
  advisorAuditPolicy?: AdvisorAuditPolicy
}

/** A project agent definition, or model/temperature/readOnly overrides for a built-in one. */
export type ConfigAgent = {
  description?: string
  model?: string
  temperature?: number
  /** Disable write/edit/bash tools for this agent. */
  readOnly?: boolean
  /** Advising model for steps using this agent; beats defaults.advisor. */
  advisor?: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

/** Canonical form for user-created pipeline names. */
export function normalizePipelineName(value: string): string {
  return value.trim().toLowerCase()
}

const configFileNames = ["config.yaml", "config.yml"]

export async function loadConvoyConfig(targetDir: string): Promise<ConvoyConfig | undefined> {
  for (const fileName of configFileNames) {
    const path = join(targetDir, ".convoy", fileName)
    let body: string
    try {
      body = await readFile(path, "utf8")
    } catch {
      continue
    }
    return parseConvoyConfig(body, `.convoy/${fileName}`, targetDir)
  }
  return undefined
}

/**
 * The per-user config at ~/.convoy/config.yaml. Parsed with targetDir set to
 * convoyRoot() — the directory that holds `.convoy` — so agent-prompt validation
 * resolves to ~/.convoy/agents/<name>.md, exactly like a project repo.
 */
export async function loadGlobalConvoyConfig(): Promise<ConvoyConfig | undefined> {
  for (const fileName of configFileNames) {
    const path = join(convoyHome(), fileName)
    let body: string
    try {
      body = await readFile(path, "utf8")
    } catch {
      continue
    }
    const config = parseConvoyConfig(body, `~/.convoy/${fileName}`, convoyRoot())
    if (normalizeGlobalPipelineNames(config)) await writeConvoyConfig(path, config, convoyRoot())
    return config
  }
  return undefined
}

/**
 * Migrates pipeline identifiers in the user-level config. Pipeline hooks and
 * the configured default are references to those identifiers, so move them in
 * the same transaction.
 */
function normalizeGlobalPipelineNames(config: ConvoyConfig): boolean {
  const pipelines = normalizePipelineKeyRecord(config.pipelines, "pipelines")
  const hooks = normalizePipelineKeyRecord(config.hooks.pipelines, "hooks.pipelines")
  const defaultPipeline = config.defaults.pipeline === undefined ? undefined : normalizePipelineName(config.defaults.pipeline)
  const defaultChanged = defaultPipeline !== config.defaults.pipeline

  if (!pipelines.changed && !hooks.changed && !defaultChanged) return false

  config.pipelines = pipelines.record
  config.hooks = { ...config.hooks, pipelines: hooks.record }
  if (defaultPipeline === undefined) delete config.defaults.pipeline
  else config.defaults.pipeline = defaultPipeline
  return true
}

function normalizePipelineKeyRecord<T>(record: Record<string, T>, section: string): { record: Record<string, T>; changed: boolean } {
  const normalized: Record<string, T> = {}
  const originalNames = new Map<string, string>()
  let changed = false
  for (const [name, value] of Object.entries(record)) {
    const canonical = normalizePipelineName(name)
    const original = originalNames.get(canonical)
    if (original !== undefined) {
      throw new ConfigError(`${section} contains names "${original}" and "${name}" that collide when lowercased to "${canonical}"`)
    }
    normalized[canonical] = value
    originalNames.set(canonical, name)
    changed ||= canonical !== name
  }
  return { record: normalized, changed }
}

/**
 * Merges the global config under the project one: project keys win on
 * defaults/agents/pipelines (shallow, by key/name), and permissions/hooks/
 * attachments concatenate (global first). deny still wins over allow in
 * bashPolicy, so the concatenation order is irrelevant there.
 */
export function mergeConvoyConfigs(global: ConvoyConfig | undefined, project: ConvoyConfig | undefined): ConvoyConfig | undefined {
  if (!global) return project
  if (!project) return global
  return {
    defaults: { ...global.defaults, ...project.defaults },
    agents: { ...global.agents, ...project.agents },
    pipelines: { ...global.pipelines, ...project.pipelines },
    permissions: {
      allow: [...global.permissions.allow, ...project.permissions.allow],
      deny: [...global.permissions.deny, ...project.permissions.deny],
    },
    hooks: mergeHooksConfig(global.hooks, project.hooks),
    attachments: [...global.attachments, ...project.attachments],
    notifications: { ...global.notifications, ...project.notifications },
    modelRouting: {
      ...(global.modelRouting?.gateway !== undefined ? { gateway: global.modelRouting.gateway } : {}),
      ...(project.modelRouting?.gateway !== undefined ? { gateway: project.modelRouting.gateway } : {}),
      overrides: mergeRoutingOverrides(global.modelRouting?.overrides ?? {}, project.modelRouting?.overrides ?? {}),
    },
    ...(global.loopGuard || project.loopGuard ? { loopGuard: { ...global.loopGuard, ...project.loopGuard } } : {}),
    ...(global.ui || project.ui ? { ui: { ...global.ui, ...project.ui } } : {}),
  }
}

/** The effective config for a run: global merged under the project config. */
export async function loadMergedConvoyConfig(targetDir: string): Promise<ConvoyConfig | undefined> {
  const [global, project] = await Promise.all([loadGlobalConvoyConfig(), loadConvoyConfig(targetDir)])
  return mergeConvoyConfigs(global, project)
}

export function emptyHooksConfig(): HooksConfig {
  return { pre: [], post: [], pipelines: {} }
}

function emptyHookSet(): HookSet {
  return { pre: [], post: [] }
}

function mergeHooksConfig(global: HooksConfig, project: HooksConfig): HooksConfig {
  const pipelineNames = new Set([...Object.keys(global.pipelines), ...Object.keys(project.pipelines)])
  const pipelines: Record<string, HookSet> = {}
  for (const name of pipelineNames) {
    pipelines[name] = mergeHookSet(global.pipelines[name] ?? emptyHookSet(), project.pipelines[name] ?? emptyHookSet())
  }
  return { ...mergeHookSet(global, project), pipelines }
}

function mergeHookSet(global: HookSet, project: HookSet): HookSet {
  return { pre: [...global.pre, ...project.pre], post: [...global.post, ...project.post] }
}

/**
 * The commented YAML template written by `convoy init`. It documents every key
 * (commented out) and inlines the built-in `implement` pipeline so it's an
 * immediately editable starting point. Unlike `defaultConfigTemplate` (used by
 * the TUI's initialize action), this is a human-readable string with comments.
 */
export const defaultConvoyConfig = `# Convoy configuration.
# Global default path: ~/.convoy/config.yaml
# Project override path: .convoy/config.yaml

version: 1

# Route OpenCode models without rewriting pipelines. Project config overrides the global choice.
# modelRouting:
#   gateway: configured # ${modelGateways.join(" | ")}
#   overrides:
#     zai/glm-5.2:
#       openrouter: openrouter/z-ai/glm-5.2
#       nitro: openrouter/z-ai/glm-5.2 # optional; the openrouter fallback alone is enough
#       vercel: vercel/zai/glm-5.2

defaults:
  # model: openai/gpt-5.6-terra#xhigh # optional: uncomment to force every agent unless a step/agent overrides it
  # maxConcurrentAgents: 30 # optional: cap agents running at once within a parallel group
  # baseRef: main # optional: when unset, convoy auto-detects (origin default branch, else main/master/develop/trunk, else current branch)
  # pipeline: full-cycle
  # branchNameModel: openrouter/deepseek/deepseek-v4-flash-0731 # optional: model that names worktree branches
  # commitMessageModel: openai/gpt-5.6-luna # optional: model that writes the conventional commit message for automatic run compaction and close's squash-merge commit
  # worktree: true # optional: force a fresh branch + worktree for every run; false always runs in the current tree. Unset decides per branch: isolate on a trunk (main/master/develop/trunk or the detected base), run in place on any other branch
  # worktreeLocation: ~/dev/worktrees/{repo}/{branch} # optional: where isolated worktrees are created ({repo}/{branch} placeholders, ~ = home; the branch slug is appended when {branch} is missing). A marker in the repo's AGENTS.md/README.md outranks this; unusable locations fall back to ~/.convoy/worktrees
  # prdHistory: true # optional: store a git-ignored copy of each run's prompt in .convoy/prd-history; false disables history writes and scope attachments
  # advisor: anthropic/claude-opus-5 # optional: reviewing model consulted at phase decision points
  # advisorMaxCalls: 1000 # optional: consultation budget per phase attempt; the default is effectively unlimited, set this to put a real cap on it
  # advisorAuditPolicy: summary # summary (hashes), redacted (lengths), or full content retention

# Stop a phase that is going nowhere before it burns the budget. Convoy watches
# the live tool stream: OpenCode's own doom_loop detector only sees repeats
# inside a single turn, which is not how Kimi/GLM loop (one identical call per
# turn, forever). Unset keys use the built-in defaults below. enabled: false
# turns the whole guard off. maxPhaseCost: false disables just the dollar cap.
# loopGuard:
#   enabled: true
#   identicalCalls: 4      # same tool + same args in a row
#   sameToolFailures: 6    # same tool failing in a row (args may drift)
#   maxSteps: 200          # hard budget gate; a best-effort model-only nudge is queued at half this value
#   maxPhaseCost: 20       # USD; false to disable the cost fuse

# Terminal motion for the home session's loading transition. "auto" (the
# default) honors the OS reduce-motion setting; "on" always renders a static
# frame; "off" always animates. The CONVOY_REDUCED_MOTION environment variable
# outranks this.
# ui:
#   reducedMotion: auto

# Agents are matched by name with Markdown prompts next to this config:
#   agents/<name>.md
# Uncomment entries to override metadata/model/temperature or to add custom agents.
# Custom agents must have a matching agents/<name>.md prompt file.
# agents:
#   implementer:
#     description: Implements the feature described in the PRD respecting repo patterns
#     model: openai/gpt-5.6-terra#xhigh
#   design-polisher:
#     description: Polishes new UI following the repo's design system, without redesigning
#     model: openrouter/x-ai/grok-4.6#high
#     temperature: 0.2
#   api-reviewer:
#     description: Reviews API consistency
#     model: openai/gpt-5.6-terra#xhigh

# Convoy ships these pipelines built in; pick one with -p/--pipeline without redeclaring it here:
#   full-cycle           the default: advised implementation, then a verified quality loop to 90/100
#   implement            advised implementation, then audit, polish, test,
#                        and a one-page extractive recap of the whole run (reports/run-report.md)
#   ship                 the close: merge the advanced base in (resolving conflicts), score the merged
#                        result against the rubric, and loop until it clears 90/100 (its terminal
#                        goal step owns the improve/re-score cycle)
#                        wants permissions.allow: git merge*, git add*, git checkout --ours*|--theirs*
#                        and, optionally, hooks.pipelines.ship to fetch the base first / open the PR after
#                        (post-hooks get CONVOY_GOAL_REACHED, so the PR step can require the bar was met)
#   fixer                turn a list of findings into proven regression tests, minimal fixes, and a verdict each
#   review               report-only: parallel audits across two models, one prioritized report, then a verified score
#   hunter               report-only repo audit: six tracks on five models each (30 audits), then consensus
# The \`implement\` pipeline is inlined below as an editable starting point; redefining a name here overrides the built-in.
pipelines:
  implement:
    description: Advised implementation on DeepSeek V4 Flash consulting Astra 6, then pattern/security audits, design polish, tests, and a one-page run recap
    # defaultPrompt and suggestedPrompts are optional. A defaultPrompt is used
    # when the pipeline runs without an explicit prompt — the launcher prefills
    # its field and \`convoy -p <pipeline>\` falls back to it — and the
    # suggestedPrompts list is Tab-cycled through while that field is still
    # clean. Concrete-action pipelines (review, ship, hunter) ship with one; the
    # prompt IS the description here, so implement deliberately has none.
    # defaultPrompt: "Implement the described change and leave it ready for review."
    # suggestedPrompts:
    #   - "Implement the described change and leave it ready for review"
    #   - "Implement it and add tests for the new behavior"
    steps:
      - agent: implementer
        model: ${defaultImplementerModel}
        advisor: ${defaultImplementAdvisorModel}
        reports: none
      # advisor: false rather than an omitted key — omitting it would inherit
      # defaults.advisor and quietly re-advise phases that don't want it.
      - agent: patterns
        model: ${defaultImplementAuditModel}
        advisor: false
      - agent: security
        model: ${defaultImplementReviewModel}
        advisor: false
      - agent: design
        model: ${defaultImplementReviewModel}
        advisor: false
      - agent: tests
        model: ${defaultImplementAuditModel}
        advisor: false
        reports: none
      - agent: run-report
        model: ${defaultRunReportModel}
        advisor: false
        reports: all
        diff: false

# Optional shell hooks. Top-level hooks run for every pipeline; hooks under
# hooks.pipelines.<name> are appended only for that pipeline. Commands run from
# the target repo by default with CONVOY_* environment variables available
# (CONVOY_RUN_ID, CONVOY_RUN_DIR, CONVOY_TARGET_DIR, CONVOY_PIPELINE,
# CONVOY_RUN_STATUS for post-hooks, etc.). Post-hook "when" defaults to success.
# hooks:
#   pre:
#     - pnpm lint
#   post:
#     - command: ./scripts/notify.sh
#       when: always          # success | failure | always
#       continueOnError: true
#   pipelines:
#     implement:
#       post:
#         - name: open-pr
#           command: gh pr create --fill
#           cwd: target       # target | run
#           timeoutSeconds: 120

permissions:
  allow: []
  deny: []

attachments: []

# Desktop notifications and the terminal window/tab title. macOS only; on other
# platforms the notifications degrade to nothing and the title still works.
# One notification per pipeline step, so a parallel block or a models: fan-out
# counts as one, not one per member.
# notifications:
#   enabled: true           # master switch (--no-notify turns it off for one run)
#   steps: true             # a step started / finished
#   waiting: true           # a permission prompt or a human gate needs you
#   failures: true
#   finish: true            # the run completed or failed
#   terminalTitle: true     # "⚙ 3/7 convoy · feat/x" in the tab title
#   sound: ""               # a macOS sound name, e.g. Ping; empty is silent
`

export type ConfigWriteResult = {
  path: string
  created: boolean
}

/** Path of the project config file (default name). */
export function projectConfigPath(targetDir: string) {
  return join(targetDir, ".convoy", "config.yaml")
}

/** Re-exported from workspace so callers don't need both modules. */
export { globalConfigPath }

/** Writes the global config at ~/.convoy/config.yaml. */
export async function writeDefaultGlobalConfig(force = false): Promise<ConfigWriteResult> {
  return writeDefaultConvoyConfig(globalConfigPath(), force)
}

/** Writes a project config at <targetDir>/.convoy/config.yaml. */
export async function writeDefaultProjectConfig(targetDir: string, force = false): Promise<ConfigWriteResult> {
  await assertDirectory(targetDir)
  return writeDefaultConvoyConfig(projectConfigPath(targetDir), force)
}

/**
 * Writes the commented template config. Existing files are left alone unless
 * `force` is set.
 *
 * Deliberately writes no agent prompts. A prompt file under `agents/` shadows
 * its built-in for good (see `loadAgentPrompt`), so seeding all of them froze
 * every prompt at the installed version and silently defeated later upgrades.
 * Prompts are now copied one at a time, on request, by `ejectAgentPrompt`.
 */
export async function writeDefaultConvoyConfig(path: string, force = false): Promise<ConfigWriteResult> {
  const configDir = dirname(path)
  await mkdir(configDir, { recursive: true })
  try {
    await writeFile(path, defaultConvoyConfig, { flag: force ? "w" : "wx" })
    return { path, created: true }
  } catch (error) {
    if (!force && isErrno(error, "EEXIST")) return { path, created: false }
    throw error
  }
}

/**
 * Copies one built-in agent prompt to `<configDir>/agents/<name>.md` so it can
 * be edited as a deliberate override. Only agents are ejectable: the runtime
 * safety and advisor-timing prompts are always read from the built-ins, so a
 * copy of either would be inert and misleading.
 */
export async function ejectAgentPrompt(configDir: string, agentName: string, force = false): Promise<ConfigWriteResult> {
  if (!builtInAgents.some((agent) => agent.name === agentName)) {
    // The pipeline-step aliases are the likeliest near-miss, so resolve rather
    // than just listing 30 names at someone who typed a name convoy accepts.
    const aliased = agentAliases[agentName]
    if (aliased) throw new Error(`${agentName} is a pipeline-step alias; eject the agent itself: convoy agents eject ${aliased}`)
    const names = builtInAgents.map((agent) => agent.name).sort().join(", ")
    throw new Error(`unknown built-in agent: ${agentName}\n\nAvailable agents: ${names}`)
  }
  const body = builtInPrompts[agentName]
  if (body === undefined) throw new Error(`missing built-in prompt: add prompts/${agentName}.md to src/built-in-prompts.ts`)

  const agentsDir = join(configDir, "agents")
  await mkdir(agentsDir, { recursive: true })
  const path = join(agentsDir, `${agentName}.md`)
  try {
    await writeFile(path, body, { flag: force ? "w" : "wx" })
    return { path, created: true }
  } catch (error) {
    if (!force && isErrno(error, "EEXIST")) return { path, created: false }
    throw error
  }
}

async function assertDirectory(path: string) {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch {
    throw new Error(`target directory does not exist: ${path}`)
  }
  if (!info.isDirectory()) throw new Error(`target path is not a directory: ${path}`)
}

function isErrno(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
}

export function parseConvoyConfig(body: string, source: string, targetDir: string): ConvoyConfig {
  let raw: unknown
  try {
    raw = Bun.YAML.parse(body)
  } catch (error) {
    throw new ConfigError(`${source}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }

  const config: ConvoyConfig = { defaults: {}, agents: {}, pipelines: {}, permissions: { allow: [], deny: [] }, hooks: emptyHooksConfig(), attachments: [], notifications: {}, modelRouting: { overrides: {} } }
  if (raw === null || raw === undefined) return config

  const v = new Validator(source)
  const root = v.record(raw, "")
  // Unknown keys warn instead of failing so configs written for a newer
  // convoy still load; typos surface in the warning either way.
  v.knownKeys(root, "", ["version", "defaults", "agents", "pipelines", "permissions", "hooks", "attachments", "notifications", "modelRouting", "loopGuard", "ui"])

  if (root.version !== undefined && root.version !== 1) v.fail("version", `unsupported value ${JSON.stringify(root.version)}; this convoy reads version 1`)

  // Legacy goal configuration is refused before anything else validates, so a
  // legacy scalar or goal-fix pipeline can never load, run, or be silently
  // converted — and every legacy path is named in one diagnostic.
  rejectLegacyGoalConfig(source, root)

  if (root.defaults !== undefined && root.defaults !== null) config.defaults = validateDefaults(v, root.defaults)
  if (root.agents !== undefined) config.agents = validateAgents(v, root.agents, targetDir)
  if (root.pipelines !== undefined) config.pipelines = validatePipelines(v, root.pipelines)
  if (root.permissions !== undefined) config.permissions = validatePermissions(v, root.permissions)
  if (root.hooks !== undefined) config.hooks = validateHooks(v, root.hooks)
  if (root.attachments !== undefined) config.attachments = v.stringArray(root.attachments, "attachments")
  if (root.notifications !== undefined) config.notifications = validateNotifications(v, root.notifications)
  if (root.modelRouting !== undefined) config.modelRouting = validateModelRouting(v, root.modelRouting)
  if (root.loopGuard !== undefined) config.loopGuard = validateLoopGuard(v, root.loopGuard)
  if (root.ui !== undefined) config.ui = validateUi(v, root.ui)

  return config
}

function validateUi(v: Validator, raw: unknown): UiConfig {
  const record = v.record(raw, "ui")
  v.knownKeys(record, "ui", ["reducedMotion"])
  const ui: UiConfig = {}
  if (record.reducedMotion !== undefined) {
    if (record.reducedMotion !== "auto" && record.reducedMotion !== "on" && record.reducedMotion !== "off") {
      v.fail("ui.reducedMotion", 'must be "auto", "on", or "off"')
    }
    ui.reducedMotion = record.reducedMotion as UiConfig["reducedMotion"]
  }
  return ui
}

/**
 * Only the keys the user actually set are returned, so an unset switch keeps
 * following defaultNotificationSettings rather than being pinned to whatever
 * the default happened to be when the file was written.
 */
function validateNotifications(v: Validator, raw: unknown): Partial<NotificationSettings> {
  const record = v.record(raw, "notifications")
  const booleans = ["enabled", "steps", "waiting", "failures", "finish", "terminalTitle"] as const
  v.knownKeys(record, "notifications", [...booleans, "sound"])

  const notifications: Partial<NotificationSettings> = {}
  for (const key of booleans) {
    if (record[key] !== undefined) notifications[key] = v.boolean(record[key], `notifications.${key}`)
  }
  if (record.sound !== undefined) {
    // Empty is meaningful here (silent), so this can't use nonEmptyString.
    if (typeof record.sound !== "string") v.fail("notifications.sound", "must be a string")
    const sound = (record.sound as string).trim()
    // The name reaches AppleScript; anything exotic is a mistake worth
    // surfacing at load time rather than silently dropping at notify time.
    if (sound && !/^[A-Za-z0-9 _-]+$/.test(sound)) {
      v.fail("notifications.sound", "must be a macOS sound name (letters, digits, spaces, - and _), e.g. Ping")
    }
    notifications.sound = sound
  }
  return notifications
}

function validateModelRouting(v: Validator, raw: unknown): ModelRoutingConfig {
  const record = v.record(raw, "modelRouting")
  v.knownKeys(record, "modelRouting", ["gateway", "overrides"])
  const routing: ModelRoutingConfig = { overrides: {} }
  if (record.gateway !== undefined) {
    if (!isModelGateway(record.gateway)) v.fail("modelRouting.gateway", `must be ${modelGatewayChoices()}`)
    routing.gateway = record.gateway
  }
  if (record.overrides !== undefined) {
    const overrides = v.record(record.overrides, "modelRouting.overrides")
    const seenCanonical = new Map<string, string>()
    for (const [logical, rawTargets] of Object.entries(overrides)) {
      if (!isValidModelString(logical)) v.fail(`modelRouting.overrides.${logical}`, "key must be a provider/model")
      // Keys name the canonical logical model, exactly as resolveModel recovers
      // it: wrapped gateway prefixes are unwrapped and known aliases (z-ai/zai)
      // are normalized, so "openrouter/z-ai/glm-5.2" and "zai/glm-5.2" are the
      // same override.
      let canonical: string
      try {
        canonical = logicalModel(logical).model
      } catch (error) {
        v.fail(`modelRouting.overrides.${logical}`, error instanceof Error ? error.message : String(error))
      }
      const previous = seenCanonical.get(canonical)
      if (previous !== undefined) {
        v.fail(
          `modelRouting.overrides.${logical}`,
          `canonicalizes to "${canonical}", same as "${previous}"; use one override key`,
        )
      }
      seenCanonical.set(canonical, logical)
      const targets = v.record(rawTargets, `modelRouting.overrides.${logical}`)
      v.knownKeys(targets, `modelRouting.overrides.${logical}`, [...modelGateways])
      const parsed: Partial<Record<import("./model-routing").ModelGateway, string>> = {}
      for (const [gateway, target] of Object.entries(targets)) {
        if (!isModelGateway(gateway)) continue
        parsed[gateway] = v.model(target, `modelRouting.overrides.${logical}.${gateway}`)
      }
      routing.overrides[canonical] = parsed
    }
  }
  return routing
}

function validateLoopGuard(v: Validator, raw: unknown): LoopGuardSettings {
  const record = v.record(raw, "loopGuard")
  v.knownKeys(record, "loopGuard", ["enabled", "identicalCalls", "sameToolFailures", "maxSteps", "maxPhaseCost"])

  const settings: LoopGuardSettings = {}
  if (record.enabled !== undefined) settings.enabled = v.boolean(record.enabled, "loopGuard.enabled")
  if (record.identicalCalls !== undefined) settings.identicalCalls = v.rangeInt(record.identicalCalls, "loopGuard.identicalCalls", 2, 500)
  if (record.sameToolFailures !== undefined) settings.sameToolFailures = v.rangeInt(record.sameToolFailures, "loopGuard.sameToolFailures", 2, 500)
  if (record.maxSteps !== undefined) settings.maxSteps = v.rangeInt(record.maxSteps, "loopGuard.maxSteps", 10, 1000)
  if (record.maxPhaseCost !== undefined) {
    if (record.maxPhaseCost === false) settings.maxPhaseCost = false
    else settings.maxPhaseCost = v.positiveNumber(record.maxPhaseCost, "loopGuard.maxPhaseCost")
  }
  return settings
}

function mergeRoutingOverrides(global: ModelRoutingOverrides, project: ModelRoutingOverrides): ModelRoutingOverrides {
  const result: ModelRoutingOverrides = structuredClone(global)
  for (const [model, targets] of Object.entries(project)) result[model] = { ...(result[model] ?? {}), ...targets }
  return result
}

/** Warns once (not per parse) that a legacy maxAttempts key is being ignored. */
let warnedIgnoredMaxAttempts = false
function warnIgnoredMaxAttempts() {
  if (warnedIgnoredMaxAttempts) return
  warnedIgnoredMaxAttempts = true
  log.warn("maxAttempts is no longer used; a failed step now waits for your decision")
}

function validateDefaults(v: Validator, raw: unknown): ConvoyDefaults {
  const record = v.record(raw, "defaults")
  v.knownKeys(record, "defaults", [
    "model",
    // Accepted so a legacy config that still sets it parses, then warned about
    // and ignored: a failed step now waits for the user's decision, so there is
    // no per-step attempt cap to configure.
    "maxAttempts",
    "maxConcurrentAgents",
    "baseRef",
    "pipeline",
    "autoAcceptJudgeModel",
    "branchNameModel",
    "commitMessageModel",
    "worktree",
    "worktreeLocation",
    "prdHistory",
    "advisor",
    "advisorMaxCalls",
    "advisorAuditPolicy",
  ])

  const defaults: ConvoyDefaults = {}
  if (record.model !== undefined) defaults.model = v.model(record.model, "defaults.model")
  if (record.maxAttempts !== undefined) warnIgnoredMaxAttempts()
  if (record.maxConcurrentAgents !== undefined) defaults.maxConcurrentAgents = v.positiveInt(record.maxConcurrentAgents, "defaults.maxConcurrentAgents")
  if (record.baseRef !== undefined) defaults.baseRef = v.nonEmptyString(record.baseRef, "defaults.baseRef")
  if (record.pipeline !== undefined) defaults.pipeline = v.nonEmptyString(record.pipeline, "defaults.pipeline")
  if (record.autoAcceptJudgeModel !== undefined) defaults.autoAcceptJudgeModel = v.model(record.autoAcceptJudgeModel, "defaults.autoAcceptJudgeModel")
  if (record.branchNameModel !== undefined) defaults.branchNameModel = v.model(record.branchNameModel, "defaults.branchNameModel")
  if (record.commitMessageModel !== undefined) defaults.commitMessageModel = v.model(record.commitMessageModel, "defaults.commitMessageModel")
  if (record.worktree !== undefined) defaults.worktree = v.boolean(record.worktree, "defaults.worktree")
  if (record.worktreeLocation !== undefined) defaults.worktreeLocation = v.nonEmptyString(record.worktreeLocation, "defaults.worktreeLocation")
  if (record.prdHistory !== undefined) defaults.prdHistory = v.boolean(record.prdHistory, "defaults.prdHistory")
  if (record.advisor !== undefined) defaults.advisor = v.model(record.advisor, "defaults.advisor")
  if (record.advisorMaxCalls !== undefined) defaults.advisorMaxCalls = v.positiveInt(record.advisorMaxCalls, "defaults.advisorMaxCalls")
  if (record.advisorAuditPolicy !== undefined) {
    const policy = v.nonEmptyString(record.advisorAuditPolicy, "defaults.advisorAuditPolicy")
    if (policy !== "summary" && policy !== "redacted" && policy !== "full") v.fail("defaults.advisorAuditPolicy", "must be summary, redacted, or full")
    defaults.advisorAuditPolicy = policy as AdvisorAuditPolicy
  }
  return defaults
}

function validateAgents(v: Validator, raw: unknown, targetDir: string): Record<string, ConfigAgent> {
  const record = v.record(raw, "agents")
  const agents: Record<string, ConfigAgent> = {}

  for (const [name, value] of Object.entries(record)) {
    const path = `agents.${name}`
    validateStepName(v, name, path)
    if (name === humanReviewStep) v.fail(path, `"${humanReviewStep}" is a reserved step keyword, not an agent`)
    if (agentAliases[name]) v.fail(path, `"${name}" is an alias of the built-in agent "${agentAliases[name]}"; use that name to override it`)
    if (name.endsWith(readOnlyAgentSuffix)) v.fail(path, `agent names can't end in "${readOnlyAgentSuffix}"; that suffix is reserved for convoy's forced-read-only variants`)
    if (name.endsWith(verifyAgentSuffix)) v.fail(path, `agent names can't end in "${verifyAgentSuffix}"; that suffix is reserved for convoy's verifying-step variants`)

    const entry = v.record(value, path)
    v.knownKeys(entry, path, ["description", "model", "temperature", "readOnly", "advisor"])

    const agent: ConfigAgent = {}
    if (entry.description !== undefined) agent.description = v.nonEmptyString(entry.description, `${path}.description`)
    if (entry.model !== undefined) agent.model = v.model(entry.model, `${path}.model`)
    if (entry.temperature !== undefined) agent.temperature = v.temperature(entry.temperature, `${path}.temperature`)
    if (entry.readOnly !== undefined) agent.readOnly = v.boolean(entry.readOnly, `${path}.readOnly`)
    if (entry.advisor !== undefined) agent.advisor = v.model(entry.advisor, `${path}.advisor`)

    // Project agents bring their own prompt; built-in overrides keep theirs
    // (optionally replaced via the same path). Fail at load, not mid-run.
    const builtIn = builtInAgents.some((candidate) => candidate.name === name)
    if (!builtIn && !isFile(projectAgentPromptPath(name, targetDir))) {
      v.fail(path, `agent "${name}" needs a prompt at .convoy/agents/${name}.md`)
    }

    agents[name] = agent
  }
  return agents
}

function validatePipelines(v: Validator, raw: unknown): Record<string, PipelineSpec> {
  const record = v.record(raw, "pipelines")
  const pipelines: Record<string, PipelineSpec> = {}

  for (const [name, value] of Object.entries(record)) {
    const path = `pipelines.${name}`
    const entry = v.record(value, path)
    v.knownKeys(entry, path, ["description", "maxConcurrentAgents", "defaultPrompt", "suggestedPrompts", "steps"])

    if (!Array.isArray(entry.steps) || entry.steps.length === 0) v.fail(`${path}.steps`, "must be a non-empty list of steps")
    const steps = (entry.steps as unknown[]).map((step, index) => validateStep(v, step, `${path}.steps[${index}]`))

    // The default prompt and its Tab-cycleable suggestions are optional; when
    // present they must be non-empty so a pipeline can never silently fall back
    // to a blank prompt.
    const defaultPrompt =
      entry.defaultPrompt !== undefined ? v.nonEmptyString(entry.defaultPrompt, `${path}.defaultPrompt`) : undefined

    let suggestedPrompts: string[] | undefined
    if (entry.suggestedPrompts !== undefined) {
      if (!Array.isArray(entry.suggestedPrompts)) v.fail(`${path}.suggestedPrompts`, "must be a list of non-empty strings")
      suggestedPrompts = (entry.suggestedPrompts as unknown[]).map((suggestion, index) => {
        const suggestionPath = `${path}.suggestedPrompts[${index}]`
        const value = v.nonEmptyString(suggestion, suggestionPath)
        return value.trim()
      })
    }

    pipelines[name] = {
      ...(entry.description !== undefined ? { description: v.nonEmptyString(entry.description, `${path}.description`) } : {}),
      ...(entry.maxConcurrentAgents !== undefined ? { maxConcurrentAgents: v.positiveInt(entry.maxConcurrentAgents, `${path}.maxConcurrentAgents`) } : {}),
      ...(defaultPrompt !== undefined ? { defaultPrompt } : {}),
      ...(suggestedPrompts !== undefined && suggestedPrompts.length > 0 ? { suggestedPrompts } : {}),
      steps,
    }
  }
  return pipelines
}

type StepContext = { insideParallel?: boolean; insideGoalFragment?: boolean }

/**
 * Scans the raw pipelines mapping for every legacy goal shape — pipeline-level
 * scalar `goal`/`goalMaxIterations`/`goalPlateau`, and a top-level pipeline
 * named `goal-fix` — and fails the load with one aggregated diagnostic that
 * names every path and prints a copyable terminal-goal-step skeleton. It never
 * writes or mutates the operator's file: the skeleton is advisory text only.
 */
function rejectLegacyGoalConfig(source: string, root: Record<string, unknown>): void {
  const pipelines = root.pipelines
  if (!pipelines || typeof pipelines !== "object" || Array.isArray(pipelines)) return

  const paths: string[] = []
  const scalarOwners: { name: string; entry: Record<string, unknown> }[] = []
  let goalFixSteps: unknown
  for (const [name, value] of Object.entries(pipelines as Record<string, unknown>)) {
    if (name === "goal-fix") {
      paths.push(`pipelines.goal-fix — a top-level "goal-fix" pipeline is reserved; declare its steps inside the owning pipeline's terminal goal step`)
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const entry = value as Record<string, unknown>
        if (Array.isArray(entry.steps)) goalFixSteps = entry.steps
      }
      continue
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const scalars = (["goal", "goalMaxIterations", "goalPlateau"] as const).filter((key) => entry[key] !== undefined)
    if (scalars.length > 0) {
      paths.push(...scalars.map((key) => `pipelines.${name}.${key} — goal policy belongs in a terminal \`goal\` step`))
      scalarOwners.push({ name, entry })
    }
  }
  if (paths.length === 0) return

  const skeletonOwners = scalarOwners.length > 0 ? scalarOwners : [{ name: "<your-pipeline>", entry: {} as Record<string, unknown> }]
  const skeletons = skeletonOwners.map(({ name, entry }) => {
    const target = typeof entry.goal === "number" ? entry.goal : "<1-100>"
    const maxIterations = typeof entry.goalMaxIterations === "number" ? entry.goalMaxIterations : 3
    const plateau = typeof entry.goalPlateau === "number" ? entry.goalPlateau : 3
    const lines = [
      `  pipelines:`,
      `    ${name}:`,
      `      # the terminal goal step must be the pipeline's final step`,
      `      steps:`,
      `        # ...keep the pipeline's ordinary steps here...`,
      `        - goal:`,
      `            target: ${target}`,
      `            maxIterations: ${maxIterations}`,
      `            plateau: ${plateau}`,
      `            improve:`,
      `              briefStep: fix # the improve step that alone receives the score brief`,
      `              steps:`,
      `                - # your directed-fix step(s), able to modify the repository`,
      `            measure:`,
      `              steps:`,
      `                - # read-only scoring steps ending in exactly one quality-score deliverable`,
    ]
    if (goalFixSteps !== undefined) {
      lines.push(`        # source material from pipelines.goal-fix — split these between improve and measure yourself:`)
      for (const line of Bun.YAML.stringify(goalFixSteps).trimEnd().split("\n")) {
        lines.push(`        # ${line}`)
      }
    }
    return lines.join("\n")
  })

  throw new ConfigError(
    [
      `${source}: legacy goal configuration can no longer run and must migrate to the embedded goal step:`,
      ...paths.map((path) => `  - ${path}`),
      "",
      "Goal mode is enabled exclusively by a terminal `goal` step (the pipeline's last step);",
      "there are no goal CLI flags and no separate goal-fix pipeline. Equivalent skeleton:",
      "",
      ...skeletons,
    ].join("\n"),
  )
}

function validateStep(v: Validator, raw: unknown, path: string, context: StepContext = {}): StepSpec {
  if (typeof raw === "string") {
    if (!raw.trim()) v.fail(path, "step name can't be empty")
    if (!isSafeStepName(raw)) v.fail(path, "must be a filesystem-safe identifier using letters, numbers, hyphens, or underscores")
    if (context.insideParallel && raw.trim() === humanReviewStep) v.fail(path, `"${humanReviewStep}" can't run inside a parallel block`)
    return raw
  }

  const record = v.record(raw, path)

  if ("goal" in record) {
    if (context.insideParallel) v.fail(path, "goal steps can't run inside a parallel block")
    if (context.insideGoalFragment) v.fail(path, "goal steps can't nest inside a goal fragment")
    v.knownKeys(record, path, ["goal"])
    const node = v.record(record.goal, `${path}.goal`)
    v.knownKeys(node, `${path}.goal`, ["target", "maxIterations", "plateau", "improve", "measure"])
    if (node.target === undefined) v.fail(`${path}.goal.target`, "is required: an integer from 1 through 100")
    const target = v.rangeInt(node.target, `${path}.goal.target`, 1, 100)
    const maxIterations = node.maxIterations !== undefined ? v.positiveInt(node.maxIterations, `${path}.goal.maxIterations`) : undefined
    const plateau = node.plateau !== undefined ? v.positiveInt(node.plateau, `${path}.goal.plateau`) : undefined

    const fragmentSteps = (value: unknown, fragmentPath: string): StepSpec[] => {
      const fragment = v.record(value, fragmentPath)
      if (!Array.isArray(fragment.steps) || fragment.steps.length === 0) {
        v.fail(`${fragmentPath}.steps`, "must be a non-empty list of steps")
      }
      return (fragment.steps as unknown[]).map((step, index) => validateStep(v, step, `${fragmentPath}.steps[${index}]`, { insideGoalFragment: true }))
    }

    if (node.improve === undefined) v.fail(`${path}.goal.improve`, "is required: a mapping with briefStep and steps")
    const improve = v.record(node.improve, `${path}.goal.improve`)
    v.knownKeys(improve, `${path}.goal.improve`, ["briefStep", "steps"])
    const briefStep = v.nonEmptyString(improve.briefStep, `${path}.goal.improve.briefStep`)
    const improveSteps = fragmentSteps(node.improve, `${path}.goal.improve`)

    if (node.measure === undefined) v.fail(`${path}.goal.measure`, "is required: { steps }")
    const measure = v.record(node.measure, `${path}.goal.measure`)
    v.knownKeys(measure, `${path}.goal.measure`, ["steps"])
    const measureSteps = fragmentSteps(node.measure, `${path}.goal.measure`)

    return {
      goal: {
        target,
        ...(maxIterations !== undefined ? { maxIterations } : {}),
        ...(plateau !== undefined ? { plateau } : {}),
        improve: { briefStep, steps: improveSteps },
        measure: { steps: measureSteps },
      },
    }
  }

  if ("parallel" in record) {
    if (context.insideParallel) v.fail(path, "parallel blocks can't be nested")
    v.knownKeys(record, path, ["parallel"])
    if (!Array.isArray(record.parallel) || record.parallel.length === 0) v.fail(`${path}.parallel`, "must be a non-empty list of steps")
    const members = (record.parallel as unknown[]).map((step, index) =>
      validateStep(v, step, `${path}.parallel[${index}]`, { insideParallel: true, ...(context.insideGoalFragment ? { insideGoalFragment: true } : {}) }),
    )
    return { parallel: members as (string | AgentStepSpec)[] }
  }

  if ("type" in record) {
    if (context.insideParallel) v.fail(path, "human steps can't run inside a parallel block")
    if (context.insideGoalFragment) v.fail(path, "human steps can't run inside a goal fragment")
    v.knownKeys(record, path, ["type", "name", "description"])
    if (record.type !== humanStepType) v.fail(`${path}.type`, `must be "${humanStepType}"`)
    const step: HumanStepSpec = { type: humanStepType }
    if (record.name !== undefined) step.name = validateStepName(v, record.name, `${path}.name`)
    if (record.description !== undefined) step.description = v.nonEmptyString(record.description, `${path}.description`)
    return step
  }

  v.knownKeys(record, path, ["agent", "name", "model", "models", "runner", "advisor", "advisorMaxCalls", "maxAttempts", "reports", "diff", "verify", "prdHistory", "deliverable"])

  const agent = validateStepName(v, record.agent, `${path}.agent`)
  if (context.insideParallel && agent === humanReviewStep) v.fail(path, `"${humanReviewStep}" can't run inside a parallel block`)
  if (record.model !== undefined && record.models !== undefined) v.fail(path, `set either "model" or "models", not both`)

  const runner = record.runner !== undefined ? validateRunner(v, record.runner, `${path}.runner`) : undefined
  if (!stepRunnerFor(runner).capabilities.modelFanout && record.models !== undefined) {
    v.fail(path, `can't combine runner: ${runner} with "models"; give the step a single model (or none for the CLI default)`)
  }
  if (!stepRunnerFor(runner).capabilities.advisor && record.advisor !== undefined && record.advisor !== false) {
    v.fail(`${path}.advisor`, `runner: ${runner} does not support an advisor; remove it or drop the runner`)
  }

  const advisor = record.advisor === undefined ? undefined : validateStepAdvisor(v, record.advisor, `${path}.advisor`)
  if (record.advisorMaxCalls !== undefined && advisor === false) {
    v.fail(`${path}.advisorMaxCalls`, `is meaningless with advisor: false; remove one of them`)
  }

  let models: string[] | undefined
  if (record.models !== undefined) {
    models = v.stringArray(record.models, `${path}.models`)
    if (models.length < 2) v.fail(`${path}.models`, `must have at least 2 entries; use "model" for a single model`)
    models.forEach((model, index) => v.model(model, `${path}.models[${index}]`))
  }

  const model =
    record.model === undefined
      ? undefined
      : validateStepRunnerModel(v, runner ?? "opencode", record.model, `${path}.model`)

  if (record.maxAttempts !== undefined) warnIgnoredMaxAttempts()

  return {
    agent,
    ...(record.name !== undefined ? { name: validateStepName(v, record.name, `${path}.name`) } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(runner !== undefined ? { runner } : {}),
    ...(advisor !== undefined ? { advisor } : {}),
    ...(record.advisorMaxCalls !== undefined ? { advisorMaxCalls: v.positiveInt(record.advisorMaxCalls, `${path}.advisorMaxCalls`) } : {}),
    ...(record.reports !== undefined ? { reports: validateReports(v, record.reports, `${path}.reports`) } : {}),
    ...(record.diff !== undefined ? { diff: v.boolean(record.diff, `${path}.diff`) } : {}),
    ...(record.verify !== undefined ? { verify: v.boolean(record.verify, `${path}.verify`) } : {}),
    ...(record.prdHistory !== undefined ? { prdHistory: v.boolean(record.prdHistory, `${path}.prdHistory`) } : {}),
    ...(record.deliverable !== undefined ? { deliverable: validateDeliverable(v, record.deliverable, `${path}.deliverable`) } : {}),
  }
}

/** The only explicit deliverable override: an arbitrarily named step can produce the machine-readable score a measure fragment ends in. */
function validateDeliverable(v: Validator, raw: unknown, path: string): "quality-score" | "markdown" {
  if (raw !== "quality-score" && raw !== "markdown") v.fail(path, `must be "quality-score" or "markdown"`)
  return raw
}

function validateStepName(v: Validator, raw: unknown, path: string): string {
  const value = v.nonEmptyString(raw, path)
  if (!isSafeStepName(value)) v.fail(path, "must be a filesystem-safe identifier using letters, numbers, hyphens, or underscores")
  return value
}

function validateRunner(v: Validator, raw: unknown, path: string): StepRunnerId {
  if (isStepRunnerId(raw)) return raw
  return v.fail(path, `must be "opencode" or "claude-code"`)
}

/**
 * A step's advisor is either a model or the literal `false`, which opts the step
 * out of an advisor inherited from its agent or from defaults. Unlike `model`,
 * the advisor always names an OpenCode model: it is consulted through the
 * OpenCode session API regardless of which engine runs the step.
 */
function validateStepAdvisor(v: Validator, raw: unknown, path: string): string | false {
  if (raw === false) return false
  if (raw === true) v.fail(path, `must be a model like "anthropic/claude-opus-5", or false to disable; true is not a model`)
  return v.model(raw, path)
}

function validateStepRunnerModel(v: Validator, runner: StepRunnerId, raw: unknown, path: string): string {
  const value = v.nonEmptyString(raw, path)
  try {
    return normalizeStepRunnerModel(runner, value)
  } catch (error) {
    return v.fail(path, error instanceof Error ? error.message : String(error))
  }
}

function validateReports(v: Validator, raw: unknown, path: string): "previous" | "all" | "none" | string[] {
  if (raw === "previous" || raw === "all" || raw === "none") return raw
  if (Array.isArray(raw)) return v.stringArray(raw, path)
  return v.fail(path, `must be "previous", "all", "none", or a list of step names`)
}

function validatePermissions(v: Validator, raw: unknown): PermissionAdditions {
  const record = v.record(raw, "permissions")
  if (record.yolo !== undefined) v.fail("permissions.yolo", "is not supported: a repo must not grant itself permissions; --yolo is per-invocation only")
  v.knownKeys(record, "permissions", ["allow", "deny"])

  return {
    allow: record.allow !== undefined ? v.stringArray(record.allow, "permissions.allow") : [],
    deny: record.deny !== undefined ? v.stringArray(record.deny, "permissions.deny") : [],
  }
}

function validateHooks(v: Validator, raw: unknown): HooksConfig {
  const record = v.record(raw, "hooks")
  v.knownKeys(record, "hooks", ["pre", "post", "pipelines"])

  const hooks: HooksConfig = {
    pre: record.pre !== undefined ? validateHookList(v, record.pre, "hooks.pre", "pre") : [],
    post: record.post !== undefined ? validateHookList(v, record.post, "hooks.post", "post") : [],
    pipelines: {},
  }

  if (record.pipelines !== undefined) {
    const pipelines = v.record(record.pipelines, "hooks.pipelines")
    for (const [pipeline, value] of Object.entries(pipelines)) {
      if (!pipeline.trim()) v.fail("hooks.pipelines", "pipeline name can't be empty")
      const path = `hooks.pipelines.${pipeline}`
      hooks.pipelines[pipeline] = validateHookSet(v, value, path)
    }
  }

  return hooks
}

function validateHookSet(v: Validator, raw: unknown, path: string): HookSet {
  const record = v.record(raw, path)
  v.knownKeys(record, path, ["pre", "post"])
  return {
    pre: record.pre !== undefined ? validateHookList(v, record.pre, `${path}.pre`, "pre") : [],
    post: record.post !== undefined ? validateHookList(v, record.post, `${path}.post`, "post") : [],
  }
}

function validateHookList(v: Validator, raw: unknown, path: string, stage: "pre" | "post"): HookSpec[] {
  if (!Array.isArray(raw)) v.fail(path, "must be a list of hook commands")
  return raw.map((entry, index) => validateHook(v, entry, `${path}[${index}]`, stage))
}

function validateHook(v: Validator, raw: unknown, path: string, stage: "pre" | "post"): HookSpec {
  if (typeof raw === "string") return { command: v.nonEmptyString(raw, path) }

  const record = v.record(raw, path)
  v.knownKeys(record, path, stage === "post" ? ["name", "command", "when", "continueOnError", "timeoutSeconds", "cwd"] : ["name", "command", "continueOnError", "timeoutSeconds", "cwd"])

  const hook: HookSpec = { command: v.nonEmptyString(record.command, `${path}.command`) }
  if (record.name !== undefined) hook.name = v.nonEmptyString(record.name, `${path}.name`)
  if (stage === "post" && record.when !== undefined) hook.when = validateHookWhen(v, record.when, `${path}.when`)
  if (record.continueOnError !== undefined) hook.continueOnError = v.boolean(record.continueOnError, `${path}.continueOnError`)
  if (record.timeoutSeconds !== undefined) hook.timeoutSeconds = v.positiveInt(record.timeoutSeconds, `${path}.timeoutSeconds`)
  if (record.cwd !== undefined) {
    if (record.cwd !== "target" && record.cwd !== "run") v.fail(`${path}.cwd`, 'must be "target" or "run"')
    hook.cwd = record.cwd
  }
  return hook
}

function validateHookWhen(v: Validator, raw: unknown, path: string): HookWhen {
  if (raw === "success" || raw === "failure" || raw === "always") return raw
  return v.fail(path, 'must be "success", "failure", or "always"')
}

/** Built-in agents plus the project's additions and overrides. */
export function buildAgentRegistry(config?: ConvoyConfig): AgentSpec[] {
  const registry: AgentSpec[] = builtInAgents.map((agent) => ({ ...agent }))
  if (!config) return registry

  for (const [name, agent] of Object.entries(config.agents)) {
    const existing = registry.find((candidate) => candidate.name === name)
    if (existing) {
      if (agent.description !== undefined) existing.description = agent.description
      if (agent.model !== undefined) existing.model = agent.model
      if (agent.temperature !== undefined) existing.temperature = agent.temperature
      if (agent.readOnly !== undefined) existing.readOnly = agent.readOnly
      if (agent.advisor !== undefined) existing.advisor = agent.advisor
      continue
    }
    registry.push({
      name,
      description: agent.description ?? `Project agent ${name}`,
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      ...(agent.readOnly !== undefined ? { readOnly: agent.readOnly } : {}),
      ...(agent.advisor !== undefined ? { advisor: agent.advisor } : {}),
      builtIn: false,
    })
  }
  return registry
}

/** Project pipelines shadow built-ins of the same name (including "full-cycle", the default). */
export function selectPipelineSpec(config: ConvoyConfig | undefined, name: string): PipelineSpec {
  const spec = config?.pipelines[name] ?? builtInPipelines[name]
  if (spec) return spec
  const available = [...new Set([...Object.keys(builtInPipelines), ...Object.keys(config?.pipelines ?? {})])].sort()
  throw new ConfigError(`unknown pipeline "${name}" (available: ${available.join(", ")})`)
}

/** True when a string is a valid `provider/model` or `provider/model#variant`. Shared by config validation and the config TUI. */
export function isValidModelString(value: string): boolean {
  try {
    normalizeStepRunnerModel("opencode", value)
    return true
  } catch {
    return false
  }
}

/** Serializes a config back to YAML, omitting empty sections, with `version: 1` first. Comments are not preserved. */
export function serializeConvoyConfig(config: ConvoyConfig): string {
  const out: Record<string, unknown> = { version: 1 }
  if (Object.keys(config.defaults).length > 0) out.defaults = config.defaults
  if (Object.keys(config.agents).length > 0) out.agents = config.agents
  if (Object.keys(config.pipelines).length > 0) out.pipelines = config.pipelines
  const permissions: Record<string, string[]> = {}
  if (config.permissions.allow.length > 0) permissions.allow = config.permissions.allow
  if (config.permissions.deny.length > 0) permissions.deny = config.permissions.deny
  if (Object.keys(permissions).length > 0) out.permissions = permissions
  const hooks = serializeHooks(config.hooks)
  if (hooks) out.hooks = hooks
  if (config.attachments.length > 0) out.attachments = config.attachments
  if (Object.keys(config.notifications).length > 0) out.notifications = config.notifications
  if (config.modelRouting && (config.modelRouting.gateway !== undefined || Object.keys(config.modelRouting.overrides).length > 0)) out.modelRouting = config.modelRouting
  if (config.loopGuard && Object.keys(config.loopGuard).length > 0) out.loopGuard = config.loopGuard
  if (config.ui && Object.keys(config.ui).length > 0) out.ui = config.ui
  return Bun.YAML.stringify(out, null, 2)
}

function serializeHooks(hooks: HooksConfig): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  if (hooks.pre.length > 0) out.pre = hooks.pre
  if (hooks.post.length > 0) out.post = hooks.post

  const pipelines: Record<string, unknown> = {}
  for (const [name, set] of Object.entries(hooks.pipelines)) {
    const entry: Record<string, unknown> = {}
    if (set.pre.length > 0) entry.pre = set.pre
    if (set.post.length > 0) entry.post = set.post
    if (Object.keys(entry).length > 0) pipelines[name] = entry
  }
  if (Object.keys(pipelines).length > 0) out.pipelines = pipelines
  return Object.keys(out).length > 0 ? out : undefined
}

/** Serializes, validates by re-parsing, then writes. Never persists YAML that wouldn't load back. */
export async function writeConvoyConfig(path: string, config: ConvoyConfig, targetDir: string): Promise<void> {
  const body = serializeConvoyConfig(config)
  parseConvoyConfig(body, path, targetDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, "utf8")
}

/**
 * Boilerplate written by the config TUI's "initialize" action: the current
 * effective defaults plus the default pipeline expanded so it stays editable.
 * Agent model preferences that differ from defaults.model are inlined on their
 * steps, because defaults.model would otherwise shadow them.
 */
export function defaultConfigTemplate(): ConvoyConfig {
  const globalModel = `${defaultGptModel}#${defaultGptVariant}`
  return {
    defaults: { model: globalModel },
    agents: {},
    pipelines: { [defaultPipelineName]: materializePipelineSpec(builtInPipelines[defaultPipelineName]!, globalModel) },
    permissions: { allow: [], deny: [] },
    hooks: emptyHooksConfig(),
    attachments: [],
    notifications: {},
    modelRouting: { overrides: {} },
  }
}

/**
 * Copies a pipeline spec into a config-editable form. Deep-copied, so editing
 * the result can never mutate the source (the built-in specs are shared module
 * constants). When effectiveDefaultModel is set, built-in agent model
 * preferences that differ from it are inlined on their steps, because
 * defaults.model would otherwise shadow them at resolve time; when it's unset
 * the precedence chain already applies them, so steps stay unpinned.
 */
export function materializePipelineSpec(spec: PipelineSpec, effectiveDefaultModel?: string): PipelineSpec {
  const steps = spec.steps.map<StepSpec>((raw) => materializeStep(raw, effectiveDefaultModel))
  // The terminal goal step travels with the copy, fragments included: `ship`
  // carries its target and subflows in its spec, so dropping them here would
  // turn "customize this built-in" into "silently disable its loop".
  return {
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.maxConcurrentAgents !== undefined ? { maxConcurrentAgents: spec.maxConcurrentAgents } : {}),
    ...(spec.defaultPrompt ? { defaultPrompt: spec.defaultPrompt } : {}),
    ...(spec.suggestedPrompts?.length ? { suggestedPrompts: [...spec.suggestedPrompts] } : {}),
    steps,
  }
}

function materializeStep(raw: StepSpec, effectiveDefaultModel: string | undefined): StepSpec {
  if (typeof raw === "object" && raw !== null && "parallel" in raw) {
    return { parallel: raw.parallel.map((inner) => materializeStep(inner, effectiveDefaultModel) as string | AgentStepSpec) }
  }
  if (isHumanStepSpec(raw)) return structuredClone(raw)
  if (isGoalStepSpec(raw)) {
    return {
      goal: {
        ...structuredClone(raw.goal),
        improve: { ...structuredClone(raw.goal.improve), steps: raw.goal.improve.steps.map((step) => materializeStep(step, effectiveDefaultModel)) },
        measure: { steps: raw.goal.measure.steps.map((step) => materializeStep(step, effectiveDefaultModel)) },
      },
    }
  }
  if (typeof raw === "string") return raw === humanReviewStep ? raw : materializeAgentStep({ agent: raw }, effectiveDefaultModel)
  if (raw.agent === humanReviewStep) return raw.agent
  return materializeAgentStep(structuredClone(raw), effectiveDefaultModel)
}

function materializeAgentStep(step: AgentStepSpec, effectiveDefaultModel: string | undefined): StepSpec {
  const agent = builtInAgents.find((candidate) => candidate.name === (agentAliases[step.agent] ?? step.agent))
  const preferred = agent?.defaultModel
  const hasStepModel = step.model !== undefined || step.models !== undefined
  if (
    !hasStepModel &&
    stepRunnerFor(step.runner).capabilities.globalModelOverride &&
    effectiveDefaultModel !== undefined &&
    preferred &&
    preferred !== effectiveDefaultModel
  ) {
    step.model = preferred
  }
  // Collapse a bare { agent } back to its string shorthand for clean YAML.
  return Object.keys(step).length === 1 ? step.agent : step
}

/**
 * Best-effort resolve check for a pipeline spec: catches what parse-level
 * validation can't (duplicate step names, unknown agents, dangling reports
 * targets). Returns the error message, or undefined when the pipeline
 * resolves. Callers should treat failures as warnings — a global pipeline may
 * legitimately reference agents that only exist in some project's config.
 */
export function checkPipelineResolves(name: string, spec: PipelineSpec, config: ConvoyConfig | undefined): string | undefined {
  try {
    resolvePipeline({
      name,
      spec,
      agents: buildAgentRegistry(config),
      defaultModel: config?.defaults.model,
      defaultAdvisor: config?.defaults.advisor,
      defaultAdvisorMaxCalls: config?.defaults.advisorMaxCalls,
    })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

class Validator {
  constructor(private readonly source: string) {}

  fail(path: string, message: string): never {
    throw new ConfigError(`${this.source}: ${path ? `${path} ` : ""}${message}`)
  }

  record(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) this.fail(path, "must be a mapping")
    return value as Record<string, unknown>
  }

  knownKeys(record: Record<string, unknown>, path: string, known: string[]) {
    for (const key of Object.keys(record)) {
      if (known.includes(key)) continue
      log.warn(`${this.source}: ignoring unknown key ${path ? `${path}.` : ""}${key}`)
    }
  }

  nonEmptyString(value: unknown, path: string): string {
    if (typeof value !== "string" || !value.trim()) this.fail(path, "must be a non-empty string")
    return value
  }

  positiveInt(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) this.fail(path, "must be a positive integer")
    return value
  }

  positiveNumber(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) this.fail(path, "must be a positive number")
    return value
  }

  rangeInt(value: unknown, path: string, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      this.fail(path, `must be an integer between ${min} and ${max}`)
    }
    return value
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") this.fail(path, "must be true or false")
    return value
  }

  temperature(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) this.fail(path, "must be a number between 0 and 2")
    return value
  }

  model(value: unknown, path: string): string {
    const text = this.nonEmptyString(value, path)
    if (!isValidModelString(text)) this.fail(path, `must look like provider/model or provider/model#variant, got "${text}"`)
    return text
  }

  stringArray(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) this.fail(path, "must be a list of strings")
    return (value as unknown[]).map((item, index) => this.nonEmptyString(item, `${path}[${index}]`))
  }
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
