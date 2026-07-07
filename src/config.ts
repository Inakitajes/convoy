import { statSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { builtInPromptPath, projectAgentPromptPath } from "./agents"
import { log } from "./log"
import {
  agentAliases,
  builtInAgents,
  builtInPipelines,
  defaultGptModel,
  defaultGptVariant,
  defaultPipelineName,
  humanReviewStep,
  readOnlyAgentSuffix,
  splitModelVariant,
  type AgentStepSpec,
  type PipelineSpec,
  type StepSpec,
} from "./pipeline"
import type { AgentSpec, PermissionAdditions } from "./types"
import { archerHome, archerRoot, globalConfigPath } from "./workspace"

/**
 * Project configuration loaded from .archer/config.yaml. Everything is
 * optional: the file only declares what differs from archer's defaults.
 */
export type ArcherConfig = {
  defaults: ArcherDefaults
  agents: Record<string, ConfigAgent>
  pipelines: Record<string, PipelineSpec>
  permissions: PermissionAdditions
  attachments: string[]
}

export type ArcherDefaults = {
  model?: string
  maxAttempts?: number
  baseRef?: string
  pipeline?: string
  appRunCommand?: string
  emulator?: string
  interactiveModel?: string
  /** Model for the smart auto-accept judge; falls back to the run's model when unset. */
  autoAcceptJudgeModel?: string
}

/** A project agent definition, or model/temperature/readOnly overrides for a built-in one. */
export type ConfigAgent = {
  description?: string
  model?: string
  temperature?: number
  /** Disable write/edit/bash tools for this agent. */
  readOnly?: boolean
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

const configFileNames = ["config.yaml", "config.yml"]

export async function loadArcherConfig(targetDir: string): Promise<ArcherConfig | undefined> {
  for (const fileName of configFileNames) {
    const path = join(targetDir, ".archer", fileName)
    let body: string
    try {
      body = await readFile(path, "utf8")
    } catch {
      continue
    }
    return parseArcherConfig(body, `.archer/${fileName}`, targetDir)
  }
  return undefined
}

/**
 * The per-user config at ~/.archer/config.yaml. Parsed with targetDir set to
 * archerRoot() — the directory that holds `.archer` — so agent-prompt validation
 * resolves to ~/.archer/agents/<name>.md, exactly like a project repo.
 */
export async function loadGlobalArcherConfig(): Promise<ArcherConfig | undefined> {
  for (const fileName of configFileNames) {
    const path = join(archerHome(), fileName)
    let body: string
    try {
      body = await readFile(path, "utf8")
    } catch {
      continue
    }
    return parseArcherConfig(body, `~/.archer/${fileName}`, archerRoot())
  }
  return undefined
}

/**
 * Merges the global config under the project one: project keys win on
 * defaults/agents/pipelines (shallow, by key/name), and permissions/attachments
 * concatenate (global first). deny still wins over allow in bashPolicy, so the
 * concatenation order is irrelevant there.
 */
export function mergeArcherConfigs(global: ArcherConfig | undefined, project: ArcherConfig | undefined): ArcherConfig | undefined {
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
    attachments: [...global.attachments, ...project.attachments],
  }
}

/** The effective config for a run: global merged under the project config. */
export async function loadMergedArcherConfig(targetDir: string): Promise<ArcherConfig | undefined> {
  const [global, project] = await Promise.all([loadGlobalArcherConfig(), loadArcherConfig(targetDir)])
  return mergeArcherConfigs(global, project)
}

/**
 * The commented YAML template written by `archer init`. It documents every key
 * (commented out) and inlines the built-in `implement` pipeline so it's an
 * immediately editable starting point. Unlike `defaultConfigTemplate` (used by
 * the TUI's initialize action), this is a human-readable string with comments.
 */
export const defaultArcherConfig = `# Archer configuration.
# Global default path: ~/.archer/config.yaml
# Project override path: .archer/config.yaml

version: 1

defaults:
  # model: openai/gpt-5.5#xhigh # optional: uncomment to force every agent unless a step/agent overrides it
  # maxAttempts: 2
  # baseRef: main
  # pipeline: implement
  # interactiveModel: openai/gpt-5.5#xhigh
  # appRunCommand: pnpm dev # optional: unset by default; used during human-review
  # emulator: Pixel_8 # optional: unset by default; used during human-review

# Agents are matched by name with Markdown prompts next to this config:
#   agents/<name>.md
# Uncomment entries to override metadata/model/temperature or to add custom agents.
# Custom agents must have a matching agents/<name>.md prompt file.
# agents:
#   implementer:
#     description: Implements the feature described in the PRD respecting repo patterns
#     model: openai/gpt-5.5#xhigh
#   design-polisher:
#     description: Polishes new UI following the repo's design system, without redesigning
#     model: anthropic/claude-opus-4-8
#     temperature: 0.2
#   api-reviewer:
#     description: Reviews API consistency
#     model: openai/gpt-5.5#xhigh

# Archer ships these pipelines built in; pick one with -p/--pipeline without redeclaring it here:
#   implement            the default: build the feature, then audit, polish, test, and adversarial review
#   ultra-implement      like implement, with dual-model parallel audits and a final review/fix/validate stage
#   refine               audit the current diff, then apply the triaged fixes (changes code)
#   ultra-refine         like refine, with every audit fanned out across two models
#   review               report-only: parallel audits across two models plus one prioritized report (no changes)
# The default \`implement\` pipeline is inlined below as an editable starting point; redefining a name here overrides the built-in.
pipelines:
  implement:
    description: Implementation, pattern/security audits, design polish, tests, and adversarial review
    steps:
      - agent: implementer
        reports: none
      - patterns
      - security
      - design
      - agent: tests
        reports: none
      - agent: adversarial
        reports: all

permissions:
  allow: []
  deny: []

attachments: []
`

export type ConfigWriteResult = {
  path: string
  created: boolean
}

/** Path of the project config file (default name). */
export function projectConfigPath(targetDir: string) {
  return join(targetDir, ".archer", "config.yaml")
}

/** Re-exported from workspace so callers don't need both modules. */
export { globalConfigPath }

/** Writes the global config at ~/.archer/config.yaml (plus default agent prompts). */
export async function writeDefaultGlobalConfig(force = false): Promise<ConfigWriteResult> {
  return writeDefaultArcherConfig(globalConfigPath(), force)
}

/** Writes a project config at <targetDir>/.archer/config.yaml (plus default agent prompts). */
export async function writeDefaultProjectConfig(targetDir: string, force = false): Promise<ConfigWriteResult> {
  await assertDirectory(targetDir)
  return writeDefaultArcherConfig(projectConfigPath(targetDir), force)
}

/**
 * Writes the commented template config and copies every built-in agent prompt
 * to `<dirname(path)>/agents/<name>.md`. Existing files are left alone unless
 * `force` is set. Agent prompts live next to the config file under `agents/`,
 * mirroring how the loader discovers them.
 */
export async function writeDefaultArcherConfig(path: string, force = false): Promise<ConfigWriteResult> {
  const configDir = dirname(path)
  await mkdir(configDir, { recursive: true })
  await writeDefaultAgentPrompts(configDir, force)
  try {
    await writeFile(path, defaultArcherConfig, { flag: force ? "w" : "wx" })
    return { path, created: true }
  } catch (error) {
    if (!force && isErrno(error, "EEXIST")) return { path, created: false }
    throw error
  }
}

async function writeDefaultAgentPrompts(configDir: string, force: boolean) {
  const agentsDir = join(configDir, "agents")
  await mkdir(agentsDir, { recursive: true })
  for (const agent of builtInAgents) {
    const target = join(agentsDir, `${agent.name}.md`)
    const body = await readFile(builtInPromptPath(agent.name), "utf8")
    try {
      await writeFile(target, body, { flag: force ? "w" : "wx" })
    } catch (error) {
      if (!force && isErrno(error, "EEXIST")) continue
      throw error
    }
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

export function parseArcherConfig(body: string, source: string, targetDir: string): ArcherConfig {
  let raw: unknown
  try {
    raw = Bun.YAML.parse(body)
  } catch (error) {
    throw new ConfigError(`${source}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }

  const config: ArcherConfig = { defaults: {}, agents: {}, pipelines: {}, permissions: { allow: [], deny: [] }, attachments: [] }
  if (raw === null || raw === undefined) return config

  const v = new Validator(source)
  const root = v.record(raw, "")
  // Unknown keys warn instead of failing so configs written for a newer
  // archer still load; typos surface in the warning either way.
  v.knownKeys(root, "", ["version", "defaults", "agents", "pipelines", "permissions", "attachments"])

  if (root.version !== undefined && root.version !== 1) v.fail("version", `unsupported value ${JSON.stringify(root.version)}; this archer reads version 1`)

  if (root.defaults !== undefined && root.defaults !== null) config.defaults = validateDefaults(v, root.defaults)
  if (root.agents !== undefined) config.agents = validateAgents(v, root.agents, targetDir)
  if (root.pipelines !== undefined) config.pipelines = validatePipelines(v, root.pipelines)
  if (root.permissions !== undefined) config.permissions = validatePermissions(v, root.permissions)
  if (root.attachments !== undefined) config.attachments = v.stringArray(root.attachments, "attachments")

  return config
}

function validateDefaults(v: Validator, raw: unknown): ArcherDefaults {
  const record = v.record(raw, "defaults")
  v.knownKeys(record, "defaults", ["model", "maxAttempts", "baseRef", "pipeline", "appRunCommand", "emulator", "interactiveModel", "autoAcceptJudgeModel"])

  const defaults: ArcherDefaults = {}
  if (record.model !== undefined) defaults.model = v.model(record.model, "defaults.model")
  if (record.maxAttempts !== undefined) defaults.maxAttempts = v.positiveInt(record.maxAttempts, "defaults.maxAttempts")
  if (record.baseRef !== undefined) defaults.baseRef = v.nonEmptyString(record.baseRef, "defaults.baseRef")
  if (record.pipeline !== undefined) defaults.pipeline = v.nonEmptyString(record.pipeline, "defaults.pipeline")
  if (record.appRunCommand !== undefined) defaults.appRunCommand = v.nonEmptyString(record.appRunCommand, "defaults.appRunCommand")
  if (record.emulator !== undefined) defaults.emulator = v.nonEmptyString(record.emulator, "defaults.emulator")
  if (record.interactiveModel !== undefined) defaults.interactiveModel = v.model(record.interactiveModel, "defaults.interactiveModel")
  if (record.autoAcceptJudgeModel !== undefined) defaults.autoAcceptJudgeModel = v.model(record.autoAcceptJudgeModel, "defaults.autoAcceptJudgeModel")
  return defaults
}

function validateAgents(v: Validator, raw: unknown, targetDir: string): Record<string, ConfigAgent> {
  const record = v.record(raw, "agents")
  const agents: Record<string, ConfigAgent> = {}

  for (const [name, value] of Object.entries(record)) {
    const path = `agents.${name}`
    if (name === humanReviewStep) v.fail(path, `"${humanReviewStep}" is a reserved step keyword, not an agent`)
    if (agentAliases[name]) v.fail(path, `"${name}" is an alias of the built-in agent "${agentAliases[name]}"; use that name to override it`)
    if (name.endsWith(readOnlyAgentSuffix)) v.fail(path, `agent names can't end in "${readOnlyAgentSuffix}"; that suffix is reserved for archer's forced-read-only variants`)

    const entry = v.record(value, path)
    v.knownKeys(entry, path, ["description", "model", "temperature", "readOnly"])

    const agent: ConfigAgent = {}
    if (entry.description !== undefined) agent.description = v.nonEmptyString(entry.description, `${path}.description`)
    if (entry.model !== undefined) agent.model = v.model(entry.model, `${path}.model`)
    if (entry.temperature !== undefined) agent.temperature = v.temperature(entry.temperature, `${path}.temperature`)
    if (entry.readOnly !== undefined) agent.readOnly = v.boolean(entry.readOnly, `${path}.readOnly`)

    // Project agents bring their own prompt; built-in overrides keep theirs
    // (optionally replaced via the same path). Fail at load, not mid-run.
    const builtIn = builtInAgents.some((candidate) => candidate.name === name)
    if (!builtIn && !isFile(projectAgentPromptPath(name, targetDir))) {
      v.fail(path, `agent "${name}" needs a prompt at .archer/agents/${name}.md`)
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
    v.knownKeys(entry, path, ["description", "steps"])

    if (!Array.isArray(entry.steps) || entry.steps.length === 0) v.fail(`${path}.steps`, "must be a non-empty list of steps")
    const steps = (entry.steps as unknown[]).map((step, index) => validateStep(v, step, `${path}.steps[${index}]`))

    pipelines[name] = {
      ...(entry.description !== undefined ? { description: v.nonEmptyString(entry.description, `${path}.description`) } : {}),
      steps,
    }
  }
  return pipelines
}

function validateStep(v: Validator, raw: unknown, path: string, context: { insideParallel?: boolean } = {}): StepSpec {
  if (typeof raw === "string") {
    if (!raw.trim()) v.fail(path, "step name can't be empty")
    if (context.insideParallel && raw.trim() === humanReviewStep) v.fail(path, `"${humanReviewStep}" can't run inside a parallel block`)
    return raw
  }

  const record = v.record(raw, path)

  if ("parallel" in record) {
    if (context.insideParallel) v.fail(path, "parallel blocks can't be nested")
    v.knownKeys(record, path, ["parallel"])
    if (!Array.isArray(record.parallel) || record.parallel.length === 0) v.fail(`${path}.parallel`, "must be a non-empty list of steps")
    const members = (record.parallel as unknown[]).map((step, index) => validateStep(v, step, `${path}.parallel[${index}]`, { insideParallel: true }))
    return { parallel: members as (string | AgentStepSpec)[] }
  }

  v.knownKeys(record, path, ["agent", "name", "model", "models", "maxAttempts", "reports", "diff"])

  const agent = v.nonEmptyString(record.agent, `${path}.agent`)
  if (context.insideParallel && agent === humanReviewStep) v.fail(path, `"${humanReviewStep}" can't run inside a parallel block`)
  if (record.model !== undefined && record.models !== undefined) v.fail(path, `set either "model" or "models", not both`)

  let models: string[] | undefined
  if (record.models !== undefined) {
    models = v.stringArray(record.models, `${path}.models`)
    if (models.length < 2) v.fail(`${path}.models`, `must have at least 2 entries; use "model" for a single model`)
    models.forEach((model, index) => v.model(model, `${path}.models[${index}]`))
  }

  return {
    agent,
    ...(record.name !== undefined ? { name: v.nonEmptyString(record.name, `${path}.name`) } : {}),
    ...(record.model !== undefined ? { model: v.model(record.model, `${path}.model`) } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(record.maxAttempts !== undefined ? { maxAttempts: v.positiveInt(record.maxAttempts, `${path}.maxAttempts`) } : {}),
    ...(record.reports !== undefined ? { reports: validateReports(v, record.reports, `${path}.reports`) } : {}),
    ...(record.diff !== undefined ? { diff: v.boolean(record.diff, `${path}.diff`) } : {}),
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

/** Built-in agents plus the project's additions and overrides. */
export function buildAgentRegistry(config?: ArcherConfig): AgentSpec[] {
  const registry: AgentSpec[] = builtInAgents.map((agent) => ({ ...agent }))
  if (!config) return registry

  for (const [name, agent] of Object.entries(config.agents)) {
    const existing = registry.find((candidate) => candidate.name === name)
    if (existing) {
      if (agent.description !== undefined) existing.description = agent.description
      if (agent.model !== undefined) existing.model = agent.model
      if (agent.temperature !== undefined) existing.temperature = agent.temperature
      if (agent.readOnly !== undefined) existing.readOnly = agent.readOnly
      continue
    }
    registry.push({
      name,
      description: agent.description ?? `Project agent ${name}`,
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      ...(agent.readOnly !== undefined ? { readOnly: agent.readOnly } : {}),
      builtIn: false,
    })
  }
  return registry
}

/** Project pipelines shadow built-ins of the same name (including "implement", the default). */
export function selectPipelineSpec(config: ArcherConfig | undefined, name: string): PipelineSpec {
  const spec = config?.pipelines[name] ?? builtInPipelines[name]
  if (spec) return spec
  const available = [...new Set([...Object.keys(builtInPipelines), ...Object.keys(config?.pipelines ?? {})])].sort()
  throw new ConfigError(`unknown pipeline "${name}" (available: ${available.join(", ")})`)
}

/** True when a string is a valid `provider/model` or `provider/model#variant`. Shared by config validation and the config TUI. */
export function isValidModelString(value: string): boolean {
  if (typeof value !== "string" || !value.trim()) return false
  try {
    const { model } = splitModelVariant(value)
    const provider = model.split("/")[0]
    const rest = model.split("/").slice(1).join("/")
    return Boolean(provider && rest)
  } catch {
    return false
  }
}

/** Serializes a config back to YAML, omitting empty sections, with `version: 1` first. Comments are not preserved. */
export function serializeArcherConfig(config: ArcherConfig): string {
  const out: Record<string, unknown> = { version: 1 }
  if (Object.keys(config.defaults).length > 0) out.defaults = config.defaults
  if (Object.keys(config.agents).length > 0) out.agents = config.agents
  if (Object.keys(config.pipelines).length > 0) out.pipelines = config.pipelines
  const permissions: Record<string, string[]> = {}
  if (config.permissions.allow.length > 0) permissions.allow = config.permissions.allow
  if (config.permissions.deny.length > 0) permissions.deny = config.permissions.deny
  if (Object.keys(permissions).length > 0) out.permissions = permissions
  if (config.attachments.length > 0) out.attachments = config.attachments
  return Bun.YAML.stringify(out, null, 2)
}

/** Serializes, validates by re-parsing, then writes. Never persists YAML that wouldn't load back. */
export async function writeArcherConfig(path: string, config: ArcherConfig, targetDir: string): Promise<void> {
  const body = serializeArcherConfig(config)
  parseArcherConfig(body, path, targetDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, "utf8")
}

/**
 * Boilerplate written by the config TUI's "initialize" action: the current
 * effective defaults plus the built-in `implement` pipeline expanded so it stays
 * editable. Agent model preferences that differ from defaults.model are inlined
 * on their steps, because defaults.model would otherwise shadow them.
 */
export function defaultConfigTemplate(): ArcherConfig {
  const globalModel = `${defaultGptModel}#${defaultGptVariant}`
  return {
    defaults: { model: globalModel, maxAttempts: 2 },
    agents: {},
    pipelines: { implement: templatePipeline(builtInPipelines[defaultPipelineName]!, globalModel) },
    permissions: { allow: [], deny: [] },
    attachments: [],
  }
}

function templatePipeline(spec: PipelineSpec, globalModel: string): PipelineSpec {
  const steps = spec.steps.map<StepSpec>((raw) => templateStep(raw, globalModel))
  return { ...(spec.description ? { description: spec.description } : {}), steps }
}

function templateStep(raw: StepSpec, globalModel: string): StepSpec {
  if (typeof raw === "object" && raw !== null && "parallel" in raw) {
    return { parallel: raw.parallel.map((inner) => templateStep(inner, globalModel) as string | AgentStepSpec) }
  }
  const step = typeof raw === "string" ? { agent: raw } : { ...raw }
  if (step.agent === humanReviewStep) return step.agent
  const agent = builtInAgents.find((candidate) => candidate.name === (agentAliases[step.agent] ?? step.agent))
  const preferred = agent?.defaultModel
  const withModel = preferred && preferred !== globalModel ? { ...step, model: preferred } : step
  // Collapse a bare { agent } back to its string shorthand for clean YAML.
  return Object.keys(withModel).length === 1 ? withModel.agent : withModel
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
