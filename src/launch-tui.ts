import { basename } from "node:path"

import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg, t } from "@opentui/core"

import { buildAgentRegistry, loadMergedArcherConfig } from "./config"
import { builtInPipelines, defaultPipelineName, resolvePipeline } from "./pipeline"
import { joinLines, padBetween, paletteForTerminal, plain, raw, setTheme, terminalBackgroundHex, theme, truncate } from "./tui-theme"

import type { ArcherConfig } from "./config"
import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { AgentSpec } from "./types"
import type { PaletteColor } from "./tui-theme"

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
}

type PipelineChoice = {
  name: string
  description: string
  source: "built-in" | "configured"
  isDefault: boolean
  steps: string[]
  valid: boolean
  error?: string
}

type ToggleKey = "smart" | "yolo" | "humanReview" | "includeDirty" | "keepRunDir" | "tui"

type ToggleSpec = {
  key: ToggleKey
  label: string
  flag: string
  description: string
}

type Mode = "pipelines" | "prompt" | "options"

const toggles: readonly ToggleSpec[] = [
  {
    key: "smart",
    label: "Smart auto-accept",
    flag: "--smart",
    description: "An AI judge auto-allows safe ask-level permission requests and escalates risky ones.",
  },
  {
    key: "yolo",
    label: "Auto-accept permissions",
    flag: "--yolo",
    description: "Allow every ask-level permission request automatically. The hard denylist still applies.",
  },
  {
    key: "humanReview",
    label: "Human-review gates",
    flag: "--human-review / --no-human-review",
    description: "Keep manual checkpoints in pipelines that define them.",
  },
  {
    key: "includeDirty",
    label: "Include dirty tree",
    flag: "--include-dirty --max-attempts 1",
    description: "Include existing local changes in the first phase commit. Forces max attempts to 1.",
  },
  {
    key: "keepRunDir",
    label: "Keep run directory",
    flag: "--keep-run-dir",
    description: "Preserve the run workspace under ~/.archer/runs after the run finishes.",
  },
  {
    key: "tui",
    label: "Progress dashboard",
    flag: "--tui / --no-tui",
    description: "Show the full-screen dashboard while the pipeline is running.",
  },
]

export async function launchRunTui(options: { targetDir: string }): Promise<LaunchRunSelection | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("archer needs an interactive terminal to open the launcher")
  }

  const config = await loadMergedArcherConfig(options.targetDir)
  const choices = pipelineChoices(config, buildAgentRegistry(config))

  // No backgroundColor yet: the palette is only chosen after the terminal
  // answers the background query, so a light terminal never flashes dark.
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
    targetFps: 12,
  })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new LaunchPicker(renderer, options.targetDir, choices).result
}

function pipelineChoices(config: ArcherConfig | undefined, agents: readonly AgentSpec[]): PipelineChoice[] {
  const configured = config?.pipelines ?? {}
  const defaultName = config?.defaults.pipeline ?? defaultPipelineName
  const names = [...new Set([...Object.keys(builtInPipelines), ...Object.keys(configured)])].sort((a, b) => a.localeCompare(b))
  names.sort((a, b) => (a === defaultName ? -1 : b === defaultName ? 1 : 0))

  return names.map((name) => {
    const spec = configured[name] ?? builtInPipelines[name]!
    const source: PipelineChoice["source"] = configured[name] ? "configured" : "built-in"
    try {
      const pipeline = resolvePipeline({ name, spec, agents, defaultModel: config?.defaults.model })
      return {
        name,
        description: spec.description ?? "No description",
        source,
        isDefault: name === defaultName,
        steps: pipeline.steps.map((step) => step.name),
        valid: true,
      }
    } catch (error) {
      return {
        name,
        description: spec.description ?? "No description",
        source,
        isDefault: name === defaultName,
        steps: [],
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

class LaunchPicker {
  readonly result: Promise<LaunchRunSelection | undefined>

  private resolveResult!: (selection: LaunchRunSelection | undefined) => void
  private mode: Mode = "pipelines"
  private selected = 0
  private scroll = 0
  private prompt = ""
  private promptError = ""
  private optionIndex = 0
  private message = ""

  private readonly toggleState: Record<ToggleKey, boolean> = {
    smart: false,
    yolo: false,
    humanReview: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    includeDirty: false,
    keepRunDir: false,
    tui: Boolean(process.stdout.isTTY && process.stderr.isTTY),
  }

  private readonly ticker: ReturnType<typeof setInterval>
  private readonly headerText: TextRenderable
  private readonly pipelineText: TextRenderable
  private readonly detailText: TextRenderable
  private readonly detailBox: BoxRenderable
  private readonly footerText: TextRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []
  private pipelineRows: (number | undefined)[] = []
  private optionRows: (number | undefined)[] = []

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.render()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.raw === "\u0003") {
      key.preventDefault()
      key.stopPropagation()
      this.finish(undefined)
      return
    }

    key.preventDefault()
    key.stopPropagation()
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
    }
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly targetDir: string,
    private readonly choices: PipelineChoice[],
  ) {
    const defaultIndex = choices.findIndex((choice) => choice.isDefault)
    this.selected = defaultIndex >= 0 ? defaultIndex : 0
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })

    const shell = new BoxRenderable(renderer, {
      id: "archer-launch-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
    })

    const header = this.panel({ id: "archer-launch-header", height: 4, borderColor: theme.border, backgroundColor: theme.bg })
    const body = new BoxRenderable(renderer, { id: "archer-launch-body", width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 })

    const selectFromList = (event: { y: number; preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      const row = event.y - this.pipelineText.y
      const index = this.pipelineRows[row]
      if (index === undefined) return
      this.selected = index
      this.mode = "pipelines"
      this.promptError = ""
      this.message = ""
      this.render()
    }

    const pipeline = this.panel({
      id: "archer-launch-pipelines",
      height: "100%",
      flexGrow: 1,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " pipelines ",
      titleAlignment: "left",
      onMouseDown: selectFromList,
    })
    pipeline.text.onMouseDown = selectFromList

    const selectOption = (event: { y: number; preventDefault(): void; stopPropagation(): void }) => {
      if (this.mode !== "options") return
      event.preventDefault()
      event.stopPropagation()
      const row = event.y - this.detailText.y
      const index = this.optionRows[row]
      if (index === undefined) return
      this.optionIndex = index
      this.toggleOption()
    }

    const detail = this.panel({
      id: "archer-launch-detail",
      width: this.detailWidth(),
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " run setup ",
      titleAlignment: "left",
      onMouseDown: selectOption,
    })
    detail.text.onMouseDown = selectOption
    const footer = this.panel({ id: "archer-launch-footer", height: 3, borderColor: theme.borderDim, backgroundColor: theme.bg })

    this.headerText = header.text
    this.pipelineText = pipeline.text
    this.detailText = detail.text
    this.detailBox = detail.box
    this.footerText = footer.text

    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: header.box, background: "bg", border: "border" },
      { box: pipeline.box, background: "bg", border: "borderDim" },
      { box: detail.box, background: "bg", border: "borderDim" },
      { box: footer.box, background: "bg", border: "borderDim" },
    )

    body.add(pipeline.box)
    body.add(detail.box)
    shell.add(header.box)
    shell.add(body)
    shell.add(footer.box)
    renderer.root.add(shell)

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)

    this.ticker = setInterval(() => this.render(), 250)
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
        this.moveSelection(-this.listHeight())
        return
      case "pagedown":
        this.moveSelection(this.listHeight())
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
      case "q":
      case "escape":
        this.finish(undefined)
        return
    }
  }

  private handlePromptKey(key: KeyEvent) {
    if (key.name === "escape") {
      this.mode = "pipelines"
      this.promptError = ""
      this.render()
      return
    }
    if (key.name === "return" || key.name === "linefeed") {
      if (!this.prompt.trim()) {
        this.promptError = "Write a prompt before continuing."
      } else {
        this.prompt = this.prompt.trim()
        this.promptError = ""
        this.mode = "options"
        this.optionIndex = 0
      }
      this.render()
      return
    }
    if (key.name === "backspace") {
      this.prompt = this.prompt.slice(0, -1)
      this.promptError = ""
      this.render()
      return
    }
    if (key.ctrl && key.name === "u") {
      this.prompt = ""
      this.promptError = ""
      this.render()
      return
    }

    const char = typedChar(key)
    if (char !== undefined) {
      this.prompt += char
      this.promptError = ""
      this.render()
    }
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
      case "return":
      case "linefeed":
      case "s":
        this.startRun()
        return
      case "p":
      case "escape":
        this.mode = "prompt"
        this.render()
        return
      case "q":
        this.finish(undefined)
        return
    }
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
    this.render()
  }

  private startRun() {
    const choice = this.currentChoice()
    this.finish({
      targetDir: this.targetDir,
      prompt: this.prompt,
      pipeline: choice.name,
      humanReview: this.toggleState.humanReview,
      tui: this.toggleState.tui,
      includeDirty: this.toggleState.includeDirty,
      keepRunDir: this.toggleState.keepRunDir,
      yolo: this.toggleState.yolo,
      smart: this.toggleState.smart,
    })
  }

  private toggleOption() {
    const key = toggles[this.optionIndex]?.key
    if (!key) return
    const next = !this.toggleState[key]
    this.toggleState[key] = next
    if (key === "smart" && next) this.toggleState.yolo = false
    if (key === "yolo" && next) this.toggleState.smart = false
    this.render()
  }

  private moveSelection(delta: number) {
    this.selected = clamp(this.selected + delta, 0, this.choices.length - 1)
    this.message = ""
    this.render()
  }

  private moveOption(delta: number) {
    this.optionIndex = clamp(this.optionIndex + delta, 0, toggles.length - 1)
    this.render()
  }

  private currentChoice() {
    return this.choices[this.selected] ?? this.choices[0]!
  }

  private finish(selection: LaunchRunSelection | undefined) {
    clearInterval(this.ticker)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    if (!this.renderer.isDestroyed) this.renderer.destroy()
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
    if (this.renderer.isDestroyed) return
    const innerWidth = Math.max(40, this.renderer.width - 6)
    const detailWidth = this.detailWidth()
    const pipelineWidth = Math.max(36, this.renderer.width - detailWidth - 7)

    this.detailBox.width = detailWidth
    this.headerText.content = this.headerContent(innerWidth)
    this.pipelineText.content = this.pipelineContent(pipelineWidth)
    this.detailText.content = this.detailContent(detailWidth - 4)
    this.footerText.content = this.footerContent(innerWidth)
    this.renderer.requestRender()
  }

  private headerContent(width: number) {
    const title: TextChunk[] = [bold(fg(theme.accent)("◆ archer")), fg(theme.faint)("  ·  "), fg(theme.text)("new run")]
    const stage: TextChunk[] = []
    for (const [index, step] of ["pipeline", "prompt", "options"].entries()) {
      if (index > 0) stage.push(fg(theme.faint)(" → "))
      const active = (this.mode === "pipelines" && index === 0) || (this.mode === "prompt" && index === 1) || (this.mode === "options" && index === 2)
      stage.push(active ? bold(fg(theme.accent)(step)) : fg(theme.dim)(step))
    }
    const line1 = padBetween(title, stage, width)
    const project = basename(this.targetDir) || this.targetDir
    const line2 = new StyledText([fg(theme.faint)("target "), fg(theme.text)(truncate(project, Math.max(12, width - 8)))])
    return joinLines([line1, line2])
  }

  private pipelineContent(width: number) {
    const visible = this.listHeight()
    if (this.selected < this.scroll) this.scroll = this.selected
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1
    this.scroll = clamp(this.scroll, 0, Math.max(0, this.choices.length - visible))

    const rows: StyledText[] = []
    this.pipelineRows = []
    for (let index = this.scroll; index < Math.min(this.choices.length, this.scroll + visible); index++) {
      const selected = index === this.selected
      rows.push(this.pipelineRow(this.choices[index]!, selected, width))
      this.pipelineRows.push(index)
    }
    while (rows.length < visible) {
      rows.push(plain(""))
      this.pipelineRows.push(undefined)
    }
    return joinLines(rows)
  }

  private pipelineRow(choice: PipelineChoice, selected: boolean, width: number) {
    const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  ")]
    left.push(choice.valid ? fg(choice.source === "configured" ? theme.teal : theme.dim)(choice.source === "configured" ? "●" : "○") : fg(theme.red)("!"))
    left.push(raw(" "))
    left.push(selected ? bold(fg(theme.text)(choice.name)) : fg(theme.text)(choice.name))
    const right: TextChunk[] = []
    if (choice.isDefault) right.push(fg(theme.green)("default"))
    else right.push(fg(choice.source === "configured" ? theme.teal : theme.faint)(choice.source))
    return padBetween(left, right, width)
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
      lines.push(t`${fg(theme.faint)("steps")}`)
      for (const step of choice.steps) lines.push(new StyledText([fg(theme.accent)("• "), fg(theme.text)(truncate(step, Math.max(8, width - 2)))]))
    }
    if (this.message) {
      lines.push(plain(""))
      for (const line of wrapWords(this.message, width)) lines.push(t`${fg(theme.red)(line)}`)
    }
    return joinLines(lines)
  }

  private promptDetail(width: number) {
    const choice = this.currentChoice()
    const lines: StyledText[] = []
    lines.push(new StyledText([fg(theme.faint)("pipeline "), bold(fg(theme.text)(choice.name))]))
    lines.push(plain(""))
    lines.push(t`${fg(theme.dim)("Describe what Archer should do. Press Enter to continue.")}`)
    lines.push(plain(""))
    const fieldWidth = Math.max(10, width - 2)
    const placeholder = "Add onboarding, fix bug #123, review current diff…"
    const visiblePrompt = this.prompt ? tail(this.prompt, fieldWidth - 1) : truncate(placeholder, fieldWidth - 1)
    const chunks: TextChunk[] = [fg(theme.faint)("┌" + "─".repeat(fieldWidth) + "┐")]
    lines.push(new StyledText(chunks))
    lines.push(new StyledText([fg(theme.faint)("│"), this.prompt ? fg(theme.text)(visiblePrompt) : fg(theme.faint)(visiblePrompt), fg(theme.accent)("▏"), fg(theme.faint)(" ".repeat(Math.max(0, fieldWidth - visiblePrompt.length - 1)) + "│")]))
    lines.push(new StyledText([fg(theme.faint)("└" + "─".repeat(fieldWidth) + "┘")]))
    if (this.promptError) {
      lines.push(plain(""))
      lines.push(t`${fg(theme.red)(this.promptError)}`)
    }
    lines.push(plain(""))
    lines.push(t`${fg(theme.faint)("Esc returns to the pipeline list. Ctrl+U clears the field.")}`)
    return joinLines(lines)
  }

  private optionsDetail(width: number) {
    const choice = this.currentChoice()
    const lines: StyledText[] = []
    lines.push(new StyledText([fg(theme.faint)("pipeline "), bold(fg(theme.text)(choice.name))]))
    lines.push(new StyledText([fg(theme.faint)("prompt   "), fg(theme.text)(truncate(this.prompt, Math.max(10, width - 9)))]))
    lines.push(plain(""))
    lines.push(t`${fg(theme.dim)("Toggle extra run parameters, then press Enter to start.")}`)
    lines.push(plain(""))

    this.optionRows = Array(lines.length).fill(undefined)
    for (const [index, spec] of toggles.entries()) {
      const selected = index === this.optionIndex
      const enabled = this.toggleState[spec.key]
      const marker = selected ? fg(theme.accent)("▸ ") : raw("  ")
      const box = enabled ? fg(theme.green)("[on] ") : fg(theme.faint)("[off]")
      const label = selected ? bold(fg(theme.text)(spec.label)) : fg(theme.text)(spec.label)
      const flag = fg(enabled ? theme.green : theme.dim)(spec.flag)
      lines.push(padBetween([marker, box, raw(" "), label], [flag], width))
      this.optionRows.push(index)
      lines.push(new StyledText([raw("     "), fg(theme.dim)(truncate(spec.description, Math.max(8, width - 5)))]))
      this.optionRows.push(index)
    }

    const flags = this.enabledFlags()
    lines.push(plain(""))
    this.optionRows.push(undefined)
    lines.push(new StyledText([fg(theme.faint)("will run with "), fg(theme.text)(flags.length ? flags.join(" ") : "no extra flags")]))
    this.optionRows.push(undefined)
    return joinLines(lines)
  }

  private enabledFlags() {
    const flags = [`--pipeline ${this.currentChoice().name}`]
    if (this.toggleState.smart) flags.push("--smart")
    if (this.toggleState.yolo) flags.push("--yolo")
    flags.push(this.toggleState.humanReview ? "--human-review" : "--no-human-review")
    if (this.toggleState.includeDirty) flags.push("--include-dirty", "--max-attempts 1")
    if (this.toggleState.keepRunDir) flags.push("--keep-run-dir")
    flags.push(this.toggleState.tui ? "--tui" : "--no-tui")
    return flags
  }

  private footerContent(width: number) {
    const right = [fg(theme.faint)(`${this.selected + 1}/${this.choices.length}`)]
    if (this.mode === "pipelines") {
      return padBetween(
        [fg(theme.dim)("↑/↓ select · "), fg(theme.accent)("enter"), fg(theme.dim)(" prompt · "), fg(theme.accent)("q"), fg(theme.dim)(" quit")],
        right,
        width,
      )
    }
    if (this.mode === "prompt") {
      return padBetween(
        [fg(theme.dim)("type prompt · "), fg(theme.accent)("enter"), fg(theme.dim)(" options · "), fg(theme.accent)("esc"), fg(theme.dim)(" back")],
        [fg(theme.faint)(`${this.prompt.length} chars`)],
        width,
      )
    }
    return padBetween(
      [fg(theme.dim)("↑/↓ select · "), fg(theme.accent)("space"), fg(theme.dim)(" toggle · "), fg(theme.accent)("enter"), fg(theme.dim)(" start · "), fg(theme.accent)("p"), fg(theme.dim)(" prompt · "), fg(theme.accent)("q"), fg(theme.dim)(" quit")],
      [fg(theme.faint)(`${this.optionIndex + 1}/${toggles.length}`)],
      width,
    )
  }

  private detailWidth() {
    return Math.max(42, Math.min(70, this.renderer.width - 50))
  }

  private listHeight() {
    // header (4) + footer (3) + list panel borders (2).
    return Math.max(3, this.renderer.height - 9)
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
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

function tail(value: string, width: number) {
  if (value.length <= width) return value
  return `…${value.slice(-Math.max(1, width - 1))}`
}
