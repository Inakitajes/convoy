import { basename } from "node:path"

import { BoxRenderable, StyledText, TextRenderable, bg, bold, createCliRenderer, decodePasteBytes, fg, stripAnsiSequences, t } from "@opentui/core"

import { buildAgentRegistry, loadMergedArcherConfig } from "./config"
import { builtInPipelines, defaultPipelineName, resolvePipeline } from "./pipeline"
import { joinLines, padBetween, paletteForTerminal, plain, raw, setTheme, spinnerFrame, terminalBackgroundHex, theme, truncate } from "./tui-theme"

import type { ArcherConfig } from "./config"
import type { BoxOptions, CliRenderer, KeyEvent, PasteEvent, TextChunk } from "@opentui/core"
import type { AgentSpec, Step } from "./types"
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
  /** When set, Archer ran against an isolated worktree created on launch. */
  worktree?: { dir: string; branch: string }
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
  /** Short model label (e.g. "claude-opus-4-8"); empty for human gates. */
  modelLabel: string
}

type PipelineChoice = {
  name: string
  description: string
  source: "built-in" | "configured"
  isDefault: boolean
  steps: StepNode[]
  valid: boolean
  error?: string
}

type ToggleKey = "smart" | "yolo" | "humanReview" | "includeDirty" | "keepRunDir" | "tui" | "worktree"

type ToggleSpec = {
  key: ToggleKey
  label: string
  flag: string
  description: string
}

type Mode = "pipelines" | "prompt" | "options"

type Modal =
  | { kind: "message"; title: string; message: string; footer?: string }
  | { kind: "loading"; title: string; message: string; footer?: string }
  | { kind: "confirm"; title: string; message: string; footer?: string; onConfirm: () => void }

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
  {
    key: "worktree",
    label: "Isolate in a worktree",
    flag: "--worktree",
    description: "Create a new branch + git worktree (named from your prompt) and run Archer there, leaving the current branch untouched.",
  },
]

export async function launchRunTui(options: { targetDir: string }): Promise<LaunchRunSelection | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("archer needs an interactive terminal to open the launcher")
  }

  const config = await loadMergedArcherConfig(options.targetDir)
  const choices = pipelineChoices(config, buildAgentRegistry(config))
  const baseRef = config?.defaults.baseRef ?? "main"

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
  return new LaunchPicker(renderer, options.targetDir, choices, baseRef).result
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
        steps: pipeline.steps.map(stepNode),
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

function stepNode(step: Step): StepNode {
  if (step.type === "human") return { stepName: step.name, groupId: "", kind: "human", modelLabel: "" }
  return { stepName: step.stepName, groupId: step.groupId, kind: "agent", modelLabel: shortModelLabel(step.model, step.variant) }
}

/** Drops the provider path from a model id so the tree shows "claude-opus-4-8", not "anthropic/claude-opus-4-8#…". */
function shortModelLabel(model: string, variant?: string): string {
  const base = model.slice(model.lastIndexOf("/") + 1)
  return variant ? `${base} ${variant}` : base
}

class LaunchPicker {
  readonly result: Promise<LaunchRunSelection | undefined>

  private resolveResult!: (selection: LaunchRunSelection | undefined) => void
  private mode: Mode = "pipelines"
  private selected = 0
  private scroll = 0
  private prompt = ""
  private cursor = 0
  private promptScroll = 0
  private promptError = ""
  private optionIndex = 0
  private message = ""
  private modal?: Modal

  private readonly toggleState: Record<ToggleKey, boolean> = {
    smart: false,
    yolo: false,
    humanReview: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    includeDirty: false,
    keepRunDir: false,
    tui: Boolean(process.stdout.isTTY && process.stderr.isTTY),
    worktree: false,
  }

  private readonly ticker: ReturnType<typeof setInterval>
  private readonly headerText: TextRenderable
  private readonly pipelineText: TextRenderable
  private readonly pipelineBox: BoxRenderable
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
    if (this.mode !== "prompt") return
    event.preventDefault()
    event.stopPropagation()
    const text = sanitizePaste(stripAnsiSequences(decodePasteBytes(event.bytes)))
    if (!text) return
    this.insertPromptText(text)
    this.promptError = ""
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
    const modal = this.modal
    if (modal) {
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
    }
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly targetDir: string,
    private readonly choices: PipelineChoice[],
    private readonly baseRef: string,
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
      // Ignore clicks while a loading/message modal is up.
      if (this.modal) return
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
      width: this.pipelineWidth(),
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " pipelines ",
      titleAlignment: "left",
      onMouseDown: selectFromList,
    })
    pipeline.text.onMouseDown = selectFromList

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

    const detail = this.panel({
      id: "archer-launch-detail",
      flexGrow: 1,
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
    this.pipelineBox = pipeline.box
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

    // Modals float over the whole canvas, matching config-tui/runs-tui: an
    // absolute overlay centers a rounded accent-bordered box painted on
    // theme.overlay so it masks the setup screen underneath.
    this.overlay = new BoxRenderable(renderer, {
      id: "archer-launch-overlay",
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
      id: "archer-launch-modal",
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
    renderer.root.add(this.overlay)
    this.paletteTargets.push({ box: this.modalBox, background: "overlay", border: "accent" })

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.keyInput.on("paste", this.handlePaste)
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
    const enterAction = promptEnterAction(key)
    if (enterAction === "newline") {
      this.insertPromptText("\n")
      this.promptError = ""
      this.render()
      return
    }
    if (enterAction === "submit") {
      if (!this.prompt.trim()) {
        this.promptError = "Write a prompt before continuing."
      } else {
        this.prompt = this.prompt.trim()
        this.cursor = this.prompt.length
        this.promptError = ""
        this.mode = "options"
        this.optionIndex = 0
      }
      this.render()
      return
    }
    if (key.name === "backspace" || (key.ctrl && key.name === "h")) {
      if (this.cursor > 0) {
        this.prompt = this.prompt.slice(0, this.cursor - 1) + this.prompt.slice(this.cursor)
        this.cursor -= 1
      }
      this.promptError = ""
      this.render()
      return
    }
    if (key.ctrl && key.name === "u") {
      this.prompt = ""
      this.cursor = 0
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
      this.promptError = ""
      this.render()
    }
  }

  private insertPromptText(text: string) {
    this.prompt = this.prompt.slice(0, this.cursor) + text + this.prompt.slice(this.cursor)
    this.cursor += text.length
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
        this.cursor = this.prompt.length
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
    this.cursor = this.prompt.length
    this.promptScroll = 0
    this.render()
  }

  private startRun() {
    void this.startRunAfterGitCheck()
  }

  private async startRunAfterGitCheck() {
    const choice = this.currentChoice()
    try {
      const { repoBootstrapStatus } = await import("./git")
      const status = await repoBootstrapStatus(this.targetDir)
      if (status !== "ready") {
        this.modal = {
          kind: "confirm",
          title: "Initialize Git",
          message: status === "no-repo" ? "This project has no Git repository. Initialize it now with an initial commit?" : "This Git repository has no commits. Create an initial commit now?",
          footer: "enter initialize · esc cancel",
          onConfirm: () => void this.initializeGitAndStart(choice.name),
        }
        this.render()
        return
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.modal = { kind: "message", title: "git check failed", message }
      this.render()
      return
    }

    this.startReadyRun(choice.name)
  }

  private async initializeGitAndStart(pipelineName: string) {
    this.modal = { kind: "loading", title: "initializing Git", message: "creating initial commit…", footer: "please wait…" }
    this.render()
    try {
      const { initializeRepoWithInitialCommit } = await import("./git")
      await initializeRepoWithInitialCommit(this.targetDir, { baseRef: this.baseRef })
      this.startReadyRun(pipelineName)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.modal = { kind: "message", title: "git init failed", message }
      this.render()
    }
  }

  private startReadyRun(pipelineName: string) {
    if (this.toggleState.worktree) {
      void this.startWorktreeRun(pipelineName)
      return
    }
    this.finish({
      targetDir: this.targetDir,
      prompt: this.prompt,
      pipeline: pipelineName,
      humanReview: this.toggleState.humanReview,
      tui: this.toggleState.tui,
      includeDirty: this.toggleState.includeDirty,
      keepRunDir: this.toggleState.keepRunDir,
      yolo: this.toggleState.yolo,
      smart: this.toggleState.smart,
    })
  }

  // The AI naming call + `git worktree add` happen here, behind a blocking
  // loading modal so the user can't toggle options mid-creation. Any failure
  // falls back to the options screen with an explanatory message modal.
  private async startWorktreeRun(pipelineName: string) {
    this.modal = { kind: "loading", title: "isolating worktree", message: "generating a branch name…", footer: "creating a new branch + worktree…" }
    this.render()
    try {
      const { createIsolatedWorktree } = await import("./worktree")
      const result = await createIsolatedWorktree({
        targetDir: this.targetDir,
        prompt: this.prompt,
      })
      this.finish({
        targetDir: result.dir,
        prompt: this.prompt,
        pipeline: pipelineName,
        humanReview: this.toggleState.humanReview,
        tui: this.toggleState.tui,
        includeDirty: false,
        keepRunDir: this.toggleState.keepRunDir,
        yolo: this.toggleState.yolo,
        smart: this.toggleState.smart,
        worktree: { dir: result.dir, branch: result.branch },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.modal = { kind: "message", title: "worktree failed", message }
      this.render()
    }
  }

  private toggleOption() {
    const key = toggles[this.optionIndex]?.key
    if (!key) return
    const next = !this.toggleState[key]
    this.toggleState[key] = next
    if (key === "smart" && next) this.toggleState.yolo = false
    if (key === "yolo" && next) this.toggleState.smart = false
    // A fresh worktree is always clean, so includeDirty is meaningless there.
    if (key === "worktree" && next) this.toggleState.includeDirty = false
    if (key === "includeDirty" && next) this.toggleState.worktree = false
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
    this.renderer.keyInput.off("paste", this.handlePaste)
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
    const pipelineWidth = this.pipelineWidth()
    const detailWidth = Math.max(40, this.renderer.width - pipelineWidth - 7)

    this.pipelineBox.width = pipelineWidth
    this.detailBox.width = detailWidth
    // Mirror the dashboard focus cue: the accented border marks where Enter,
    // Esc, and the navigation keys apply in the current setup step.
    this.pipelineBox.borderColor = this.mode === "pipelines" ? theme.accent : theme.borderDim
    this.detailBox.borderColor = this.mode === "pipelines" ? theme.borderDim : theme.accent
    this.headerText.content = this.headerContent(innerWidth)
    // Panels reserve 4 cells of chrome (rounded border + paddingX:1 each side),
    // so lay out the rows against the inner text width — matching detailWidth
    // below. Passing the full box width made every right-aligned badge overflow
    // and wrap onto its own line.
    this.pipelineText.content = this.pipelineContent(pipelineWidth - 4)
    this.detailText.content = this.detailContent(detailWidth - 4)
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
    this.modalBox.borderColor = modal.kind === "message" ? theme.yellow : theme.accent

    if (modal.kind === "loading") {
      const frame = spinnerFrame(Date.now())
      lines.push(new StyledText([fg(theme.accent)(frame), raw("  "), fg(theme.text)(truncate(modal.message, width - 3))]))
    } else {
      for (const line of wrapWords(modal.message, width)) lines.push(new StyledText([fg(theme.text)(line)]))
    }
    lines.push(plain(""))
    const footer = modal.footer ?? (modal.kind === "message" ? "press any key to dismiss" : modal.kind === "confirm" ? "enter confirm · esc cancel" : "please wait…")
    lines.push(new StyledText([fg(theme.dim)(footer)]))

    this.modalBox.width = boxWidth
    this.modalBox.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }

  private modalWidth() {
    return Math.max(46, Math.min(80, this.renderer.width - 10))
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

  // One row per pipeline: a selection caret, a source/validity dot, the name,
  // and an optional right-aligned badge. The dot already encodes the source
  // (● configured · ○ built-in · ! invalid), so the row only spends a badge on
  // the signal that dot can't carry — the default, and user-defined pipelines.
  private pipelineRow(choice: PipelineChoice, selected: boolean, width: number) {
    const marker = selected ? fg(theme.accent)("▸ ") : raw("  ")
    const dot = choice.valid ? fg(choice.source === "configured" ? theme.teal : theme.dim)(choice.source === "configured" ? "●" : "○") : fg(theme.red)("!")
    const badgeText = choice.isDefault ? "default" : choice.source === "configured" ? "custom" : ""
    const badge: TextChunk[] = badgeText ? [fg(choice.isDefault ? theme.green : theme.teal)(badgeText)] : []
    // Prefix is caret (2) + dot (1) + space (1); reserve the badge plus a
    // 1-cell gap so a long name truncates instead of wrapping into the badge.
    const nameWidth = Math.max(3, width - 4 - (badgeText ? badgeText.length + 1 : 0))
    const name = truncate(choice.name, nameWidth)
    const label = selected ? bold(fg(theme.text)(name)) : fg(theme.text)(name)
    return padBetween([marker, dot, raw(" "), label], badge, width)
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
      for (const line of stepTree(choice.steps, width)) lines.push(line)
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
    lines.push(t`${fg(theme.dim)("Describe what Archer should do. Paste freely; Shift+Enter adds a line.")}`)
    lines.push(plain(""))

    const fieldWidth = Math.max(10, width - 2)
    const contentWidth = Math.max(1, fieldWidth)
    const inputHeight = Math.max(5, Math.min(20, this.listHeight() - 6))
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
    if (wrapped.length > 1) {
      lines.push(new StyledText([fg(theme.faint)(hint + " · "), fg(theme.accent)(`${wrapped.length} lines`)]))
    } else {
      lines.push(t`${fg(theme.faint)(hint)}`)
    }
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
      const toggle = toggleSwitch(enabled)
      const label = selected ? bold(fg(theme.text)(spec.label)) : fg(theme.text)(spec.label)
      const flag = fg(enabled ? theme.green : theme.dim)(spec.flag)
      lines.push(padBetween([marker, ...toggle, raw(" "), label], [flag], width))
      this.optionRows.push(index)
      lines.push(new StyledText([raw("        "), fg(theme.dim)(truncate(spec.description, Math.max(8, width - 8)))]))
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
    if (this.toggleState.worktree) flags.push("--worktree")
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
        [fg(theme.dim)("type/paste · "), fg(theme.accent)("shift+enter"), fg(theme.dim)(" newline · "), fg(theme.accent)("enter"), fg(theme.dim)(" options · "), fg(theme.accent)("esc"), fg(theme.dim)(" back")],
        [fg(theme.faint)(`${this.prompt.length} char${this.prompt.length === 1 ? "" : "s"}`)],
        width,
      )
    }
    return padBetween(
      [fg(theme.dim)("↑/↓ select · "), fg(theme.accent)("space"), fg(theme.dim)(" toggle · "), fg(theme.accent)("enter"), fg(theme.dim)(" start · "), fg(theme.accent)("p"), fg(theme.dim)(" prompt · "), fg(theme.accent)("q"), fg(theme.dim)(" quit")],
      [fg(theme.faint)(`${this.optionIndex + 1}/${toggles.length}`)],
      width,
    )
  }

  // The pipeline sidebar is capped at one third of the inner width so the
  // prompt/options panel gets the bulk of the screen; clamped so very narrow
  // terminals still show enough of each pipeline name to disambiguate.
  private pipelineWidth() {
    const inner = Math.max(40, this.renderer.width - 6)
    return clamp(Math.floor(inner / 3), 22, 44)
  }

  private listHeight() {
    // header (4) + footer (3) + list panel borders (2).
    return Math.max(3, this.renderer.height - 9)
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
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
      phases.push({ kind: node.kind, groupId: node.groupId, agents: [{ stepName: node.stepName, models: node.modelLabel ? [node.modelLabel] : [] }] })
      continue
    }
    const agent = last.agents.find((candidate) => candidate.stepName === node.stepName)
    if (agent) agent.models.push(node.modelLabel)
    else last.agents.push({ stepName: node.stepName, models: [node.modelLabel] })
  }

  const lines: StyledText[] = []
  const fit = (text: string, used: number) => truncate(text, Math.max(6, width - used))

  for (const phase of phases) {
    if (phase.kind === "human") {
      lines.push(new StyledText([fg(theme.faint)("○ "), fg(theme.yellow)(fit(phase.agents[0]!.stepName, 2)), fg(theme.faint)("  · manual gate")]))
      continue
    }
    const total = phase.agents.reduce((sum, agent) => sum + agent.models.length, 0)

    // A lone single-model step is just a sequential leaf.
    if (total === 1) {
      lines.push(new StyledText([fg(theme.faint)("○ "), fg(theme.text)(fit(phase.agents[0]!.stepName, 2))]))
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

// Model leaves under a step node; `prefix` carries the ancestor spine so the
// leaf connectors line up under the parent's branch.
function pushModels(lines: StyledText[], models: readonly string[], prefix: string, width: number) {
  models.forEach((model, index) => {
    const leaf = index === models.length - 1 ? "└ " : "├ "
    lines.push(new StyledText([fg(theme.faint)(prefix + leaf), fg(theme.dim)(truncate(model, Math.max(6, width - prefix.length - 2)))]))
  })
}
