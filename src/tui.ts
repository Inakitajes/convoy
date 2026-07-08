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
import { openOpencodeSessionWindow, openStoredSessionWindow } from "./opencode"
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
  HumanReviewAction,
  HumanReviewPromptInfo,
  ProgressMessage,
  ProgressMessageChannel,
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

// The right-hand content panel is a three-tab view of the focused phase.
type ContentTab = "logs" | "reports" | "session"
const contentTabOrder: readonly ContentTab[] = ["session", "reports", "logs"]

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

// One contiguous span of a phase's live transcript. Reasoning/response blocks
// grow as their verbatim deltas arrive; tool/bash blocks are single markers.
type TranscriptBlock = { channel: ProgressMessageChannel; text: string }

// Keep only the newest slice of a phase's stream in memory: reasoning can run
// to tens of thousands of characters, and the session tab only ever tails it.
const transcriptCap = 24_000

type PendingPermission = {
  info: PermissionPromptInfo
  resolve: (reply: PermissionReply) => void
}

type PendingHumanReview = {
  info: HumanReviewPromptInfo
  resolve: (action: HumanReviewAction) => void
}

// The post-run screen keeps the very same dashboard: the pipeline is still the
// phase selector and the content panel still carries its logs/reports/session
// tabs. Only the run is over, so it becomes frozen-in-time browsing.
type FinishState = RunOutcome & {
  at: number
  resolve: () => void
}

export async function createTuiProgress(
  phases: readonly ProgressPhase[],
  onAbort?: () => void,
  autoAccept?: AutoAccept,
  // Re-opened finished runs have no live server, so [o] opens their stored
  // sessions from disk instead of attaching. Live runs/attaches leave this off.
  options?: { offlineSessions?: boolean },
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
  return new TuiProgress(renderer, phases, onAbort, autoAccept, options?.offlineSessions ?? false)
}

export class TuiProgress implements ProgressUI {
  private runID = ""
  private targetDir = ""
  private serverUrl = ""
  // The phase whose work is most recent, kept updated by every progress
  // callback; the focused tab auto-follows it until the user takes over.
  private activePhase = ""
  // The focused phase — an index into `phases`, driven by the pipeline tab
  // selector (↑/↓, j/k, click). It auto-follows `activePhase` until the user
  // navigates, then `manualFocus` pins it so any step (past, present, or
  // still-scheduled) stays open for inspection.
  private selected = 0
  private manualFocus = false
  // Run workspace dir, where phase reports land; set at start so the reports
  // tab reads them live, and refreshed from the outcome on the finish screen.
  private runDir = ""
  private lastActivityAt = Date.now()
  private readonly startedAt = Date.now()
  private readonly phases: PhaseState[]
  private readonly feed: FeedEntry[] = []
  // The live model transcript per phase (the session tab): verbatim reasoning
  // and response text, interleaved with tool/bash action markers. Streamed in
  // via phaseMessage and repainted on the ticker, not per delta.
  private readonly transcripts = new Map<string, TranscriptBlock[]>()
  private readonly ticker: ReturnType<typeof setInterval>
  private readonly dirText: TextRenderable
  private readonly headerText: TextRenderable
  private readonly pipelineBox: BoxRenderable
  private readonly pipelineText: TextRenderable
  // The detail panel: header (name, status, model, cost, tokens, diff) of the
  // one focused phase. A single pane now — concurrent phases are browsed via
  // the pipeline tab selector rather than each getting their own live pane.
  private readonly stepBox: BoxRenderable
  private readonly stepText: TextRenderable
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
  private humanReview?: PendingHumanReview
  private permissionChoice = 0
  // Suspension nests: outer scopes (human-review gate) and inner prompts may
  // both suspend; only the outermost transition touches the renderer.
  private suspendDepth = 0
  private finished?: FinishState
  // A subshell (lazygit / git log) owns the terminal while the renderer is
  // suspended; every key must reach it untouched.
  private inSubshell = false
  // Phase reports read lazily from the run dir; the cache entry is dropped when
  // a phase finishes so a report written mid-run is picked up on the next view.
  private readonly reports = new Map<string, string[] | "loading" | "missing">()
  // Visible rows of the content tab, captured at render time for paging keys.
  private contentPageRows = 10
  // The content panel has an explicit read focus: normally ↑/↓ move the
  // pipeline selector; after Enter they scroll the active tab until Escape.
  private contentFocused = false
  // Scroll offsets + indicator for the content tabs, shared across live/finished.
  // sessionScroll is measured from the bottom so live transcripts keep tailing.
  private reportScroll = 0
  private logScroll = 0
  private sessionScroll = 0
  private contentPosition = ""
  // The content panel's active tab, scoped to the focused phase: its activity
  // feed, the report it wrote (if any), or a read-only "follow along" view of
  // its opencode session. [o] still opens the interactive session externally.
  private contentTab: ContentTab = "logs"
  // Click hit-regions for the tab strip, rebuilt every render: column span → tab.
  private feedTabRegions: { tab: ContentTab; start: number; end: number }[] = []
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
    // Checked before the permission modal so the toggle also resolves an open
    // prompt (enabling auto-accept flushes the whole queue). Harmless on the
    // finish screen, where nothing is queued.
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
    if (this.humanReview && this.handleHumanReviewKey(key)) return
    // Everything else is navigation, shared by the live dashboard and the
    // finish screen: move the focused phase, switch the content tab, focus or
    // scroll the reading panel, or open the external session.
    this.handleNavKey(key)
  }

  // Unified navigation for both the live run and the finish screen. Vertical
  // keys move the focused phase through the pipeline (the tab selector);
  // Enter focuses the content panel; horizontal keys / Tab / digits switch the
  // content tab; page keys scroll; [o] opens the external session.
  private handleNavKey(key: KeyEvent) {
    const finished = this.finished
    const consume = () => {
      key.preventDefault()
      key.stopPropagation()
    }
    if (this.contentFocused && this.handleContentFocusedKey(key, consume)) return
    switch (key.name) {
      case "up":
      case "k":
        consume()
        this.moveSelection(-1)
        return
      case "down":
      case "j":
        consume()
        this.moveSelection(1)
        return
      case "left":
      case "h":
        consume()
        this.cycleContentTab(-1)
        return
      case "right":
      case "l":
      case "tab":
        consume()
        this.cycleContentTab(1)
        return
      case "return":
      case "linefeed":
        consume()
        this.contentFocused = true
        this.render()
        return
      case "pagedown":
      case "space":
        consume()
        this.scrollContent(this.contentPageRows)
        return
      case "pageup":
        consume()
        this.scrollContent(-this.contentPageRows)
        return
      case "o":
        consume()
        this.openActiveSessionWindow("key")
        return
    }
    // Digit keys jump straight to a content tab (1 session · 2 reports · 3 logs).
    const digitTab: Record<string, ContentTab> = { "1": "session", "2": "reports", "3": "logs" }
    const jump = digitTab[key.name] ?? digitTab[key.raw ?? ""]
    if (jump) {
      consume()
      this.setContentTab(jump)
      return
    }
    if (finished) {
      if (key.name === "g") {
        consume()
        void this.openGitSubshell()
      } else if (key.name === "q" || key.name === "escape") {
        consume()
        finished.resolve()
      }
      return
    }
    // On a live run, Escape hands focus back to auto-follow so the view tracks
    // the active phase again.
    if (key.name === "escape") {
      consume()
      this.manualFocus = false
      this.render()
    }
  }

  private handleContentFocusedKey(key: KeyEvent, consume: () => void) {
    switch (key.name) {
      case "up":
      case "k":
        consume()
        this.scrollContent(-1)
        return true
      case "down":
      case "j":
        consume()
        this.scrollContent(1)
        return true
      case "pageup":
        consume()
        this.scrollContent(-this.contentPageRows)
        return true
      case "pagedown":
      case "space":
        consume()
        this.scrollContent(this.contentPageRows)
        return true
      case "home":
        consume()
        this.scrollContentToStart()
        return true
      case "end":
        consume()
        this.scrollContentToEnd()
        return true
      case "g":
        consume()
        if (key.shift) this.scrollContentToEnd()
        else this.scrollContentToStart()
        return true
      case "escape":
        consume()
        this.contentFocused = false
        this.render()
        return true
      case "return":
      case "linefeed":
        consume()
        return true
    }
    return false
  }

  constructor(
    private readonly renderer: CliRenderer,
    phases: readonly ProgressPhase[],
    private readonly onAbort?: () => void,
    private readonly autoAccept?: AutoAccept,
    // When true (a re-opened finished run), [o] opens the phase's stored
    // session from disk rather than attaching to a (nonexistent) live server.
    private readonly offlineSessions = false,
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

    // A click on any pipeline row focuses that phase (the tab selector); it no
    // longer opens the opencode session — [o] / a detail-panel click do that.
    const focusFromPipeline = (event: { y: number; preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      const name = this.pipelineRowPhases[event.y - this.pipelineText.y]
      if (name) this.selectPhaseByName(name)
    }

    const pipeline = this.panel({
      id: "archer-pipeline",
      width: pipelineWidth,
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " pipeline ",
      titleAlignment: "left",
      onMouseDown: focusFromPipeline,
    })
    pipeline.text.onMouseDown = focusFromPipeline

    const right = new BoxRenderable(renderer, {
      id: "archer-right",
      height: "100%",
      flexGrow: 1,
      flexDirection: "column",
      gap: 0,
    })

    // The detail panel shows the focused phase; a click on it opens that
    // phase's opencode session externally (same as [o]).
    const openFocusedSession = (event: { preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      this.openActiveSessionWindow("click")
    }

    const step = this.panel({
      id: "archer-step",
      width: "100%",
      height: 8,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " step ",
      titleAlignment: "left",
      onMouseDown: openFocusedSession,
    })
    step.text.onMouseDown = openFocusedSession

    // Todos live in their own panel below the detail meta, showing the focused
    // phase's list whenever it has one.
    const todos = this.panel({
      id: "archer-todos",
      width: "100%",
      height: 3,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " todos ",
      titleAlignment: "left",
      visible: false,
      onMouseDown: openFocusedSession,
    })
    todos.text.onMouseDown = openFocusedSession

    // A click on the tab strip (content rows 0-1: labels or rail) selects
    // that tab; clicks anywhere else in the panel fall through untouched.
    // Works live and on the finish screen alike.
    const switchTabFromFeed = (event: { x: number; y: number; preventDefault(): void; stopPropagation(): void }) => {
      const row = event.y - this.feedText.y
      if (row !== 0 && row !== 1) return
      const col = event.x - this.feedText.x
      const hit = this.feedTabRegions.find((region) => col >= region.start && col < region.end)
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      this.setContentTab(hit.tab)
    }

    const feed = this.panel({
      id: "archer-feed",
      width: "100%",
      flexGrow: 1,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      onMouseDown: switchTabFromFeed,
    })
    feed.text.onMouseDown = switchTabFromFeed

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
    this.pipelineBox = pipeline.box
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

  start(runID: string, targetDir: string, runDir = "") {
    this.runID = runID
    this.targetDir = targetDir
    this.runDir = runDir
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

  // Appends a raw slice of the model's stream to the phase's transcript.
  // Deliberately does NOT render: text deltas arrive many-per-second, so the
  // 250ms ticker repaints the session tab instead of paying a layout pass per
  // delta. Bumping updatedAt keeps the "idle" detector honest between the
  // (throttled) activity summaries.
  phaseMessage(name: string, message: ProgressMessage) {
    const phase = this.findPhase(name)
    if (!phase) return
    let blocks = this.transcripts.get(name)
    if (!blocks) {
      blocks = []
      this.transcripts.set(name, blocks)
    }
    const streaming = message.channel === "reasoning" || message.channel === "response"
    const last = blocks[blocks.length - 1]
    // Consecutive deltas of the same channel are one paragraph; anything else
    // (a channel switch, or a tool/bash marker) starts a fresh block.
    if (streaming && last && last.channel === message.channel) last.text += message.text
    else blocks.push({ channel: message.channel, text: message.text })
    capTranscript(blocks)
    phase.updatedAt = Date.now()
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
    // Drop any cached "missing" so the report this phase just wrote loads.
    this.reports.delete(name)
    this.addEvent(name, "system", detail || "phase completed")
  }

  phaseSkipped(name: string) {
    this.setPhase(name, "skipped")
    this.addEvent(name, "system", "skipped by flag")
  }

  phaseFailed(name: string, detail = "") {
    this.setPhase(name, "failed")
    this.reports.delete(name)
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

  askHumanReview(info: HumanReviewPromptInfo): Promise<HumanReviewAction> {
    if (this.renderer.isDestroyed) return Promise.resolve("abort")
    return new Promise((resolve) => {
      this.humanReview = { info, resolve }
      this.selectPhaseByName(info.stepName)
      this.manualFocus = false
      this.addEvent(info.stepName, "permission", "waiting for human review action")
      this.render()
    })
  }

  // Resolves when the user dismisses the screen (q/esc/ctrl+c). Until then the
  // run stays alive upstream: the opencode server keeps serving [o] and the
  // run dir keeps the reports readable.
  runFinished(outcome: RunOutcome): Promise<void> {
    if (this.renderer.isDestroyed) return Promise.resolve()
    return new Promise((resolve) => {
      this.finished = { ...outcome, at: Date.now(), resolve }
      if (outcome.runDir) this.runDir = outcome.runDir
      // Jump the browser to the first failed phase (if any) so the failure is
      // front and centre; otherwise keep whatever the user was looking at.
      const failed = this.phases.findIndex((phase) => phase.status === "failed")
      if (failed >= 0) {
        this.selected = failed
        this.manualFocus = true
      }
      this.resetContentScroll()
      for (const pending of this.permissionQueue.splice(0)) pending.resolve("reject")
      this.addEvent(
        "archer",
        outcome.status === "completed" ? "system" : "error",
        outcome.status === "completed" ? "run completed" : `run failed: ${outcome.error ?? "unknown error"}`,
      )
      this.render()
    })
  }

  // The focused phase, clamped to a valid index (the pipeline can be empty
  // only in degenerate cases). Shared by rendering and [o].
  private focusedPhase(): PhaseState | undefined {
    if (this.phases.length === 0) return undefined
    this.selected = Math.max(0, Math.min(this.phases.length - 1, this.selected))
    return this.phases[this.selected]
  }

  // Moves the focused phase through the pipeline (the tab selector). The first
  // move pins focus (manualFocus) so it no longer auto-follows live activity.
  private moveSelection(delta: number) {
    if (this.phases.length === 0) return
    this.manualFocus = true
    this.selected = Math.max(0, Math.min(this.phases.length - 1, this.selected + delta))
    this.resetContentScroll()
    this.render()
  }

  private selectPhaseByName(name: string) {
    const index = this.phases.findIndex((phase) => phase.name === name)
    if (index === -1) return
    this.manualFocus = true
    this.selected = index
    this.resetContentScroll()
    this.render()
  }

  private cycleContentTab(delta: number) {
    const index = contentTabOrder.indexOf(this.contentTab)
    this.setContentTab(contentTabOrder[(index + delta + contentTabOrder.length) % contentTabOrder.length]!)
  }

  private setContentTab(tab: ContentTab) {
    if (this.contentTab !== tab) {
      this.contentTab = tab
      this.resetContentScroll()
    }
    this.render()
  }

  private resetContentScroll() {
    this.reportScroll = 0
    this.logScroll = 0
    this.sessionScroll = 0
  }

  private scrollContent(delta: number) {
    switch (this.contentTab) {
      case "reports":
        this.reportScroll = Math.max(0, this.reportScroll + delta)
        break
      case "logs":
        this.logScroll = Math.max(0, this.logScroll + delta)
        break
      case "session":
        this.sessionScroll = Math.max(0, this.sessionScroll - delta)
        break
    }
    this.render()
  }

  private scrollContentToStart() {
    if (this.contentTab === "session") this.sessionScroll = Number.MAX_SAFE_INTEGER
    else if (this.contentTab === "reports") this.reportScroll = 0
    else this.logScroll = 0
    this.render()
  }

  private scrollContentToEnd() {
    if (this.contentTab === "session") this.sessionScroll = 0
    else if (this.contentTab === "reports") this.reportScroll = Number.MAX_SAFE_INTEGER
    else this.logScroll = Number.MAX_SAFE_INTEGER
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
    this.humanReview?.resolve("abort")
    this.humanReview = undefined
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

  private handleHumanReviewKey(key: KeyEvent) {
    const action = humanReviewActionForKey(key)
    if (!action) return false
    key.preventDefault()
    key.stopPropagation()
    this.resolveHumanReview(action)
    return true
  }

  private resolveHumanReview(action: HumanReviewAction) {
    const pending = this.humanReview
    if (!pending) return
    this.humanReview = undefined
    this.addEvent(pending.info.stepName, action === "prepare" ? "step" : action === "abort" ? "error" : "permission", humanReviewActionLabel(action))
    pending.resolve(action)
    this.render()
  }

  // Opens the focused phase's opencode session in an external window; falls
  // back to any running phase if focus somehow lands on one without a session.
  private openActiveSessionWindow(source: "click" | "key") {
    const active = this.focusedPhase() ?? this.phases.find((phase) => phase.status === "running")
    if (!active) {
      this.addEvent("archer", "system", "no active opencode session to open yet")
      this.render()
      return
    }
    this.openSessionWindowForPhase(active.name, source)
  }

  private openSessionWindowForPhase(name: string, source: "click" | "key") {
    const phase = this.findPhase(name)
    if (!phase) return
    if (!phase.sessionID) {
      this.addEvent("archer", "system", `no opencode session for ${name} yet`)
      this.render()
      return
    }
    // A live server (this run, or a live attach) → attach to it; a re-opened
    // finished run → open the stored session standalone from disk.
    const targetDir = this.targetDir || process.cwd()
    const open = this.serverUrl
      ? openOpencodeSessionWindow({ url: this.serverUrl, targetDir, sessionID: phase.sessionID })
      : this.offlineSessions
        ? openStoredSessionWindow({ targetDir, sessionID: phase.sessionID })
        : undefined
    if (!open) {
      this.addEvent("archer", "system", "opencode server is not ready yet")
      this.render()
      return
    }

    this.addEvent("archer", "system", `${source === "key" ? "[o]" : "click"}: opening ${name} session ${shortID(phase.sessionID)}`)
    open
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
    // detail and todos panels grow with their content but never starve the
    // content panel below them.
    const bodyHeight = Math.max(8, this.renderer.height - 7)

    // Auto-follow the active phase until the user takes over navigation; after
    // that the selection stays put so any step (past, present, scheduled) can
    // be inspected without the live run yanking focus away.
    if (!this.finished && !this.manualFocus) {
      const activeIndex = this.phases.findIndex((phase) => phase.name === this.activePhase)
      if (activeIndex >= 0) this.selected = activeIndex
    }
    const focus = this.focusedPhase()
    this.pipelineBox.borderColor = this.contentFocused ? theme.borderDim : theme.accent
    this.feedBox.borderColor = this.contentFocused ? theme.accent : theme.borderDim

    // Detail panel: the focused phase's header — name, status, model, cost,
    // tokens, diff — the same shape whether it's running, finished, or still
    // scheduled (a future step reads as scheduled with zeroed usage).
    const detailLines = this.detailContent(focus, now, rightWidth)
    this.stepBox.title = " step "
    this.stepBox.height = detailLines.length + 2
    this.stepText.content = joinLines(detailLines)

    // Todos panel: the focused phase's list, whenever it has one.
    const todoBudget = Math.max(3, Math.floor(bodyHeight * 0.5) - detailLines.length - 4)
    const todoRows = focus && focus.todos.length > 0 ? todoLines(focus.todos, todoBudget, rightWidth) : []
    this.todosBox.visible = todoRows.length > 0
    if (focus && todoRows.length > 0) {
      const completed = focus.todos.filter((todo) => todo.status === "completed").length
      this.todosBox.height = todoRows.length + 2
      this.todosBox.title = ` todos ${completed}/${focus.todos.length} `
      this.todosText.content = joinLines(todoRows)
    }
    const usedHeight = detailLines.length + 2 + (this.todosBox.visible ? todoRows.length + 2 : 0)

    // The content panel fills the rest: a two-row tab strip (labels, then a
    // rail) over the active tab's body, all scoped to the focused phase.
    const feedRows = Math.max(3, bodyHeight - usedHeight - 2)
    const contentRows = feedRows - 2
    this.contentPageRows = contentRows

    this.dirText.content = this.dirContent(innerWidth)
    this.headerText.content = this.headerContent(now, innerWidth)
    this.pipelineText.content = this.pipelineContent(now)

    // Body first: the active content tab computes the scroll indicator the rail shows.
    const body =
      this.contentTab === "reports"
        ? this.reportPanelLines(focus, rightWidth, contentRows)
        : this.contentTab === "session"
          ? this.sessionLines(focus, rightWidth, contentRows)
          : this.phaseFeedLines(focus, rightWidth, contentRows)
    this.feedText.content = joinLines([...this.contentTabBar(rightWidth), ...body])

    this.footerText.content = this.footerContent(now, innerWidth)
    this.renderPermissionModal()
    this.renderer.requestRender()
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
    // The pipeline is the tab selector, live and finished alike: the focused
    // phase carries a ▸ marker at column 0 (before the tree prefix, so it stays
    // aligned across every depth).
    const isSelected = (phase: PhaseState) => this.phases[this.selected] === phase

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
      left.push(selected ? fg(theme.accent)("▸ ") : raw("  "))
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
    // models under a fan-out header — not always the raw member total. When
    // the focused phase is one of this header's members (directly or via a
    // nested sub-header), the label picks up the same accent as the focused
    // leaf so the whole ancestor chain reads as one highlighted path down the
    // tree, instead of only the leaf itself carrying any indication.
    const emitHeader = (members: PhaseState[], labelText: string, kind: "step" | "parallel", count: number, lasts: boolean[]) => {
      const status = groupStatus(members)
      const onPath = members.some(isSelected)
      emitLine({
        rowPhase: members[0]!.name,
        lasts,
        icon: statusIcon(status, now),
        labelText,
        labelStatus: status,
        color: onPath ? (text) => bold(fg(theme.accent)(text)) : kind === "parallel" ? (text) => fg(theme.teal)(text) : undefined,
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

  // The detail panel header for the focused phase — one shape for every state.
  // Running: spinner, live activity, elapsed. Finished: outcome, duration, final
  // usage, diff. Scheduled (a future step): the planned model, zeroed usage.
  private detailContent(phase: PhaseState | undefined, now: number, width: number): StyledText[] {
    if (!phase) return [t`${fg(theme.dim)("waiting for the first phase to start…")}`]

    const out: StyledText[] = []
    const running = phase.status === "running"
    const title = phaseDisplayName(phase)
    const head: TextChunk[] = running
      ? [fg(theme.accent)(`${spinnerFrame(now)} `), bold(fg(theme.text)(title))]
      : [statusIcon(phase.status, now), raw(" "), bold(fg(theme.text)(title))]
    // A one-glance status word right after the name — "ongoing or not".
    head.push(fg(theme.faint)("  ·  "), statusWordChunk(phase, now))
    out.push(new StyledText(head))

    // Second line: live activity while running, else the step's description.
    if (running) {
      if (phase.now.message) {
        const style = kindStyle(phase.now.kind)
        out.push(new StyledText([fg(style.color)(`${style.icon} `), fg(theme.text)(truncate(phase.now.message, Math.max(10, width - 4)))]))
      } else {
        out.push(t`${fg(theme.dim)("waiting for opencode events…")}`)
      }
    } else if (phase.description) {
      out.push(t`${fg(theme.dim)(truncate(phase.description, Math.max(10, width - 2)))}`)
    }

    const meta: TextChunk[] = []
    const elapsed = phaseElapsed(phase, now)
    if (elapsed !== undefined) meta.push(fg(theme.faint)(running ? "elapsed " : "took "), fg(theme.dim)(formatElapsed(elapsed)))
    // Falls back to the planned model so a scheduled step still shows what it
    // will run on.
    const model = phase.lastStepModel || phase.model || phase.plannedModel
    if (model) {
      if (meta.length > 0) meta.push(fg(theme.faint)(" · "))
      meta.push(fg(theme.faint)("model "), fg(theme.dim)(truncate(model, 30)))
    }
    if (phase.attempt > 0) {
      if (meta.length > 0) meta.push(fg(theme.faint)(" · "))
      meta.push(fg(theme.faint)("attempt "), fg(phase.attempt > 1 ? theme.yellow : theme.dim)(`${phase.attempt}/${phase.maxAttempts}`))
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
    if (this.humanReview?.info.stepName === phase.name) {
      out.push(plain(""))
      out.push(new StyledText([fg(theme.yellow)("human review"), fg(theme.faint)(" · choose from the dashboard shortcuts")]))
      out.push(new StyledText([fg(theme.accent)("c"), fg(theme.dim)(" continue pipeline   "), fg(theme.accent)("s"), fg(theme.dim)(" start app   "), fg(theme.accent)("r"), fg(theme.dim)(" rerun app")]))
      out.push(new StyledText([fg(theme.accent)("i"), fg(theme.dim)(" open OpenCode iteration   "), fg(theme.accent)("a"), fg(theme.dim)(" abort")]))
      const info = this.humanReview.info
      const app = info.appCommand ? (info.appRunning ? "running" : "configured") : "disabled"
      out.push(new StyledText([fg(theme.faint)("app "), fg(theme.dim)(app), fg(theme.faint)(" · iterations "), fg(theme.dim)(String(info.iterations))]))
    }
    return out
  }

  // The reports tab: the markdown report the focused phase wrote, scrollable.
  // Works live (the run dir is known from start) and on the finish screen; a
  // step that hasn't finished yet — or wrote nothing — says so.
  private reportPanelLines(phase: PhaseState | undefined, width: number, visible: number): StyledText[] {
    this.contentPosition = ""
    if (visible <= 0) return []
    if (!phase) return [t`${fg(theme.dim)("no step selected")}`]
    if (!this.runDir) return [t`${fg(theme.dim)("report directory not ready yet…")}`]

    const report = this.reports.get(phase.name)
    if (!report) {
      this.loadReport(phase.name, this.runDir)
      return [t`${fg(theme.dim)("loading report…")}`]
    }
    if (report === "loading") return [t`${fg(theme.dim)("loading report…")}`]
    if (report === "missing") {
      const done = phase.status === "completed" || phase.status === "failed"
      return [t`${fg(theme.dim)(done ? "this step wrote no report" : "no report yet — it appears once the step finishes")}`]
    }

    const wrapped = wrapLines(report, Math.max(20, width))
    const maxScroll = Math.max(0, wrapped.length - visible)
    this.reportScroll = Math.max(0, Math.min(this.reportScroll, maxScroll))
    this.contentPosition = scrollPosition(this.reportScroll, maxScroll)
    return wrapped.slice(this.reportScroll, this.reportScroll + visible).map(styleSummaryLine)
  }

  // The logs tab: the focused phase's activity, newest first. Scoped to one
  // phase (the tab selector picks it), so there's no cross-phase label column —
  // just time, kind icon, and message, leaving more room for the message.
  private phaseFeedLines(phase: PhaseState | undefined, width: number, visible: number): StyledText[] {
    this.contentPosition = ""
    if (visible <= 0) return []
    if (!phase) return [t`${fg(theme.dim)("no step selected")}`]
    const events = this.feed.filter((entry) => entry.phase === phase.name).reverse()
    if (events.length === 0) return [t`${fg(theme.dim)("no activity for this step yet…")}`]

    const maxScroll = Math.max(0, events.length - visible)
    this.logScroll = Math.max(0, Math.min(this.logScroll, maxScroll))
    this.contentPosition = scrollPosition(this.logScroll, maxScroll)

    return events.slice(this.logScroll, this.logScroll + visible).map((entry) => {
      const style = kindStyle(entry.kind)
      return new StyledText([
        fg(theme.faint)(formatTime(entry.time)),
        raw(" "),
        fg(style.color)(style.icon),
        raw(" "),
        fg(entry.kind === "error" ? theme.red : theme.text)(truncate(entry.message, Math.max(20, width - 12))),
      ])
    })
  }

  // The tab strip that owns rows 0-1 of the content panel: a label row
  // (faint digit hint + name, bold accent when active) and a rail row below
  // it where a thick accent segment sits under the active label — like a
  // browser tab underline — with faint dashes elsewhere. Pure character
  // styling, no painted chip. Records each label's column span (shared by
  // both rows) so a click on either row resolves to the right tab. The
  // active tab's scroll position rides in faint text at the rail's tail.
  private contentTabBar(width: number): StyledText[] {
    this.feedTabRegions = []
    const labelChunks: TextChunk[] = []
    let col = 0
    contentTabOrder.forEach((tab, index) => {
      if (index > 0) {
        labelChunks.push(fg(theme.faint)("  "))
        col += 2
      }
      const start = col
      const digit = `${index + 1}`
      const active = this.contentTab === tab
      labelChunks.push(fg(theme.faint)(` ${digit} `))
      labelChunks.push(active ? bold(fg(theme.accent)(tab)) : fg(theme.dim)(tab))
      labelChunks.push(fg(theme.faint)(" "))
      col += digit.length + tab.length + 3
      this.feedTabRegions.push({ tab, start, end: col })
    })
    if (col < width) labelChunks.push(fg(theme.faint)(" ".repeat(width - col)))

    const active = this.feedTabRegions.find((region) => region.tab === this.contentTab) ?? { start: 0, end: 0 }
    const railChunks: TextChunk[] = []
    const pushRail = (text: string, color: string) => {
      if (text.length > 0) railChunks.push(fg(color)(text))
    }
    const activeStart = Math.min(active.start, width)
    const activeEnd = Math.min(Math.max(active.end, activeStart), width)
    pushRail("╌".repeat(activeStart), theme.faint)
    pushRail("━".repeat(activeEnd - activeStart), theme.accent)
    const suffix = this.contentPosition
    const remaining = width - activeEnd
    if (suffix.length > 0 && suffix.length < remaining) {
      pushRail("╌".repeat(remaining - suffix.length), theme.faint)
      pushRail(suffix, theme.faint)
    } else {
      pushRail("╌".repeat(remaining), theme.faint)
    }

    return [new StyledText(labelChunks), new StyledText(railChunks)]
  }

  // Read-only "follow along" view of one phase's opencode session: a status
  // header (what it's doing right now — reasoning, running a command, editing,
  // applying a diff), the run meta and diff summary, then the tail of that
  // phase's activity so the session reads top-to-bottom with the newest at the
  // bottom. All from data the dashboard already holds; [o] remains the way in
  // for full interactivity.
  // The session tab: a live, verbatim stream of the model's own output —
  // reasoning and response text as it types, with tool/bash markers inline.
  // No status/model/cost header here: that all lives in the step panel above,
  // so this whole pane is the transcript. Tails the newest rows, like a
  // terminal, since streaming means the interesting end is the bottom.
  private sessionLines(phase: PhaseState | undefined, width: number, visible: number): StyledText[] {
    this.contentPosition = ""
    if (visible <= 0) return []
    if (!phase) return [t`${fg(theme.dim)("no active session yet — waiting for a phase to start…")}`]

    const blocks = this.transcripts.get(phase.name) ?? []
    if (blocks.length === 0) {
      const hint =
        phase.status === "running"
          ? "waiting for the model to start streaming…"
          : phase.status === "pending"
            ? "this step hasn't started yet"
            : "no streamed messages captured for this step"
      return [t`${fg(theme.dim)(hint)}`]
    }

    const running = phase.status === "running"
    const lines: StyledText[] = []
    blocks.forEach((block, index) => {
      if (index > 0) lines.push(plain(""))
      // A blinking-style cursor trails the final block only while it's still
      // being written, so you can see the stream is live.
      const live = running && index === blocks.length - 1
      lines.push(...transcriptBlockLines(block, width, live))
    })
    if (!this.contentFocused) this.sessionScroll = 0
    const maxScroll = Math.max(0, lines.length - visible)
    this.sessionScroll = Math.max(0, Math.min(this.sessionScroll, maxScroll))
    const topOffset = maxScroll - this.sessionScroll
    this.contentPosition = scrollPosition(topOffset, maxScroll)
    // Newest at the bottom by default, but explicit read focus can scroll back.
    return lines.slice(topOffset, topOffset + visible)
  }

  private footerContent(now: number, width: number) {
    if (this.finished) {
      if (this.contentFocused) {
        const left: TextChunk[] = [
          fg(theme.dim)("read · ["),
          fg(theme.accent)("↑↓"),
          fg(theme.dim)("] scroll · ["),
          fg(theme.accent)("pgup/pgdn"),
          fg(theme.dim)("] page · ["),
          fg(theme.accent)("esc"),
          fg(theme.dim)("] pipeline · ["),
          fg(theme.accent)("q"),
          fg(theme.dim)("] close"),
        ]
        const right: TextChunk[] = [fg(theme.faint)(this.runID ? `run ${this.runID}` : "run …")]
        return padBetween(left, right, width)
      }
      const left: TextChunk[] = [
        fg(theme.dim)("["),
        fg(theme.accent)("↑↓"),
        fg(theme.dim)("] step · ["),
        fg(theme.accent)("enter"),
        fg(theme.dim)("] read · ["),
        fg(theme.accent)("←→"),
        fg(theme.dim)("] tab · ["),
        fg(theme.accent)("o"),
        fg(theme.dim)("] session · ["),
        fg(theme.accent)("g"),
        fg(theme.dim)("] lazygit · ["),
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

    if (this.humanReview) {
      const left: TextChunk[] = [
        fg(theme.yellow)("human review · "),
        fg(theme.accent)("c"),
        fg(theme.dim)(" continue · "),
        fg(theme.accent)("s"),
        fg(theme.dim)(" start app · "),
        fg(theme.accent)("r"),
        fg(theme.dim)(" rerun app · "),
        fg(theme.accent)("i"),
        fg(theme.dim)(" iterate · "),
        fg(theme.accent)("a"),
        fg(theme.dim)(" abort"),
      ]
      const right: TextChunk[] = [fg(theme.faint)(this.humanReview.info.appRunning ? "app running" : this.humanReview.info.appCommand ? "app configured" : "app disabled")]
      return padBetween(left, right, width)
    }

    const left: TextChunk[] = this.contentFocused
      ? [
          fg(theme.dim)("read · ["),
          fg(theme.accent)("↑↓"),
          fg(theme.dim)("] scroll · ["),
          fg(theme.accent)("pgup/pgdn"),
          fg(theme.dim)("] page · ["),
          fg(theme.accent)("esc"),
          fg(theme.dim)("] pipeline · "),
          fg(theme.yellow)("ctrl+c"),
          fg(theme.dim)(" abort"),
        ]
      : [
          fg(theme.dim)("["),
          fg(theme.accent)("↑↓"),
          fg(theme.dim)("] step · ["),
          fg(theme.accent)("enter"),
          fg(theme.dim)("] read · ["),
          fg(theme.accent)("←→"),
          fg(theme.dim)("] tab · ["),
          fg(theme.accent)("o"),
          fg(theme.dim)("] session · "),
          fg(theme.yellow)("ctrl+c"),
          fg(theme.dim)(" abort"),
        ]
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

// The detail panel's status word — "ongoing or not" at a glance. A running
// phase reads as ongoing (and flags a long silence); the rest map to their
// terminal state, and a not-yet-started step reads as scheduled.
function statusWordChunk(phase: PhaseState, now: number): TextChunk {
  switch (phase.status) {
    case "running": {
      const quiet = now - phase.updatedAt
      if (quiet > 60_000) return fg(theme.yellow)(`ongoing · quiet ${Math.floor(quiet / 1000)}s`)
      return fg(theme.accent)("ongoing")
    }
    case "completed":
      return fg(theme.green)("done")
    case "failed":
      return fg(theme.red)("failed")
    case "skipped":
      return fg(theme.faint)("skipped")
    default:
      return fg(theme.faint)("scheduled")
  }
}

function humanReviewActionForKey(key: KeyEvent): HumanReviewAction | undefined {
  switch (key.name) {
    case "c":
      return "continue"
    case "s":
      return "prepare"
    case "r":
      return "rerun"
    case "i":
      return "iterate"
    case "a":
      return "abort"
  }
  return undefined
}

function humanReviewActionLabel(action: HumanReviewAction) {
  switch (action) {
    case "continue":
      return "human review: continue"
    case "prepare":
      return "human review: start app"
    case "rerun":
      return "human review: rerun app"
    case "iterate":
      return "human review: open OpenCode iteration"
    case "abort":
      return "human review: abort"
  }
}

// Trims a phase's transcript back under the cap by dropping the oldest text
// first (partial-trimming the head block, then shifting whole blocks), so the
// tail the session tab shows always survives.
function capTranscript(blocks: TranscriptBlock[]) {
  let total = 0
  for (const block of blocks) total += block.text.length
  while (total > transcriptCap && blocks.length > 0) {
    const first = blocks[0]!
    const excess = total - transcriptCap
    if (first.text.length > excess) {
      first.text = first.text.slice(excess)
      total -= excess
    } else {
      total -= first.text.length
      blocks.shift()
    }
  }
}

// Renders one transcript block. Tool/bash markers are a single labelled line;
// reasoning/response are a channel label followed by the verbatim text,
// wrapped under a two-space hang. Reasoning is dimmed so the model's actual
// answer (response) stands out. `live` trails a cursor on the final line.
function transcriptBlockLines(block: TranscriptBlock, width: number, live: boolean): StyledText[] {
  const cursor: TextChunk[] = live ? [fg(theme.accent)("▌")] : []

  if (block.channel === "tool" || block.channel === "bash") {
    const marker = block.channel === "bash" ? { icon: "$", color: theme.green } : { icon: "⚒", color: theme.cyan }
    return [new StyledText([fg(marker.color)(`${marker.icon} `), fg(theme.text)(truncate(block.text, Math.max(8, width - 2))), ...cursor])]
  }

  const isReasoning = block.channel === "reasoning"
  const lines: StyledText[] = [
    new StyledText([fg(isReasoning ? theme.magenta : theme.accent)(isReasoning ? "✻ " : "✎ "), fg(theme.faint)(isReasoning ? "reasoning" : "response")]),
  ]
  const bodyColor = isReasoning ? theme.dim : theme.text
  const wrapped = wrapMessageText(block.text, Math.max(12, width - 2))
  if (wrapped.length === 0) {
    if (live) lines.push(new StyledText([raw("  "), ...cursor]))
    return lines
  }
  wrapped.forEach((segment, index) => {
    const chunks: TextChunk[] = [raw("  "), fg(bodyColor)(segment)]
    if (live && index === wrapped.length - 1) chunks.push(...cursor)
    lines.push(new StyledText(chunks))
  })
  return lines
}

// Word-wraps the model's text while preserving its own line breaks, so
// paragraphs and lists in the stream read the way the model wrote them.
function wrapMessageText(text: string, width: number): string[] {
  const out: string[] = []
  for (const line of text.split("\n")) {
    if (line.length === 0) out.push("")
    else out.push(...wrapWords(line, width))
  }
  return out
}

// Greedy word wrap; a single word longer than the width is hard-split so it
// never overflows the panel (whose text renderer never wraps on its own).
function wrapWords(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ")
  const lines: string[] = []
  let current = ""
  for (let word of words) {
    while (word.length > width) {
      if (current) {
        lines.push(current)
        current = ""
      }
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (!word) continue
    if (!current) current = word
    else if (current.length + 1 + word.length <= width) current += ` ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : [""]
}

function scrollPosition(topOffset: number, maxScroll: number) {
  if (maxScroll <= 0) return ""
  if (topOffset <= 0) return "top"
  if (topOffset >= maxScroll) return "end"
  return `${Math.round((topOffset / maxScroll) * 100)}%`
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
