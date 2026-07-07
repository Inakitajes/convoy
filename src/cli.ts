import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { buildAgentRegistry, loadMergedArcherConfig, selectPipelineSpec, writeDefaultGlobalConfig, writeDefaultProjectConfig, type ArcherDefaults } from "./config"
import { defaultGptModel, defaultGptVariant, defaultPipeline, defaultPipelineName, resolvePipeline, splitModelVariant, validateStepFilters } from "./pipeline"
import { parseModel, run } from "./runner"
import { browseRuns } from "./runs"
import type { Pipeline, RunOptions } from "./types"
import { isValidRunID } from "./workspace"

/**
 * Flags as written: every scalar stays undefined until the user sets it, so
 * resolveRunOptions can tell "flag given" from "flag at its default" and apply
 * the precedence chain flag > .archer/config.yaml defaults > built-in default.
 */
export type ParsedArgs = {
  prompt?: string
  promptFile?: string
  help?: boolean
  pipeline?: string
  files: string[]
  onlySteps: string[]
  skipSteps: string[]
  resumeRunID?: string
  keepRunDir?: boolean
  modelOverride?: string
  tui?: boolean
  humanReview?: boolean
  emulatorID?: string
  appRunCommand?: string
  interactiveModel?: string
  interactiveVariant?: string
  maxAttempts?: number
  baseRef?: string
  targetDir: string
  includeDirty?: boolean
  yolo?: boolean
  smart?: boolean
  smartModel?: string
}

export type InitOptions = {
  targetDir: string
  global: boolean
  force: boolean
  quiet: boolean
}

export type CliCommand =
  | { type: "help"; text: string }
  | { type: "run"; options: RunOptions }
  | { type: "runs"; runID?: string }
  | { type: "config"; targetDir: string }
  | { type: "init"; options: InitOptions }

export async function parseAndRun(argv: string[]) {
  const command = await parseCommand(argv)
  if (command.type === "help") {
    process.stdout.write(command.text)
    return
  }
  if (command.type === "runs") {
    // The browser can open a run's dashboard and come back, so loop until the
    // user resumes (which hands off to a real run) or quits.
    let initialRunID = command.runID
    for (;;) {
      const resolution = await browseRuns(initialRunID)
      if (resolution.type === "resume") {
        await run(await resumeOptions(resolution.runID, resolution.targetDir))
        return
      }
      if (resolution.type === "open") {
        // Lazily imported: attaching pulls in the dashboard + opencode client.
        const { openRunDashboard } = await import("./attach")
        await openRunDashboard(resolution.runID)
        initialRunID = resolution.runID
        continue
      }
      return
    }
  }
  if (command.type === "config") {
    // Imported lazily so normal runs never pull in the opentui editor.
    const { editConfigTui } = await import("./config-tui")
    await editConfigTui({ targetDir: command.targetDir })
    return
  }
  if (command.type === "init") {
    const result = command.options.global
      ? await writeDefaultGlobalConfig(command.options.force)
      : await writeDefaultProjectConfig(command.options.targetDir, command.options.force)
    if (!command.options.quiet) {
      const scope = command.options.global ? "global config" : "project config"
      process.stdout.write(`${result.created ? "created" : "ensured"} ${scope}: ${result.path}\n`)
    }
    return
  }

  await run(command.options)
}

// The browser resumes with default flags; metadata recovers both the repo the
// run was launched against and the pipeline it was running.
async function resumeOptions(runID: string, targetDir?: string): Promise<RunOptions> {
  const parsed = parseArgs([])
  parsed.resumeRunID = runID
  if (targetDir) parsed.targetDir = targetDir
  return { ...(await resolveRunOptions(parsed)), prompt: "" }
}

export async function parseCommand(argv: string[]): Promise<CliCommand> {
  if (argv[0] === "runs") {
    const rest = argv.slice(1)
    if (rest.length > 1) throw new Error("usage: archer runs [run-id]")
    if (rest[0] !== undefined && !isValidRunID(rest[0])) throw new Error(`invalid run id: ${rest[0]}`)
    return { type: "runs", runID: rest[0] }
  }
  if (argv[0] === "config") {
    if (argv.length > 1) throw new Error("usage: archer config")
    return { type: "config", targetDir: process.cwd() }
  }
  if (argv[0] === "init") {
    const parsed = parseInitArgs(argv.slice(1))
    if (parsed.help) return { type: "help", text: initHelp() }
    return { type: "init", options: parsed }
  }

  const parsed = parseArgs(argv)
  if (parsed.help) return { type: "help", text: help() }

  if (parsed.prompt && parsed.promptFile) {
    throw new Error("use either a positional prompt or --prompt-file, not both")
  }
  if (parsed.resumeRunID && (parsed.prompt || parsed.promptFile)) {
    throw new Error("--resume continues a previous run with its original PRD; it can't take a new prompt")
  }

  let prompt = parsed.prompt ?? ""
  if (parsed.promptFile) {
    prompt = await readFile(resolve(process.cwd(), parsed.promptFile), "utf8")
  }

  if (!prompt && !parsed.resumeRunID) {
    throw new Error("need a prompt (positional or --prompt-file) or --resume <id>")
  }

  return { type: "run", options: { ...(await resolveRunOptions(parsed)), prompt } }
}

type ParsedInitArgs = InitOptions & { help?: boolean }

function parseInitArgs(argv: string[]): ParsedInitArgs {
  const parsed: ParsedInitArgs = {
    targetDir: process.cwd(),
    global: false,
    force: false,
    quiet: false,
  }
  let hasDir = false

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (!raw.startsWith("-")) throw new Error("usage: archer init [--global] [--force] [--dir <path>]")

    const { flag, value } = splitFlag(raw)
    const noValue = () => {
      if (value !== undefined) throw new Error(`${flag} does not take a value`)
    }
    const takeValue = () => {
      if (value !== undefined) return value
      const next = argv[++i]
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new Error(`${flag} requires a value`)
      return next
    }

    switch (flag) {
      case "--help":
      case "-h":
        noValue()
        parsed.help = true
        return parsed
      case "--global":
        noValue()
        parsed.global = true
        break
      case "--force":
        noValue()
        parsed.force = true
        break
      case "--quiet":
        noValue()
        parsed.quiet = true
        break
      case "--dir":
        parsed.targetDir = resolve(process.cwd(), takeValue())
        hasDir = true
        break
      default:
        throw new Error(`unknown init flag: ${flag}`)
    }
  }

  if (parsed.global && hasDir) throw new Error("use either --global or --dir, not both")
  return parsed
}

/** Applies the precedence chain and resolves the pipeline the run will execute. */
export async function resolveRunOptions(parsed: ParsedArgs): Promise<Omit<RunOptions, "prompt">> {
  const config = await loadMergedArcherConfig(parsed.targetDir)
  const defaults = config?.defaults ?? {}

  const humanReview = parsed.humanReview ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)

  const agents = buildAgentRegistry(config)
  const pipelineName = parsed.pipeline ?? defaults.pipeline ?? defaultPipelineName
  let pipeline: Pipeline
  try {
    pipeline = resolvePipeline({ name: pipelineName, spec: selectPipelineSpec(config, pipelineName), agents, defaultModel: defaults.model })
  } catch (error) {
    // A resumed run replays the pipeline frozen in its metadata; a config
    // that has since broken must not block it. New runs surface the error.
    if (!parsed.resumeRunID) throw error
    pipeline = defaultPipeline()
  }
  // --no-human-review (and non-interactive defaults) drop manual gates from
  // the run entirely, so they never show up as steps.
  if (!humanReview) pipeline = { ...pipeline, steps: pipeline.steps.filter((step) => step.type !== "human") }

  if (parsed.modelOverride) parseModel(splitModelVariant(parsed.modelOverride).model)
  if (parsed.smartModel) parseModel(splitModelVariant(parsed.smartModel).model)
  const interactive = resolveInteractiveModel(parsed, defaults)
  // Smart auto-accept always needs a concrete judge model; resolve the fallback
  // chain here so the runner can stay oblivious to config and built-in defaults.
  const smartJudgeModel =
    parsed.smartModel || defaults.autoAcceptJudgeModel || parsed.modelOverride || defaults.model || `${defaultGptModel}#${defaultGptVariant}`

  const options: Omit<RunOptions, "prompt"> = {
    files: [...(config?.attachments ?? []), ...parsed.files],
    onlySteps: parsed.onlySteps,
    skipSteps: parsed.skipSteps,
    resumeRunID: parsed.resumeRunID ?? "",
    keepRunDir: parsed.keepRunDir ?? false,
    modelOverride: parsed.modelOverride ?? "",
    tui: parsed.tui ?? Boolean(process.stdout.isTTY && process.stderr.isTTY),
    humanReview,
    emulatorID: parsed.emulatorID ?? defaults.emulator ?? "",
    appRunCommand: parsed.appRunCommand ?? defaults.appRunCommand ?? "",
    interactiveModel: interactive.model,
    interactiveVariant: interactive.variant,
    maxAttempts: parsed.maxAttempts ?? defaults.maxAttempts ?? 2,
    baseRef: parsed.baseRef ?? defaults.baseRef ?? "main",
    targetDir: parsed.targetDir,
    includeDirty: parsed.includeDirty ?? false,
    yolo: parsed.yolo ?? false,
    smart: parsed.smart ?? false,
    smartJudgeModel,
    pipeline,
    agents,
    permissions: config?.permissions ?? { allow: [], deny: [] },
  }

  // Fast feedback for typos; a resumed run validates again in the runner
  // against the pipeline frozen in its metadata.
  if (!options.resumeRunID) validateStepFilters(pipeline, options)

  return options
}

// Model source: flag > config defaults.interactiveModel > built-in default.
// The variant rides on whichever source won (or --interactive-variant).
function resolveInteractiveModel(parsed: ParsedArgs, defaults: ArcherDefaults): { model: string; variant: string } {
  const chosen = parsed.interactiveModel
    ? splitModelVariant(parsed.interactiveModel)
    : defaults.interactiveModel
      ? splitModelVariant(defaults.interactiveModel)
      : { model: defaultGptModel, variant: defaultGptVariant }
  return { model: chosen.model, variant: parsed.interactiveVariant ?? chosen.variant ?? "" }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    files: [],
    onlySteps: [],
    skipSteps: [],
    targetDir: process.cwd(),
  }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (raw === "--") {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (!raw.startsWith("-")) {
      positional.push(raw)
      continue
    }

    const { flag, value } = splitFlag(raw)
    const takeValue = () => {
      if (value !== undefined) return value
      const next = argv[++i]
      // A following flag is not a value; catching it here beats silently
      // consuming it (e.g. `--prompt-file --only x`).
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new Error(`${flag} requires a value`)
      return next
    }

    switch (flag) {
      case "--help":
      case "-h":
        parsed.help = true
        return parsed
      case "--prompt-file":
      case "--prd":
        parsed.promptFile = takeValue()
        break
      case "--file":
      case "-f":
        parsed.files.push(takeValue())
        break
      case "--pipeline":
      case "-p":
        parsed.pipeline = takeValue()
        break
      case "--only":
        parsed.onlySteps.push(...listValue(takeValue()))
        break
      case "--skip":
        parsed.skipSteps.push(...listValue(takeValue()))
        break
      case "--resume":
        parsed.resumeRunID = takeValue()
        break
      case "--keep-run-dir":
        parsed.keepRunDir = true
        break
      case "--include-dirty":
        parsed.includeDirty = true
        break
      case "--yolo":
        parsed.yolo = true
        break
      case "--smart":
        parsed.smart = true
        break
      case "--smart-model":
        parsed.smartModel = takeValue()
        break
      case "--model":
        parsed.modelOverride = takeValue()
        break
      case "--tui":
        parsed.tui = true
        break
      case "--no-tui":
        parsed.tui = false
        break
      case "--human-review":
        parsed.humanReview = true
        break
      case "--no-human-review":
        parsed.humanReview = false
        break
      case "--emulator":
        parsed.emulatorID = takeValue()
        break
      case "--app-run-command":
        parsed.appRunCommand = takeValue()
        break
      case "--no-app-run":
        parsed.appRunCommand = ""
        break
      case "--interactive-model":
        parsed.interactiveModel = takeValue()
        break
      case "--interactive-variant":
        parsed.interactiveVariant = takeValue()
        break
      case "--max-attempts":
        parsed.maxAttempts = parseInt(takeValue(), 10)
        if (!Number.isInteger(parsed.maxAttempts) || parsed.maxAttempts < 1) {
          throw new Error("--max-attempts must be a positive integer")
        }
        break
      case "--base":
        parsed.baseRef = takeValue()
        break
      case "--dir":
        parsed.targetDir = resolve(process.cwd(), takeValue())
        break
      default:
        throw new Error(`unknown flag: ${flag}`)
    }
  }

  if (positional.length > 0) parsed.prompt = positional.join(" ")
  return parsed
}

function splitFlag(raw: string) {
  const index = raw.indexOf("=")
  if (index === -1) return { flag: raw, value: undefined }
  return { flag: raw.slice(0, index), value: raw.slice(index + 1) }
}

function listValue(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function help() {
  return `archer [prompt]

Sequential OpenCode agent pipeline for implementing features.

Usage:
  archer "Add onboarding"
  archer --prompt-file prd.md --file lib/onboarding --file test/onboarding_test.dart
  archer --pipeline bug-fix --prompt-file bug.md
  archer init
  archer runs [run-id]
  archer config

Commands:
  init                     Create .archer/config.yaml and .archer/agents/*.md in the target repo
  init --global            Create ~/.archer/config.yaml and ~/.archer/agents/*.md
  runs [run-id]            Browse run history: resume a run, read its summary/reports,
                           or open a subshell in its run dir (under ~/.archer/runs)
  config                   View and edit the global (~/.archer) and current project config in a TUI

Flags:
  --prompt-file <path>     Read the PRD/prompt from a file
  --file, -f <path>        Attach a file or directory to all steps (repeatable)
  --pipeline, -p <name>    Pipeline to run (default: "implement"), which runs
                           implementer,patterns,security,design,tests,adversarial
  --only <steps>           Run only these pipeline steps
  --skip <steps>           Skip these pipeline steps
  --resume <id>            Resume a previous run by its ID (steps with an existing report are
                           skipped; the run replays the pipeline it started with)
  --keep-run-dir           Don't delete the run dir when done
  --yolo                   Auto-allow ask-level permissions (hard denylist still applies; shift+tab cycles it live in the TUI)
  --smart                  Smart auto-accept: an AI judge auto-allows safe ask-level requests and escalates risky ones (shift+tab cycles)
  --smart-model <provider/model[#variant]> Model for the smart auto-accept judge (default: defaults.autoAcceptJudgeModel, else the run's model)
  --include-dirty          Include existing changes in the first commit (requires --max-attempts 1)
  --model <provider/model[#variant]> Force a model for all steps
  --tui                    Show visual phase progress (default in interactive terminals)
  --no-tui                 Disable visual phase progress
  --human-review           Enable human-review steps (default in interactive terminals)
  --no-human-review        Drop all human-review steps from the pipeline
  --emulator <id>          Optional Flutter emulator to launch during manual review
  --app-run-command <cmd>  Command used to run the app during manual review (default: disabled)
  --no-app-run             Don't launch the app automatically during manual review
  --interactive-model <m>  Model used by manual OpenCode iterations (default: ${defaultGptModel}#${defaultGptVariant})
  --interactive-variant <v> Model variant for manual iterations
  --max-attempts <n>       Attempts per step before failing (default: 2)
  --base <ref>             Branch/base for calculating diffs (default: main)
  --dir <path>             Target repo (default: cwd)

Config files:
  ~/.archer/config.yaml    user defaults, created by make install or archer init --global
  .archer/config.yaml      project-local overrides, created by archer init
  agents/*.md              Markdown prompts loaded by matching the agent name

Config keys:
  defaults:                model, maxAttempts, baseRef, pipeline, appRunCommand, emulator, interactiveModel
  agents:                  project agents or built-in overrides; prompts live at agents/<name>.md
  pipelines:               named step lists mixing agents and human-review gates
  permissions:             allow/deny additions to the bash policy (deny always wins)
  attachments:             files attached to every step
  The same schema lives globally at ~/.archer/config.yaml; project config merges on top.
  Precedence: CLI flags > project config > global config > built-in defaults.
`
}

function initHelp() {
  return `archer init [--global] [--force] [--dir <path>]

Create Archer's default config file and agent prompt Markdown files. Existing files are not overwritten unless --force is set.

Options:
  --global                 Write ~/.archer/config.yaml instead of a project config
  --dir <path>             Target repo for .archer/config.yaml (default: cwd)
  --force                  Overwrite an existing config file
  --quiet                  Suppress status output
`
}
