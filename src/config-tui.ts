import { join } from "node:path"

import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg } from "@opentui/core"

import {
  buildAgentRegistry,
  checkPipelineResolves,
  defaultConfigTemplate,
  isValidModelString,
  loadConvoyConfig,
  loadGlobalConvoyConfig,
  materializePipelineSpec,
  mergeConvoyConfigs,
  writeConvoyConfig,
  type ConvoyConfig,
  type ConvoyDefaults,
  type ConfigAgent,
} from "./config"
import { listModels, type ModelChoice } from "./model-catalog"
import {
  builtInPipelines,
  agentAliases,
  humanReviewStep,
  humanStepType,
  isHumanStepSpec,
  isParallelSpec,
  isSafeStepName,
  type AgentStepSpec,
  type HumanStepSpec,
  type ParallelStepSpec,
  type PipelineSpec,
  type StepSpec,
} from "./pipeline"
import { claudeCodeModelAliases, normalizeStepRunnerModel, stepRunnerFor } from "./step-runners"
import {
  joinLines,
  padBetween,
  paletteForTerminal,
  plain,
  raw,
  setTheme,
  spinnerFrame,
  terminalBackgroundHex,
  theme,
  truncate,
} from "./tui-theme"
import { convoyRoot, globalConfigPath } from "./workspace"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { PaletteColor } from "./tui-theme"
import type { HookSpec } from "./types"

export async function editConfigTui(options: { targetDir: string }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("convoy config needs an interactive terminal")
  }
  const [globalConfig, projectConfig] = await Promise.all([loadGlobalConvoyConfig(), loadConvoyConfig(options.targetDir)])

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
    targetFps: 12,
  })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  await new ConfigEditor(renderer, options.targetDir, globalConfig, projectConfig).result
}

type Tab = {
  readonly title: string
  readonly path: string
  /** Where agent-prompt validation resolves on save: convoyHome() for global, the repo for project. */
  readonly validateDir: string
  config?: ConvoyConfig
  dirty: boolean
}

type ChooseItem = { value: string; label: string; hint?: string }

type Modal =
  | { kind: "input"; title: string; help: string; value: string; error?: string; validate?: (value: string) => string | undefined; commit: (value: string) => void }
  | {
      kind: "model"
      title: string
      filter: string
      loading: boolean
      options: ModelChoice[]
      index: number
      normalize?: (value: string) => string
      commit: (value: string | undefined) => void
    }
  | { kind: "models"; title: string; filter: string; loading: boolean; options: ModelChoice[]; index: number; selected: string[]; commit: (values: string[]) => void }
  | { kind: "choose"; title: string; filter: string; options: ChooseItem[]; index: number; commit: (value: string) => void }
  | { kind: "confirm"; title: string; message: string; onYes: () => void }
  | { kind: "message"; title: string; message: string }

/** What the focused row represents; drives `enter` and the secondary keys. */
type RowMeta =
  | { t: "initialize" }
  | { t: "default"; field: DefaultField }
  | { t: "agent"; name: string }
  | { t: "pipeline"; name: string }
  /** member set: the row is `steps[index].parallel[member]`; unset: `steps[index]` (a parallel group's header when that spec is a parallel block). */
  | { t: "step"; pipeline: string; index: number; member?: number }
  | { t: "add-step"; pipeline: string }
  | { t: "add-member"; pipeline: string; index: number }
  | { t: "add-pipeline" }
  | { t: "builtin"; name: string }

type DefaultField = { key: keyof ConvoyDefaults; type: "model" | "number" | "string" }

type Row = {
  chunks: (selected: boolean, width: number) => TextChunk[]
  meta?: RowMeta
}

const defaultFields: DefaultField[] = [
  { key: "model", type: "model" },
  { key: "autoAcceptJudgeModel", type: "model" },
  { key: "branchNameModel", type: "model" },
  { key: "maxAttempts", type: "number" },
  { key: "baseRef", type: "string" },
  { key: "pipeline", type: "string" },
]

const modalListHeight = 12

/** Synthetic top entry in the model picker; its empty value means "inherit / clear the override". */
const clearOption: ModelChoice = { value: "", label: "inherit — clear override", providerID: "" }

export function claudeModelPickerState(current: string | undefined): { options: ModelChoice[]; index: number } {
  const options: ModelChoice[] = [
    clearOption,
    ...claudeCodeModelAliases.map((alias) => ({ value: alias, label: `Claude ${alias}`, providerID: "claude-code" })),
  ]
  if (current && !options.some((choice) => choice.value === current)) {
    options.push({ value: current, label: `Claude ${current} · current`, providerID: "claude-code" })
  }
  const index = current ? options.findIndex((choice) => choice.value === current) : 0
  return { options, index }
}

export class ConfigEditor {
  readonly result: Promise<void>
  private resolveResult!: () => void

  private readonly tabs: [Tab, Tab]
  private active = 0
  private selected = 0
  private scroll = 0
  private readonly expanded = new Set<string>()
  private modal?: Modal
  private rows: Row[] = []

  private readonly ticker: ReturnType<typeof setInterval>
  private readonly headerText: TextRenderable
  private readonly listText: TextRenderable
  private readonly detailText: TextRenderable
  private readonly detailBox: BoxRenderable
  private readonly footerText: TextRenderable
  private readonly overlay: BoxRenderable
  private readonly modalBox: BoxRenderable
  private readonly modalText: TextRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.render()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.raw === "") {
      key.preventDefault()
      key.stopPropagation()
      this.tryQuit()
      return
    }
    key.preventDefault()
    key.stopPropagation()
    if (this.modal) this.handleModalKey(key)
    else this.handleListKey(key)
  }

  constructor(
    private readonly renderer: CliRenderer,
    targetDir: string,
    globalConfig: ConvoyConfig | undefined,
    projectConfig: ConvoyConfig | undefined,
  ) {
    this.tabs = [
      { title: "Global", path: globalConfigPath(), validateDir: convoyRoot(), config: globalConfig, dirty: false },
      { title: "Project", path: join(targetDir, ".convoy", "config.yaml"), validateDir: targetDir, config: projectConfig, dirty: false },
    ]
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })

    const shell = new BoxRenderable(renderer, {
      id: "convoy-config-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
    })

    const header = this.panel({ id: "convoy-config-header", height: 4, borderColor: theme.border, backgroundColor: theme.bg })
    const body = new BoxRenderable(renderer, { id: "convoy-config-body", width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 })
    const list = this.panel({
      id: "convoy-config-list",
      height: "100%",
      flexGrow: 1,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " configuration ",
      titleAlignment: "left",
    })
    const detail = this.panel({
      id: "convoy-config-detail",
      width: this.detailWidth(),
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " field ",
      titleAlignment: "left",
    })
    const footer = this.panel({ id: "convoy-config-footer", height: 3, borderColor: theme.borderDim, backgroundColor: theme.bg })

    this.headerText = header.text
    this.listText = list.text
    this.detailText = detail.text
    this.detailBox = detail.box
    this.footerText = footer.text

    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: header.box, background: "bg", border: "border" },
      { box: list.box, background: "bg", border: "borderDim" },
      { box: detail.box, background: "bg", border: "borderDim" },
      { box: footer.box, background: "bg", border: "borderDim" },
    )

    body.add(list.box)
    body.add(detail.box)
    shell.add(header.box)
    shell.add(body)
    shell.add(footer.box)
    renderer.root.add(shell)

    this.overlay = new BoxRenderable(renderer, {
      id: "convoy-config-overlay",
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
      id: "convoy-config-modal",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.overlay,
      paddingX: 2,
      paddingY: 1,
      title: " edit ",
      titleAlignment: "left",
    })
    this.modalText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    this.modalBox.add(this.modalText)
    this.overlay.add(this.modalBox)
    renderer.root.add(this.overlay)
    this.paletteTargets.push({ box: this.modalBox, background: "overlay", border: "accent" })

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)

    this.ticker = setInterval(() => this.render(), 250)
    this.render()
    this.selected = this.firstSelectable()
    this.render()
  }

  private tab() {
    return this.tabs[this.active]!
  }

  // ---- key handling -------------------------------------------------------

  private handleListKey(key: KeyEvent) {
    switch (key.name) {
      case "tab":
        this.active = this.active === 0 ? 1 : 0
        this.selected = this.firstSelectable()
        this.scroll = 0
        this.render()
        return
      case "up":
      case "k":
        if (key.shift) this.moveStep(-1)
        else this.moveSelection(-1)
        return
      case "down":
      case "j":
        if (key.shift) this.moveStep(1)
        else this.moveSelection(1)
        return
      case "pageup":
        this.moveSelection(-this.listHeight())
        return
      case "pagedown":
        this.moveSelection(this.listHeight())
        return
      case "return":
      case "linefeed":
        this.activateRow()
        return
      case "s":
        void this.save()
        return
      case "q":
      case "escape":
        this.tryQuit()
        return
      case "t":
        this.editTemperature()
        return
      case "m":
        if (key.shift) this.editStepModels()
        else this.editStepMaxAttempts()
        return
      case "g":
        this.toggleGroup()
        return
      case "n":
        this.editStepName()
        return
      case "r":
        if (key.shift) this.toggleStepRunner()
        else this.editReportsOrReadOnly()
        return
      case "x":
        this.toggleStepDiff()
        return
      case "d":
        this.deleteUnderCursor()
        return
      case "a":
        this.addUnderCursor()
        return
    }
  }

  private handleModalKey(key: KeyEvent) {
    const modal = this.modal
    if (!modal) return

    if (modal.kind === "message") {
      this.modal = undefined
      this.render()
      return
    }
    if (modal.kind === "confirm") {
      if (key.name === "y") {
        this.modal = undefined
        modal.onYes()
      } else if (key.name === "n" || key.name === "escape" || key.name === "q") {
        this.modal = undefined
      }
      this.render()
      return
    }
    if (key.name === "escape") {
      this.modal = undefined
      this.render()
      return
    }

    if (modal.kind === "input") {
      if (key.name === "return" || key.name === "linefeed") {
        const error = modal.validate?.(modal.value)
        if (error) {
          modal.error = error
        } else {
          this.modal = undefined
          modal.commit(modal.value)
        }
      } else if (key.name === "backspace") {
        modal.value = modal.value.slice(0, -1)
        modal.error = undefined
      } else {
        const char = typedChar(key)
        if (char !== undefined) {
          modal.value += char
          modal.error = undefined
        }
      }
      this.render()
      return
    }

    // model + models + choose share filter/navigation behavior
    const filtered = this.filteredOptions(modal)
    if (key.name === "up") {
      modal.index = Math.max(0, modal.index - 1)
    } else if (key.name === "down") {
      modal.index = Math.min(Math.max(0, filtered.length - 1), modal.index + 1)
    } else if (key.name === "backspace") {
      modal.filter = modal.filter.slice(0, -1)
      modal.index = 0
    } else if (modal.kind === "models" && key.name === "space") {
      // Space toggles instead of filtering; toggle order becomes the fan-out order.
      const chosen = filtered[modal.index]
      if (chosen) {
        const at = modal.selected.indexOf(chosen.value)
        if (at >= 0) modal.selected.splice(at, 1)
        else modal.selected.push(chosen.value)
      }
    } else if (key.name === "return" || key.name === "linefeed") {
      this.commitOption(modal, filtered)
      return
    } else {
      const char = typedChar(key)
      if (char !== undefined) {
        modal.filter += char
        modal.index = 0
      }
    }
    this.render()
  }

  private commitOption(modal: Modal & { kind: "model" | "models" | "choose" }, filtered: Array<ModelChoice | ChooseItem>) {
    if (modal.kind === "models") {
      this.modal = undefined
      modal.commit([...modal.selected])
      this.render()
      return
    }
    if (modal.kind === "model") {
      const chosen = filtered[modal.index] as ModelChoice | undefined
      if (chosen) {
        this.modal = undefined
        // The synthetic clear entry has an empty value: it means "inherit / clear".
        modal.commit(chosen.value === "" ? undefined : chosen.value)
        this.render()
        return
      }
      // Nothing highlighted: accept the typed text as a free-form model id.
      const text = modal.filter.trim()
      let value: string
      try {
        value = modal.normalize ? modal.normalize(text) : text
      } catch {
        this.render()
        return
      }
      if (!modal.normalize && !isValidModelString(value)) {
        this.render()
        return
      }
      this.modal = undefined
      modal.commit(value)
      this.render()
      return
    }
    const chosen = filtered[modal.index] as ChooseItem | undefined
    if (chosen) {
      this.modal = undefined
      modal.commit(chosen.value)
    }
    this.render()
  }

  private filteredOptions(modal: Modal): Array<ModelChoice | ChooseItem> {
    if (modal.kind === "model") return modal.options.filter((option) => matches(modal.filter, option.value, option.label))
    if (modal.kind === "models") {
      // Selected values missing from the catalog stay visible and toggleable.
      const known = new Set(modal.options.map((option) => option.value))
      const extras: ModelChoice[] = modal.selected.filter((value) => !known.has(value)).map((value) => ({ value, label: "not in catalog", providerID: "" }))
      const filtered = [...extras, ...modal.options].filter((option) => matches(modal.filter, option.value, option.label))
      const typed = modal.filter.trim()
      if (filtered.length === 0 && isValidModelString(typed)) return [{ value: typed, label: "typed", providerID: "" }]
      return filtered
    }
    if (modal.kind === "choose") return modal.options.filter((option) => matches(modal.filter, option.value, option.label, option.hint ?? ""))
    return []
  }

  // ---- actions ------------------------------------------------------------

  private activateRow() {
    const meta = this.rows[this.selected]?.meta
    if (!meta) return
    switch (meta.t) {
      case "initialize":
        this.tab().config = defaultConfigTemplate()
        this.tab().dirty = true
        this.selected = this.firstSelectable()
        this.render()
        return
      case "default":
        this.editDefault(meta.field)
        return
      case "agent":
        this.editAgentModel(meta.name)
        return
      case "pipeline":
        this.togglePipeline(meta.name)
        return
      case "step": {
        // Enter on a parallel group's header adds a member; on any other step it picks the model.
        const spec = this.specAtMeta(meta)
        if (meta.member === undefined && spec !== undefined && isParallelSpec(spec)) this.addMember(meta.pipeline, meta.index)
        else this.editStepModel(meta.pipeline, meta.index, meta.member)
        return
      }
      case "add-step":
        this.addStep(meta.pipeline)
        return
      case "add-member":
        this.addMember(meta.pipeline, meta.index)
        return
      case "add-pipeline":
        this.addPipeline()
        return
      case "builtin":
        this.customizeBuiltIn(meta.name)
        return
    }
  }

  private addUnderCursor() {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t === "pipeline") this.addStep(meta.name)
    else if (meta?.t === "step" && meta.member !== undefined) this.addMember(meta.pipeline, meta.index)
    else if (meta?.t === "step") {
      const spec = this.specAtMeta(meta)
      if (spec !== undefined && isParallelSpec(spec)) this.addMember(meta.pipeline, meta.index)
      else this.addStep(meta.pipeline)
    } else if (meta?.t === "add-member") this.addMember(meta.pipeline, meta.index)
    else if (meta?.t === "add-pipeline") this.addPipeline()
  }

  private deleteUnderCursor() {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t === "pipeline") this.deletePipeline(meta.name)
    else if (meta?.t === "step") this.deleteStep()
  }

  private stepsOf(pipeline: string): StepSpec[] | undefined {
    return this.tab().config?.pipelines[pipeline]?.steps
  }

  private specAtMeta(meta: RowMeta & { t: "step" }): StepSpec | undefined {
    const steps = this.stepsOf(meta.pipeline)
    return steps === undefined ? undefined : specAt(steps, meta.index, meta.member)
  }

  private otherTabDefines(name: string): boolean {
    return Boolean(this.tabs[this.active === 0 ? 1 : 0].config?.pipelines[name])
  }

  private editDefault(field: DefaultField) {
    const config = this.tab().config
    if (!config) return
    const current = config.defaults[field.key]
    if (field.type === "model") {
      this.openModelPicker(`defaults.${field.key}`, typeof current === "string" ? current : undefined, (value) => {
        setDefault(config.defaults, field.key, value)
        this.markDirty()
      })
      return
    }
    if (field.type === "number") {
      this.openInput(`defaults.${field.key}`, current === undefined ? "" : String(current), "positive integer, empty to clear", {
        validate: (value) => (value.trim() === "" || isPositiveInt(value) ? undefined : "must be a positive integer"),
        commit: (value) => {
          setDefault(config.defaults, field.key, value.trim() === "" ? undefined : Number(value))
          this.markDirty()
        },
      })
      return
    }
    this.openInput(`defaults.${field.key}`, current === undefined ? "" : String(current), "text, empty to clear", {
      commit: (value) => {
        setDefault(config.defaults, field.key, value.trim() === "" ? undefined : value.trim())
        this.markDirty()
      },
    })
  }

  private editAgentModel(name: string) {
    const config = this.tab().config
    if (!config) return
    const current = config.agents[name]?.model
    this.openModelPicker(`agents.${name}.model`, current, (value) => {
      const entry: ConfigAgent = { ...config.agents[name] }
      if (value === undefined) delete entry.model
      else entry.model = value
      if (Object.keys(entry).length === 0) delete config.agents[name]
      else config.agents[name] = entry
      this.markDirty()
    })
  }

  private editTemperature() {
    const meta = this.rows[this.selected]?.meta
    const config = this.tab().config
    if (!config || meta?.t !== "agent") return
    const current = config.agents[meta.name]?.temperature
    this.openInput(`agents.${meta.name}.temperature`, current === undefined ? "" : String(current), "0–2, empty to clear", {
      validate: (value) => (value.trim() === "" || isTemperature(value) ? undefined : "must be a number between 0 and 2"),
      commit: (value) => {
        const entry: ConfigAgent = { ...config.agents[meta.name] }
        if (value.trim() === "") delete entry.temperature
        else entry.temperature = Number(value)
        if (Object.keys(entry).length === 0) delete config.agents[meta.name]
        else config.agents[meta.name] = entry
        this.markDirty()
      },
    })
  }

  /** The focused row's step address plus its steps array, when it's an editable agent step. */
  private agentStepUnderCursor(): { steps: StepSpec[]; spec: string | AgentStepSpec; meta: RowMeta & { t: "step" } } | undefined {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t !== "step") return undefined
    const steps = this.stepsOf(meta.pipeline)
    const spec = steps === undefined ? undefined : specAt(steps, meta.index, meta.member)
    if (!steps || spec === undefined || isParallelSpec(spec) || isHumanStep(spec)) return undefined
    return { steps, spec: spec as string | AgentStepSpec, meta }
  }

  private editStepModel(pipelineName: string, index: number, member?: number) {
    const steps = this.stepsOf(pipelineName)
    const spec = steps === undefined ? undefined : specAt(steps, index, member)
    if (!steps || spec === undefined || isParallelSpec(spec) || isHumanStep(spec)) return
    const obj = asStepObject(spec)
    if (stepRunnerFor(obj.runner).id === "claude-code") {
      this.openClaudeModelPicker(`${stepLabel(pipelineName, index, member)}.model — Claude CLI alias/ID`, obj.model, (value) => {
        const next = { ...obj }
        if (value === undefined) delete next.model
        else next.model = value
        setSpecAt(steps, index, member, collapseStep(next))
        this.markDirty()
      })
      return
    }
    this.openModelPicker(`${stepLabel(pipelineName, index, member)}.model`, obj.model, (value) => {
      const next = { ...obj }
      // A single-model pick replaces a fan-out; model and models are mutually exclusive.
      delete next.models
      if (value === undefined) delete next.model
      else next.model = value
      setSpecAt(steps, index, member, collapseStep(next))
      this.markDirty()
    })
  }

  private editStepModels() {
    const at = this.agentStepUnderCursor()
    if (!at) return
    const obj = asStepObject(at.spec)
    if (!stepRunnerFor(obj.runner).capabilities.modelFanout) {
      this.message("Model fan-out unavailable", "Claude Code steps use one CLI model. Switch to OpenCode with Shift+R first.")
      return
    }
    const current = obj.models ?? (obj.model !== undefined ? [obj.model] : [])
    this.openModelsPicker(`${stepLabel(at.meta.pipeline, at.meta.index, at.meta.member)}.models`, current, (values) => {
      setSpecAt(at.steps, at.meta.index, at.meta.member, collapseStep(applyModelsSelection(obj, values)))
      this.markDirty()
    })
  }

  private toggleStepRunner() {
    const at = this.agentStepUnderCursor()
    if (!at) return
    const spec = asStepObject(at.spec)
    const agentName = agentAliases[spec.agent] ?? spec.agent
    const agent = buildAgentRegistry(this.effectiveConfig()).find((candidate) => candidate.name === agentName)
    const supportsReadOnlyRunner = at.meta.member !== undefined || agent?.readOnly === true
    const result = toggleStepRunnerSpec(spec, supportsReadOnlyRunner)
    if (!result.ok) {
      const detail =
        result.reason === "model-fanout"
          ? "Remove the models fan-out before switching this step to Claude Code."
          : "Claude Code currently supports read-only steps only. Use a read-only agent or place the step in a parallel audit group."
      this.message("Can't switch runner", detail)
      return
    }
    const apply = () => {
      setSpecAt(at.steps, at.meta.index, at.meta.member, collapseStep(result.spec))
      this.markDirty()
    }
    if (!result.clearedModel) {
      apply()
      return
    }
    this.modal = {
      kind: "confirm",
      title: "Switch step runner",
      message: "The current model belongs to the other runner and will be cleared. Continue? [y/n]",
      onYes: apply,
    }
    this.render()
  }

  private editStepMaxAttempts() {
    const at = this.agentStepUnderCursor()
    if (!at) return
    const obj = asStepObject(at.spec)
    const { pipeline, index, member } = at.meta
    this.openInput(`${stepLabel(pipeline, index, member)}.maxAttempts`, obj.maxAttempts === undefined ? "" : String(obj.maxAttempts), "positive integer, empty to clear", {
      validate: (value) => (value.trim() === "" || isPositiveInt(value) ? undefined : "must be a positive integer"),
      commit: (value) => {
        const next = { ...obj }
        if (value.trim() === "") delete next.maxAttempts
        else next.maxAttempts = Number(value)
        setSpecAt(at.steps, index, member, collapseStep(next))
        this.markDirty()
      },
    })
  }

  private editStepName() {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t !== "step") return
    const steps = this.stepsOf(meta.pipeline)
    const spec = steps === undefined ? undefined : specAt(steps, meta.index, meta.member)
    if (!steps || spec === undefined || isParallelSpec(spec)) return
    const current = typeof spec === "string" ? undefined : spec.name
    this.openInput(`${stepLabel(meta.pipeline, meta.index, meta.member)}.name`, current ?? "", "step/report name, empty to clear", {
      validate: (value) => {
        const name = value.trim()
        if (!name) return undefined
        if (!isSafeStepName(name)) return "must use only letters, numbers, hyphens, or underscores"
        if (name === humanReviewStep || name.startsWith(`${humanReviewStep}-`)) return `"${humanReviewStep}" is a reserved name`
        return undefined
      },
      commit: (value) => {
        const name = value.trim()
        if (isHumanStepSpec(spec)) {
          const next: HumanStepSpec = { ...spec }
          if (!name) delete next.name
          else next.name = name
          setSpecAt(steps, meta.index, meta.member, next)
        } else {
          const next = asStepObject(spec as string | AgentStepSpec)
          if (!name) delete next.name
          else next.name = name
          setSpecAt(steps, meta.index, meta.member, collapseStep(next))
        }
        this.markDirty()
      },
    })
  }

  /** `r` edits reports on step rows and cycles readOnly on agent rows. */
  private editReportsOrReadOnly() {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t === "agent") {
      this.toggleAgentReadOnly(meta.name)
      return
    }
    this.editStepReports()
  }

  private editStepReports() {
    const at = this.agentStepUnderCursor()
    if (!at) return
    const obj = asStepObject(at.spec)
    const { pipeline, index, member } = at.meta
    const title = `${stepLabel(pipeline, index, member)}.reports`
    const apply = (reports: AgentStepSpec["reports"] | undefined) => {
      const next = { ...obj }
      if (reports === undefined) delete next.reports
      else next.reports = reports
      setSpecAt(at.steps, index, member, collapseStep(next))
      this.markDirty()
    }
    this.modal = {
      kind: "choose",
      title,
      filter: "",
      index: 0,
      options: [
        { value: "inherit", label: "inherit (clear)", hint: "default: the nearest previous group" },
        { value: "previous", label: "previous", hint: "reports from the nearest previous group" },
        { value: "all", label: "all", hint: "every prior step report" },
        { value: "none", label: "none", hint: "no prior reports" },
        { value: "custom", label: "custom…", hint: "explicit list of earlier step names" },
      ],
      commit: (value) => {
        if (value !== "custom") {
          apply(value === "inherit" ? undefined : (value as "previous" | "all" | "none"))
          return
        }
        const known = priorStepNames(at.steps, index)
        this.openInput(title, Array.isArray(obj.reports) ? obj.reports.join(", ") : "", `comma-separated earlier step names (${known.length > 0 ? known.join(", ") : "none available"})`, {
          validate: (value) => {
            const names = splitNameList(value)
            if (names.length === 0) return "list at least one step name"
            const unknown = names.find((name) => !known.includes(name))
            return unknown === undefined ? undefined : `"${unknown}" is not an earlier step`
          },
          commit: (value) => apply(splitNameList(value)),
        })
      },
    }
    this.render()
  }

  /** Cycles diff: unset (contextual default: on except for the first agent step) → on → off → unset. */
  private toggleStepDiff() {
    const at = this.agentStepUnderCursor()
    if (!at) return
    const obj = asStepObject(at.spec)
    const next = { ...obj }
    if (obj.diff === undefined) next.diff = true
    else if (obj.diff) next.diff = false
    else delete next.diff
    setSpecAt(at.steps, at.meta.index, at.meta.member, collapseStep(next))
    this.markDirty()
  }

  /** Cycles readOnly: unset (agent's own default) → true → false → unset. */
  private toggleAgentReadOnly(name: string) {
    const config = this.tab().config
    if (!config) return
    const entry: ConfigAgent = { ...config.agents[name] }
    if (entry.readOnly === undefined) entry.readOnly = true
    else if (entry.readOnly) entry.readOnly = false
    else delete entry.readOnly
    if (Object.keys(entry).length === 0) delete config.agents[name]
    else config.agents[name] = entry
    this.markDirty()
  }

  /** `g` groups/ungroups: wraps a sequential step into a parallel group, ejects a member, or dissolves a group. */
  private toggleGroup() {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t !== "step") return
    const steps = this.stepsOf(meta.pipeline)
    if (!steps) return
    if (meta.member !== undefined) {
      const at = ejectMember(steps, meta.index, meta.member)
      if (at === undefined) return
      this.markDirty()
      this.selectStep(meta.pipeline, at, undefined)
      return
    }
    const spec = steps[meta.index]
    if (spec === undefined) return
    if (isParallelSpec(spec)) {
      const at = dissolveParallel(steps, meta.index)
      if (at === undefined) return
      this.markDirty()
      this.selectStep(meta.pipeline, at, undefined)
      return
    }
    if (isHumanStep(spec)) {
      this.message("Can't parallelize", "Human steps can't run inside a parallel block.")
      return
    }
    const at = wrapInParallel(steps, meta.index)
    if (at === undefined) return
    this.markDirty()
    this.selectStep(meta.pipeline, at.index, at.member)
  }

  private addStep(pipelineName: string) {
    const config = this.tab().config
    const pipeline = config?.pipelines[pipelineName]
    if (!config || !pipeline) return
    const options: ChooseItem[] = [
      { value: humanStepType, label: humanStepType, hint: "manual human gate" },
      ...buildAgentRegistry(config).map((agent) => ({ value: agent.name, label: agent.name, hint: agent.description })),
    ]
    this.modal = {
      kind: "choose",
      title: `add step to "${pipelineName}"`,
      filter: "",
      index: 0,
      options,
      commit: (value) => {
        pipeline.steps.push(value === humanStepType ? { type: humanStepType } : value)
        this.expanded.add(this.expandKey(pipelineName))
        this.markDirty()
      },
    }
    this.render()
  }

  private addMember(pipelineName: string, index: number) {
    const config = this.tab().config
    const steps = this.stepsOf(pipelineName)
    if (!config || !steps) return
    // No human option: human steps can't run inside a parallel block.
    const options: ChooseItem[] = buildAgentRegistry(config).map((agent) => ({ value: agent.name, label: agent.name, hint: agent.description }))
    this.modal = {
      kind: "choose",
      title: `add parallel member to ${stepLabel(pipelineName, index)}`,
      filter: "",
      index: 0,
      options,
      commit: (value) => {
        const at = addParallelMember(steps, index, value)
        this.markDirty()
        if (at !== undefined) this.selectStep(pipelineName, index, at)
      },
    }
    this.render()
  }

  private deleteStep() {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t !== "step") return
    const steps = this.stepsOf(meta.pipeline)
    const spec = steps === undefined ? undefined : specAt(steps, meta.index, meta.member)
    if (!steps || spec === undefined) return
    const removing = isParallelSpec(spec) ? spec.parallel.length : isHumanStep(spec) ? 0 : 1
    if (removing > 0 && agentStepCount(steps) - removing < 1) {
      this.message("Can't delete", "A pipeline needs at least one agent step.")
      return
    }
    deleteAt(steps, meta.index, meta.member)
    this.markDirty()
  }

  private deletePipeline(name: string) {
    const config = this.tab().config
    if (!config?.pipelines[name]) return
    const revertsTo = builtInPipelines[name] ? " The built-in of the same name takes over." : ""
    this.modal = {
      kind: "confirm",
      title: `Delete pipeline "${name}"`,
      message: `Delete pipeline "${name}" from this config?${revertsTo} [y/n]`,
      onYes: () => {
        delete config.pipelines[name]
        this.expanded.delete(this.expandKey(name))
        this.markDirty()
      },
    }
    this.render()
  }

  private customizeBuiltIn(name: string) {
    const config = this.tab().config
    const spec = builtInPipelines[name]
    if (!config || !spec || config.pipelines[name]) return
    this.modal = {
      kind: "confirm",
      title: `Customize "${name}"`,
      message: `Copy the built-in "${name}" pipeline into this config as an editable override? [y/n]`,
      onYes: () => {
        config.pipelines[name] = materializePipelineSpec(spec, this.effectiveDefaultModel())
        this.expanded.add(this.expandKey(name))
        this.markDirty()
        this.selectPipelineRow(name)
      },
    }
    this.render()
  }

  /**
   * The defaults.model a run would resolve steps against from this tab's
   * viewpoint: project ?? global on the Project tab (mergeConvoyConfigs lets
   * project win), the global one on the Global tab. Drives whether built-in
   * agent model preferences must be pinned when materializing a built-in.
   */
  private effectiveDefaultModel(): string | undefined {
    const global = this.tabs[0].config?.defaults.model
    if (this.active === 0) return global
    return this.tabs[1].config?.defaults.model ?? global
  }

  private effectiveConfig(): ConvoyConfig | undefined {
    if (this.active === 0) return this.tabs[0].config
    return mergeConvoyConfigs(this.tabs[0].config, this.tabs[1].config)
  }

  private moveStep(direction: -1 | 1) {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t !== "step") return
    const steps = this.stepsOf(meta.pipeline)
    if (!steps) return
    if (meta.member !== undefined) {
      const at = moveMember(steps, meta.index, meta.member, direction)
      if (at === undefined) return
      this.markDirty()
      this.selectStep(meta.pipeline, meta.index, at)
      return
    }
    const target = meta.index + direction
    if (target < 0 || target >= steps.length) return
    ;[steps[meta.index], steps[target]] = [steps[target]!, steps[meta.index]!]
    this.markDirty()
    this.selectStep(meta.pipeline, target, undefined)
  }

  /** Re-anchors the cursor on the row addressing a step after a structural change. */
  private selectStep(pipeline: string, index: number, member: number | undefined) {
    this.rows = this.buildRows()
    const at = this.rows.findIndex(
      (row) => row.meta?.t === "step" && row.meta.pipeline === pipeline && row.meta.index === index && row.meta.member === member,
    )
    if (at >= 0) this.selected = at
    this.render()
  }

  private selectPipelineRow(name: string) {
    this.rows = this.buildRows()
    const at = this.rows.findIndex((row) => row.meta?.t === "pipeline" && row.meta.name === name)
    if (at >= 0) this.selected = at
    this.render()
  }

  private addPipeline() {
    const config = this.tab().config
    if (!config) return
    this.openInput("new pipeline name", "", "lowercase name, e.g. quick", {
      validate: (value) => {
        const name = value.trim()
        if (!name) return "name can't be empty"
        if (config.pipelines[name]) return `pipeline "${name}" already exists`
        return undefined
      },
      commit: (value) => {
        const name = value.trim()
        config.pipelines[name] = { steps: ["implementer"] }
        this.expanded.add(this.expandKey(name))
        this.markDirty()
      },
    })
  }

  private togglePipeline(name: string) {
    const key = this.expandKey(name)
    if (this.expanded.has(key)) this.expanded.delete(key)
    else this.expanded.add(key)
    this.render()
  }

  private markDirty() {
    this.tab().dirty = true
    this.render()
  }

  private async save() {
    const tab = this.tab()
    if (!tab.config) return
    const config = pruneConfig(tab.config)
    // Parse-level validation can't see resolve problems (duplicate step names,
    // unknown agents, dangling reports refs). Warn but let the user save: a
    // global pipeline may reference agents that only exist in some project.
    const problem = Object.entries(config.pipelines)
      .map(([name, spec]) => checkPipelineResolves(name, spec, config))
      .find((error) => error !== undefined)
    if (problem) {
      this.modal = {
        kind: "confirm",
        title: "Pipeline won't resolve",
        message: `${problem} — save anyway? [y/n]`,
        onYes: () => void this.persist(config),
      }
      this.render()
      return
    }
    await this.persist(config)
  }

  private async persist(config: ConvoyConfig) {
    const tab = this.tab()
    try {
      await writeConvoyConfig(tab.path, config, tab.validateDir)
      tab.config = config
      tab.dirty = false
      this.message("Saved", tab.path)
    } catch (error) {
      this.message("Save failed", error instanceof Error ? error.message : String(error))
    }
  }

  private tryQuit() {
    if (this.tabs.some((tab) => tab.dirty)) {
      this.modal = {
        kind: "confirm",
        title: "Unsaved changes",
        message: "Discard unsaved changes and quit? [y/n]",
        onYes: () => this.finish(),
      }
      this.render()
      return
    }
    this.finish()
  }

  // ---- modal openers ------------------------------------------------------

  private openInput(title: string, value: string, help: string, options: { validate?: (value: string) => string | undefined; commit: (value: string) => void }) {
    this.modal = { kind: "input", title, help, value, validate: options.validate, commit: options.commit }
    this.render()
  }

  private openModelPicker(title: string, current: string | undefined, commit: (value: string | undefined) => void) {
    const modal: Modal = { kind: "model", title, filter: "", loading: true, options: [clearOption], index: 0, commit }
    this.modal = modal
    this.render()
    // Model edits target the project repo for provider resolution; the global tab has none of its own.
    const dir = this.tab().validateDir === convoyRoot() ? process.cwd() : this.tab().validateDir
    listModels(dir)
      .then((choices) => {
        if (this.modal !== modal) return
        modal.options = [clearOption, ...choices]
        modal.loading = false
        if (current) {
          const at = modal.options.findIndex((choice) => choice.value === current)
          if (at >= 0) modal.index = at
        }
        this.render()
      })
      .catch(() => {
        if (this.modal !== modal) return
        modal.loading = false
        this.render()
      })
  }

  private openClaudeModelPicker(title: string, current: string | undefined, commit: (value: string | undefined) => void) {
    const { options, index } = claudeModelPickerState(current)
    this.modal = {
      kind: "model",
      title,
      filter: "",
      loading: false,
      options,
      index,
      normalize: (value) => normalizeStepRunnerModel("claude-code", value),
      commit,
    }
    this.render()
  }

  private openModelsPicker(title: string, current: string[], commit: (values: string[]) => void) {
    const modal: Modal = { kind: "models", title, filter: "", loading: true, options: [], index: 0, selected: [...current], commit }
    this.modal = modal
    this.render()
    // Same provider resolution as the single picker: the global tab has no repo of its own.
    const dir = this.tab().validateDir === convoyRoot() ? process.cwd() : this.tab().validateDir
    listModels(dir)
      .then((choices) => {
        if (this.modal !== modal) return
        modal.options = choices
        modal.loading = false
        this.render()
      })
      .catch(() => {
        if (this.modal !== modal) return
        modal.loading = false
        this.render()
      })
  }

  private message(title: string, message: string) {
    this.modal = { kind: "message", title, message }
    this.render()
  }

  private finish() {
    clearInterval(this.ticker)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    if (!this.renderer.isDestroyed) this.renderer.destroy()
    this.resolveResult()
  }

  // ---- navigation ---------------------------------------------------------

  private moveSelection(delta: number) {
    if (this.rows.length === 0) return
    const step = delta === 0 ? 0 : delta > 0 ? 1 : -1
    let index = this.selected
    let remaining = Math.abs(delta)
    while (remaining > 0) {
      let next = index + step
      while (next >= 0 && next < this.rows.length && !this.rows[next]!.meta) next += step
      if (next < 0 || next >= this.rows.length) break
      index = next
      remaining--
    }
    this.selected = index
    this.render()
  }

  private firstSelectable() {
    const at = this.rows.findIndex((row) => row.meta)
    return at < 0 ? 0 : at
  }

  private expandKey(name: string) {
    return `${this.active}:${name}`
  }

  // ---- row model ----------------------------------------------------------

  private buildRows(): Row[] {
    const config = this.tab().config
    if (!config) {
      return [
        sectionRow("No config file yet"),
        infoRow(`Nothing at ${shortenPath(this.tab().path)}.`),
        blankRow(),
        actionRow("⊕ Initialize default config", { t: "initialize" }),
      ]
    }

    const rows: Row[] = []

    rows.push(sectionRow("Defaults"))
    for (const field of defaultFields) {
      const value = config.defaults[field.key]
      rows.push(fieldRow(field.key, value === undefined ? "(unset)" : String(value), { t: "default", field }))
    }

    rows.push(blankRow(), sectionRow("Agents"))
    for (const agent of buildAgentRegistry(config)) {
      const model = config.agents[agent.name]?.model
      const temp = config.agents[agent.name]?.temperature
      const readOnly = config.agents[agent.name]?.readOnly
      const readOnlyLabel = readOnly === undefined ? "" : readOnly ? "  ·  read-only" : "  ·  writable (override)"
      const value = (model ?? "(inherits)") + (temp !== undefined ? `  ·  temp ${temp}` : "") + readOnlyLabel
      rows.push(fieldRow(agent.name, value, { t: "agent", name: agent.name }))
    }

    rows.push(blankRow(), sectionRow("Pipelines"))
    const pipelineNames = Object.keys(config.pipelines)
    if (pipelineNames.length === 0) {
      rows.push(infoRow("none defined here — built-in 'implement' is used"))
    }
    for (const name of pipelineNames) {
      const open = this.expanded.has(this.expandKey(name))
      rows.push(pipelineRow(name, config.pipelines[name]!, open))
      if (open) {
        const steps = config.pipelines[name]!.steps
        steps.forEach((spec, index) => {
          if (isParallelSpec(spec)) {
            rows.push(parallelHeaderRow(name, index, spec))
            spec.parallel.forEach((member, memberIndex) => rows.push(memberRow(name, index, memberIndex, member)))
            rows.push(actionRow("        ⊕ add member", { t: "add-member", pipeline: name, index }))
          } else {
            rows.push(stepRow(name, index, spec))
          }
        })
        rows.push(actionRow("  ⊕ add step", { t: "add-step", pipeline: name }))
      }
    }
    rows.push(actionRow("⊕ add pipeline", { t: "add-pipeline" }))

    // Built-ins not shadowed by a config pipeline of the same name; enter copies
    // one into this config as an editable override (the row disappears then).
    const builtins = Object.keys(builtInPipelines).filter((name) => !config.pipelines[name])
    if (builtins.length > 0) {
      rows.push(blankRow(), sectionRow("Built-in pipelines  (enter to customize)"))
      for (const name of builtins) {
        const spec = builtInPipelines[name]!
        rows.push(fieldRow(name, `built-in · ${spec.steps.length} step${spec.steps.length === 1 ? "" : "s"}`, { t: "builtin", name }))
      }
    }

    rows.push(blankRow(), sectionRow("Permissions  (read-only — edit in .convoy/config.yaml)"))
    rows.push(infoRow(readonlyList("allow", config.permissions.allow)))
    rows.push(infoRow(readonlyList("deny", config.permissions.deny)))
    rows.push(blankRow(), sectionRow("Hooks  (read-only — edit in .convoy/config.yaml)"))
    rows.push(infoRow(readonlyList("pre", config.hooks.pre.map(describeHook))))
    rows.push(infoRow(readonlyList("post", config.hooks.post.map(describeHook))))
    const pipelineHooks = Object.entries(config.hooks.pipelines).flatMap(([name, set]) => [
      ...set.pre.map((hook) => `${name}:pre:${describeHook(hook)}`),
      ...set.post.map((hook) => `${name}:post:${describeHook(hook)}`),
    ])
    rows.push(infoRow(readonlyList("pipeline", pipelineHooks)))
    rows.push(blankRow(), sectionRow("Attachments  (read-only — edit in .convoy/config.yaml)"))
    rows.push(infoRow(readonlyList("files", config.attachments)))

    return rows
  }

  // ---- rendering ----------------------------------------------------------

  private detailWidth() {
    return Math.max(30, Math.min(48, this.renderer.width - 60))
  }

  private listHeight() {
    return Math.max(3, this.renderer.height - 9)
  }

  private render() {
    if (this.renderer.isDestroyed) return
    this.rows = this.buildRows()
    if (this.selected >= this.rows.length) this.selected = this.firstSelectable()
    if (!this.rows[this.selected]?.meta) this.selected = this.firstSelectable()

    const innerWidth = Math.max(40, this.renderer.width - 6)
    const detailWidth = this.detailWidth()
    const listWidth = Math.max(30, this.renderer.width - detailWidth - 7)

    this.detailBox.width = detailWidth
    this.headerText.content = this.headerContent(innerWidth)
    this.listText.content = this.listContent(listWidth)
    this.detailText.content = this.detailContent(detailWidth - 4)
    this.footerText.content = this.footerContent(innerWidth)
    this.renderModal()
    this.renderer.requestRender()
  }

  private headerContent(width: number) {
    const tabs: TextChunk[] = []
    this.tabs.forEach((tab, index) => {
      if (index > 0) tabs.push(fg(theme.faint)("   "))
      const label = `${tab.title}${tab.dirty ? " ●" : ""}`
      tabs.push(index === this.active ? bold(fg(theme.accent)(`▸ ${label}`)) : fg(theme.dim)(`  ${label}`))
    })
    const title: TextChunk[] = [bold(fg(theme.accent)("◆ convoy")), fg(theme.faint)("  ·  "), fg(theme.text)("config")]
    const line1 = padBetween(title, tabs, width)
    const line2 = new StyledText([fg(theme.dim)(truncate(shortenPath(this.tab().path), width))])
    return joinLines([line1, line2])
  }

  private listContent(width: number) {
    const visible = this.listHeight()
    if (this.selected < this.scroll) this.scroll = this.selected
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1
    const slice = this.rows.slice(this.scroll, this.scroll + visible)
    const lines = slice.map((row, offset) => new StyledText(row.chunks(this.scroll + offset === this.selected, width)))
    while (lines.length < visible) lines.push(plain(""))
    return joinLines(lines)
  }

  private detailContent(width: number) {
    const meta = this.rows[this.selected]?.meta
    const lines: StyledText[] = []
    const push = (chunks: TextChunk[]) => lines.push(new StyledText(chunks))

    if (!meta) {
      push([fg(theme.dim)("—")])
      return joinLines(lines)
    }
    switch (meta.t) {
      case "initialize":
        push([fg(theme.text)("Create a starter config")])
        push([fg(theme.faint)("with the built-in default")])
        push([fg(theme.faint)("pipeline and models, ready")])
        push([fg(theme.faint)("to edit.")])
        lines.push(plain(""))
        push([fg(theme.accent)("enter"), fg(theme.dim)(" initialize")])
        break
      case "default":
        push([fg(theme.text)(`defaults.${meta.field.key}`)])
        push([fg(theme.faint)(describeDefault(meta.field.key))])
        lines.push(plain(""))
        push([fg(theme.accent)("enter"), fg(theme.dim)(meta.field.type === "model" ? " pick a model" : " edit value")])
        break
      case "agent":
        push([fg(theme.text)(`agent: ${meta.name}`)])
        push([fg(theme.faint)("Model, temperature, or readOnly override.")])
        lines.push(plain(""))
        push([fg(theme.accent)("enter"), fg(theme.dim)(" pick model   "), fg(theme.accent)("t"), fg(theme.dim)(" temperature")])
        push([fg(theme.accent)("r"), fg(theme.dim)(" read-only: unset → on → off")])
        break
      case "pipeline":
        push([fg(theme.text)(`pipeline: ${meta.name}`)])
        if (builtInPipelines[meta.name]) push([fg(theme.faint)("Overrides the built-in of the same name.")])
        lines.push(plain(""))
        push([fg(theme.accent)("enter"), fg(theme.dim)(" expand/collapse   "), fg(theme.accent)("a"), fg(theme.dim)(" add step")])
        push([fg(theme.accent)("d"), fg(theme.dim)(" delete pipeline")])
        break
      case "step": {
        const spec = this.specAtMeta(meta)
        const position = meta.member === undefined ? `${meta.index + 1}` : `${meta.index + 1}.${meta.member + 1}`
        if (spec !== undefined && isParallelSpec(spec)) {
          push([fg(theme.text)(`parallel group ${position} of ${meta.pipeline}`)])
          push([fg(theme.faint)("Members run concurrently and are")])
          push([fg(theme.faint)("forced read-only.")])
          lines.push(plain(""))
          push([fg(theme.accent)("enter/a"), fg(theme.dim)(" add member   "), fg(theme.accent)("g"), fg(theme.dim)(" dissolve")])
          push([fg(theme.accent)("d"), fg(theme.dim)(" delete group   "), fg(theme.accent)("shift+↑/↓"), fg(theme.dim)(" move")])
          break
        }
        if (spec !== undefined && isHumanStep(spec)) {
          push([fg(theme.text)(`human gate ${position} of ${meta.pipeline}`)])
          lines.push(plain(""))
          push([fg(theme.accent)("n"), fg(theme.dim)(" name   "), fg(theme.accent)("d"), fg(theme.dim)(" delete   "), fg(theme.accent)("shift+↑/↓"), fg(theme.dim)(" reorder")])
          break
        }
        const step = spec === undefined ? undefined : asStepObject(spec as string | AgentStepSpec)
        const runner = stepRunnerFor(step?.runner)
        push([fg(theme.text)(`step ${position} of ${meta.pipeline}`)])
        if (meta.member !== undefined) push([fg(theme.faint)("Parallel member: read-only at run time.")])
        push([fg(theme.faint)(`runner: ${runner.displayName}${runner.capabilities.writeSteps ? "" : " (read-only)"}`)])
        lines.push(plain(""))
        push([
          fg(theme.accent)("enter"),
          fg(theme.dim)(runner.id === "claude-code" ? " edit CLI model   " : " pick model   "),
          fg(theme.accent)("M"),
          fg(theme.dim)(runner.capabilities.modelFanout ? " multi-model" : " unavailable"),
        ])
        push([fg(theme.accent)("m"), fg(theme.dim)(" max-attempts   "), fg(theme.accent)("n"), fg(theme.dim)(" name")])
        push([fg(theme.accent)("r"), fg(theme.dim)(" reports   "), fg(theme.accent)("R"), fg(theme.dim)(" runner   "), fg(theme.accent)("x"), fg(theme.dim)(" diff")])
        push([fg(theme.accent)("d"), fg(theme.dim)(" delete   "), fg(theme.accent)("g"), fg(theme.dim)(meta.member === undefined ? " make parallel   " : " eject from group   ")])
        push([fg(theme.accent)("shift+↑/↓"), fg(theme.dim)(" reorder")])
        break
      }
      case "add-step":
        push([fg(theme.text)("Add a step")])
        push([fg(theme.accent)("enter"), fg(theme.dim)(" choose an agent or gate")])
        break
      case "add-member":
        push([fg(theme.text)("Add a parallel member")])
        push([fg(theme.faint)("Members run concurrently, read-only.")])
        push([fg(theme.accent)("enter"), fg(theme.dim)(" choose an agent")])
        break
      case "add-pipeline":
        push([fg(theme.text)("Add a pipeline")])
        push([fg(theme.accent)("enter"), fg(theme.dim)(" name a new pipeline")])
        break
      case "builtin": {
        push([fg(theme.text)(`built-in pipeline: ${meta.name}`)])
        for (const line of wrapText(builtInPipelines[meta.name]?.description ?? "", width).slice(0, 6)) push([fg(theme.faint)(line)])
        lines.push(plain(""))
        if (this.otherTabDefines(meta.name)) push([fg(theme.yellow)(`also customized in ${this.tabs[this.active === 0 ? 1 : 0].title}`)])
        push([fg(theme.accent)("enter"), fg(theme.dim)(" copy here to customize")])
        break
      }
    }
    return joinLines(lines)
  }

  private footerContent(width: number) {
    const left: TextChunk[] = [
      fg(theme.dim)("↑/↓ move · "),
      fg(theme.accent)("enter"),
      fg(theme.dim)(" edit · "),
      fg(theme.accent)("s"),
      fg(theme.dim)("ave · "),
      fg(theme.accent)("tab"),
      fg(theme.dim)(" switch · "),
      fg(theme.accent)("q"),
      fg(theme.dim)("uit"),
    ]
    const dirty = this.tab().dirty ? fg(theme.yellow)("● unsaved") : fg(theme.faint)("saved")
    return padBetween(left, [dirty], width)
  }

  private modalWidth() {
    return Math.max(46, Math.min(80, this.renderer.width - 10))
  }

  private renderModal() {
    const modal = this.modal
    this.overlay.visible = Boolean(modal)
    if (!modal) return
    const boxWidth = this.modalWidth()
    const width = boxWidth - 6
    const lines: StyledText[] = []
    const push = (chunks: TextChunk[]) => lines.push(new StyledText(chunks))

    this.modalBox.title = ` ${truncate(modal.title, boxWidth - 8)} `

    if (modal.kind === "message" || modal.kind === "confirm") {
      push([fg(theme.text)(truncate(modal.message, width))])
      lines.push(plain(""))
      push([fg(theme.dim)(modal.kind === "confirm" ? "y / n" : "press any key to dismiss")])
    } else if (modal.kind === "input") {
      push([fg(theme.faint)(modal.help)])
      lines.push(plain(""))
      push([fg(theme.accent)("> "), fg(theme.text)(modal.value), fg(theme.dim)("▏")])
      lines.push(plain(""))
      if (modal.error) push([fg(theme.red)(modal.error)])
      else push([fg(theme.dim)("enter confirm · esc cancel")])
    } else {
      // model / models / choose
      push([fg(theme.accent)("filter: "), fg(theme.text)(modal.filter), fg(theme.dim)("▏")])
      lines.push(plain(""))
      const filtered = this.filteredOptions(modal)
      if ((modal.kind === "model" || modal.kind === "models") && modal.loading) {
        push([fg(theme.accent)(spinnerFrame(Date.now())), fg(theme.dim)(" loading models…")])
      } else if (filtered.length === 0) {
        const hint = modal.kind === "model" && isValidModelString(modal.filter.trim()) ? "no match — enter uses typed value" : "no matches"
        push([fg(theme.dim)(hint)])
      } else {
        const start = Math.max(0, Math.min(modal.index - Math.floor(modalListHeight / 2), filtered.length - modalListHeight))
        const windowed = filtered.slice(start, start + modalListHeight)
        windowed.forEach((option, offset) => {
          const index = start + offset
          const selected = index === modal.index
          const valueText = truncateChunkSafe(option.value, Math.max(12, Math.floor(width * 0.5)))
          const marker = selected ? fg(theme.accent)("▸ ") : raw("  ")
          const value = selected ? bold(fg(theme.text)(valueText)) : fg(theme.text)(valueText)
          const hint = optionHint(option)
          const chunks: TextChunk[] = [marker]
          if (modal.kind === "models") {
            const on = modal.selected.includes(option.value)
            chunks.push(on ? fg(theme.accent)("◆ ") : fg(theme.dim)("◇ "))
          }
          chunks.push(value)
          if (hint) chunks.push(fg(theme.faint)(`   ${truncateChunkSafe(hint, Math.max(8, width - valueText.length - 6))}`))
          push(chunks)
        })
      }
      lines.push(plain(""))
      if (modal.kind === "models") {
        const summary =
          modal.selected.length === 0 ? "0 selected → inherit" : modal.selected.length === 1 ? `1 selected → model: ${modal.selected[0]}` : `${modal.selected.length} selected → models fan-out (read-only)`
        push([fg(theme.text)(truncate(summary, width))])
        push([fg(theme.dim)("space toggle · enter apply · esc cancel")])
      } else {
        const help = modal.kind === "model" ? "↑/↓ select · type to filter · enter set · esc cancel" : "↑/↓ select · type to filter · enter add · esc cancel"
        push([fg(theme.dim)(help)])
      }
    }

    this.modalBox.width = boxWidth
    this.modalBox.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }

  private applyPalette() {
    for (const target of this.paletteTargets) {
      target.box.backgroundColor = theme[target.background]
      if (target.border) target.box.borderColor = theme[target.border]
    }
  }

  private panel(options: BoxOptions) {
    const box = new BoxRenderable(this.renderer, { border: true, borderStyle: "rounded", paddingX: 1, paddingY: 0, ...options })
    const text = new TextRenderable(this.renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    box.add(text)
    return { box, text }
  }
}

// ---- row builders ---------------------------------------------------------

function sectionRow(text: string): Row {
  return { chunks: (_selected, width) => [bold(fg(theme.accent)(truncateChunkSafe(text, width)))] }
}

function blankRow(): Row {
  return { chunks: () => [raw("")] }
}

function infoRow(text: string): Row {
  return { chunks: (_selected, width) => [fg(theme.faint)(truncateChunkSafe(text, width))] }
}

function fieldRow(label: string, value: string, meta: RowMeta): Row {
  const labelCol = label.padEnd(18)
  return {
    meta,
    chunks: (selected, width) => [
      selected ? fg(theme.accent)("▸ ") : raw("  "),
      selected ? bold(fg(theme.text)(labelCol)) : fg(theme.text)(labelCol),
      // Explicit gap so names longer than the column still separate from the value.
      raw(" "),
      fg(theme.dim)(truncateChunkSafe(value, Math.max(8, width - 23))),
    ],
  }
}

function actionRow(label: string, meta: RowMeta): Row {
  return { meta, chunks: (selected, width) => [selected ? fg(theme.accent)("▸ ") : raw("  "), fg(theme.accent)(truncateChunkSafe(label, Math.max(8, width - 2)))] }
}

function pipelineRow(name: string, spec: PipelineSpec, open: boolean): Row {
  const count = `  (${spec.steps.length} step${spec.steps.length === 1 ? "" : "s"})`
  return {
    meta: { t: "pipeline", name },
    chunks: (selected, width) => [
      selected ? fg(theme.accent)("▸ ") : raw("  "),
      fg(theme.dim)(open ? "▾ " : "▸ "),
      selected ? bold(fg(theme.text)(truncateChunkSafe(name, Math.max(8, width - count.length - 6)))) : fg(theme.text)(truncateChunkSafe(name, Math.max(8, width - count.length - 6))),
      fg(theme.faint)(count),
    ],
  }
}

function stepRow(pipeline: string, index: number, spec: Exclude<StepSpec, ParallelStepSpec>): Row {
  const human = isHumanStep(spec)
  const agent = isHumanStepSpec(spec) ? (spec.name ?? humanStepType) : agentOf(spec)
  return {
    meta: { t: "step", pipeline, index },
    chunks: (selected, width) => {
      const chunks: TextChunk[] = [
        selected ? fg(theme.accent)("    ▸ ") : raw("      "),
        fg(theme.faint)(`${index + 1}. `),
        selected ? bold(fg(theme.text)(truncateChunkSafe(agent, 24))) : fg(human ? theme.magenta : theme.text)(truncateChunkSafe(agent, 24)),
      ]
      if (!human) chunks.push(fg(theme.dim)(`   ${truncateChunkSafe(stepValueSummary(spec as string | AgentStepSpec), Math.max(8, width - 40))}`))
      return chunks
    },
  }
}

function parallelHeaderRow(pipeline: string, index: number, spec: ParallelStepSpec): Row {
  const label = `parallel (${spec.parallel.length} member${spec.parallel.length === 1 ? "" : "s"} · read-only)`
  return {
    meta: { t: "step", pipeline, index },
    chunks: (selected, width) => [
      selected ? fg(theme.accent)("    ▸ ") : raw("      "),
      fg(theme.faint)(`${index + 1}. `),
      selected ? bold(fg(theme.text)(truncateChunkSafe(label, Math.max(8, width - 12)))) : fg(theme.text)(truncateChunkSafe(label, Math.max(8, width - 12))),
    ],
  }
}

function memberRow(pipeline: string, index: number, member: number, spec: string | AgentStepSpec): Row {
  const agent = agentOf(spec)
  return {
    meta: { t: "step", pipeline, index, member },
    chunks: (selected, width) => [
      selected ? fg(theme.accent)("      ▸ ") : raw("        "),
      fg(theme.faint)(`${index + 1}.${member + 1} `),
      selected ? bold(fg(theme.text)(truncateChunkSafe(agent, 22))) : fg(theme.text)(truncateChunkSafe(agent, 22)),
      fg(theme.dim)(`   ${truncateChunkSafe(stepValueSummary(spec), Math.max(8, width - 44))}`),
    ],
  }
}

// ---- pure helpers ----------------------------------------------------------

function setDefault(defaults: ConvoyDefaults, key: keyof ConvoyDefaults, value: string | number | undefined) {
  const record = defaults as Record<string, unknown>
  if (value === undefined) delete record[key]
  else record[key] = value
}

export function isHumanStep(spec: StepSpec): spec is HumanStepSpec | typeof humanReviewStep | (AgentStepSpec & { agent: typeof humanReviewStep }) {
  return !isParallelSpec(spec) && (isHumanStepSpec(spec) || agentOf(spec) === humanReviewStep)
}

/** Only meaningful for non-parallel steps; callers must guard with isParallelSpec first. */
function agentOf(spec: Exclude<StepSpec, ParallelStepSpec | HumanStepSpec>): string {
  return typeof spec === "string" ? spec : spec.agent
}

export function asStepObject(spec: Exclude<StepSpec, ParallelStepSpec | HumanStepSpec>): AgentStepSpec {
  return typeof spec === "string" ? { agent: spec } : { ...spec }
}

export function collapseStep(spec: AgentStepSpec): StepSpec {
  return Object.keys(spec).length === 1 ? spec.agent : spec
}

/** "pipeline[3]" / "pipeline[3.2]" — 1-based, dotted for parallel members, matching resolve error positions. */
function stepLabel(pipeline: string, index: number, member?: number): string {
  return member === undefined ? `${pipeline}[${index + 1}]` : `${pipeline}[${index + 1}.${member + 1}]`
}

/** Reads `steps[index]` or, when member is set, `steps[index].parallel[member]`. */
export function specAt(steps: StepSpec[], index: number, member?: number): StepSpec | undefined {
  const top = steps[index]
  if (top === undefined || member === undefined) return top
  return isParallelSpec(top) ? top.parallel[member] : undefined
}

/** Writes a spec back at the address specAt reads from. */
export function setSpecAt(steps: StepSpec[], index: number, member: number | undefined, spec: StepSpec) {
  if (member === undefined) {
    steps[index] = spec
    return
  }
  const top = steps[index]
  if (top !== undefined && isParallelSpec(top)) top.parallel[member] = spec as string | AgentStepSpec
}

/**
 * Wraps the sequential agent step at index into a parallel group, joining the
 * group directly above/below instead when one exists. Returns the step's new
 * address, or undefined for human steps and group headers.
 */
export function wrapInParallel(steps: StepSpec[], index: number): { index: number; member: number } | undefined {
  const spec = steps[index]
  if (spec === undefined || isParallelSpec(spec) || isHumanStep(spec)) return undefined
  const step = spec as string | AgentStepSpec
  const prev = steps[index - 1]
  if (prev !== undefined && isParallelSpec(prev)) {
    prev.parallel.push(step)
    steps.splice(index, 1)
    return { index: index - 1, member: prev.parallel.length - 1 }
  }
  const next = steps[index + 1]
  if (next !== undefined && isParallelSpec(next)) {
    next.parallel.unshift(step)
    steps.splice(index, 1)
    return { index, member: 0 }
  }
  steps[index] = { parallel: [step] }
  return { index, member: 0 }
}

/** Moves a member out of its group, re-inserting it right after the group (in place when the group empties). Returns its new top-level index. */
export function ejectMember(steps: StepSpec[], index: number, member: number): number | undefined {
  const top = steps[index]
  if (top === undefined || !isParallelSpec(top)) return undefined
  const [spec] = top.parallel.splice(member, 1)
  if (spec === undefined) return undefined
  if (top.parallel.length === 0) {
    steps.splice(index, 1, spec)
    return index
  }
  steps.splice(index + 1, 0, spec)
  return index + 1
}

/** Splices a group's members back inline as sequential steps. Returns the first member's index. */
export function dissolveParallel(steps: StepSpec[], index: number): number | undefined {
  const top = steps[index]
  if (top === undefined || !isParallelSpec(top)) return undefined
  steps.splice(index, 1, ...top.parallel)
  return index
}

/** Appends an agent to the group at index. Returns the new member's index. */
export function addParallelMember(steps: StepSpec[], index: number, agent: string): number | undefined {
  const top = steps[index]
  if (top === undefined || !isParallelSpec(top)) return undefined
  top.parallel.push(agent)
  return top.parallel.length - 1
}

/** Deletes a step or member; a group that empties is removed with it. */
export function deleteAt(steps: StepSpec[], index: number, member?: number) {
  if (member === undefined) {
    steps.splice(index, 1)
    return
  }
  const top = steps[index]
  if (top === undefined || !isParallelSpec(top)) return
  top.parallel.splice(member, 1)
  if (top.parallel.length === 0) steps.splice(index, 1)
}

/** Reorders a member within its group. Returns its new member index, or undefined at the group's edge. */
export function moveMember(steps: StepSpec[], index: number, member: number, direction: -1 | 1): number | undefined {
  const top = steps[index]
  if (top === undefined || !isParallelSpec(top)) return undefined
  const target = member + direction
  if (target < 0 || target >= top.parallel.length) return undefined
  ;[top.parallel[member], top.parallel[target]] = [top.parallel[target]!, top.parallel[member]!]
  return target
}

/** Agent steps in the pipeline, counting parallel members individually. */
export function agentStepCount(steps: StepSpec[]): number {
  let count = 0
  for (const spec of steps) {
    if (isParallelSpec(spec)) count += spec.parallel.filter((member) => !isHumanStep(member)).length
    else if (!isHumanStep(spec)) count++
  }
  return count
}

/**
 * Applies a multi-model selection to a step: none clears both keys (inherit),
 * one sets `model`, several set `models` (fan-out). model/models exclusivity
 * and the min-2 fan-out rule hold by construction.
 */
export function applyModelsSelection(spec: AgentStepSpec, values: string[]): AgentStepSpec {
  const next = { ...spec }
  delete next.model
  delete next.models
  if (values.length === 1) next.model = values[0]!
  else if (values.length >= 2) next.models = [...values]
  return next
}

export type ToggleStepRunnerResult =
  | { ok: true; spec: AgentStepSpec; clearedModel: boolean }
  | { ok: false; reason: "model-fanout" | "writable-agent" }

export function toggleStepRunnerSpec(spec: AgentStepSpec, supportsReadOnlyRunner: boolean): ToggleStepRunnerResult {
  const current = stepRunnerFor(spec.runner)
  if (current.id === "opencode" && spec.models !== undefined) return { ok: false, reason: "model-fanout" }
  if (current.id === "opencode" && !supportsReadOnlyRunner) return { ok: false, reason: "writable-agent" }

  const next = { ...spec }
  const clearedModel = next.model !== undefined
  delete next.model
  if (current.id === "claude-code") delete next.runner
  else next.runner = "claude-code"
  return { ok: true, spec: next, clearedModel }
}

/**
 * Base step names (`name` ?? agent as written) of agent steps strictly before
 * `steps[index]` — the names `reports:` lists may reference. Groupmates are
 * excluded: reports resolve against steps that finished before the group started.
 */
export function priorStepNames(steps: StepSpec[], index: number): string[] {
  const names: string[] = []
  for (const spec of steps.slice(0, index)) {
    if (isParallelSpec(spec)) {
      for (const inner of spec.parallel) if (!isHumanStep(inner)) names.push(baseStepName(inner))
    } else if (!isHumanStep(spec)) {
      names.push(baseStepName(spec as string | AgentStepSpec))
    }
  }
  return names
}

function baseStepName(spec: string | AgentStepSpec): string {
  return typeof spec === "string" ? spec : (spec.name ?? spec.agent)
}

/** One-line value summary for an agent step row: model or fan-out plus any explicitly set fields. */
export function stepValueSummary(spec: string | AgentStepSpec): string {
  if (typeof spec === "string") return "(inherits)"
  const runner = stepRunnerFor(spec.runner)
  const model = runner.id === "claude-code" ? runner.modelLabel(spec.model ?? "") : (spec.model ?? "(inherits)")
  const parts = [spec.models ? `${spec.models.length} models` : model]
  if (!runner.capabilities.writeSteps) parts.push("read-only")
  if (spec.name !== undefined) parts.push(`name ${spec.name}`)
  if (spec.reports !== undefined) parts.push(`reports ${Array.isArray(spec.reports) ? spec.reports.join(",") : spec.reports}`)
  if (spec.diff !== undefined) parts.push(`diff ${spec.diff ? "on" : "off"}`)
  if (spec.maxAttempts !== undefined) parts.push(`attempts ${spec.maxAttempts}`)
  return parts.join(" · ")
}

function splitNameList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** Greedy word-wrap for the detail panel. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line.length === 0) line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

/** Drops empty agent override entries so they don't serialize as `name: {}`. */
function pruneConfig(config: ConvoyConfig): ConvoyConfig {
  const agents: Record<string, ConfigAgent> = {}
  for (const [name, agent] of Object.entries(config.agents)) {
    if (Object.keys(agent).length > 0) agents[name] = agent
  }
  return { ...config, agents }
}

function isPositiveInt(value: string) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1
}

function isTemperature(value: string) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= 2
}

function matches(filter: string, ...fields: string[]) {
  const needle = filter.trim().toLowerCase()
  if (!needle) return true
  const hay = fields.join(" ").toLowerCase()
  return needle.split(/\s+/).every((part) => hay.includes(part))
}

function optionHint(option: ModelChoice | ChooseItem): string {
  if ("providerID" in option) {
    const parts = [option.label]
    if (option.contextK) parts.push(`${option.contextK}k`)
    if (option.status) parts.push(option.status)
    return parts.join(" · ")
  }
  return option.hint ?? ""
}

function describeDefault(key: keyof ConvoyDefaults): string {
  switch (key) {
    case "model":
      return "Default model for steps with no model of their own."
    case "autoAcceptJudgeModel":
      return "Model the smart auto-accept judge uses (falls back to the run's model)."
    case "branchNameModel":
      return "Model that names worktree branches (default: anthropic/claude-haiku-4-5)."
    case "maxAttempts":
      return "Attempts per step before failing."
    case "baseRef":
      return "Branch/base used to diff between steps (auto-detected when unset)."
    case "pipeline":
      return "Pipeline used when -p/--pipeline is not given."
    default:
      return ""
  }
}

function readonlyList(label: string, values: string[]): string {
  return `${label}: ${values.length === 0 ? "—" : values.join(", ")}`
}

function describeHook(hook: HookSpec): string {
  const name = hook.name ? `${hook.name}=` : ""
  const suffix = hook.when ? ` (${hook.when})` : ""
  return `${name}${hook.command}${suffix}`
}

function shortenPath(path: string): string {
  const home = process.env.HOME
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function truncateChunkSafe(text: string, width: number): string {
  if (text.length <= width) return text
  return `${text.slice(0, Math.max(0, width - 1))}…`
}

function typedChar(key: KeyEvent): string | undefined {
  if (key.ctrl) return undefined
  const raw = key.raw
  if (typeof raw === "string" && raw.length === 1) {
    const code = raw.codePointAt(0)!
    if (code >= 0x20 && code !== 0x7f) return raw
  }
  return undefined
}
