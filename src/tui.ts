import { readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  bg,
  bold,
  createCliRenderer,
  fg,
  t,
} from "@opentui/core"

import { log } from "./log"
import { openOpencodeSessionWindow } from "./opencode"
import { PhaseUsage, addTokens, emptyTokens } from "./usage"
import {
  formatAgo,
  formatCount,
  formatElapsed,
  formatMoney,
  formatTime,
  joinLines,
  padBetween,
  paletteForTerminal,
  plain,
  progressBar,
  raw,
  setTheme,
  shortID,
  shortPath,
  shortUrl,
  spinnerFrame,
  statusIcon,
  styleSummaryLine,
  terminalBackgroundHex,
  theme,
  truncate,
  wrapLines,
} from "./tui-theme"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { PaletteColor, PhaseStatus } from "./tui-theme"
import type {
  ActivityKind,
  AutoAccept,
  AutoAcceptMode,
  PermissionPromptInfo,
  PermissionReply,
  ProgressAttempt,
  ProgressDiffSummary,
  ProgressPhase,
  ProgressPhaseSnapshot,
  ProgressStepUsage,
  ProgressTodo,
  ProgressTokens,
  ProgressUI,
  ProgressUsage,
  RunOutcome,
} from "./progress"

const kindStyles: Record<ActivityKind, { icon: string; color: PaletteColor }> = {
  tool: { icon: "⚒", color: "cyan" },
  bash: { icon: "$", color: "green" },
  think: { icon: "✻", color: "magenta" },
  write: { icon: "✎", color: "accent" },
  step: { icon: "▸", color: "teal" },
  retry: { icon: "↻", color: "yellow" },
  permission: { icon: "⚿", color: "yellow" },
  todo: { icon: "☑", color: "teal" },
  diff: { icon: "±", color: "orange" },
  error: { icon: "✗", color: "red" },
  info: { icon: "·", color: "dim" },
  system: { icon: "◆", color: "dim" },
}

function kindStyle(kind: ActivityKind): { icon: string; color: string } {
  const style = kindStyles[kind]
  return { icon: style.icon, color: theme[style.color] }
}

const pipelineWidth = 32
const feedLimit = 100
// Concurrently-running phases (a parallel block, or a step fanned out across
// models) each get their own live-detail pane, up to this many at once; extra
// running phases beyond this are folded into the last pane's title.
const maxPanes = 4

const permissionChoices: ReadonlyArray<{ reply: PermissionReply; label: string; color: PaletteColor }> = [
  { reply: "once", label: "allow once", color: "green" },
  { reply: "always", label: "always allow", color: "accent" },
  { reply: "reject", label: "reject", color: "red" },
]

const autoAcceptAnnouncement: Record<AutoAcceptMode, string> = {
  off: "auto-accept OFF: permissions prompt again",
  all: "auto-accept ON: ask-level permissions will be allowed (denylist still applies)",
  smart: "smart auto-accept ON: an AI judge allows safe requests and escalates risky ones",
}

function autoAcceptStatusChunk(mode: AutoAcceptMode): TextChunk {
  if (mode === "all") return bold(fg(theme.yellow)(" auto-accept ON"))
  if (mode === "smart") return bold(fg(theme.cyan)(" smart auto-accept"))
  return fg(theme.dim)(" auto-accept off")
}

type PhaseState = ProgressPhase & {
  status: PhaseStatus
  sessionID: string
  attempt: number
  maxAttempts: number
  /** Model requested for the attempt; lastStepModel (from usage events) wins when present. */
  model: string
  cost: number
  tokens: ProgressTokens
  stepCount: number
  lastStepModel: string
  usageReported: boolean
  usage: PhaseUsage
  now: { kind: ActivityKind; message: string }
  todos: ProgressTodo[]
  diff?: ProgressDiffSummary
  startedAt?: number
  endedAt?: number
  /** Real duration replayed from a previous run; set only by phaseRestored. */
  restoredDurationMs?: number
  updatedAt: number
}

type FeedEntry = {
  time: number
  phase: string
  kind: ActivityKind
  message: string
}

type PendingPermission = {
  info: PermissionPromptInfo
  resolve: (reply: PermissionReply) => void
}

// The post-run screen: the dashboard stays up, phases become a browsable list,
// and the logs panel turns into the selected phase's report viewer.
type FinishState = RunOutcome & {
  at: number
  selected: number
  reportScroll: number
  resolve: () => void
}

export async function createTuiProgress(
  phases: readonly ProgressPhase[],
  onAbort?: () => void,
  autoAccept?: AutoAccept,
): Promise<ProgressUI> {
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
  return new TuiProgress(renderer, phases, onAbort, autoAccept)
}

export class TuiProgress implements ProgressUI {
  private runID = ""
  private targetDir = ""
  private serverUrl = ""
  // Fallback focus for single-phase rendering: the phase that most recently
  // had activity, kept updated by every progress callback exactly as before.
  private activePhase = ""
  // Explicit user focus among concurrently-running phases (Tab / pane click);
  // unlike activePhase, this only ever changes on direct user action.
  private focusedPhaseName = ""
  private lastActivityAt = Date.now()
  private readonly startedAt = Date.now()
  private readonly phases: PhaseState[]
  private readonly feed: FeedEntry[] = []
  private readonly ticker: ReturnType<typeof setInterval>
  private readonly dirText: TextRenderable
  private readonly headerText: TextRenderable
  private readonly pipelineText: TextRenderable
  private readonly stepBox: BoxRenderable
  private readonly stepText: TextRenderable
  // Extra live-detail panes for additional concurrently-running phases beyond
  // the first (which reuses stepBox); hidden whenever at most one phase runs.
  private readonly extraPanes: { box: BoxRenderable; text: TextRenderable }[] = []
  // Slot index -> phase name currently assigned there, rebuilt every render
  // so pane clicks resolve against exactly what's on screen.
  private paneAssignment: (string | undefined)[] = []
  private readonly todosBox: BoxRenderable
  private readonly todosText: TextRenderable
  private readonly feedBox: BoxRenderable
  private readonly feedText: TextRenderable
  private readonly footerText: TextRenderable
  // Rebuilt on every pipeline render: panel row index → phase name, so clicks
  // resolve against exactly what is on screen (the active phase adds a row).
  private pipelineRowPhases: (string | undefined)[] = []
  private readonly overlay: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  // Panels repainted when the terminal reports a theme change mid-run.
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []
  private readonly permissionQueue: PendingPermission[] = []
  private permissionChoice = 0
  // Suspension nests: outer scopes (human-review gate) and inner prompts may
  // both suspend; only the outermost transition touches the renderer.
  private suspendDepth = 0
  private finished?: FinishState
  // A subshell (lazygit / git log) owns the terminal while the renderer is
  // suspended; every key must reach it untouched.
  private inSubshell = false
  // Phase reports read lazily from the run dir once the finish screen is up.
  private readonly reports = new Map<string, string[] | "loading" | "missing">()
  // Visible rows of the report panel, captured at render time for paging keys.
  private reportPageRows = 10
  // Scroll indicator for the footer ("" while everything fits), set at render time.
  private reportPosition = ""
  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.addEvent("archer", "system", `terminal theme changed: ${mode}`)
    this.render()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    if (this.inSubshell) return
    if ((key.ctrl && key.name === "c") || key.raw === "\u0003") {
      key.preventDefault()
      key.stopPropagation()
      // After the run ended Ctrl+C just dismisses the finish screen; aborting
      // a finished run would only race the cleanup it already triggers.
      if (this.finished) {
        this.finished.resolve()
        return
      }
      this.addEvent("archer", "system", "ctrl+c received; shutting down")
      this.render()
      this.onAbort?.()
      return
    }
    if (this.finished) {
      // A permission can still arrive while the finish screen is up (e.g. the
      // user iterates in a session opened with [o]); the modal keeps priority.
      if (this.permissionQueue.length > 0) {
        this.handlePermissionKey(key)
        return
      }
      this.handleFinishedKey(key)
      return
    }
    // Checked before the permission modal so the toggle also resolves an
    // open prompt (enabling auto-accept flushes the whole queue).
    if (key.name === "tab" && key.shift) {
      key.preventDefault()
      key.stopPropagation()
      this.cycleAutoAccept()
      return
    }
    if (this.permissionQueue.length > 0) {
      this.handlePermissionKey(key)
      return
    }
    // Plain Tab cycles focus among concurrently-running phases; a no-op when
    // at most one is running. Checked after the permission modal, which
    // already claims plain Tab for cycling its own choices.
    if (key.name === "tab" && !key.ctrl && !key.meta && !key.option) {
      key.preventDefault()
      key.stopPropagation()
      this.cycleFocusedPhase()
      return
    }
    if (key.name !== "o" || key.ctrl || key.meta || key.option) return
    key.preventDefault()
    key.stopPropagation()
    this.openActiveSessionWindow("key")
  }

  constructor(
    private readonly renderer: CliRenderer,
    phases: readonly ProgressPhase[],
    private readonly onAbort?: () => void,
    private readonly autoAccept?: AutoAccept,
  ) {
    this.phases = phases.map((phase) => ({
      ...phase,
      status: "pending",
      sessionID: "",
      attempt: 0,
      maxAttempts: 0,
      model: "",
      cost: 0,
      tokens: emptyTokens(),
      stepCount: 0,
      lastStepModel: "",
      usageReported: false,
      usage: new PhaseUsage(),
      now: { kind: "info", message: "" },
      todos: [],
      updatedAt: Date.now(),
    }))

    const shell = new BoxRenderable(renderer, {
      id: "archer-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
      gap: 0,
    })

    // The working directory sits above the header as a bare line, outside the
    // bordered box, so the header itself stays a single clean row of totals.
    const dirLine = new TextRenderable(renderer, {
      id: "archer-dir",
      content: "",
      fg: theme.text,
      width: "100%",
      height: 1,
    })

    const header = this.panel({
      id: "archer-header",
      height: 3,
      borderColor: theme.border,
      backgroundColor: theme.bg,
    })

    const body = new BoxRenderable(renderer, {
      id: "archer-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
    })

    const openFromPipeline = (event: { y: number; preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      const name = this.pipelineRowPhases[event.y - this.pipelineText.y]
      if (!name) return
      // On the finish screen a click browses; opening stays on [o].
      if (this.finished) this.selectFinishedPhase(name)
      else this.openSessionWindowForPhase(name, "click")
    }

    const pipeline = this.panel({
      id: "archer-pipeline",
      width: pipelineWidth,
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " pipeline ",
      titleAlignment: "left",
      onMouseDown: openFromPipeline,
    })
    pipeline.text.onMouseDown = openFromPipeline

    const right = new BoxRenderable(renderer, {
      id: "archer-right",
      height: "100%",
      flexGrow: 1,
      flexDirection: "column",
      gap: 0,
    })

    const paneClickHandler = (index: number) => (event: { preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      this.focusPaneAndOpen(index)
    }
    const openFromStep = paneClickHandler(0)

    const step = this.panel({
      id: "archer-step",
      width: "100%",
      height: 8,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " current step ",
      titleAlignment: "left",
      onMouseDown: openFromStep,
    })
    step.text.onMouseDown = openFromStep

    // Extra panes for additional concurrently-running phases (a parallel
    // block, or a step fanned out across models); hidden until more than one
    // phase is running at once. Pane 0 is the step panel above.
    for (let index = 1; index < maxPanes; index++) {
      const openFromThisPane = paneClickHandler(index)
      const pane = this.panel({
        id: `archer-step-${index}`,
        width: "100%",
        height: 3,
        borderColor: theme.borderDim,
        backgroundColor: theme.bg,
        title: " ",
        titleAlignment: "left",
        visible: false,
        onMouseDown: openFromThisPane,
      })
      pane.text.onMouseDown = openFromThisPane
      this.extraPanes.push(pane)
      this.paletteTargets.push({ box: pane.box, background: "bg", border: "borderDim" })
    }

    // Todos live in their own panel below the step meta; its border is the
    // divider between session usage above and the todo list itself. Only
    // shown when exactly one phase is running - concurrent phases fold their
    // todos into their own compact pane instead.
    const todos = this.panel({
      id: "archer-todos",
      width: "100%",
      height: 3,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " todos ",
      titleAlignment: "left",
      visible: false,
      onMouseDown: openFromStep,
    })
    todos.text.onMouseDown = openFromStep

    const feed = this.panel({
      id: "archer-feed",
      width: "100%",
      flexGrow: 1,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " logs ",
      titleAlignment: "left",
    })

    const openFromFooter = (event: { preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      this.openActiveSessionWindow("click")
    }

    const footer = this.panel({
      id: "archer-footer",
      height: 3,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      onMouseDown: openFromFooter,
    })
    footer.text.onMouseDown = openFromFooter

    this.dirText = dirLine
    this.headerText = header.text
    this.pipelineText = pipeline.text
    this.stepBox = step.box
    this.stepText = step.text
    this.todosBox = todos.box
    this.todosText = todos.text
    this.feedBox = feed.box
    this.feedText = feed.text
    this.footerText = footer.text

    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: header.box, background: "bg", border: "border" },
      { box: pipeline.box, background: "bg", border: "borderDim" },
      { box: step.box, background: "bg", border: "borderDim" },
      { box: todos.box, background: "bg", border: "borderDim" },
      { box: feed.box, background: "bg", border: "borderDim" },
      { box: footer.box, background: "bg", border: "borderDim" },
    )

    body.add(pipeline.box)
    right.add(step.box)
    for (const pane of this.extraPanes) right.add(pane.box)
    right.add(todos.box)
    right.add(feed.box)
    body.add(right)
    shell.add(dirLine)
    shell.add(header.box)
    shell.add(body)
    shell.add(footer.box)
    renderer.root.add(shell)

    this.overlay = new BoxRenderable(renderer, {
      id: "archer-permission-overlay",
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
    this.modal = new BoxRenderable(renderer, {
      id: "archer-permission-modal",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.yellow,
      backgroundColor: theme.overlay,
      title: " ⚿ permission required ",
      titleAlignment: "left",
      width: 64,
      height: 10,
      paddingX: 2,
      paddingY: 1,
    })
    this.modalText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    this.modal.add(this.modalText)
    this.overlay.add(this.modal)
    renderer.root.add(this.overlay)
    this.paletteTargets.push({ box: this.modal, background: "overlay", border: "yellow" })

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)

    this.ticker = setInterval(() => this.render(), 250)
    this.render()
  }

  start(runID: string, targetDir: string) {
    this.runID = runID
    this.targetDir = targetDir
    this.addEvent("archer", "system", `run ${runID} started`)
    this.render()
  }

  serverReady(url: string) {
    this.serverUrl = url
    this.addEvent("archer", "system", `opencode server at ${url}`)
    this.render()
  }

  phaseStarted(name: string, detail = "") {
    this.setPhase(name, "running")
    this.addEvent(name, "system", detail || "phase started")
  }

  phaseRunning(name: string, detail = "") {
    this.setPhase(name, "running")
    if (!detail) return
    const phase = this.findPhase(name)
    if (phase) phase.now = { kind: "info", message: detail }
    this.addEvent(name, "info", detail)
    this.render()
  }

  phaseAttempt(name: string, info: ProgressAttempt) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.attempt = info.attempt
    phase.maxAttempts = info.maxAttempts
    if (info.model) phase.model = info.model
    phase.updatedAt = Date.now()
    this.activePhase = name
    this.addEvent(name, "step", `attempt ${info.attempt}/${info.maxAttempts}${info.model ? ` · ${info.model}` : ""}`)
    this.render()
  }

  phaseSession(name: string, sessionID: string) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.sessionID = sessionID
    // Usage events without a sessionID belong to this phase's session, not a
    // separate bucket.
    phase.usage.fallbackSessionID = sessionID || "phase"
    phase.updatedAt = Date.now()
    this.activePhase = name
    this.addEvent(name, "system", `session ${shortID(sessionID)}`)
    this.render()
  }

  phaseActivity(name: string, detail: string, kind: ActivityKind = "info", pulse = false) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.now = { kind, message: detail }
    phase.updatedAt = Date.now()
    this.activePhase = name
    if (pulse) this.lastActivityAt = Date.now()
    else this.addEvent(name, kind, detail)
    this.render()
  }

  phaseStepUsage(name: string, usage: ProgressStepUsage) {
    const phase = this.findPhase(name)
    if (!phase || !phase.usage.addStep(usage)) return

    phase.lastStepModel = usage.model || phase.lastStepModel
    phase.updatedAt = Date.now()
    this.recalculateUsage(phase)
    this.render()
  }

  phaseUsageTotal(name: string, usage: ProgressUsage) {
    const phase = this.findPhase(name)
    if (!phase) return

    phase.usage.setTotal(usage)
    if (usage.model) phase.lastStepModel = usage.model
    phase.updatedAt = Date.now()
    this.recalculateUsage(phase)
    this.render()
  }

  phaseTodos(name: string, todos: ProgressTodo[]) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.todos = todos
    phase.updatedAt = Date.now()
    this.render()
  }

  phaseDiff(name: string, summary: ProgressDiffSummary) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.diff = summary
    phase.updatedAt = Date.now()
    this.render()
  }

  phaseCompleted(name: string, detail = "") {
    this.setPhase(name, "completed")
    this.addEvent(name, "system", detail || "phase completed")
  }

  phaseSkipped(name: string) {
    this.setPhase(name, "skipped")
    this.addEvent(name, "system", "skipped by flag")
  }

  phaseFailed(name: string, detail = "") {
    this.setPhase(name, "failed")
    this.addEvent(name, "error", detail || "failed")
  }

  phaseRestored(name: string, snapshot: ProgressPhaseSnapshot) {
    const phase = this.findPhase(name)
    if (!phase) return
    // Written directly instead of via setPhase: a restored phase must not
    // claim the active slot or reset the quiet timer of the live run.
    phase.status = snapshot.status
    phase.sessionID = snapshot.sessionID ?? ""
    phase.restoredDurationMs = snapshot.durationMs
    if (snapshot.cost !== undefined || snapshot.tokens) {
      phase.usage.setTotal({
        sessionID: snapshot.sessionID || "restored",
        cost: snapshot.cost,
        tokens: snapshot.tokens,
        model: snapshot.model,
      })
      this.recalculateUsage(phase)
    }
    if (snapshot.model) phase.lastStepModel = snapshot.model
    phase.updatedAt = Date.now()
    const parts = [
      snapshot.durationMs !== undefined ? formatElapsed(snapshot.durationMs) : "",
      snapshot.cost !== undefined ? formatMoney(snapshot.cost) : "",
      snapshot.sessionID ? `session ${shortID(snapshot.sessionID)}` : "",
    ].filter(Boolean)
    this.addEvent(name, "system", `restored from previous run${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`)
    this.render()
  }

  askPermission(info: PermissionPromptInfo): Promise<PermissionReply> {
    if (this.renderer.isDestroyed) return Promise.resolve("reject")
    // The gate checks auto-accept before prompting, but the toggle can flip
    // between that check and this call; never show a prompt in "all" mode.
    // "smart" decisions are made in the gate before this call, so reaching here
    // in smart mode means the judge already escalated — show the prompt.
    if (this.autoAccept?.mode === "all") {
      this.addEvent("archer", "permission", `auto-allowed: ${permissionSummary(info)}`)
      this.render()
      return Promise.resolve("once")
    }
    return new Promise((resolve) => {
      this.permissionQueue.push({ info, resolve })
      if (this.permissionQueue.length === 1) this.permissionChoice = 0
      this.addEvent("archer", "permission", `approval needed: ${permissionSummary(info)}`)
      this.render()
    })
  }

  // Resolves when the user dismisses the screen (q/esc/ctrl+c). Until then the
  // run stays alive upstream: the opencode server keeps serving [o] and the
  // run dir keeps the reports readable.
  runFinished(outcome: RunOutcome): Promise<void> {
    if (this.renderer.isDestroyed) return Promise.resolve()
    return new Promise((resolve) => {
      const failed = this.phases.findIndex((phase) => phase.status === "failed")
      this.finished = {
        ...outcome,
        at: Date.now(),
        selected: failed >= 0 ? failed : 0,
        reportScroll: 0,
        resolve,
      }
      for (const pending of this.permissionQueue.splice(0)) pending.resolve("reject")
      this.addEvent(
        "archer",
        outcome.status === "completed" ? "system" : "error",
        outcome.status === "completed" ? "run completed" : `run failed: ${outcome.error ?? "unknown error"}`,
      )
      this.render()
    })
  }

  private handleFinishedKey(key: KeyEvent) {
    const finished = this.finished
    if (!finished) return
    key.preventDefault()
    key.stopPropagation()
    switch (key.name) {
      case "down":
      case "j":
        this.moveFinishedSelection(1)
        break
      case "up":
      case "k":
        this.moveFinishedSelection(-1)
        break
      case "o":
        this.openSessionWindowForPhase(this.phases[finished.selected]!.name, "key")
        break
      case "g":
        void this.openGitSubshell()
        break
      case "pagedown":
      case "space":
        finished.reportScroll += this.reportPageRows
        break
      case "pageup":
        finished.reportScroll = Math.max(0, finished.reportScroll - this.reportPageRows)
        break
      case "q":
      case "escape":
        finished.resolve()
        return
    }
    this.render()
  }

  private moveFinishedSelection(delta: number) {
    const finished = this.finished
    if (!finished || this.phases.length === 0) return
    finished.selected = Math.max(0, Math.min(this.phases.length - 1, finished.selected + delta))
    finished.reportScroll = 0
  }

  private selectFinishedPhase(name: string) {
    const finished = this.finished
    if (!finished) return
    const index = this.phases.findIndex((phase) => phase.name === name)
    if (index === -1) return
    finished.selected = index
    finished.reportScroll = 0
    this.render()
  }

  // Lazygit (or plain `git log` when it isn't installed) takes over the whole
  // terminal as a subshell; the dashboard suspends and repaints afterwards.
  private async openGitSubshell() {
    if (this.inSubshell || this.renderer.isDestroyed) return
    const lazygit = Bun.which("lazygit")
    const argv = lazygit ? [lazygit] : ["git", "log", "--graph", "--decorate", "--stat"]
    const label = lazygit ? "lazygit" : "git log"
    if (!lazygit) this.addEvent("archer", "system", "lazygit not installed; falling back to git log")
    this.inSubshell = true
    this.suspend()
    try {
      const proc = Bun.spawn(argv, {
        cwd: this.targetDir || process.cwd(),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      })
      const code = await proc.exited
      if (code !== 0) this.addEvent("archer", "error", `${label} exited with code ${code}`)
    } catch (error) {
      this.addEvent("archer", "error", `couldn't launch ${label}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.inSubshell = false
      this.resume()
    }
  }

  private loadReport(name: string, runDir: string) {
    this.reports.set(name, "loading")
    readFile(join(runDir, "reports", `${name}.md`), "utf8")
      .then((body) => {
        this.reports.set(name, body.replace(/\r\n/g, "\n").split("\n"))
        this.render()
      })
      .catch(() => {
        this.reports.set(name, "missing")
        this.render()
      })
  }

  message(message: string) {
    this.addEvent("archer", "system", message)
    this.render()
  }

  suspend() {
    if (this.renderer.isDestroyed) return
    if (this.suspendDepth++ > 0) return
    log.mute(false)
    this.renderer.suspend()
  }

  resume() {
    if (this.renderer.isDestroyed) return
    if (this.suspendDepth === 0) return
    if (--this.suspendDepth > 0) return
    log.mute(true)
    this.renderer.resume()
    this.render()
  }

  stop() {
    clearInterval(this.ticker)
    log.mute(false)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    // A shutdown signal can tear the run down while the finish screen is still
    // up; resolving here keeps that promise from leaking.
    this.finished?.resolve()
    for (const pending of this.permissionQueue.splice(0)) pending.resolve("reject")
    if (this.renderer.isDestroyed) return
    this.renderer.destroy()
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
    const text = new TextRenderable(this.renderer, {
      content: "",
      fg: theme.text,
      width: "100%",
      height: "100%",
      // Every panel manages its own wrapping/truncation to a known width; a
      // stray over-long line must clip at the panel edge, never wrap onto a
      // second row (which would desync the pipeline's click row mapping).
      wrapMode: "none",
    })
    box.add(text)
    return { box, text }
  }

  private handlePermissionKey(key: KeyEvent) {
    key.preventDefault()
    key.stopPropagation()
    switch (key.name) {
      case "left":
        this.permissionChoice = (this.permissionChoice + permissionChoices.length - 1) % permissionChoices.length
        break
      case "right":
      case "tab":
        this.permissionChoice = (this.permissionChoice + 1) % permissionChoices.length
        break
      case "return":
      case "linefeed":
        this.resolvePermission(permissionChoices[this.permissionChoice]!.reply)
        break
      case "o":
      case "y":
        this.resolvePermission("once")
        break
      case "a":
        this.resolvePermission("always")
        break
      case "r":
      case "n":
      case "escape":
        this.resolvePermission("reject")
        break
    }
    this.render()
  }

  private cycleAutoAccept() {
    if (!this.autoAccept) return
    const order = ["off", "all", "smart"] as const
    const next = order[(order.indexOf(this.autoAccept.mode) + 1) % order.length]!
    this.autoAccept.mode = next
    this.addEvent("archer", "permission", autoAcceptAnnouncement[next])
    // Only "all" clears the backlog blindly; "smart" leaves already-escalated
    // prompts for the user (re-judging an open prompt would be surprising).
    if (next === "all") {
      for (const pending of this.permissionQueue.splice(0)) {
        this.addEvent("archer", "permission", `auto-allowed: ${permissionSummary(pending.info)}`)
        pending.resolve("once")
      }
      this.permissionChoice = 0
    }
    this.render()
  }

  private resolvePermission(reply: PermissionReply) {
    const pending = this.permissionQueue.shift()
    if (!pending) return
    this.permissionChoice = 0
    const verdict = reply === "once" ? "allowed once" : reply === "always" ? "always allowed" : "rejected"
    this.addEvent("archer", "permission", `${verdict}: ${permissionSummary(pending.info)}`)
    pending.resolve(reply)
    this.render()
  }

  private openActiveSessionWindow(source: "click" | "key") {
    const active = this.finished
      ? this.phases[this.finished.selected]
      : (this.findPhase(this.focusedPhaseName) ?? this.findPhase(this.activePhase) ?? this.phases.find((phase) => phase.status === "running"))
    if (!active) {
      this.addEvent("archer", "system", "no active opencode session to open yet")
      this.render()
      return
    }
    this.openSessionWindowForPhase(active.name, source)
  }

  // Clicking a specific pane both focuses it (so [o]/Tab agree with what was
  // clicked) and opens its session immediately, matching the single-pane
  // click-to-open behavior this replaces.
  private focusPaneAndOpen(index: number) {
    const name = this.paneAssignment[index]
    if (name) this.focusedPhaseName = name
    this.openActiveSessionWindow("click")
  }

  // Cycles explicit focus among currently-running phases; a no-op with zero
  // or one running phase (nothing to choose between).
  private cycleFocusedPhase() {
    const running = this.phases.filter((phase) => phase.status === "running")
    if (running.length === 0) return
    const currentIndex = running.findIndex((phase) => phase.name === this.focusedPhaseName)
    const next = running[(currentIndex + 1) % running.length]!
    this.focusedPhaseName = next.name
    this.render()
  }

  private openSessionWindowForPhase(name: string, source: "click" | "key") {
    const phase = this.findPhase(name)
    if (!phase) return
    if (!this.serverUrl) {
      this.addEvent("archer", "system", "opencode server is not ready yet")
      this.render()
      return
    }
    if (!phase.sessionID) {
      this.addEvent("archer", "system", `no opencode session for ${name} yet`)
      this.render()
      return
    }

    this.addEvent("archer", "system", `${source === "key" ? "[o]" : "click"}: opening ${name} session ${shortID(phase.sessionID)}`)
    openOpencodeSessionWindow({ url: this.serverUrl, targetDir: this.targetDir || process.cwd(), sessionID: phase.sessionID })
      .then((backend) => {
        this.addEvent("archer", "system", `${name} session opened in ${backend}`)
        this.render()
      })
      .catch((error: unknown) => {
        this.addEvent("archer", "error", `couldn't open opencode session: ${error instanceof Error ? error.message : String(error)}`)
        this.render()
      })
    this.render()
  }

  private setPhase(name: string, status: PhaseStatus) {
    const phase = this.findPhase(name)
    if (!phase) return
    if (status === "running" && phase.startedAt === undefined) phase.startedAt = Date.now()
    if (status === "completed" || status === "failed" || status === "skipped") phase.endedAt = Date.now()
    phase.status = status
    phase.updatedAt = Date.now()
    this.activePhase = name
    this.lastActivityAt = Date.now()
    this.render()
  }

  private findPhase(name: string) {
    return this.phases.find((item) => item.name === name)
  }

  private addEvent(phase: string, kind: ActivityKind, message: string) {
    this.lastActivityAt = Date.now()
    const entry: FeedEntry = { time: this.lastActivityAt, phase, kind, message: truncate(message, 220) }
    const last = this.feed[this.feed.length - 1]

    // Streaming kinds update in place; identical repeats collapse. Keeps the feed calm.
    if (last && last.phase === phase && last.kind === kind) {
      if (kind === "think" || kind === "write" || last.message === entry.message) {
        this.feed[this.feed.length - 1] = entry
        return
      }
    }
    this.feed.push(entry)
    if (this.feed.length > feedLimit) this.feed.splice(0, this.feed.length - feedLimit)
  }

  private recalculateUsage(phase: PhaseState) {
    const totals = phase.usage.totals()
    phase.cost = totals.cost
    phase.tokens = totals.tokens
    phase.stepCount = totals.steps
    phase.usageReported = totals.reported
  }

  private render() {
    if (this.renderer.isDestroyed) return
    const now = Date.now()
    const innerWidth = Math.max(40, this.renderer.width - 6)
    const rightWidth = Math.max(40, this.renderer.width - pipelineWidth - 9)
    // Body rows left after the dir line (1), header (3), and footer (3); the
    // step/pane panels grow with their content but never starve the logs.
    const bodyHeight = Math.max(8, this.renderer.height - 7)

    // A finished run always browses one phase at a time (its live-run
    // concurrency is over); a live run with more than one phase running at
    // once shows each in its own pane instead of following a single focus.
    const running = this.finished ? [] : this.runningPhasesByFocus()
    const focus = this.finished ? this.phases[this.finished.selected] : (this.findPhase(this.activePhase) ?? running[0])

    const multi = running.length > 1
    const usedHeight = multi ? this.renderPanes(running, now, rightWidth, bodyHeight) : this.renderSinglePane(focus, now, rightWidth, bodyHeight)

    // usedHeight already counts every pane's own border, so the feed box only
    // needs its own 2 rows subtracted. Single mode keeps a floor of 3 (its
    // content is small and bounded, so there's always room); multi mode
    // can't assume that - several full-height panes can legitimately leave
    // nothing over, so it floors at 0 instead of asking for lines the feed
    // box has no room to show (which would bleed into its own border).
    const feedRows = Math.max(multi ? 0 : 3, bodyHeight - usedHeight - 2)
    this.dirText.content = this.dirContent(innerWidth)
    this.headerText.content = this.headerContent(now, innerWidth)
    this.pipelineText.content = this.pipelineContent(now)
    if (this.finished) {
      this.reportPageRows = feedRows
      // Content first: it computes the scroll indicator the title shows.
      this.feedText.content = joinLines(this.reportPanelLines(focus, rightWidth, feedRows))
      this.feedBox.title = ` report · ${focus ? phaseDisplayName(focus) : "—"}${this.reportPosition ? ` · ${this.reportPosition}` : ""} `
    } else {
      this.feedBox.title = " logs "
      this.feedText.content = joinLines(this.feedLines(rightWidth, feedRows))
    }
    this.footerText.content = this.footerContent(now, innerWidth)
    this.renderPermissionModal()
    this.renderer.requestRender()
  }

  // Running phases ordered for pane assignment: the explicitly-focused one
  // (if still running) first so it's always visible even under overflow,
  // then the rest oldest-first so pane assignment stays stable frame to frame.
  private runningPhasesByFocus(): PhaseState[] {
    const running = this.phases.filter((phase) => phase.status === "running").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    const focusedIndex = running.findIndex((phase) => phase.name === this.focusedPhaseName)
    if (focusedIndex <= 0) return running
    return [running[focusedIndex]!, ...running.slice(0, focusedIndex), ...running.slice(focusedIndex + 1)]
  }

  // Single-phase mode: identical to archer's original one-pane layout (step
  // panel plus a separate todos panel), used whenever at most one phase is
  // running - i.e. every ordinary sequential pipeline, unchanged.
  private renderSinglePane(focus: PhaseState | undefined, now: number, width: number, bodyHeight: number): number {
    for (const pane of this.extraPanes) pane.box.visible = false
    this.paneAssignment = [focus?.name]

    const stepLines = this.finished ? this.finishedPhaseContent(focus, now, width) : this.stepContent(focus, now, width)
    this.stepBox.title = this.finished ? " phase " : " current step "
    this.stepBox.height = stepLines.length + 2
    this.stepText.content = joinLines(stepLines)

    const todoRows =
      focus && focus.todos.length > 0
        ? todoLines(focus.todos, Math.max(3, Math.floor(bodyHeight * 0.6) - stepLines.length - 4), width)
        : []
    this.todosBox.visible = todoRows.length > 0
    if (focus && todoRows.length > 0) {
      const completed = focus.todos.filter((todo) => todo.status === "completed").length
      this.todosBox.height = todoRows.length + 2
      this.todosBox.title = ` todos ${completed}/${focus.todos.length} `
      this.todosText.content = joinLines(todoRows)
    }
    return stepLines.length + 2 + (this.todosBox.visible ? todoRows.length + 2 : 0)
  }

  // Multi-phase mode: one compact pane per concurrently-running phase (step
  // content plus a condensed todo summary), up to maxPanes; the separate
  // todos panel is hidden since each pane already carries its own.
  private renderPanes(running: PhaseState[], now: number, width: number, bodyHeight: number): number {
    this.todosBox.visible = false
    const { visibleCount, overflow, perPaneBudget } = paneLayout(running.length, bodyHeight, maxPanes)
    const visible = running.slice(0, visibleCount)
    const focusedName = this.focusedPhaseName || visible[0]!.name
    this.paneAssignment = []

    let usedHeight = 0
    visible.forEach((phase, index) => {
      const pane = index === 0 ? { box: this.stepBox, text: this.stepText } : this.extraPanes[index - 1]!
      const stepLines = this.stepContent(phase, now, width).slice(0, perPaneBudget)
      const todoCap = Math.max(0, Math.min(2, perPaneBudget - stepLines.length))
      const lines = todoCap > 0 && phase.todos.length > 0 ? [...stepLines, ...todoLines(phase.todos, todoCap, width)] : stepLines

      const focused = phase.name === focusedName
      const overflowSuffix = overflow > 0 && index === visible.length - 1 ? ` · +${overflow} more running` : ""
      pane.box.visible = true
      pane.box.title = ` ${focused ? "▸ " : "  "}${phaseDisplayName(phase)}${overflowSuffix} `
      pane.box.height = lines.length + 2
      pane.text.content = joinLines(lines)
      this.paneAssignment[index] = phase.name
      usedHeight += lines.length + 2
    })

    for (let index = visible.length; index < maxPanes; index++) {
      const pane = index === 0 ? this.stepBox : this.extraPanes[index - 1]!.box
      pane.visible = false
      this.paneAssignment[index] = undefined
    }

    return usedHeight
  }

  // Header owns the session-wide totals in a single row: clock, elapsed time,
  // cost, and tokens. Phase status lives in the pipeline panel.
  private headerContent(now: number, width: number) {
    const usage = totalUsage(this.phases)
    // The clock and elapsed time freeze at the moment the run ended.
    const endAt = this.finished?.at ?? now
    const totals: TextChunk[] = [
      fg(theme.dim)(formatTime(endAt)),
      fg(theme.faint)("  ·  "),
      fg(theme.text)(formatElapsed(endAt - this.startedAt)),
      fg(theme.faint)("  ·  "),
      fg(theme.green)(formatMoney(usage.cost)),
      fg(theme.faint)("  ·  "),
      fg(theme.dim)(`↑${formatCount(usage.tokens.input)} ↓${formatCount(usage.tokens.output)} tokens`),
    ]
    const title: TextChunk[] = [bold(fg(theme.accent)("◆ archer"))]
    if (this.finished) {
      title.push(
        fg(theme.faint)("  ·  "),
        this.finished.status === "completed" ? bold(fg(theme.green)("✓ run completed")) : bold(fg(theme.red)("✗ run failed")),
      )
    }
    return padBetween(title, totals, width)
  }

  // The working directory renders above the header box, outside its border.
  private dirContent(width: number) {
    return t`${fg(theme.dim)("dir ")}${fg(theme.text)(shortPath(this.targetDir, width - 4))}`
  }

  private overallFraction() {
    const total = Math.max(1, this.phases.length)
    let done = 0
    for (const phase of this.phases) {
      if (phase.status === "completed" || phase.status === "skipped") done += 1
      else if (phase.status === "running") done += runningFraction(phase)
    }
    return Math.min(1, done / total)
  }

  // The pipeline owns run progress: the overall bar plus the phase list. A
  // sequential step is one flat row (unchanged); a concurrent group (a
  // `parallel:` block, or a step fanned out across `models:`) renders as an
  // indented sub-tree under a group header, so the nesting is visible instead
  // of a flat list of `step__model` names all sitting at the same level.
  private pipelineContent(now: number) {
    const width = pipelineWidth - 4
    const done = this.phases.filter((phase) => phase.status === "completed" || phase.status === "skipped").length
    const failed = this.phases.some((phase) => phase.status === "failed")
    const finished = this.phases.length > 0 && done === this.phases.length
    const barColor = failed ? theme.red : finished ? theme.green : theme.accent
    const counter = ` ${done}/${this.phases.length}`

    const out: StyledText[] = [
      new StyledText([
        ...progressBar(this.overallFraction(), Math.max(6, width - counter.length), barColor),
        fg(theme.text)(counter),
      ]),
      plain(""),
    ]
    // Rebuilt in lockstep with `out`: one entry per rendered line so a click
    // resolves against exactly what is on screen. Group headers point at their
    // first member so a click still opens (or, on the finish screen, browses)
    // something sensible.
    const rows: (string | undefined)[] = [undefined, undefined]
    const emit = (left: TextChunk[], right: TextChunk[], rowPhase: string | undefined) => {
      out.push(padBetween(left, right, width))
      rows.push(rowPhase)
    }
    // The selection marker (▸) only exists on the finish screen, where the
    // pipeline doubles as the phase browser; emitLine draws it at column 0,
    // before the tree prefix, so it stays aligned across every depth.
    const isSelected = (phase: PhaseState) => this.finished !== undefined && this.phases[this.finished.selected] === phase

    // One rendered line, sized so it never wraps: the marker, tree prefix and
    // status icon are fixed, the right-aligned meta is preserved whole, and
    // the label (name or model) is truncated to whatever budget is left
    // between them. Deep nesting eats into the name, never into the layout —
    // which keeps `rows` one-to-one with the visible lines (clicks resolve).
    const emitLine = (args: {
      rowPhase: string | undefined
      selectedPhase?: PhaseState
      lasts: boolean[]
      icon: TextChunk
      labelText: string
      labelStatus: PhaseStatus
      color?: (text: string) => TextChunk
      suffix?: TextChunk[]
      right: TextChunk[]
    }) => {
      const selected = args.selectedPhase !== undefined && isSelected(args.selectedPhase)
      const left: TextChunk[] = []
      if (this.finished) left.push(selected ? fg(theme.accent)("▸ ") : raw("  "))
      const prefix = treePrefix(args.lasts)
      if (prefix) left.push(fg(theme.faint)(prefix))
      left.push(args.icon, raw(" "))
      const suffix = args.suffix ?? []
      // -1 reserves the single-column gap padBetween keeps before the meta.
      // Floored at 1 (not higher) so a very deep row shrinks its name to fit
      // rather than forcing extra columns that would push the meta off-panel.
      const budget = Math.max(1, width - plainLen(left) - plainLen(suffix) - plainLen(args.right) - 1)
      const label = truncate(args.labelText, budget)
      left.push(args.color ? args.color(label) : phaseNameChunk(label, args.labelStatus, selected))
      left.push(...suffix)
      emit(left, args.right, args.rowPhase)
    }

    // A leaf row: a single phase (sequential step, human gate, or one member
    // of a concurrent group) labelled by `labelText`.
    const emitRow = (phase: PhaseState, lasts: boolean[], labelText: string, right: TextChunk[]) =>
      emitLine({ rowPhase: phase.name, selectedPhase: phase, lasts, icon: statusIcon(phase.status, now), labelText, labelStatus: phase.status, right })

    // A fanned-out member, labelled by its model with the variant (if any) as
    // a faint suffix.
    const emitModelRow = (phase: PhaseState, lasts: boolean[]) =>
      emitLine({
        rowPhase: phase.name,
        selectedPhase: phase,
        lasts,
        icon: statusIcon(phase.status, now),
        labelText: modelLabel(phase),
        labelStatus: phase.status,
        suffix: phase.plannedVariant ? [fg(theme.faint)(`#${phase.plannedVariant}`)] : undefined,
        right: phaseMetaChunks(phase, now),
      })

    // A group / sub-group header: the aggregate status icon, a label, and an
    // `×N` count, carrying the group's aggregate elapsed/cost. `count` is the
    // number of visible branches — distinct steps under a `parallel:` header,
    // models under a fan-out header — not always the raw member total.
    const emitHeader = (members: PhaseState[], labelText: string, kind: "step" | "parallel", count: number, lasts: boolean[]) => {
      const status = groupStatus(members)
      emitLine({
        rowPhase: members[0]!.name,
        lasts,
        icon: statusIcon(status, now),
        labelText,
        labelStatus: status,
        color: kind === "parallel" ? (text) => fg(theme.teal)(text) : undefined,
        suffix: [fg(theme.faint)(` ×${count}`)],
        right: groupMetaChunks(members, now),
      })
    }

    for (const group of groupPhases(this.phases)) {
      if (group.length === 1) {
        const phase = group[0]!
        emitRow(phase, [], phase.name, phaseMetaChunks(phase, now))
        continue
      }

      const stepGroups = chunkByStepName(group)
      if (stepGroups.length === 1) {
        // A single step fanned out across models: the header names the step,
        // each member names just its model.
        emitHeader(group, stepLabel(group[0]!), "step", group.length, [])
        group.forEach((phase, index) => emitModelRow(phase, [index === group.length - 1]))
        continue
      }

      // A `parallel:` block of distinct steps; the header counts the steps,
      // and any step that is itself fanned out across models nests one level
      // deeper under its own ×N sub-header.
      emitHeader(group, "parallel", "parallel", stepGroups.length, [])
      stepGroups.forEach((members, stepIndex) => {
        const lastStep = stepIndex === stepGroups.length - 1
        if (members.length === 1) {
          emitRow(members[0]!, [lastStep], stepLabel(members[0]!), phaseMetaChunks(members[0]!, now))
          return
        }
        emitHeader(members, stepLabel(members[0]!), "step", members.length, [lastStep])
        members.forEach((phase, index) => emitModelRow(phase, [lastStep, index === members.length - 1]))
      })
    }

    this.pipelineRowPhases = rows
    return joinLines(out)
  }

  // The current-step panel owns everything about the phase in flight: live
  // activity, model, attempt, session usage, and diff. Todos render in their
  // own panel below this one.
  private stepContent(active: PhaseState | undefined, now: number, width: number): StyledText[] {
    if (!active) return [t`${fg(theme.dim)("waiting for the first phase to start…")}`]

    const out: StyledText[] = []
    const title = phaseDisplayName(active)
    const head: TextChunk[] =
      active.status === "running"
        ? [fg(theme.accent)(`${spinnerFrame(now)} `), bold(fg(theme.text)(title))]
        : [statusIcon(active.status, now), raw(" "), bold(fg(theme.text)(title))]
    // Live activity sits to the right of the name; truncation reserves room
    // for the name, the separators, and a possible quiet indicator.
    if (active.now.message) {
      const style = kindStyle(active.now.kind)
      head.push(
        fg(theme.faint)("  ·  "),
        fg(style.color)(`${style.icon} `),
        fg(theme.text)(truncate(active.now.message, Math.max(10, width - title.length - 28))),
      )
    } else {
      head.push(fg(theme.faint)("  ·  "), fg(theme.dim)("waiting for opencode events…"))
    }
    const quiet = now - active.updatedAt
    if (quiet > 10_000 && active.status === "running") {
      head.push(fg(quiet > 60_000 ? theme.yellow : theme.faint)(`  ·  quiet ${Math.floor(quiet / 1000)}s`))
    }
    out.push(new StyledText(head))

    const meta: TextChunk[] = []
    const model = active.lastStepModel || active.model
    if (model) meta.push(fg(theme.faint)("model "), fg(theme.dim)(truncate(model, 30)))
    if (active.attempt > 0) {
      if (meta.length > 0) meta.push(fg(theme.faint)(" · "))
      meta.push(fg(theme.faint)("attempt "), fg(active.attempt > 1 ? theme.yellow : theme.dim)(`${active.attempt}/${active.maxAttempts}`))
    }
    if (active.sessionID) {
      if (meta.length > 0) meta.push(fg(theme.faint)(" · "))
      meta.push(fg(theme.faint)(shortID(active.sessionID)))
    }
    if (meta.length > 0) out.push(new StyledText(meta))

    out.push(
      new StyledText([
        fg(theme.faint)("cost "),
        fg(theme.dim)(active.usageReported ? formatMoney(active.cost) : "—"),
        fg(theme.faint)(" · tokens "),
        fg(theme.dim)(active.usageReported ? `↑${formatCount(active.tokens.input)} ↓${formatCount(active.tokens.output)}` : "—"),
        fg(theme.faint)(" · steps "),
        fg(theme.dim)(String(active.stepCount)),
      ]),
    )

    if (active.diff && active.diff.files > 0) {
      out.push(
        t`${fg(theme.dim)("changes ")}${fg(theme.text)(`${active.diff.files} files`)} ${fg(theme.green)(`+${active.diff.additions}`)} ${fg(theme.red)(`−${active.diff.deletions}`)}`,
      )
    }
    return out
  }

  // The phase panel on the finish screen: outcome, duration, model, session,
  // usage, and diff of the browsed phase (there is no live activity anymore).
  private finishedPhaseContent(phase: PhaseState | undefined, now: number, width: number): StyledText[] {
    if (!phase) return [t`${fg(theme.dim)("no phases to show")}`]
    const out: StyledText[] = []

    const title = phaseDisplayName(phase)
    const head: TextChunk[] = [statusIcon(phase.status, now), raw(" "), bold(fg(theme.text)(title))]
    if (phase.description) {
      head.push(fg(theme.faint)("  ·  "), fg(theme.dim)(truncate(phase.description, Math.max(10, width - title.length - 8))))
    }
    out.push(new StyledText(head))

    const meta: TextChunk[] = []
    const elapsed = phaseElapsed(phase, now)
    if (elapsed !== undefined) meta.push(fg(theme.faint)("took "), fg(theme.dim)(formatElapsed(elapsed)))
    const model = phase.lastStepModel || phase.model
    if (model) {
      if (meta.length > 0) meta.push(fg(theme.faint)(" · "))
      meta.push(fg(theme.faint)("model "), fg(theme.dim)(truncate(model, 30)))
    }
    if (phase.attempt > 1) {
      if (meta.length > 0) meta.push(fg(theme.faint)(" · "))
      meta.push(fg(theme.faint)("attempts "), fg(theme.yellow)(`${phase.attempt}/${phase.maxAttempts}`))
    }
    if (phase.sessionID) {
      if (meta.length > 0) meta.push(fg(theme.faint)(" · "))
      meta.push(fg(theme.faint)(shortID(phase.sessionID)))
    }
    if (meta.length > 0) out.push(new StyledText(meta))

    out.push(
      new StyledText([
        fg(theme.faint)("cost "),
        fg(theme.dim)(phase.usageReported ? formatMoney(phase.cost) : "—"),
        fg(theme.faint)(" · tokens "),
        fg(theme.dim)(phase.usageReported ? `↑${formatCount(phase.tokens.input)} ↓${formatCount(phase.tokens.output)}` : "—"),
        fg(theme.faint)(" · steps "),
        fg(theme.dim)(String(phase.stepCount)),
      ]),
    )

    if (phase.diff && phase.diff.files > 0) {
      out.push(
        t`${fg(theme.dim)("changes ")}${fg(theme.text)(`${phase.diff.files} files`)} ${fg(theme.green)(`+${phase.diff.additions}`)} ${fg(theme.red)(`−${phase.diff.deletions}`)}`,
      )
    }
    if (this.finished?.error && phase.status === "failed") {
      out.push(t`${fg(theme.red)(truncate(this.finished.error, Math.max(20, width)))}`)
    }
    return out
  }

  private reportPanelLines(phase: PhaseState | undefined, width: number, visible: number): StyledText[] {
    const finished = this.finished
    this.reportPosition = ""
    if (!finished || !phase) return [t`${fg(theme.dim)("nothing to show")}`]

    const report = this.reports.get(phase.name)
    if (!report) {
      this.loadReport(phase.name, finished.runDir)
      return [t`${fg(theme.dim)("loading report…")}`]
    }
    if (report === "loading") return [t`${fg(theme.dim)("loading report…")}`]
    if (report === "missing") return [t`${fg(theme.dim)("no report for this phase")}`]

    const wrapped = wrapLines(report, Math.max(20, width))
    const maxScroll = Math.max(0, wrapped.length - visible)
    finished.reportScroll = Math.max(0, Math.min(finished.reportScroll, maxScroll))
    if (maxScroll > 0) {
      this.reportPosition = `${Math.round(((finished.reportScroll + visible) / wrapped.length) * 100)}%`
    }
    return wrapped.slice(finished.reportScroll, finished.reportScroll + visible).map(styleSummaryLine)
  }

  private feedLines(width: number, visible: number): StyledText[] {
    // No room at all (several full-height panes left nothing over): render
    // nothing rather than a placeholder line that would bleed into the
    // feed box's own border.
    if (visible <= 0) return []
    // Array.slice(-0) is slice(0) - the whole array, not empty - already
    // ruled out above, but keep the guard explicit for any future caller.
    const events = this.feed.slice(-visible).reverse()
    if (events.length === 0) return [t`${fg(theme.dim)("no activity yet…")}`]

    return events.map((entry, index) => {
      const style = kindStyle(entry.kind)
      // Newest-first list: blank the phase label when the older neighbour
      // repeats it, so each phase shows once at the start of its group.
      const older = events[index + 1]
      const label = this.feedLabel(entry.phase)
      const phaseLabel = older && older.phase === entry.phase ? raw(" ".repeat(12)) : fg(theme.dim)(label.padEnd(12).slice(0, 12))
      return new StyledText([
        fg(theme.faint)(formatTime(entry.time)),
        raw(" "),
        fg(style.color)(style.icon),
        raw(" "),
        phaseLabel,
        raw(" "),
        fg(entry.kind === "error" ? theme.red : theme.text)(truncate(entry.message, Math.max(20, width - 26))),
      ])
    })
  }

  // Feed rows are cross-phase and only 12 columns wide, so a fanned-out
  // member reads by its model alone (`opus-4-7`) rather than its `step__slug`
  // id; every other phase keeps its own name. "archer" and unknown phases pass
  // through untouched.
  private feedLabel(name: string): string {
    const phase = this.findPhase(name)
    if (phase && phase.stepName && phase.stepName !== phase.name) return modelLabel(phase)
    return name
  }

  private footerContent(now: number, width: number) {
    if (this.finished) {
      const left: TextChunk[] = [
        fg(theme.dim)("["),
        fg(theme.accent)("j/k"),
        fg(theme.dim)("] phases · ["),
        fg(theme.accent)("o"),
        fg(theme.dim)("] session · ["),
        fg(theme.accent)("g"),
        fg(theme.dim)("] lazygit · ["),
        fg(theme.accent)("pgdn"),
        fg(theme.dim)("] scroll · ["),
        fg(theme.accent)("q"),
        fg(theme.dim)("] close"),
      ]
      const right: TextChunk[] = [fg(theme.faint)(this.runID ? `run ${this.runID}` : "run …")]
      return padBetween(left, right, width)
    }

    if (this.permissionQueue.length > 0) {
      const left: TextChunk[] = [
        fg(theme.yellow)("⚿ "),
        fg(theme.dim)("←/→ choose · "),
        fg(theme.accent)("enter"),
        fg(theme.dim)(" confirm · "),
        fg(theme.accent)("o"),
        fg(theme.dim)("nce · "),
        fg(theme.accent)("a"),
        fg(theme.dim)("lways · "),
        fg(theme.accent)("r"),
        fg(theme.dim)("eject · "),
        fg(theme.accent)("esc"),
        fg(theme.dim)(" rejects · "),
        fg(theme.accent)("shift+tab"),
        fg(theme.dim)(" auto-accept"),
      ]
      const right: TextChunk[] = this.permissionQueue.length > 1 ? [fg(theme.yellow)(`${this.permissionQueue.length} pending`)] : []
      return padBetween(left, right, width)
    }

    const left: TextChunk[] = [
      fg(theme.dim)("["),
      fg(theme.accent)("o"),
      fg(theme.dim)("] open session · "),
      fg(theme.yellow)("ctrl+c"),
      fg(theme.dim)(" abort"),
    ]
    if (this.phases.filter((phase) => phase.status === "running").length > 1) {
      left.push(fg(theme.dim)(" · ["), fg(theme.accent)("tab"), fg(theme.dim)("] focus"))
    }
    if (this.autoAccept) {
      left.push(fg(theme.dim)(" · "), fg(theme.accent)("shift+tab"))
      left.push(autoAcceptStatusChunk(this.autoAccept.mode))
    }
    const quiet = now - this.lastActivityAt
    const right: TextChunk[] = [
      fg(theme.faint)(this.runID ? `run ${this.runID}` : "run …"),
      fg(theme.faint)(" · "),
      fg(theme.faint)(this.serverUrl ? `⚡ ${shortUrl(this.serverUrl)}` : "⚡ starting…"),
      fg(theme.faint)(" · "),
      fg(quiet > 60_000 ? theme.yellow : theme.faint)(formatAgo(quiet)),
    ]
    return padBetween(left, right, width)
  }

  private renderPermissionModal() {
    const pending = this.permissionQueue[0]
    this.overlay.visible = Boolean(pending)
    if (!pending) return

    const boxWidth = Math.max(44, Math.min(68, this.renderer.width - 8))
    const width = boxWidth - 6
    const info = pending.info
    const lines: StyledText[] = []

    const headChunks: TextChunk[] = [bold(fg(theme.text)(info.permission))]
    if (this.permissionQueue.length > 1) headChunks.push(fg(theme.faint)(`  ·  ${this.permissionQueue.length - 1} more queued`))
    lines.push(new StyledText(headChunks))
    lines.push(plain(""))
    if (info.command) lines.push(new StyledText([fg(theme.green)("$ "), fg(theme.text)(truncate(info.command, width - 2))]))
    if (info.target) lines.push(new StyledText([fg(theme.dim)("target "), fg(theme.text)(truncate(info.target, width - 7))]))
    if (info.patterns.length > 0) {
      lines.push(new StyledText([fg(theme.dim)("pattern "), fg(theme.text)(truncate(info.patterns.join(", "), width - 8))]))
    }
    if (info.description) lines.push(t`${fg(theme.faint)(truncate(info.description, width))}`)
    if (info.judgeReason) lines.push(new StyledText([fg(theme.yellow)("⚠ "), fg(theme.yellow)(truncate(info.judgeReason, width - 2))]))
    if (info.sessionID) lines.push(t`${fg(theme.faint)(`session ${shortID(info.sessionID)}`)}`)
    lines.push(plain(""))

    const buttons: TextChunk[] = []
    permissionChoices.forEach((choice, index) => {
      if (index > 0) buttons.push(raw("   "))
      const label = ` ${choice.label} `
      buttons.push(index === this.permissionChoice ? bold(bg(theme[choice.color])(fg(theme.chipText)(label))) : fg(theme.dim)(label))
    })
    lines.push(new StyledText(buttons))

    this.modal.width = boxWidth
    this.modal.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }
}

function phaseMetaChunks(phase: PhaseState, now: number): TextChunk[] {
  if (phase.status === "pending") return []
  if (phase.status === "skipped" && phase.restoredDurationMs === undefined) return [fg(theme.faint)("skipped")]
  const parts: TextChunk[] = []
  const elapsed = phaseElapsed(phase, now)
  if (elapsed !== undefined) {
    parts.push(fg(phase.status === "failed" ? theme.red : theme.dim)(formatElapsed(elapsed)))
  }
  // Live cost belongs to the current-step panel; a phase's final cost lands here once it ends.
  if (phase.usageReported && phase.status !== "running") parts.push(fg(theme.faint)(` ${formatMoney(phase.cost)}`))
  return parts
}

function phaseElapsed(phase: PhaseState, now: number): number | undefined {
  return phase.restoredDurationMs ?? (phase.startedAt !== undefined ? (phase.endedAt ?? now) - phase.startedAt : undefined)
}

// Consecutive phases sharing a defined groupId form one concurrent group; a
// human gate (no groupId) or a plain sequential step is a group of one.
function groupPhases(phases: readonly PhaseState[]): PhaseState[][] {
  const groups: PhaseState[][] = []
  for (const phase of phases) {
    const last = groups[groups.length - 1]
    if (phase.groupId && last && last[0]!.groupId === phase.groupId) last.push(phase)
    else groups.push([phase])
  }
  return groups
}

// Splits a group into its distinct logical steps: a pure `models:` fan-out is
// one step (every member shares a stepName), a `parallel:` block is several.
function chunkByStepName(group: readonly PhaseState[]): PhaseState[][] {
  const chunks: PhaseState[][] = []
  for (const phase of group) {
    const last = chunks[chunks.length - 1]
    if (last && stepLabel(last[0]!) === stepLabel(phase)) last.push(phase)
    else chunks.push([phase])
  }
  return chunks
}

// Column count of a chunk list. The pipeline tree uses only single-cell
// glyphs (icons, box-drawing, ASCII), so a codepoint count is the cell width.
function plainLen(chunks: readonly TextChunk[]): number {
  let count = 0
  for (const chunk of chunks) for (const _ of chunk.text) count++
  return count
}

// Box-drawing prefix for a tree row: one entry per ancestor level, true when
// that ancestor was its parent's last child (so its vertical line stops).
function treePrefix(lasts: readonly boolean[]): string {
  if (lasts.length === 0) return ""
  let prefix = ""
  for (let i = 0; i < lasts.length - 1; i++) prefix += lasts[i] ? "  " : "│ "
  return `${prefix}${lasts[lasts.length - 1] ? "└ " : "├ "}`
}

// A concurrent group's aggregate status: running while any member is (or has
// started but none have), then failed/skipped/completed once all have ended.
function groupStatus(members: readonly PhaseState[]): PhaseStatus {
  const allEnded = members.every((m) => m.status === "completed" || m.status === "skipped" || m.status === "failed")
  if (!allEnded) return members.some((m) => m.status === "running" || m.startedAt !== undefined) ? "running" : "pending"
  if (members.some((m) => m.status === "failed")) return "failed"
  if (members.every((m) => m.status === "skipped")) return "skipped"
  return "completed"
}

// Aggregate meta for a group header: wall-clock is the longest member (they
// run concurrently), cost is their sum.
function groupMetaChunks(members: readonly PhaseState[], now: number): TextChunk[] {
  const status = groupStatus(members)
  if (status === "pending") return []
  const parts: TextChunk[] = []
  const elapsed = members.map((m) => phaseElapsed(m, now)).filter((value): value is number => value !== undefined)
  if (elapsed.length > 0) parts.push(fg(status === "failed" ? theme.red : theme.dim)(formatElapsed(Math.max(...elapsed))))
  if (members.some((m) => m.usageReported) && status !== "running") {
    parts.push(fg(theme.faint)(` ${formatMoney(members.reduce((sum, m) => sum + m.cost, 0))}`))
  }
  return parts
}

// The status-driven colouring a pipeline name (or model label) takes: bold
// while running or selected, dimmed while pending, faint once skipped.
function phaseNameChunk(text: string, status: PhaseStatus, selected: boolean): TextChunk {
  if (selected || status === "running") return bold(fg(theme.text)(text))
  if (status === "pending") return fg(theme.dim)(text)
  if (status === "skipped") return fg(theme.faint)(text)
  return fg(theme.text)(text)
}

// The logical (pre-fan-out) name of a phase; equals its own name for a plain
// sequential step or a human gate.
function stepLabel(phase: PhaseState): string {
  return phase.stepName ?? phase.name
}

// A compact model label for a fanned-out member: provider prefix dropped, and
// the redundant `claude-` vendor token trimmed, so `security__…opus-4-7`
// reads as just `opus-4-7`. Falls back to the live/planned model once known.
function modelLabel(phase: PhaseState): string {
  const full = phase.lastStepModel || phase.model || phase.plannedModel || ""
  if (!full) return stepLabel(phase)
  const id = full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : full
  return id.replace(/^claude-/, "")
}

// A phase's name for use outside the pipeline tree (pane titles, the feed):
// a fanned-out member reads as `step · model` instead of its `step__slug` id.
function phaseDisplayName(phase: PhaseState): string {
  if (phase.stepName && phase.stepName !== phase.name) return `${phase.stepName} · ${modelLabel(phase)}`
  return phase.name
}

// One row per todo, windowed around the first unfinished item when the list
// outgrows the panel; the edges collapse into "↑ n completed" / "↓ n more".
function todoLines(todos: ProgressTodo[], cap: number, width: number): StyledText[] {
  if (todos.length <= cap) return todos.map((todo) => todoRow(todo, width))
  const firstOpen = todos.findIndex((todo) => todo.status !== "completed")
  const anchor = firstOpen === -1 ? todos.length : firstOpen
  const start = Math.min(anchor, todos.length - (cap - 1))
  const head = start > 0 ? 1 : 0
  let end = start + cap - head
  if (end < todos.length) end -= 1
  const out: StyledText[] = []
  if (head > 0) out.push(t`  ${fg(theme.faint)(`↑ ${start} completed`)}`)
  for (const todo of todos.slice(start, end)) out.push(todoRow(todo, width))
  if (end < todos.length) out.push(t`  ${fg(theme.faint)(`↓ ${todos.length - end} more`)}`)
  return out
}

function todoRow(todo: ProgressTodo, width: number): StyledText {
  const text = truncate(todo.content, Math.max(10, width - 4))
  switch (todo.status) {
    case "completed":
      return new StyledText([fg(theme.green)("  ✓ "), fg(theme.dim)(text)])
    case "in_progress":
      return new StyledText([fg(theme.accent)("  ● "), bold(fg(theme.text)(text))])
    case "cancelled":
      return new StyledText([fg(theme.faint)("  ⊘ "), fg(theme.faint)(text)])
    default:
      return new StyledText([fg(theme.dim)("  ○ "), fg(theme.text)(text)])
  }
}

/**
 * How many concurrently-running phases get their own pane, and how much
 * content-line budget each one gets, for a given body height. Pure and
 * exported so the height math that caused real overflow/corruption bugs
 * during development can be unit tested without spinning up OpenTUI.
 */
export function paneLayout(runningCount: number, bodyHeight: number, cap: number): { visibleCount: number; overflow: number; perPaneBudget: number } {
  // A pane needs at least 3 content lines plus its border (5 rows) to be
  // worth showing; a terminal too short for `cap` panes at that floor folds
  // the rest into overflow instead of overflowing the terminal itself.
  const minPaneHeight = 5
  const fitCount = Math.max(1, Math.floor(bodyHeight / minPaneHeight))
  const visibleCount = Math.max(1, Math.min(cap, fitCount, runningCount))
  const overflow = Math.max(0, runningCount - visibleCount)
  // An equal share of the body per pane (minus its own border); callers trim
  // content to this budget rather than letting it overflow the terminal.
  const perPaneBudget = Math.max(3, Math.floor(bodyHeight / visibleCount) - 2)
  return { visibleCount, overflow, perPaneBudget }
}

function runningFraction(phase: PhaseState) {
  if (phase.todos.length === 0) return 0.1
  const completed = phase.todos.filter((todo) => todo.status === "completed").length
  return Math.min(0.95, Math.max(0.1, completed / phase.todos.length))
}

function permissionSummary(info: PermissionPromptInfo) {
  const detail = info.command || info.target || info.patterns.join(", ")
  return detail ? `${info.permission} · ${truncate(detail, 120)}` : info.permission
}

function totalUsage(phases: PhaseState[]) {
  return phases.reduce(
    (usage, phase) => ({ cost: usage.cost + phase.cost, tokens: addTokens(usage.tokens, phase.tokens) }),
    { cost: 0, tokens: emptyTokens() },
  )
}
