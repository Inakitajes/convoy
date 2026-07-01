import { join } from "node:path"

import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg } from "@opentui/core"

import {
  buildAgentRegistry,
  defaultConfigTemplate,
  isValidModelString,
  loadArcherConfig,
  loadGlobalArcherConfig,
  writeArcherConfig,
  type ArcherConfig,
  type ArcherDefaults,
  type ConfigAgent,
} from "./config"
import { listModels, type ModelChoice } from "./model-catalog"
import { humanReviewStep, isParallelSpec, type AgentStepSpec, type ParallelStepSpec, type PipelineSpec, type StepSpec } from "./pipeline"
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
import { archerRoot, globalConfigPath } from "./workspace"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { PaletteColor } from "./tui-theme"

export async function editConfigTui(options: { targetDir: string }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("archer config needs an interactive terminal")
  }
  const [globalConfig, projectConfig] = await Promise.all([loadGlobalArcherConfig(), loadArcherConfig(options.targetDir)])

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
  /** Where agent-prompt validation resolves on save: archerHome() for global, the repo for project. */
  readonly validateDir: string
  config?: ArcherConfig
  dirty: boolean
}

type ChooseItem = { value: string; label: string; hint?: string }

type Modal =
  | { kind: "input"; title: string; help: string; value: string; error?: string; validate?: (value: string) => string | undefined; commit: (value: string) => void }
  | { kind: "model"; title: string; filter: string; loading: boolean; options: ModelChoice[]; index: number; commit: (value: string | undefined) => void }
  | { kind: "choose"; title: string; filter: string; options: ChooseItem[]; index: number; commit: (value: string) => void }
  | { kind: "confirm"; title: string; message: string; onYes: () => void }
  | { kind: "message"; title: string; message: string }

/** What the focused row represents; drives `enter` and the secondary keys. */
type RowMeta =
  | { t: "initialize" }
  | { t: "default"; field: DefaultField }
  | { t: "agent"; name: string }
  | { t: "pipeline"; name: string }
  | { t: "step"; pipeline: string; index: number }
  | { t: "add-step"; pipeline: string }
  | { t: "add-pipeline" }

type DefaultField = { key: keyof ArcherDefaults; type: "model" | "number" | "string" }

type Row = {
  chunks: (selected: boolean, width: number) => TextChunk[]
  meta?: RowMeta
}

const defaultFields: DefaultField[] = [
  { key: "model", type: "model" },
  { key: "interactiveModel", type: "model" },
  { key: "autoAcceptJudgeModel", type: "model" },
  { key: "maxAttempts", type: "number" },
  { key: "baseRef", type: "string" },
  { key: "pipeline", type: "string" },
  { key: "appRunCommand", type: "string" },
  { key: "emulator", type: "string" },
]

const modalListHeight = 12

/** Synthetic top entry in the model picker; its empty value means "inherit / clear the override". */
const clearOption: ModelChoice = { value: "", label: "inherit — clear override", providerID: "" }

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
    globalConfig: ArcherConfig | undefined,
    projectConfig: ArcherConfig | undefined,
  ) {
    this.tabs = [
      { title: "Global", path: globalConfigPath(), validateDir: archerRoot(), config: globalConfig, dirty: false },
      { title: "Project", path: join(targetDir, ".archer", "config.yaml"), validateDir: targetDir, config: projectConfig, dirty: false },
    ]
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })

    const shell = new BoxRenderable(renderer, {
      id: "archer-config-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
    })

    const header = this.panel({ id: "archer-config-header", height: 4, borderColor: theme.border, backgroundColor: theme.bg })
    const body = new BoxRenderable(renderer, { id: "archer-config-body", width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 })
    const list = this.panel({
      id: "archer-config-list",
      height: "100%",
      flexGrow: 1,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " configuration ",
      titleAlignment: "left",
    })
    const detail = this.panel({
      id: "archer-config-detail",
      width: this.detailWidth(),
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " field ",
      titleAlignment: "left",
    })
    const footer = this.panel({ id: "archer-config-footer", height: 3, borderColor: theme.borderDim, backgroundColor: theme.bg })

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
      id: "archer-config-overlay",
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
      id: "archer-config-modal",
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
        this.editStepMaxAttempts()
        return
      case "d":
        this.deleteStep()
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

    // model + choose share filter/navigation behavior
    const filtered = this.filteredOptions(modal)
    if (key.name === "up") {
      modal.index = Math.max(0, modal.index - 1)
    } else if (key.name === "down") {
      modal.index = Math.min(Math.max(0, filtered.length - 1), modal.index + 1)
    } else if (key.name === "backspace") {
      modal.filter = modal.filter.slice(0, -1)
      modal.index = 0
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

  private commitOption(modal: Modal & { kind: "model" | "choose" }, filtered: Array<ModelChoice | ChooseItem>) {
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
      if (!isValidModelString(text)) {
        this.render()
        return
      }
      this.modal = undefined
      modal.commit(text)
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
      case "step":
        this.editStepModel(meta.pipeline, meta.index)
        return
      case "add-step":
        this.addStep(meta.pipeline)
        return
      case "add-pipeline":
        this.addPipeline()
        return
    }
  }

  private addUnderCursor() {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t === "pipeline") this.addStep(meta.name)
    else if (meta?.t === "step") this.addStep(meta.pipeline)
    else if (meta?.t === "add-pipeline") this.addPipeline()
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

  private editStepModel(pipelineName: string, index: number) {
    const steps = this.tab().config?.pipelines[pipelineName]?.steps
    const spec = steps?.[index]
    if (!steps || spec === undefined || isParallelSpec(spec) || agentOf(spec) === humanReviewStep) return
    const obj = asStepObject(spec)
    this.openModelPicker(`${pipelineName}[${index + 1}].model`, obj.model, (value) => {
      const next = { ...obj }
      if (value === undefined) delete next.model
      else next.model = value
      steps[index] = collapseStep(next)
      this.markDirty()
    })
  }

  private editStepMaxAttempts() {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t !== "step") return
    const steps = this.tab().config?.pipelines[meta.pipeline]?.steps
    const spec = steps?.[meta.index]
    if (!steps || spec === undefined || isParallelSpec(spec) || agentOf(spec) === humanReviewStep) return
    const obj = asStepObject(spec)
    this.openInput(`${meta.pipeline}[${meta.index + 1}].maxAttempts`, obj.maxAttempts === undefined ? "" : String(obj.maxAttempts), "positive integer, empty to clear", {
      validate: (value) => (value.trim() === "" || isPositiveInt(value) ? undefined : "must be a positive integer"),
      commit: (value) => {
        const next = { ...obj }
        if (value.trim() === "") delete next.maxAttempts
        else next.maxAttempts = Number(value)
        steps[meta.index] = collapseStep(next)
        this.markDirty()
      },
    })
  }

  private addStep(pipelineName: string) {
    const config = this.tab().config
    const pipeline = config?.pipelines[pipelineName]
    if (!config || !pipeline) return
    const options: ChooseItem[] = [
      { value: humanReviewStep, label: humanReviewStep, hint: "manual review gate" },
      ...buildAgentRegistry(config).map((agent) => ({ value: agent.name, label: agent.name, hint: agent.description })),
    ]
    this.modal = {
      kind: "choose",
      title: `add step to "${pipelineName}"`,
      filter: "",
      index: 0,
      options,
      commit: (value) => {
        pipeline.steps.push(value)
        this.expanded.add(this.expandKey(pipelineName))
        this.markDirty()
      },
    }
    this.render()
  }

  private deleteStep() {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t !== "step") return
    const steps = this.tab().config?.pipelines[meta.pipeline]?.steps
    if (!steps) return
    const agentSteps = steps.filter((step) => !isHumanReviewStep(step)).length
    if (agentSteps <= 1 && !isHumanReviewStep(steps[meta.index]!)) {
      this.message("Can't delete", "A pipeline needs at least one agent step.")
      return
    }
    steps.splice(meta.index, 1)
    this.markDirty()
  }

  private moveStep(direction: -1 | 1) {
    const meta = this.rows[this.selected]?.meta
    if (meta?.t !== "step") return
    const steps = this.tab().config?.pipelines[meta.pipeline]?.steps
    if (!steps) return
    const target = meta.index + direction
    if (target < 0 || target >= steps.length) return
    ;[steps[meta.index], steps[target]] = [steps[target]!, steps[meta.index]!]
    this.markDirty()
    this.moveSelection(direction)
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
    try {
      await writeArcherConfig(tab.path, config, tab.validateDir)
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
    const dir = this.tab().validateDir === archerRoot() ? process.cwd() : this.tab().validateDir
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
      const value = (model ?? "(inherits)") + (temp !== undefined ? `  ·  temp ${temp}` : "") + (readOnly ? "  ·  read-only" : "")
      rows.push(fieldRow(agent.name, value, { t: "agent", name: agent.name }))
    }

    rows.push(blankRow(), sectionRow("Pipelines"))
    const pipelineNames = Object.keys(config.pipelines)
    if (pipelineNames.length === 0) {
      rows.push(infoRow("none defined here — built-in 'default' is used"))
    }
    for (const name of pipelineNames) {
      const open = this.expanded.has(this.expandKey(name))
      rows.push(pipelineRow(name, config.pipelines[name]!, open))
      if (open) {
        const steps = config.pipelines[name]!.steps
        steps.forEach((spec, index) => rows.push(stepRow(name, index, spec)))
        rows.push(actionRow("  ⊕ add step", { t: "add-step", pipeline: name }))
      }
    }
    rows.push(actionRow("⊕ add pipeline", { t: "add-pipeline" }))

    rows.push(blankRow(), sectionRow("Permissions  (read-only — edit in .archer/config.yaml)"))
    rows.push(infoRow(readonlyList("allow", config.permissions.allow)))
    rows.push(infoRow(readonlyList("deny", config.permissions.deny)))
    rows.push(blankRow(), sectionRow("Attachments  (read-only — edit in .archer/config.yaml)"))
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
    const title: TextChunk[] = [bold(fg(theme.accent)("◆ archer")), fg(theme.faint)("  ·  "), fg(theme.text)("config")]
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
        push([fg(theme.faint)("Toggle readOnly by editing YAML directly.")])
        lines.push(plain(""))
        push([fg(theme.accent)("enter"), fg(theme.dim)(" pick model   "), fg(theme.accent)("t"), fg(theme.dim)(" temperature")])
        break
      case "pipeline":
        push([fg(theme.text)(`pipeline: ${meta.name}`)])
        lines.push(plain(""))
        push([fg(theme.accent)("enter"), fg(theme.dim)(" expand/collapse   "), fg(theme.accent)("a"), fg(theme.dim)(" add step")])
        break
      case "step":
        push([fg(theme.text)(`step ${meta.index + 1} of ${meta.pipeline}`)])
        lines.push(plain(""))
        push([fg(theme.accent)("enter"), fg(theme.dim)(" pick model")])
        push([fg(theme.accent)("m"), fg(theme.dim)(" max-attempts   "), fg(theme.accent)("d"), fg(theme.dim)(" delete")])
        push([fg(theme.accent)("shift+↑/↓"), fg(theme.dim)(" reorder")])
        break
      case "add-step":
        push([fg(theme.text)("Add a step")])
        push([fg(theme.accent)("enter"), fg(theme.dim)(" choose an agent or gate")])
        break
      case "add-pipeline":
        push([fg(theme.text)("Add a pipeline")])
        push([fg(theme.accent)("enter"), fg(theme.dim)(" name a new pipeline")])
        break
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
      // model / choose
      push([fg(theme.accent)("filter: "), fg(theme.text)(modal.filter), fg(theme.dim)("▏")])
      lines.push(plain(""))
      const filtered = this.filteredOptions(modal)
      if (modal.kind === "model" && modal.loading) {
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
          const chunks: TextChunk[] = [marker, value]
          if (hint) chunks.push(fg(theme.faint)(`   ${truncateChunkSafe(hint, Math.max(8, width - valueText.length - 6))}`))
          push(chunks)
        })
      }
      lines.push(plain(""))
      const help = modal.kind === "model" ? "↑/↓ select · type to filter · enter set · esc cancel" : "↑/↓ select · type to filter · enter add · esc cancel"
      push([fg(theme.dim)(help)])
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

// Parallel blocks aren't authorable here yet (no visual editor for `parallel:`
// steps) - render a non-editable summary row instead of crashing on them.
function stepRow(pipeline: string, index: number, spec: StepSpec): Row {
  if (isParallelSpec(spec)) {
    const label = `parallel (${spec.parallel.length} step${spec.parallel.length === 1 ? "" : "s"})`
    return {
      meta: { t: "step", pipeline, index },
      chunks: (selected) => [
        selected ? fg(theme.accent)("    ▸ ") : raw("      "),
        fg(theme.faint)(`${index + 1}. `),
        selected ? bold(fg(theme.text)(label)) : fg(theme.dim)(label),
      ],
    }
  }

  const agent = agentOf(spec)
  const model = typeof spec === "string" ? undefined : spec.model
  const human = agent === humanReviewStep
  return {
    meta: { t: "step", pipeline, index },
    chunks: (selected, width) => {
      const chunks: TextChunk[] = [
        selected ? fg(theme.accent)("    ▸ ") : raw("      "),
        fg(theme.faint)(`${index + 1}. `),
        selected ? bold(fg(theme.text)(truncateChunkSafe(agent, 24))) : fg(human ? theme.magenta : theme.text)(truncateChunkSafe(agent, 24)),
      ]
      if (!human) chunks.push(fg(theme.dim)(`   ${truncateChunkSafe(model ?? "(inherits)", Math.max(8, width - 40))}`))
      return chunks
    },
  }
}

// ---- pure helpers ----------------------------------------------------------

function setDefault(defaults: ArcherDefaults, key: keyof ArcherDefaults, value: string | number | undefined) {
  const record = defaults as Record<string, unknown>
  if (value === undefined) delete record[key]
  else record[key] = value
}

function isHumanReviewStep(spec: StepSpec): boolean {
  return !isParallelSpec(spec) && agentOf(spec) === humanReviewStep
}

/** Only meaningful for non-parallel steps; callers must guard with isParallelSpec first. */
function agentOf(spec: Exclude<StepSpec, ParallelStepSpec>): string {
  return typeof spec === "string" ? spec : spec.agent
}

function asStepObject(spec: Exclude<StepSpec, ParallelStepSpec>): AgentStepSpec {
  return typeof spec === "string" ? { agent: spec } : { ...spec }
}

function collapseStep(spec: AgentStepSpec): StepSpec {
  return Object.keys(spec).length === 1 ? spec.agent : spec
}

/** Drops empty agent override entries so they don't serialize as `name: {}`. */
function pruneConfig(config: ArcherConfig): ArcherConfig {
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

function describeDefault(key: keyof ArcherDefaults): string {
  switch (key) {
    case "model":
      return "Default model for steps with no model of their own."
    case "interactiveModel":
      return "Model used by manual OpenCode iterations in human-review."
    case "autoAcceptJudgeModel":
      return "Model the smart auto-accept judge uses (falls back to the run's model)."
    case "maxAttempts":
      return "Attempts per step before failing."
    case "baseRef":
      return "Branch/base used to diff between steps."
    case "pipeline":
      return "Pipeline used when -p/--pipeline is not given."
    case "appRunCommand":
      return "App command run during human-review gates."
    case "emulator":
      return "Flutter emulator launched during human-review."
    default:
      return ""
  }
}

function readonlyList(label: string, values: string[]): string {
  return `${label}: ${values.length === 0 ? "—" : values.join(", ")}`
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
