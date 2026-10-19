import { resolve } from "node:path"

import { buildAgentRegistry, loadConvoyConfig, loadGlobalConvoyConfig, loadPipelineFile, mergeConvoyConfigs, normalizePipelineName, pipelineDefaultsOf, type ConvoyConfig } from "./config"
import { builtInPipelines, defaultPipelineName, resolvePipeline, type PipelineSpec } from "./pipeline"
import { defaultStepRunnerId, type StepRunnerId } from "./step-runners"
import type { AgentStep, Pipeline } from "./types"

/**
 * `convoy pipelines`: the catalog a script or agent reads before choosing or
 * composing a pipeline — every runnable name with where it comes from, and
 * one pipeline's resolved steps (models, runners, advisors, read-only, goal
 * loop). `--plan` remains the authority for a concrete run; this answers
 * "what is there" without a prompt or a repository effect.
 */

export type PipelineSource = "built-in" | "global" | "project" | "file"

export type PipelinesCommand = {
  type: "pipelines"
  targetDir: string
  json: boolean
  /** `show <name>`: one pipeline's resolved steps. */
  name?: string
  /** `show --pipeline-file <path>`: validate and describe a pipeline file. */
  pipelineFile?: string
}

export type PipelineStepView = {
  name: string
  agent: string
  model: string
  runner: StepRunnerId
  advisor?: string
  readOnly: boolean
  verify?: boolean
  /** Steps sharing a group run concurrently (a `parallel:` block or a `models:` fan-out). */
  group: string
}

export type PipelineView = {
  name: string
  source: PipelineSource
  default: boolean
  description?: string
  defaultPrompt?: string
  writesCode: boolean
  runners: StepRunnerId[]
  steps: PipelineStepView[]
  goal?: {
    target: number
    maxIterations: number
    plateau: number
    improve: PipelineStepView[]
    measure: PipelineStepView[]
  }
}

export type AgentView = { name: string; description: string; readOnly: boolean; builtIn: boolean }

type Catalog = {
  config: ConvoyConfig | undefined
  sources: Map<string, PipelineSource>
  defaultName: string
}

async function loadCatalog(targetDir: string): Promise<Catalog> {
  const [global, project] = await Promise.all([loadGlobalConvoyConfig(), loadConvoyConfig(targetDir)])
  const sources = new Map<string, PipelineSource>()
  for (const name of Object.keys(builtInPipelines)) sources.set(name, "built-in")
  for (const name of Object.keys(global?.pipelines ?? {})) sources.set(name, "global")
  for (const name of Object.keys(project?.pipelines ?? {})) sources.set(name, "project")
  // goal-fix is reserved: a config may still carry one, but it never runs.
  sources.delete("goal-fix")
  const config = mergeConvoyConfigs(global, project)
  return { config, sources, defaultName: config?.defaults.pipeline ?? defaultPipelineName }
}

function resolveWith(catalog: Catalog, name: string, spec: PipelineSpec): Pipeline {
  return resolvePipeline({ name, spec, agents: buildAgentRegistry(catalog.config), ...pipelineDefaultsOf(catalog.config?.defaults) })
}

function stepView(step: AgentStep): PipelineStepView {
  const runner: StepRunnerId = step.runner ?? defaultStepRunnerId
  const model = step.model ? `${step.model}${step.variant ? `#${step.variant}` : ""}` : "(CLI default)"
  return {
    name: step.name,
    agent: step.agentName,
    model,
    runner,
    ...(step.advisor ? { advisor: `${step.advisor}${step.advisorVariant ? `#${step.advisorVariant}` : ""}` } : {}),
    readOnly: Boolean(step.readOnly),
    ...(step.verify ? { verify: true } : {}),
    group: step.groupId,
  }
}

export function pipelineView(pipeline: Pipeline, source: PipelineSource, isDefault: boolean): PipelineView {
  const steps = pipeline.steps.filter((step): step is AgentStep => step.type === "agent").map(stepView)
  const goal = pipeline.goalPlan
  const goalSteps = goal ? [...goal.improve.steps, ...goal.measure.steps].map(stepView) : []
  const all = [...steps, ...goalSteps]
  return {
    name: pipeline.name,
    source,
    default: isDefault,
    ...(pipeline.description ? { description: pipeline.description } : {}),
    ...(pipeline.defaultPrompt ? { defaultPrompt: pipeline.defaultPrompt } : {}),
    writesCode: all.some((step) => !step.readOnly),
    runners: [...new Set(all.map((step) => step.runner))].sort(),
    steps,
    ...(goal
      ? {
          goal: {
            target: goal.target,
            maxIterations: goal.maxIterations,
            plateau: goal.plateau,
            improve: goal.improve.steps.map(stepView),
            measure: goal.measure.steps.map(stepView),
          },
        }
      : {}),
  }
}

export async function listPipelineViews(targetDir: string): Promise<{ pipelines: PipelineView[]; agents: AgentView[] }> {
  const catalog = await loadCatalog(targetDir)
  const pipelines = [...catalog.sources.keys()].sort().map((name) => {
    const spec = catalog.config?.pipelines[name] ?? builtInPipelines[name]!
    return pipelineView(resolveWith(catalog, name, spec), catalog.sources.get(name)!, name === catalog.defaultName)
  })
  const agents = buildAgentRegistry(catalog.config)
    .map((agent) => ({ name: agent.name, description: agent.description, readOnly: Boolean(agent.readOnly), builtIn: agent.builtIn }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { pipelines, agents }
}

export async function showPipelineView(targetDir: string, selector: { name?: string; pipelineFile?: string }): Promise<PipelineView> {
  const catalog = await loadCatalog(targetDir)
  if (selector.pipelineFile) {
    const file = await loadPipelineFile(resolve(process.cwd(), selector.pipelineFile))
    return pipelineView(resolveWith(catalog, file.name, file.spec), "file", false)
  }
  const name = normalizePipelineName(selector.name ?? "")
  const source = catalog.sources.get(name)
  if (!source) throw new Error(`unknown pipeline "${selector.name}" (available: ${[...catalog.sources.keys()].sort().join(", ")})`)
  const spec = catalog.config?.pipelines[name] ?? builtInPipelines[name]!
  return pipelineView(resolveWith(catalog, name, spec), source, name === catalog.defaultName)
}

function stepLine(step: PipelineStepView): string {
  const traits = [step.runner !== defaultStepRunnerId ? step.runner : undefined, step.readOnly ? (step.verify ? "read-only + verify" : "read-only") : "writes", step.advisor ? `advisor ${step.advisor}` : undefined].filter(Boolean)
  return `${step.name} · ${step.agent} · ${step.model} · ${traits.join(" · ")}`
}

function stepLines(steps: PipelineStepView[], indent: string): string[] {
  const lines: string[] = []
  let index = 0
  for (let i = 0; i < steps.length; ) {
    const group = steps.filter((step) => step.group === steps[i]!.group)
    index++
    if (group.length === 1) {
      lines.push(`${indent}${index}. ${stepLine(group[0]!)}`)
    } else {
      lines.push(`${indent}${index}. in parallel:`)
      for (const step of group) lines.push(`${indent}   - ${stepLine(step)}`)
    }
    i += group.length
  }
  return lines
}

export function renderPipelineView(view: PipelineView): string {
  const lines = [`pipeline ${view.name} (${view.source}${view.default ? ", default" : ""}) · ${view.writesCode ? "writes code" : "read-only"} · ${view.runners.join(" + ")}`]
  if (view.description) lines.push(view.description)
  if (view.defaultPrompt) lines.push(`default prompt: ${view.defaultPrompt}`)
  lines.push("", "steps:", ...stepLines(view.steps, "  "))
  if (view.goal) {
    lines.push("", `goal: reach ${view.goal.target}/100 · up to ${view.goal.maxIterations} improve rounds · stop when a round gains under ${view.goal.plateau}`)
    lines.push("  improve:", ...stepLines(view.goal.improve, "    "))
    lines.push("  measure:", ...stepLines(view.goal.measure, "    "))
  }
  return `${lines.join("\n")}\n`
}

/** Names the runners a pipeline needs beyond the default one. */
function runnerTag(runners: StepRunnerId[]): string | undefined {
  const others = runners.filter((runner) => runner !== defaultStepRunnerId)
  if (others.length === 0) return undefined
  return others.length === runners.length && others.length === 1 ? `${others[0]} only` : `uses ${others.join(" + ")}`
}

export function renderPipelineList(pipelines: PipelineView[], agents: AgentView[]): string {
  const width = Math.max(...pipelines.map((view) => view.name.length))
  const lines = ["pipelines:"]
  for (const view of pipelines) {
    const tags = [view.source, view.writesCode ? "writes code" : "read-only", view.goal ? `goal ${view.goal.target}` : undefined, runnerTag(view.runners), view.default ? "default" : undefined].filter(Boolean)
    lines.push(`  ${view.name.padEnd(width)}  ${tags.join(" · ")}`)
    if (view.description) lines.push(`  ${" ".repeat(width)}  ${view.description}`)
  }
  lines.push("", "agents (for composing a pipeline):")
  const agentWidth = Math.max(...agents.map((agent) => agent.name.length))
  for (const agent of agents) {
    lines.push(`  ${agent.name.padEnd(agentWidth)}  ${agent.readOnly ? "read-only" : "writes"} · ${agent.builtIn ? "" : "project · "}${agent.description}`)
  }
  lines.push("", "convoy pipelines show <name> for a pipeline's steps; --json for machine-readable output.")
  return `${lines.join("\n")}\n`
}

export async function runPipelinesCommand(command: PipelinesCommand, write: (text: string) => void = (text) => process.stdout.write(text)): Promise<void> {
  if (command.name !== undefined || command.pipelineFile !== undefined) {
    const view = await showPipelineView(command.targetDir, command)
    write(command.json ? `${JSON.stringify(view, null, 2)}\n` : renderPipelineView(view))
    return
  }
  const { pipelines, agents } = await listPipelineViews(command.targetDir)
  write(command.json ? `${JSON.stringify({ pipelines, agents }, null, 2)}\n` : renderPipelineList(pipelines, agents))
}

export function pipelinesHelp(): string {
  return `convoy pipelines [--json] [--dir <path>]
convoy pipelines show <name> [--json] [--dir <path>]
convoy pipelines show --pipeline-file <path> [--json]

List the pipelines this repository can run (built-in, global, and project), with
the agents a pipeline can use, or describe one pipeline's resolved steps: agent,
model, runner, advisor, read-only, parallel groups, and its goal loop.

show --pipeline-file validates a standalone pipeline file (the same mapping as a
pipelines.<name> entry, plus an optional name) without running it; launch it with
convoy --pipeline-file <path>. convoy --plan shows the complete plan of a run,
with models routed through the run's gateway.
`
}

/** Parses everything after `convoy pipelines`. */
export function parsePipelinesArgs(argv: string[]): PipelinesCommand | { type: "help"; text: string } {
  const command: PipelinesCommand = { type: "pipelines", targetDir: process.cwd(), json: false }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    const eq = raw.indexOf("=")
    const flag = raw.startsWith("--") && eq !== -1 ? raw.slice(0, eq) : raw
    const takeValue = () => {
      const value = raw.startsWith("--") && eq !== -1 ? raw.slice(eq + 1) : argv[++i]
      if (value === undefined || value.startsWith("-")) throw new Error(`${flag} requires a value`)
      return value
    }
    switch (flag) {
      case "--help":
      case "-h":
        return { type: "help", text: pipelinesHelp() }
      case "--json":
        command.json = true
        break
      case "--dir":
        command.targetDir = resolve(process.cwd(), takeValue())
        break
      case "--pipeline-file":
        command.pipelineFile = takeValue()
        break
      default:
        if (raw.startsWith("-")) throw new Error(`unknown flag: ${flag}\n\n${pipelinesHelp()}`)
        positional.push(raw)
    }
  }
  if (positional.length === 0) {
    if (command.pipelineFile !== undefined) throw new Error("usage: convoy pipelines show --pipeline-file <path>")
    return command
  }
  const [verb, name, ...extra] = positional
  if (verb !== "show" || extra.length > 0) throw new Error(`usage: convoy pipelines [show <name>] [--json]`)
  if ((name === undefined) === (command.pipelineFile === undefined)) {
    throw new Error("usage: convoy pipelines show <name> | convoy pipelines show --pipeline-file <path>")
  }
  return { ...command, ...(name !== undefined ? { name } : {}) }
}
