import { readFile, stat } from "node:fs/promises"
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

import { openClaudeSessionWindow } from "./claude-code"
import { startLimitsPoller } from "./limits"
import { log } from "./log"
import { openIterateOpencodeWindow, openOpencodeSessionWindow, openStoredSessionWindow, type SessionWindowBackend } from "./opencode"
import { stepRunnerFor, type StepRunnerId } from "./step-runners"
import { PhaseUsage, addTokens, emptyTokens } from "./usage"
import {
  formatAgo,
  formatCount,
  formatElapsed,
  formatMoney,
  formatTime,
  displayWidth,
  joinLines,
  limitsRow,
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

import type { BoxOptions, CliRenderer, KeyEvent, Selection, TextChunk } from "@opentui/core"
import type { LimitsSnapshot } from "./limits"
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
const contentTabBarRows = 2

type RunnerSessionContext = {
  targetDir: string
  sessionID: string
  runDir: string
  serverUrl: string
  offlineSessions: boolean
}

const runnerSessionOpeners: Record<StepRunnerId, (context: RunnerSessionContext) => Promise<SessionWindowBackend> | undefined> = {
  opencode: (context) =>
    context.serverUrl
      ? openOpencodeSessionWindow({ url: context.serverUrl, targetDir: context.targetDir, sessionID: context.sessionID })
      : context.offlineSessions
        ? openStoredSessionWindow({ targetDir: context.targetDir, sessionID: context.sessionID })
        : undefined,
  "claude-code": (context) => openClaudeSessionWindow({ targetDir: context.targetDir, sessionID: context.sessionID, runDir: context.runDir }),
}

// The right-hand content panel is a three-tab view of the focused phase.
export type ContentTab = "logs" | "reports" | "session"
const contentTabOrder: readonly ContentTab[] = ["session", "reports", "logs"]

export type TuiDashboardMode = "historical" | "live"

// A live run is primarily something to follow, while a reconstructed run is
// primarily something to inspect. Logs remain available but are deliberately
// never the initial tab.
export function initialContentTab(mode: TuiDashboardMode): ContentTab {
  return mode === "historical" ? "reports" : "session"
}

// The [i] iterate window's opening message. Plain absolute paths on purpose:
// the fresh opencode instance reads them with its own tools, so this works
// without the run's server and survives convoy exiting. Single line because
// the whole command travels through `zsh -lc`.
export function iteratePrompt(runID: string, files: string[]): string {
  return (
    `Continuing convoy run ${runID}. First read these context files: ${files.join(", ")}. ` +
    "prd.md is the original task; each report is one pipeline step's output. " +
    "The work is already applied in this directory. After reading, give a one-line status and wait for my instructions."
  )
}

export type PipelineSelectionTarget =
  | { kind: "phase"; name: string }
  | { kind: "group"; groupId: string; stepName?: string }

type GroupSelection = Extract<PipelineSelectionTarget, { kind: "group" }>

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
  // offlineSessions: re-opened finished runs have no live server, so [o] opens
  // their stored sessions from disk instead of attaching. observer: read-only
  // attach to another process's run, where [i] takeover must be refused.
  options?: { offlineSessions?: boolean; observer?: boolean; mode?: TuiDashboardMode },
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
  return new TuiProgress(
    renderer,
    phases,
    onAbort,
    autoAccept,
    options?.offlineSessions ?? false,
    options?.observer ?? false,
    initialContentTab(options?.mode ?? "live"),
  )
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
  // Group headers are first-class selections. The concrete index above is kept
  // on one of the group's children so returning to leaf navigation is stable.
  private selectedGroup?: GroupSelection
  private manualFocus = false
  // First visible step row in the pipeline panel when the tree overflows it.
  private pipelineScroll = 0
  // Run workspace dir, where phase reports land; set at start so the reports
  // tab reads them live, and refreshed from the outcome on the finish screen.
  private runDir = ""
  // Set when an external session opens with paths into the run directory, so
  // the runner must not clean the workspace up while that session uses them.
  private iterateRequested = false
  private lastActivityAt = Date.now()
  private readonly startedAt = Date.now()
  private readonly phases: PhaseState[]
  private readonly feed: FeedEntry[] = []
  // The live model transcript per phase (the session tab): verbatim reasoning
  // and response text, interleaved with tool/bash action markers. Streamed in
  // via phaseMessage and repainted on the ticker, not per delta.
  private readonly transcripts = new Map<string, TranscriptBlock[]>()
  private readonly ticker: ReturnType<typeof setInterval>
  // Subscription meters (GPT windows, OpenRouter credits) polled in the
  // background; the 250ms ticker just repaints whatever the last poll left.
  private readonly stopLimits: () => void
  private limits?: LimitsSnapshot
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
  // Rebuilt on every pipeline render: panel row index → selectable tree target,
  // so group headers and concrete phases both resolve exactly as rendered.
  private pipelineRowTargets: (PipelineSelectionTarget | undefined)[] = []
  private readonly overlay: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  // Panels repainted when the terminal reports a theme change mid-run.
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []
  private readonly permissionQueue: PendingPermission[] = []
  // Gates queue because parallel phases can both be armed with [i]; the head
  // entry owns the c/o/a keys, the rest wait their turn.
  private readonly humanReviewQueue: PendingHumanReview[] = []
  // Phases the user armed with [i]: the runner checks this set (via
  // isInteractiveTakeover) and gates instead of retrying or completing.
  private readonly interactiveTakeover = new Set<string>()
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
  // Identity token for each async report read. Terminal phase transitions
  // invalidate it so an older failed read cannot repopulate a stale "missing".
  private readonly reportLoads = new Map<string, object>()
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
  private groupScroll = 0
  private contentPosition = ""
  // The content panel's active tab, scoped to the focused phase: its activity
  // feed, the report it wrote (if any), or a read-only "follow along" view of
  // its opencode session. [o] still opens the interactive session externally.
  private contentTab: ContentTab
  // Click hit-regions for the tab strip, rebuilt every render: column span → tab.
  private feedTabRegions: { tab: ContentTab; start: number; end: number }[] = []
  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.addEvent("convoy", "system", `terminal theme changed: ${mode}`)
    this.render()
  }

  private readonly handleSelection = (selection: Selection) => {
    if (this.contentTab !== "session" && this.contentTab !== "reports") return
    const { x, y, width, height } = selection.bounds
    if (
      x < this.feedText.x ||
      x + width > this.feedText.x + this.feedText.width ||
      y < this.feedText.y + contentTabBarRows ||
      y + height > this.feedText.y + this.feedText.height
    ) {
      return
    }
    if (selection.selectedRenderables.length !== 1 || selection.selectedRenderables[0] !== this.feedText) return

    const text = selection.getSelectedText()
    if (text && this.renderer.copyToClipboardOSC52(text)) this.renderer.clearSelection()
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
      this.addEvent("convoy", "system", "ctrl+c received; shutting down")
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
    if (this.humanReviewQueue.length > 0 && this.handleHumanReviewKey(key)) return
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
      case "i":
        consume()
        // The same key shifts meaning with the run: mid-run it takes over the
        // live session, on the finish screen it iterates in a fresh one.
        if (this.finished) void this.openIterateWindow()
        else this.toggleInteractiveTakeover()
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
    // When true (attached read-only to another process's run), [i] is refused:
    // no runner reads this dashboard's takeover set.
    private readonly observer = false,
    initialTab: ContentTab = "session",
  ) {
    this.contentTab = initialTab
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
      id: "convoy-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
      gap: 0,
    })

    // The working directory sits above the header as a bare line, outside the
    // bordered box, so the header holds just the run totals row and the
    // subscription-meter row beneath it.
    const dirLine = new TextRenderable(renderer, {
      id: "convoy-dir",
      content: "",
      fg: theme.text,
      width: "100%",
      height: 1,
    })

    const header = this.panel({
      id: "convoy-header",
      height: 4,
      borderColor: theme.border,
      backgroundColor: theme.bg,
    })

    const body = new BoxRenderable(renderer, {
      id: "convoy-body",
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
      const target = this.pipelineRowTargets[event.y - this.pipelineText.y]
      if (target) this.selectPipelineTarget(target)
    }

    // The wheel over the pipeline steps the phase selector, one row per tick.
    const wheelFromPipeline = (event: WheelEvent) => {
      const delta = wheelDelta(event)
      if (delta === 0) return
      event.preventDefault()
      event.stopPropagation()
      this.moveSelection(Math.sign(delta))
    }

    const pipeline = this.panel({
      id: "convoy-pipeline",
      width: pipelineWidth,
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " pipeline ",
      titleAlignment: "left",
      onMouseDown: focusFromPipeline,
      onMouseScroll: wheelFromPipeline,
    })
    pipeline.text.onMouseDown = focusFromPipeline
    pipeline.text.onMouseScroll = wheelFromPipeline

    const right = new BoxRenderable(renderer, {
      id: "convoy-right",
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
      id: "convoy-step",
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
      id: "convoy-todos",
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
      if (row < 0 || row >= contentTabBarRows) return
      const col = event.x - this.feedText.x
      const hit = this.feedTabRegions.find((region) => col >= region.start && col < region.end)
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      this.setContentTab(hit.tab)
    }

    // The wheel scrolls the active content tab without needing [enter] focus.
    const wheelFromFeed = (event: WheelEvent) => {
      const delta = wheelDelta(event)
      if (delta === 0) return
      event.preventDefault()
      event.stopPropagation()
      this.scrollContent(delta)
    }

    const feed = this.panel({
      id: "convoy-feed",
      width: "100%",
      flexGrow: 1,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      onMouseDown: switchTabFromFeed,
      onMouseScroll: wheelFromFeed,
    })
    feed.text.onMouseDown = switchTabFromFeed
    feed.text.onMouseScroll = wheelFromFeed

    const openFromFooter = (event: { preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      this.openActiveSessionWindow("click")
    }

    const footer = this.panel({
      id: "convoy-footer",
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
      id: "convoy-permission-overlay",
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
      id: "convoy-permission-modal",
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
    renderer.on("selection", this.handleSelection)
    renderer.on("theme_mode", this.handleThemeMode)

    this.ticker = setInterval(() => this.render(), 250)
    this.stopLimits = startLimitsPoller((snapshot) => {
      this.limits = snapshot
    })
    this.render()
  }

  start(runID: string, targetDir: string, runDir = "") {
    this.runID = runID
    this.targetDir = targetDir
    this.runDir = runDir
    this.addEvent("convoy", "system", `run ${runID} started`)
    this.render()
  }

  serverReady(url: string) {
    this.serverUrl = url
    this.addEvent("convoy", "system", `opencode server at ${url}`)
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
    this.invalidateReport(name)
    this.addEvent(name, "system", detail || "phase completed")
  }

  phaseSkipped(name: string) {
    this.setPhase(name, "skipped")
    this.addEvent(name, "system", "skipped by flag")
  }

  phaseFailed(name: string, detail = "") {
    this.setPhase(name, "failed")
    this.invalidateReport(name)
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
    // Live observers can have loaded "missing" while this phase was still
    // running; restoration means its final report is now ready to be retried.
    this.invalidateReport(name)
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
      this.addEvent("convoy", "permission", `auto-allowed: ${permissionSummary(info)}`)
      this.render()
      return Promise.resolve("once")
    }
    return new Promise((resolve) => {
      this.permissionQueue.push({ info, resolve })
      if (this.permissionQueue.length === 1) this.permissionChoice = 0
      this.addEvent("convoy", "permission", `approval needed: ${permissionSummary(info)}`)
      this.render()
    })
  }

  askHumanReview(info: HumanReviewPromptInfo): Promise<HumanReviewAction> {
    if (this.renderer.isDestroyed) return Promise.resolve("abort")
    return new Promise((resolve) => {
      this.humanReviewQueue.push({ info, resolve })
      if (this.humanReviewQueue.length === 1) {
        this.selectPhaseByName(info.stepName)
        this.manualFocus = false
      }
      this.addEvent(info.stepName, "permission", info.kind === "interactive" ? "interactive session — waiting for your decision" : "waiting for human review action")
      this.render()
    })
  }

  isInteractiveTakeover(name: string): boolean {
    return this.interactiveTakeover.has(name)
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
        this.selectedGroup = undefined
        this.manualFocus = true
      }
      this.resetContentScroll()
      for (const pending of this.permissionQueue.splice(0)) pending.resolve("reject")
      this.addEvent(
        "convoy",
        outcome.status === "completed" ? "system" : "error",
        outcome.status === "completed" ? "run completed" : `run failed: ${outcome.error ?? "unknown error"}`,
      )
      this.render()
    })
  }

  // The runner checks this after the finish screen because external sessions
  // can still be reading files from the run directory.
  keepRunDirRequested(): boolean {
    return this.iterateRequested
  }

  // The focused phase, clamped to a valid index (the pipeline can be empty
  // only in degenerate cases). Shared by rendering and [o].
  private focusedPhase(): PhaseState | undefined {
    if (this.phases.length === 0) return undefined
    this.selected = Math.max(0, Math.min(this.phases.length - 1, this.selected))
    return this.phases[this.selected]
  }

  private focusedGroup(): { selection: GroupSelection; members: PhaseState[] } | undefined {
    const selection = this.selectedGroup
    if (!selection) return undefined
    const members = this.phases.filter(
      (phase) =>
        phase.groupId === selection.groupId &&
        (selection.stepName === undefined || stepLabel(phase) === selection.stepName),
    )
    if (members.length === 0) {
      this.selectedGroup = undefined
      return undefined
    }
    return { selection, members }
  }

  private currentPipelineTarget(): PipelineSelectionTarget | undefined {
    if (this.selectedGroup) return this.selectedGroup
    const phase = this.focusedPhase()
    return phase ? { kind: "phase", name: phase.name } : undefined
  }

  // Moves the focused phase through the pipeline (the tab selector). The first
  // move pins focus (manualFocus) so it no longer auto-follows live activity.
  private moveSelection(delta: number) {
    const targets = pipelineSelectionTargets(this.phases)
    if (targets.length === 0) return
    const current = this.currentPipelineTarget()
    const currentIndex = current ? targets.findIndex((target) => samePipelineTarget(target, current)) : -1
    const nextIndex = Math.max(0, Math.min(targets.length - 1, (currentIndex < 0 ? 0 : currentIndex) + delta))
    this.selectPipelineTarget(targets[nextIndex]!)
  }

  private selectPhaseByName(name: string) {
    this.selectPipelineTarget({ kind: "phase", name })
  }

  private selectPipelineTarget(target: PipelineSelectionTarget) {
    const index =
      target.kind === "phase"
        ? this.phases.findIndex((phase) => phase.name === target.name)
        : this.phases.findIndex(
            (phase) =>
              phase.groupId === target.groupId &&
              (target.stepName === undefined || stepLabel(phase) === target.stepName),
          )
    if (index === -1) return
    this.manualFocus = true
    this.selected = index
    this.selectedGroup = target.kind === "group" ? target : undefined
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
    this.groupScroll = 0
  }

  private scrollContent(delta: number) {
    if (this.selectedGroup) {
      this.groupScroll = Math.max(0, this.groupScroll + delta)
      this.render()
      return
    }
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
    if (this.selectedGroup) this.groupScroll = 0
    else if (this.contentTab === "session") this.sessionScroll = Number.MAX_SAFE_INTEGER
    else if (this.contentTab === "reports") this.reportScroll = 0
    else this.logScroll = 0
    this.render()
  }

  private scrollContentToEnd() {
    if (this.selectedGroup) this.groupScroll = Number.MAX_SAFE_INTEGER
    else if (this.contentTab === "session") this.sessionScroll = 0
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
    if (!lazygit) this.addEvent("convoy", "system", "lazygit not installed; falling back to git log")
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
      if (code !== 0) this.addEvent("convoy", "error", `${label} exited with code ${code}`)
    } catch (error) {
      this.addEvent("convoy", "error", `couldn't launch ${label}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.inSubshell = false
      this.resume()
    }
  }

  private loadReport(name: string, runDir: string) {
    const token = {}
    this.reportLoads.set(name, token)
    this.reports.set(name, "loading")
    readFile(join(runDir, "reports", `${name}.md`), "utf8")
      .then((body) => {
        if (this.reportLoads.get(name) !== token) return
        this.reportLoads.delete(name)
        this.reports.set(name, body.replace(/\r\n/g, "\n").split("\n"))
        this.render()
      })
      .catch(() => {
        if (this.reportLoads.get(name) !== token) return
        this.reportLoads.delete(name)
        this.reports.set(name, "missing")
        this.render()
      })
  }

  private invalidateReport(name: string) {
    this.reportLoads.delete(name)
    this.reports.delete(name)
  }

  message(message: string) {
    this.addEvent("convoy", "system", message)
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
    this.stopLimits()
    log.mute(false)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("selection", this.handleSelection)
    this.renderer.off("theme_mode", this.handleThemeMode)
    // A shutdown signal can tear the run down while the finish screen is still
    // up; resolving here keeps that promise from leaking.
    this.finished?.resolve()
    for (const pending of this.humanReviewQueue.splice(0)) pending.resolve("abort")
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
    this.addEvent("convoy", "permission", autoAcceptAnnouncement[next])
    // Only "all" clears the backlog blindly; "smart" leaves already-escalated
    // prompts for the user (re-judging an open prompt would be surprising).
    if (next === "all") {
      for (const pending of this.permissionQueue.splice(0)) {
        this.addEvent("convoy", "permission", `auto-allowed: ${permissionSummary(pending.info)}`)
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
    this.addEvent("convoy", "permission", `${verdict}: ${permissionSummary(pending.info)}`)
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
    const pending = this.humanReviewQueue.shift()
    if (!pending) return
    this.addEvent(pending.info.stepName, action === "abort" ? "error" : "permission", humanReviewActionLabel(action, pending.info.kind === "interactive"))
    const next = this.humanReviewQueue[0]
    if (next) {
      this.selectPhaseByName(next.info.stepName)
      this.manualFocus = false
    }
    pending.resolve(action)
    this.render()
  }

  // Opens the focused phase's opencode session in an external window; falls
  // back to any running phase if focus somehow lands on one without a session.
  private openActiveSessionWindow(source: "click" | "key") {
    if (this.selectedGroup) {
      this.addEvent("convoy", "system", "select a model row to open its OpenCode session")
      this.render()
      return
    }
    const active = this.focusedPhase() ?? this.phases.find((phase) => phase.status === "running")
    if (!active) {
      this.addEvent("convoy", "system", "no active opencode session to open yet")
      this.render()
      return
    }
    this.openSessionWindowForPhase(active.name, source)
  }

  // Arms (or disarms) interactive takeover for the focused phase: while armed,
  // the runner won't retry, restore, or complete the step on its own — it gates
  // and waits, so the user can stop the agent from the attached OpenCode window
  // (esc) and keep working in the session manually.
  private toggleInteractiveTakeover() {
    if (this.finished) return
    if (this.observer) {
      this.addEvent("convoy", "system", "interactive mode isn't available while attached read-only")
      this.render()
      return
    }
    if (this.selectedGroup) {
      this.addEvent("convoy", "system", "select a running model row before enabling interactive mode")
      this.render()
      return
    }
    const phase = this.focusedPhase() ?? this.phases.find((candidate) => candidate.status === "running")
    if (!phase || phase.status !== "running") {
      this.addEvent("convoy", "system", "interactive mode needs a running step")
      this.render()
      return
    }
    const runner = stepRunnerFor(phase.runner)
    if (!runner.capabilities.takeover) {
      this.addEvent(phase.name, "system", `interactive mode isn't available for ${runner.id} steps; press o after the step finishes to resume its session`)
      this.render()
      return
    }
    if (this.interactiveTakeover.has(phase.name)) {
      this.interactiveTakeover.delete(phase.name)
      this.addEvent(phase.name, "system", "interactive mode off — normal retries apply again")
      this.render()
      return
    }
    if (!phase.sessionID) {
      this.addEvent(phase.name, "system", "interactive mode needs the step's session; wait for it to appear")
      this.render()
      return
    }
    this.interactiveTakeover.add(phase.name)
    this.addEvent(phase.name, "system", "interactive mode armed — esc in OpenCode stops the agent; convoy will wait for you")
    this.openSessionWindowForPhase(phase.name, "key")
  }

  private openSessionWindowForPhase(name: string, source: "click" | "key") {
    const phase = this.findPhase(name)
    if (!phase) return
    const runner = stepRunnerFor(phase.runner)
    if (!phase.sessionID) {
      this.addEvent("convoy", "system", `no ${runner.sessionName} session for ${name} yet`)
      this.render()
      return
    }
    const targetDir = this.targetDir || process.cwd()

    if (phase.status === "running" && !runner.capabilities.liveAttach) {
      this.addEvent(phase.name, "system", `${runner.id} steps stream here while running; press o once the step finishes to resume the session`)
      this.render()
      return
    }

    const open = runnerSessionOpeners[runner.id]({
      targetDir,
      sessionID: phase.sessionID,
      runDir: this.runDir,
      serverUrl: this.serverUrl,
      offlineSessions: this.offlineSessions,
    })
    if (!open) {
      this.addEvent("convoy", "system", `${runner.sessionName} session is not ready yet`)
      this.render()
      return
    }

    if (!runner.capabilities.liveAttach) this.iterateRequested = true
    this.addEvent("convoy", "system", `${source === "key" ? "[o]" : "click"}: opening ${name} ${runner.sessionName} session ${shortID(phase.sessionID)}`)
    open
      .then((backend) => {
        this.addEvent("convoy", "system", `${name} session opened in ${backend}`)
        this.render()
      })
      .catch((error: unknown) => {
        this.addEvent("convoy", "error", `couldn't open ${runner.sessionName} session: ${error instanceof Error ? error.message : String(error)}`)
        this.render()
      })
    this.render()
  }

  // [i] on the finish screen: a fresh opencode window in the run's directory,
  // opened on a new session whose first message points at the run's prd and
  // step reports — so iterating continues from where the pipeline left off.
  private async openIterateWindow() {
    if (!this.runDir) {
      this.addEvent("convoy", "system", "no run directory to build iterate context from")
      this.render()
      return
    }
    const candidates = [join(this.runDir, "prd.md"), ...this.phases.map((phase) => join(this.runDir, "reports", `${phase.name}.md`))]
    const files: string[] = []
    for (const path of candidates) {
      if (await fileReadable(path)) files.push(path)
    }
    if (files.length === 0) {
      this.addEvent("convoy", "system", "no context files found in the run dir; was it cleaned up?")
      this.render()
      return
    }

    this.iterateRequested = true
    this.addEvent("convoy", "system", `[i]: opening a new opencode session with ${files.length} context file${files.length === 1 ? "" : "s"}`)
    openIterateOpencodeWindow({
      targetDir: this.targetDir || process.cwd(),
      prompt: iteratePrompt(this.runID, files),
    })
      .then((backend) => {
        this.addEvent("convoy", "system", `iterate session opened in ${backend}`)
        this.render()
      })
      .catch((error: unknown) => {
        this.addEvent("convoy", "error", `couldn't open iterate session: ${error instanceof Error ? error.message : String(error)}`)
        this.render()
      })
    this.render()
  }

  private setPhase(name: string, status: PhaseStatus) {
    const phase = this.findPhase(name)
    if (!phase) return
    if (status === "running" && phase.startedAt === undefined) phase.startedAt = Date.now()
    if (status === "completed" || status === "failed" || status === "skipped") {
      phase.endedAt = Date.now()
      this.interactiveTakeover.delete(name)
    }
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
    // Body rows left after the dir line (1), header (4), and footer (3); the
    // detail and todos panels grow with their content but never starve the
    // content panel below them.
    const bodyHeight = Math.max(8, this.renderer.height - 8)

    // Auto-follow the active phase until the user takes over navigation; after
    // that the selection stays put so any step (past, present, scheduled) can
    // be inspected without the live run yanking focus away. Concurrent phases
    // interleave their events, so when the active phase belongs to a
    // multi-member group, follow the group's header instead of whichever
    // member emitted last — otherwise focus ping-pongs between the children.
    if (!this.finished && !this.manualFocus) {
      const activeIndex = this.phases.findIndex((phase) => phase.name === this.activePhase)
      if (activeIndex >= 0) {
        this.selected = activeIndex
        this.selectedGroup = autoFollowGroup(this.phases, this.phases[activeIndex]!)
      }
    }
    const group = this.focusedGroup()
    const focus = group ? undefined : this.focusedPhase()
    this.pipelineBox.borderColor = this.contentFocused ? theme.borderDim : theme.accent
    this.feedBox.borderColor = this.contentFocused ? theme.accent : theme.borderDim

    // Detail panel: either one concrete phase or an aggregate for a selected
    // parallel/multi-model header.
    const detailLines = group
      ? this.groupDetailContent(group.selection, group.members, now, rightWidth)
      : this.detailContent(focus, now, rightWidth)
    this.stepBox.title = group ? (group.selection.stepName === undefined ? " parallel group " : " step group ") : " step "
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
    const contentRows = feedRows - contentTabBarRows
    this.contentPageRows = contentRows

    this.dirText.content = this.dirContent(innerWidth)
    this.headerText.content = this.headerContent(now, innerWidth)
    this.pipelineText.content = this.pipelineContent(now, bodyHeight - 2)

    // Body first: the active content tab computes the scroll indicator the rail shows.
    const body = group
      ? this.groupContentLines(group.selection, group.members, now, rightWidth, contentRows)
      : this.contentTab === "reports"
        ? this.reportPanelLines(focus, rightWidth, contentRows)
        : this.contentTab === "session"
          ? this.sessionLines(focus, rightWidth, contentRows)
          : this.phaseFeedLines(focus, rightWidth, contentRows)
    this.feedText.content = joinLines([...this.contentTabBar(rightWidth), ...body])

    this.footerText.content = this.footerContent(now, innerWidth)
    this.renderPermissionModal()
    this.renderer.requestRender()
  }

  // Header owns the session-wide totals (clock, elapsed time, cost, tokens)
  // with the subscription meters on the row beneath. Phase status lives in
  // the pipeline panel.
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
    const title: TextChunk[] = [bold(fg(theme.accent)("◆ convoy"))]
    if (this.finished) {
      title.push(
        fg(theme.faint)("  ·  "),
        this.finished.status === "completed" ? bold(fg(theme.green)("✓ run completed")) : bold(fg(theme.red)("✗ run failed")),
      )
    }
    return joinLines([padBetween(title, totals, width), limitsRow(this.limits, now, width)])
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
  private pipelineContent(now: number, visibleRows: number) {
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
    // resolves against exactly what is on screen. Headers are real selectable
    // targets instead of aliases for their first child.
    const rows: (PipelineSelectionTarget | undefined)[] = [undefined, undefined]
    const emit = (left: TextChunk[], right: TextChunk[], rowTarget: PipelineSelectionTarget | undefined) => {
      out.push(padBetween(left, right, width))
      rows.push(rowTarget)
    }
    // The pipeline is the tab selector, live and finished alike: the focused
    // phase carries a ▸ marker at column 0 (before the tree prefix, so it stays
    // aligned across every depth).
    const selectedTarget = this.currentPipelineTarget()
    const isTargetSelected = (target: PipelineSelectionTarget) =>
      selectedTarget !== undefined && samePipelineTarget(target, selectedTarget)
    const isOnSelectedPath = (phase: PhaseState) =>
      this.selectedGroup
        ? phase.groupId === this.selectedGroup.groupId &&
          (this.selectedGroup.stepName === undefined || stepLabel(phase) === this.selectedGroup.stepName)
        : this.phases[this.selected] === phase
    // Row index of the ▸ marker, so the scroll window below can follow it.
    let selectedRow = -1

    // One rendered line, sized so it never wraps: the marker, tree prefix and
    // status icon are fixed, the right-aligned meta is preserved whole, and
    // the label (name or model) is truncated to whatever budget is left
    // between them. Deep nesting eats into the name, never into the layout —
    // which keeps `rows` one-to-one with the visible lines (clicks resolve).
    const emitLine = (args: {
      rowTarget: PipelineSelectionTarget
      lasts: boolean[]
      icon: TextChunk
      labelText: string
      labelStatus: PhaseStatus
      color?: (text: string) => TextChunk
      suffix?: TextChunk[]
      badges?: readonly string[]
      right: TextChunk[]
    }) => {
      const selected = isTargetSelected(args.rowTarget)
      if (selected) selectedRow = rows.length
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
      // The name is the only per-row information; the capability badge is step
      // config repeated down the tree. So the badge takes the longest form
      // that fits beside the whole name and vanishes before costing it a
      // single column.
      const badge = pickBadge(args.badges ?? [], budget - displayWidth(args.labelText), args.right.length > 0)
      const right = badge
        ? [fg(theme.cyan)(badge), ...(args.right.length ? [fg(theme.faint)(" · ")] : []), ...args.right]
        : args.right
      const label = truncate(args.labelText, budget)
      left.push(args.color ? args.color(label) : phaseNameChunk(label, args.labelStatus, selected))
      left.push(...suffix)
      emit(left, right, args.rowTarget)
    }

    // A leaf row: a single phase (sequential step, human gate, or one member
    // of a concurrent group) labelled by `labelText`.
    const emitRow = (phase: PhaseState, lasts: boolean[], labelText: string, right: TextChunk[], badges?: readonly string[]) =>
      emitLine({ rowTarget: { kind: "phase", name: phase.name }, lasts, icon: statusIcon(phase.status, now), labelText, labelStatus: phase.status, badges, right })

    // A fanned-out member, labelled by its model with the variant (if any) as
    // a faint suffix.
    const emitModelRow = (phase: PhaseState, lasts: boolean[]) =>
      emitLine({
        rowTarget: { kind: "phase", name: phase.name },
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
    const emitHeader = (
      members: PhaseState[],
      labelText: string,
      kind: "step" | "parallel",
      count: number,
      lasts: boolean[],
      target: GroupSelection,
      badges?: readonly string[],
    ) => {
      const status = groupStatus(members)
      const onPath = members.some(isOnSelectedPath)
      emitLine({
        rowTarget: target,
        lasts,
        icon: statusIcon(status, now),
        labelText,
        labelStatus: status,
        color: onPath ? (text) => bold(fg(theme.accent)(text)) : kind === "parallel" ? (text) => fg(theme.teal)(text) : undefined,
        suffix: [fg(theme.faint)(` ×${count}`)],
        badges,
        right: groupMetaChunks(members, now),
      })
    }

    // The capability badge dedupes upward: uniform across the whole pipeline
    // it lives in the panel title alone; uniform across a group it lives on
    // that group's header; only a phase that differs from its siblings carries
    // it on its own row. Repeating it down every row said nothing and starved
    // the step names of columns.
    const allReadOnly = this.phases.length > 0 && this.phases.every((phase) => phase.readOnly)
    this.pipelineBox.title = allReadOnly ? " pipeline · read-only " : " pipeline "

    for (const group of groupPhases(this.phases)) {
      if (group.length === 1) {
        const phase = group[0]!
        emitRow(phase, [], phase.name, phaseMetaChunks(phase, now), allReadOnly ? [] : phaseCapabilityBadges(phase))
        continue
      }

      const stepGroups = chunkByStepName(group)
      if (stepGroups.length === 1) {
        // A single step fanned out across models: the header names the step,
        // each member names just its model. All members share the step's
        // capability, so the header carries the badge for all of them.
        emitHeader(
          group,
          stepLabel(group[0]!),
          "step",
          group.length,
          [],
          {
            kind: "group",
            groupId: group[0]!.groupId!,
            stepName: stepLabel(group[0]!),
          },
          allReadOnly ? [] : phaseCapabilityBadges(group[0]!),
        )
        group.forEach((phase, index) => emitModelRow(phase, [index === group.length - 1]))
        continue
      }

      // A `parallel:` block of distinct steps; the header counts the steps,
      // and any step that is itself fanned out across models nests one level
      // deeper under its own ×N sub-header.
      const groupReadOnly = group.every((phase) => phase.readOnly)
      emitHeader(
        group,
        "parallel",
        "parallel",
        stepGroups.length,
        [],
        { kind: "group", groupId: group[0]!.groupId! },
        allReadOnly || !groupReadOnly ? [] : phaseCapabilityBadges(group[0]!),
      )
      const memberBadges = (phase: PhaseState) => (allReadOnly || groupReadOnly ? [] : phaseCapabilityBadges(phase))
      stepGroups.forEach((members, stepIndex) => {
        const lastStep = stepIndex === stepGroups.length - 1
        if (members.length === 1) {
          emitRow(members[0]!, [lastStep], stepLabel(members[0]!), phaseMetaChunks(members[0]!, now), memberBadges(members[0]!))
          return
        }
        emitHeader(
          members,
          stepLabel(members[0]!),
          "step",
          members.length,
          [lastStep],
          {
            kind: "group",
            groupId: members[0]!.groupId!,
            stepName: stepLabel(members[0]!),
          },
          memberBadges(members[0]!),
        )
        members.forEach((phase, index) => emitModelRow(phase, [lastStep, index === members.length - 1]))
      })
    }

    // Pinned header (progress bar + spacer) over a scrolled window of the step
    // rows, so pipelines taller than the panel stay reachable: the window
    // follows the ▸ selection, and rows/clicks stay one-to-one with the screen.
    const headerRows = 2
    const bodyVisible = Math.max(1, visibleRows - headerRows)
    const body = out.slice(headerRows)
    const bodyRows = rows.slice(headerRows)
    const maxScroll = Math.max(0, body.length - bodyVisible)
    if (selectedRow >= headerRows) {
      const target = selectedRow - headerRows
      if (target < this.pipelineScroll) this.pipelineScroll = target
      if (target >= this.pipelineScroll + bodyVisible) this.pipelineScroll = target - bodyVisible + 1
    }
    this.pipelineScroll = Math.max(0, Math.min(this.pipelineScroll, maxScroll))
    const start = this.pipelineScroll
    this.pipelineRowTargets = [...rows.slice(0, headerRows), ...bodyRows.slice(start, start + bodyVisible)]
    return joinLines([...out.slice(0, headerRows), ...body.slice(start, start + bodyVisible)])
  }

  // Aggregate header for a selected tree group. It stays compact so most of the
  // right pane remains available for the per-child comparison below.
  private groupDetailContent(selection: GroupSelection, members: PhaseState[], now: number, width: number): StyledText[] {
    const status = groupStatus(members)
    const logicalSteps = new Set(members.map(stepLabel)).size
    const label = selection.stepName ?? "parallel"
    const countLabel = selection.stepName
      ? `${members.length} model${members.length === 1 ? "" : "s"}`
      : `${logicalSteps} step${logicalSteps === 1 ? "" : "s"} · ${members.length} run${members.length === 1 ? "" : "s"}`
    const head: TextChunk[] =
      status === "running"
        ? [fg(theme.accent)(`${spinnerFrame(now)} `), bold(fg(theme.text)(label))]
        : [statusIcon(status, now), raw(" "), bold(fg(theme.text)(label))]
    head.push(fg(theme.faint)(`  ·  ${countLabel}`))

    const usage = totalUsage(members)
    const usageReported = members.some((phase) => phase.usageReported)
    const elapsed = members.map((phase) => phaseElapsed(phase, now)).filter((value): value is number => value !== undefined)
    const statusCounts = (["running", "completed", "failed", "pending", "skipped"] as const)
      .map((item) => [item, members.filter((phase) => phase.status === item).length] as const)
      .filter(([, count]) => count > 0)
      .map(([item, count]) => `${count} ${groupStatusLabel(item)}`)
      .join(" · ")

    const meta: TextChunk[] = []
    if (elapsed.length > 0) meta.push(fg(theme.faint)("wall "), fg(theme.dim)(formatElapsed(Math.max(...elapsed))), fg(theme.faint)(" · "))
    meta.push(
      fg(theme.faint)("cost "),
      fg(theme.dim)(usageReported ? formatMoney(usage.cost) : "—"),
      fg(theme.faint)(" · tokens "),
      fg(theme.dim)(usageReported ? `↑${formatCount(usage.tokens.input)} ↓${formatCount(usage.tokens.output)}` : "—"),
    )

    return [
      new StyledText(head),
      new StyledText([fg(theme.dim)(truncate(statusCounts, Math.max(20, width)))]),
      new StyledText(meta),
      t`${fg(theme.faint)("select a child row for full detail or OpenCode")}`,
    ]
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
    const capability = phaseCapabilityLabel(phase)
    if (capability) meta.push(fg(theme.cyan)(capability))
    const elapsed = phaseElapsed(phase, now)
    if (elapsed !== undefined) {
      if (meta.length > 0) meta.push(fg(theme.faint)(" · "))
      meta.push(fg(theme.faint)(running ? "elapsed " : "took "), fg(theme.dim)(formatElapsed(elapsed)))
    }
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
    const gate = this.humanReviewQueue[0]
    if (gate?.info.stepName === phase.name) {
      out.push(plain(""))
      out.push(new StyledText([fg(theme.yellow)(gate.info.kind === "interactive" ? "interactive session" : "human review"), fg(theme.faint)(" · choose from the dashboard shortcuts")]))
      out.push(new StyledText([fg(theme.accent)("c"), fg(theme.dim)(" continue pipeline   "), fg(theme.accent)("o"), fg(theme.dim)(" open OpenCode   "), fg(theme.accent)("a"), fg(theme.dim)(" abort")]))
      out.push(new StyledText([fg(theme.faint)("iterations "), fg(theme.dim)(String(gate.info.iterations))]))
    } else if (phase.status === "running" && this.interactiveTakeover.has(phase.name)) {
      out.push(plain(""))
      out.push(new StyledText([fg(theme.cyan)("interactive armed"), fg(theme.faint)(" · esc in OpenCode stops the agent; a gate opens here — "), fg(theme.accent)("i"), fg(theme.faint)(" disarms")]))
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
    const lines = this.reportSourceLines(phase, width)
    const maxScroll = Math.max(0, lines.length - visible)
    this.reportScroll = Math.max(0, Math.min(this.reportScroll, maxScroll))
    this.contentPosition = scrollPosition(this.reportScroll, maxScroll)
    return lines.slice(this.reportScroll, this.reportScroll + visible)
  }

  private reportSourceLines(phase: PhaseState, width: number): StyledText[] {
    if (!this.runDir) return [t`${fg(theme.dim)("report directory not ready yet…")}`]

    const report = this.reports.get(phase.name)
    if (!report) {
      this.loadReport(phase.name, this.runDir)
      return [t`${fg(theme.dim)("loading report…")}`]
    }
    if (report === "loading") return [t`${fg(theme.dim)("loading report…")}`]
    if (report === "missing") {
      if (phase.status === "skipped") return [t`${fg(theme.dim)("this step was skipped and wrote no report")}`]
      if (this.finished && phase.status === "pending") return [t`${fg(theme.dim)("this step did not run or write a report")}`]
      const done = phase.status === "completed" || phase.status === "failed"
      return [t`${fg(theme.dim)(done ? "this step wrote no report" : "no report yet — it appears once the step finishes")}`]
    }

    const wrapped = wrapLines(report, Math.max(20, width))
    return wrapped.map(styleSummaryLine)
  }

  // The logs tab: the focused phase's activity, newest first. Scoped to one
  // phase (the tab selector picks it), so there's no cross-phase label column —
  // just time, kind icon, and message, leaving more room for the message.
  private phaseFeedLines(phase: PhaseState | undefined, width: number, visible: number): StyledText[] {
    this.contentPosition = ""
    if (visible <= 0) return []
    if (!phase) return [t`${fg(theme.dim)("no step selected")}`]
    const lines = this.phaseFeedSourceLines(phase, width)
    const maxScroll = Math.max(0, lines.length - visible)
    this.logScroll = Math.max(0, Math.min(this.logScroll, maxScroll))
    this.contentPosition = scrollPosition(this.logScroll, maxScroll)
    return lines.slice(this.logScroll, this.logScroll + visible)
  }

  private phaseFeedSourceLines(phase: PhaseState, width: number): StyledText[] {
    const events = this.feed.filter((entry) => entry.phase === phase.name).reverse()
    if (events.length === 0) return [t`${fg(theme.dim)("no activity for this step yet…")}`]

    return events.map((entry) => {
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

  // A selected group compares each concrete child in an adaptive card grid:
  // side-by-side when there is room, stacked when the terminal is narrow. The
  // active tab determines the body of every card, so session/report/log content
  // can be scanned across models without cloning the entire dashboard chrome.
  private groupContentLines(
    selection: GroupSelection,
    members: PhaseState[],
    now: number,
    width: number,
    visible: number,
  ): StyledText[] {
    this.contentPosition = ""
    if (visible <= 0) return []

    const gap = 2
    const columnCount = comparisonColumnCount(width, members.length)
    const cardWidth = Math.max(20, Math.floor((width - gap * (columnCount - 1)) / columnCount))
    // Group selection is intentionally a comparison summary. A child row opens
    // the unabridged tab, while each card keeps a bounded preview so one verbose
    // model cannot push every sibling off screen.
    const previewRows = Math.max(1, Math.min(8, visible - 2))
    const allLines: StyledText[] = []

    for (let start = 0; start < members.length; start += columnCount) {
      const rowMembers = members.slice(start, start + columnCount)
      const cards = rowMembers.map((phase) => this.comparisonCardLines(selection, phase, now, cardWidth, previewRows))
      const rowHeight = Math.max(...cards.map((card) => card.length))
      for (let row = 0; row < rowHeight; row++) {
        allLines.push(mergeComparisonRow(cards.map((card) => card[row]), cardWidth, gap))
      }
      if (start + columnCount < members.length) allLines.push(plain(""))
    }

    const maxScroll = Math.max(0, allLines.length - visible)
    this.groupScroll = Math.max(0, Math.min(this.groupScroll, maxScroll))
    this.contentPosition = scrollPosition(this.groupScroll, maxScroll)
    return allLines.slice(this.groupScroll, this.groupScroll + visible)
  }

  private comparisonCardLines(
    selection: GroupSelection,
    phase: PhaseState,
    now: number,
    width: number,
    previewRows: number,
  ): StyledText[] {
    const baseLabel = selection.stepName === undefined ? phaseDisplayName(phase) : modelLabel(phase)
    const label = phase.plannedVariant ? `${baseLabel}#${phase.plannedVariant}` : baseLabel
    const right = phaseMetaWithCapability(phase, now)
    const labelBudget = Math.max(6, width - plainLen(right) - 8)
    const header = padBetween(
      [statusIcon(phase.status, now), raw(" "), bold(fg(theme.text)(truncate(label, labelBudget)))],
      right,
      width,
    )
    const divider = t`${fg(theme.faint)("─".repeat(width))}`
    const body =
      this.contentTab === "reports"
        ? this.reportSourceLines(phase, width)
        : this.contentTab === "session"
          ? this.sessionSourceLines(phase, width)
          : this.phaseFeedSourceLines(phase, width)
    const preview = this.contentTab === "session" ? body.slice(-previewRows) : body.slice(0, previewRows)
    return [header, divider, ...preview]
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
    const lines = this.sessionSourceLines(phase, width)
    const maxScroll = Math.max(0, lines.length - visible)
    this.sessionScroll = Math.max(0, Math.min(this.sessionScroll, maxScroll))
    const topOffset = maxScroll - this.sessionScroll
    this.contentPosition = scrollPosition(topOffset, maxScroll)
    // Measured from the bottom: 0 tails the live stream, scrolling up (keys or
    // wheel, focused or not) holds a position in history until scrolled back.
    return lines.slice(topOffset, topOffset + visible)
  }

  private sessionSourceLines(phase: PhaseState, width: number): StyledText[] {

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
    return lines
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
      const left: TextChunk[] = this.selectedGroup
        ? [
            fg(theme.dim)("["),
            fg(theme.accent)("↑↓"),
            fg(theme.dim)("] node · ["),
            fg(theme.accent)("enter"),
            fg(theme.dim)("] read · ["),
            fg(theme.accent)("←→"),
            fg(theme.dim)("] tab · select a child for session · ["),
            fg(theme.accent)("i"),
            fg(theme.dim)("] iterate · ["),
            fg(theme.accent)("g"),
            fg(theme.dim)("] lazygit · ["),
            fg(theme.accent)("q"),
            fg(theme.dim)("] close"),
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
            fg(theme.dim)("] session · ["),
            fg(theme.accent)("i"),
            fg(theme.dim)("] iterate · ["),
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

    const gate = this.humanReviewQueue[0]
    if (gate) {
      const left: TextChunk[] = [
        fg(theme.yellow)(gate.info.kind === "interactive" ? "interactive session · " : "human review · "),
        fg(theme.accent)("c"),
        fg(theme.dim)(" continue · "),
        fg(theme.accent)("o"),
        fg(theme.dim)(" open OpenCode · "),
        fg(theme.accent)("a"),
        fg(theme.dim)(" abort"),
      ]
      const right: TextChunk[] = []
      if (this.humanReviewQueue.length > 1) right.push(fg(theme.yellow)(`${this.humanReviewQueue.length - 1} more waiting`), fg(theme.faint)(" · "))
      if (gate.info.iterations > 0) right.push(fg(theme.faint)(`${gate.info.iterations} iteration${gate.info.iterations === 1 ? "" : "s"}`))
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
      : this.selectedGroup
        ? [
            fg(theme.dim)("["),
            fg(theme.accent)("↑↓"),
            fg(theme.dim)("] node · ["),
            fg(theme.accent)("enter"),
            fg(theme.dim)("] read · ["),
            fg(theme.accent)("←→"),
            fg(theme.dim)("] tab · select a child for OpenCode · "),
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
          fg(theme.dim)("] session · ["),
          fg(theme.accent)("i"),
          fg(theme.dim)("] interactive · "),
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

// Terminal wheel events arrive as mouse "scroll" with a direction and a tick
// count; normalized to a signed line delta (up = negative, like PgUp).
type WheelEvent = {
  scroll?: { direction: string; delta: number }
  preventDefault(): void
  stopPropagation(): void
}

function wheelDelta(event: WheelEvent): number {
  const scroll = event.scroll
  if (!scroll || (scroll.direction !== "up" && scroll.direction !== "down")) return 0
  const magnitude = Math.max(1, Math.round(scroll.delta || 1))
  return scroll.direction === "up" ? -magnitude : magnitude
}

function humanReviewActionForKey(key: KeyEvent): HumanReviewAction | undefined {
  switch (key.name) {
    case "c":
      return "continue"
    case "o":
      return "iterate"
    case "a":
      return "abort"
  }
  return undefined
}

function humanReviewActionLabel(action: HumanReviewAction, interactive: boolean) {
  const gate = interactive ? "interactive session" : "human review"
  switch (action) {
    case "continue":
      return `${gate}: continue`
    case "iterate":
      return `${gate}: open OpenCode`
    case "abort":
      return `${gate}: abort`
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
  for (const word of words) {
    const pieces = wrapLines([word], width)
    if (pieces.length > 1) {
      if (current) {
        lines.push(current)
        current = ""
      }
      lines.push(...pieces.slice(0, -1))
      const last = pieces[pieces.length - 1]!
      if (displayWidth(last) >= width) lines.push(last)
      else current = last
      continue
    }
    const piece = pieces[0] ?? ""
    if (!piece) continue
    if (!current) current = piece
    else if (displayWidth(current) + 1 + displayWidth(piece) <= width) current += ` ${piece}`
    else {
      lines.push(current)
      current = piece
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

// Elapsed/cost/skipped only — the capability badge renders separately (the
// tree degrades or dedupes it, the comparison cards keep it whole).
function phaseMetaChunks(phase: PhaseState, now: number): TextChunk[] {
  if (phase.status === "pending") return []
  if (phase.status === "skipped" && phase.restoredDurationMs === undefined) return [fg(theme.faint)("skipped")]
  const parts: TextChunk[] = []
  const elapsed = phaseElapsed(phase, now)
  if (elapsed !== undefined) parts.push(fg(phase.status === "failed" ? theme.red : theme.dim)(formatElapsed(elapsed)))
  // Live cost belongs to the current-step panel; a phase's final cost lands here once it ends.
  if (phase.usageReported && phase.status !== "running") parts.push(fg(theme.faint)(` ${formatMoney(phase.cost)}`))
  return parts
}

// The wide panes (comparison cards, detail header) show the full badge inline
// with the meta; only the narrow pipeline tree degrades it.
function phaseMetaWithCapability(phase: PhaseState, now: number): TextChunk[] {
  const meta = phaseMetaChunks(phase, now)
  const capability = phaseCapabilityLabel(phase)
  if (!capability) return meta
  const badge = fg(theme.cyan)(capability)
  return meta.length ? [badge, fg(theme.faint)(" · "), ...meta] : [badge]
}

export function phaseCapabilityLabel(phase: Pick<ProgressPhase, "readOnly">): string | undefined {
  return phase.readOnly ? "audit · read-only" : undefined
}

// The same badge in shrinking forms for the pipeline tree, longest first.
export function phaseCapabilityBadges(phase: Pick<ProgressPhase, "readOnly">): string[] {
  return phase.readOnly ? ["audit · read-only", "read-only", "ro"] : []
}

// The longest badge form that fits in `spare` columns (what a tree row has
// left after the marker, name, suffix and right-aligned meta), or none.
// `separated` accounts for the ` · ` joining the badge to meta that follows.
export function pickBadge(forms: readonly string[], spare: number, separated: boolean): string | undefined {
  return forms.find((form) => displayWidth(form) + (separated ? 3 : 0) <= spare)
}

function phaseElapsed(phase: PhaseState, now: number): number | undefined {
  return phase.restoredDurationMs ?? (phase.startedAt !== undefined ? (phase.endedAt ?? now) - phase.startedAt : undefined)
}

// Keyboard and mouse navigation follow the rendered tree, including group
// headers. Exported as a pure helper so its ordering cannot silently drift from
// the interaction model.
export function pipelineSelectionTargets(phases: readonly ProgressPhase[]): PipelineSelectionTarget[] {
  const targets: PipelineSelectionTarget[] = []
  for (const group of groupPhases(phases)) {
    if (group.length === 1) {
      targets.push({ kind: "phase", name: group[0]!.name })
      continue
    }

    const groupId = group[0]!.groupId!
    const stepGroups = chunkByStepName(group)
    if (stepGroups.length === 1) {
      targets.push({ kind: "group", groupId, stepName: stepLabel(group[0]!) })
      targets.push(...group.map((phase) => ({ kind: "phase" as const, name: phase.name })))
      continue
    }

    targets.push({ kind: "group", groupId })
    for (const members of stepGroups) {
      if (members.length === 1) targets.push({ kind: "phase", name: members[0]!.name })
      else {
        targets.push({ kind: "group", groupId, stepName: stepLabel(members[0]!) })
        targets.push(...members.map((phase) => ({ kind: "phase" as const, name: phase.name })))
      }
    }
  }
  return targets
}

// The tree node auto-follow should rest on for an active phase: the top header
// of its concurrent group (the `parallel` header for a block of distinct
// steps, the step header for a pure `models:` fan-out), or undefined for a
// phase that runs alone. Exported for the same reason as
// pipelineSelectionTargets: it must not drift from the rendered tree.
export function autoFollowGroup(phases: readonly ProgressPhase[], active: Pick<ProgressPhase, "name" | "stepName" | "groupId">): GroupSelection | undefined {
  if (!active.groupId) return undefined
  const members = phases.filter((phase) => phase.groupId === active.groupId)
  if (members.length < 2) return undefined
  return chunkByStepName(members).length === 1
    ? { kind: "group", groupId: active.groupId, stepName: stepLabel(active) }
    : { kind: "group", groupId: active.groupId }
}

function samePipelineTarget(left: PipelineSelectionTarget, right: PipelineSelectionTarget): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "phase" && right.kind === "phase") return left.name === right.name
  return left.kind === "group" && right.kind === "group" && left.groupId === right.groupId && left.stepName === right.stepName
}

// At least 28 cells keeps each comparison lane readable. More than three
// simultaneous lanes becomes harder to scan than a second row of cards.
export function comparisonColumnCount(width: number, itemCount: number): number {
  const byWidth = Math.max(1, Math.floor((Math.max(1, width) + 2) / 30))
  return Math.max(1, Math.min(Math.max(1, itemCount), 3, byWidth))
}

function mergeComparisonRow(lines: Array<StyledText | undefined>, width: number, gap: number): StyledText {
  const chunks: TextChunk[] = []
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(raw(" ".repeat(gap)))
    const fitted = fitTextChunks(line?.chunks ?? [], width)
    chunks.push(...fitted.chunks)
    if (fitted.length < width) chunks.push(raw(" ".repeat(width - fitted.length)))
  })
  return new StyledText(chunks)
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function fitTextChunks(chunks: readonly TextChunk[], width: number): { chunks: TextChunk[]; length: number } {
  const out: TextChunk[] = []
  let length = 0
  for (const chunk of chunks) {
    if (length >= width) break
    let text = ""
    for (const part of graphemeSegmenter.segment(chunk.text)) {
      const partWidth = displayWidth(part.segment)
      if (length + partWidth > width) {
        if (text) out.push({ ...chunk, text })
        return { chunks: out, length }
      }
      text += part.segment
      length += partWidth
    }
    if (text) out.push({ ...chunk, text })
  }
  return { chunks: out, length }
}

// Consecutive phases sharing a defined groupId form one concurrent group; a
// human gate (no groupId) or a plain sequential step is a group of one.
function groupPhases<T extends Pick<ProgressPhase, "groupId">>(phases: readonly T[]): T[][] {
  const groups: T[][] = []
  for (const phase of phases) {
    const last = groups[groups.length - 1]
    if (phase.groupId && last && last[0]!.groupId === phase.groupId) last.push(phase)
    else groups.push([phase])
  }
  return groups
}

// Splits a group into its distinct logical steps: a pure `models:` fan-out is
// one step (every member shares a stepName), a `parallel:` block is several.
function chunkByStepName<T extends Pick<ProgressPhase, "name" | "stepName">>(group: readonly T[]): T[][] {
  const chunks: T[][] = []
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
  return chunks.reduce((count, chunk) => count + displayWidth(chunk.text), 0)
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

function groupStatusLabel(status: PhaseStatus): string {
  switch (status) {
    case "running":
      return "running"
    case "completed":
      return "done"
    case "failed":
      return "failed"
    case "skipped":
      return "skipped"
    default:
      return "scheduled"
  }
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
function stepLabel(phase: Pick<ProgressPhase, "name" | "stepName">): string {
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

async function fileReadable(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
