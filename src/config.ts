import { statSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { builtInPromptPath, globalAgentPromptPath, projectAgentPromptPath } from "./agents"
import { log } from "./log"
import { agentAliases, builtInAgents, builtInPipelines, humanReviewStep, splitModelVariant, type PipelineSpec, type StepSpec } from "./pipeline"
import type { AgentSpec, PermissionAdditions } from "./types"
import { archerRoot } from "./workspace"

/**
 * Configuration loaded from ~/.archer/config.yaml and .archer/config.yaml.
 * Everything is optional: files only declare what differs from archer's
 * built-in defaults.
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
}

/** A project agent definition, or model/temperature overrides for a built-in one. */
export type ConfigAgent = {
  description?: string
  model?: string
  temperature?: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

const configFileNames = ["config.yaml", "config.yml"]

export const defaultArcherConfig = `# Archer configuration.
# Global default path: ~/.archer/config.yaml
# Project override path: .archer/config.yaml

version: 1

defaults:
  # maxAttempts: 2
  # baseRef: main
  # pipeline: default
  # interactiveModel: openai/gpt-5.5#xhigh
  # model: openai/gpt-5.5#xhigh # optional: unset by default; uncomment to force every agent unless a step/agent overrides it
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
#     model: anthropic/claude-opus-4-7
#     temperature: 0.2
#   api-reviewer:
#     description: Reviews API consistency
#     model: openai/gpt-5.5#xhigh

pipelines:
  default:
    description: Implementation, pattern/security audits, design polish, tests, and adversarial review
    steps:
      - agent: implementer
        reports: none
      - human-review
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

export function globalConfigPath() {
  return join(archerRoot(), "config.yaml")
}

export function projectConfigPath(targetDir: string) {
  return join(targetDir, ".archer", "config.yaml")
}

export async function loadArcherConfig(targetDir: string): Promise<ArcherConfig | undefined> {
  const configs: ArcherConfig[] = []
  const global = await readConfigFile(globalConfigPath(), globalConfigPath(), targetDir)
  if (global) configs.push(global)

  const local = await loadProjectArcherConfig(targetDir)
  if (local) configs.push(local)

  return configs.length > 0 ? mergeArcherConfigs(configs) : undefined
}

export async function loadProjectArcherConfig(targetDir: string): Promise<ArcherConfig | undefined> {
  for (const fileName of configFileNames) {
    const path = join(targetDir, ".archer", fileName)
    const config = await readConfigFile(path, `.archer/${fileName}`, targetDir)
    if (config) return config
  }
  return undefined
}

export function mergeArcherConfigs(configs: readonly ArcherConfig[]): ArcherConfig {
  const merged: ArcherConfig = { defaults: {}, agents: {}, pipelines: {}, permissions: { allow: [], deny: [] }, attachments: [] }

  for (const config of configs) {
    merged.defaults = { ...merged.defaults, ...config.defaults }
    for (const [name, agent] of Object.entries(config.agents)) {
      merged.agents[name] = { ...merged.agents[name], ...agent }
    }
    for (const [name, pipeline] of Object.entries(config.pipelines)) merged.pipelines[name] = pipeline
    merged.permissions.allow.push(...config.permissions.allow)
    merged.permissions.deny.push(...config.permissions.deny)
    merged.attachments.push(...config.attachments)
  }

  return merged
}

export async function writeDefaultGlobalConfig(force = false): Promise<ConfigWriteResult> {
  return writeDefaultArcherConfig(globalConfigPath(), force)
}

export async function writeDefaultProjectConfig(targetDir: string, force = false): Promise<ConfigWriteResult> {
  await assertDirectory(targetDir)
  return writeDefaultArcherConfig(projectConfigPath(targetDir), force)
}

export async function writeDefaultArcherConfig(path: string, force = false): Promise<ConfigWriteResult> {
  await mkdir(dirname(path), { recursive: true })
  await writeDefaultAgentPrompts(path, force)
  try {
    await writeFile(path, defaultArcherConfig, { flag: force ? "w" : "wx" })
    return { path, created: true }
  } catch (error) {
    if (!force && isErrno(error, "EEXIST")) return { path, created: false }
    throw error
  }
}

async function writeDefaultAgentPrompts(configPath: string, force: boolean) {
  const agentsDir = join(dirname(configPath), "agents")
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

async function readConfigFile(path: string, source: string, targetDir: string): Promise<ArcherConfig | undefined> {
  let body: string
  try {
    body = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  return parseArcherConfig(body, source, targetDir, dirname(path))
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

export function parseArcherConfig(body: string, source: string, targetDir: string, configDir = configDirectory(source, targetDir)): ArcherConfig {
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
  if (root.agents !== undefined) config.agents = validateAgents(v, root.agents, targetDir, configDir)
  if (root.pipelines !== undefined) config.pipelines = validatePipelines(v, root.pipelines)
  if (root.permissions !== undefined) config.permissions = validatePermissions(v, root.permissions)
  if (root.attachments !== undefined) config.attachments = v.stringArray(root.attachments, "attachments")

  return config
}

function validateDefaults(v: Validator, raw: unknown): ArcherDefaults {
  const record = v.record(raw, "defaults")
  v.knownKeys(record, "defaults", ["model", "maxAttempts", "baseRef", "pipeline", "appRunCommand", "emulator", "interactiveModel"])

  const defaults: ArcherDefaults = {}
  if (record.model !== undefined) defaults.model = v.model(record.model, "defaults.model")
  if (record.maxAttempts !== undefined) defaults.maxAttempts = v.positiveInt(record.maxAttempts, "defaults.maxAttempts")
  if (record.baseRef !== undefined) defaults.baseRef = v.nonEmptyString(record.baseRef, "defaults.baseRef")
  if (record.pipeline !== undefined) defaults.pipeline = v.nonEmptyString(record.pipeline, "defaults.pipeline")
  if (record.appRunCommand !== undefined) defaults.appRunCommand = v.nonEmptyString(record.appRunCommand, "defaults.appRunCommand")
  if (record.emulator !== undefined) defaults.emulator = v.nonEmptyString(record.emulator, "defaults.emulator")
  if (record.interactiveModel !== undefined) defaults.interactiveModel = v.model(record.interactiveModel, "defaults.interactiveModel")
  return defaults
}

function validateAgents(v: Validator, raw: unknown, targetDir: string, configDir: string): Record<string, ConfigAgent> {
  const record = v.record(raw, "agents")
  const agents: Record<string, ConfigAgent> = {}

  for (const [name, value] of Object.entries(record)) {
    const path = `agents.${name}`
    if (name === humanReviewStep) v.fail(path, `"${humanReviewStep}" is a reserved step keyword, not an agent`)
    if (agentAliases[name]) v.fail(path, `"${name}" is an alias of the built-in agent "${agentAliases[name]}"; use that name to override it`)

    const entry = v.record(value, path)
    v.knownKeys(entry, path, ["description", "model", "temperature"])

    const agent: ConfigAgent = {}
    if (entry.description !== undefined) agent.description = v.nonEmptyString(entry.description, `${path}.description`)
    if (entry.model !== undefined) agent.model = v.model(entry.model, `${path}.model`)
    if (entry.temperature !== undefined) agent.temperature = v.temperature(entry.temperature, `${path}.temperature`)

    // Project agents bring their own prompt; built-in overrides keep theirs
    // (optionally replaced via the same path). Fail at load, not mid-run.
    const builtIn = builtInAgents.some((candidate) => candidate.name === name)
    if (!builtIn && !hasConfiguredAgentPrompt(name, targetDir, configDir)) {
      v.fail(path, `agent "${name}" needs a prompt at agents/${name}.md next to the config`)
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

function validateStep(v: Validator, raw: unknown, path: string): StepSpec {
  if (typeof raw === "string") {
    if (!raw.trim()) v.fail(path, "step name can't be empty")
    return raw
  }

  const record = v.record(raw, path)
  v.knownKeys(record, path, ["agent", "name", "model", "maxAttempts", "reports", "diff"])

  const agent = v.nonEmptyString(record.agent, `${path}.agent`)
  return {
    agent,
    ...(record.name !== undefined ? { name: v.nonEmptyString(record.name, `${path}.name`) } : {}),
    ...(record.model !== undefined ? { model: v.model(record.model, `${path}.model`) } : {}),
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
      continue
    }
    registry.push({
      name,
      description: agent.description ?? `Project agent ${name}`,
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      builtIn: false,
    })
  }
  return registry
}

/** Project pipelines shadow built-ins of the same name (including "default"). */
export function selectPipelineSpec(config: ArcherConfig | undefined, name: string): PipelineSpec {
  const spec = config?.pipelines[name] ?? builtInPipelines[name]
  if (spec) return spec
  const available = [...new Set([...Object.keys(builtInPipelines), ...Object.keys(config?.pipelines ?? {})])].sort()
  throw new ConfigError(`unknown pipeline "${name}" (available: ${available.join(", ")})`)
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
    try {
      const { model } = splitModelVariant(text)
      if (!model.split("/")[0] || !model.split("/").slice(1).join("/")) throw new Error("missing provider or model")
    } catch {
      this.fail(path, `must look like provider/model or provider/model#variant, got "${text}"`)
    }
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

function configDirectory(source: string, targetDir: string) {
  return dirname(isAbsolute(source) ? source : resolve(targetDir, source))
}

function hasConfiguredAgentPrompt(agentName: string, targetDir: string, configDir: string) {
  return isFile(join(configDir, "agents", `${agentName}.md`)) || isFile(projectAgentPromptPath(agentName, targetDir)) || isFile(globalAgentPromptPath(agentName))
}

function isErrno(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
}
