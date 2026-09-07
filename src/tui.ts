import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import {
  BoxRenderable,
  ScrollBarRenderable,
  StyledText,
  TextRenderable,
  bg,
  bold,
  createCliRenderer,
  fg,
  t,
} from "@opentui/core"

import { defaultAdvisorMaxCalls } from "./advisor"
import { openClaudeSessionWindow } from "./claude-code"
import { aggregateAdvisorEvents, type AdvisorEvent } from "./advisor-events"
import { copyReportToClipboard, writeClipboardOSC52, type ClipboardResult } from "./clipboard"
import { parseGoalInvocationId } from "./goal-scheduler"
import { openRouterLowBalance, startLimitsPoller } from "./limits"
import { log } from "./log"
import { markdownInlineChunks, markdownLines, parseMarkdown, renderMarkdownDoc, type MarkdownDoc } from "./markdown-render"
import { openIterateOpencodeWindow, openOpencodeSessionWindow, openStoredSessionWindow, type SessionWindowBackend } from "./opencode"
import { formatTerminalTitle } from "./run-status"
import { compactRunRowName } from "./runner"
import { stepRunnerFor, type StepRunnerId } from "./step-runners"
import { autoAcceptModeLabel, comparePaletteActions, dashboardActions, shortcutGroupOrder, shortcutGroupTitle } from "./tui-actions"
import { PhaseUsage, addTokens, emptyTokens } from "./usage"
import {
  formatAgo,
  formatCount,
  formatElapsed,
  formatMoney,
  formatTime,
  fmtCountdown,
  clipChunks,
  chunksLength,
  displayWidth,
  hintsRow,
  indentStyled,
  joinLines,
  moreHintsMarker,
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
  terminalBackgroundHex,
  theme,
  truncate,
  wrapLines,
} from "./tui-theme"
import { shortVersion } from "./version"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { BoxOptions, CliRenderer, KeyEvent, Selection, TextChunk } from "@opentui/core"
import type { LimitsSnapshot } from "./limits"
import type { Action, ActionID, DashboardActionState } from "./tui-actions"
import type { Hint, OverflowHint, PaletteColor, PhaseStatus } from "./tui-theme"
import type {
  ActivityKind,
  AutoAccept,
  AutoAcceptMode,
  GoalLoopView,
  PermissionPromptInfo,
  PermissionReply,
  ProgressAttempt,
  ProgressDiffSummary,
  HumanReviewAction,
  HumanReviewPromptInfo,
  ProgressHostControls,
  ProgressMessage,
  ProgressMessageChannel,
  ProgressPhase,
  ProgressPhaseSnapshot,
  ProgressStepUsage,
  ProgressTodo,
  ProgressTokens,
  ProgressUI,
  ProgressUsage,
  KeepAwakeState,
  RunControlState,
  RunOutcome,
  RunStatus,
  PublishPlan,
  PublishSeam,
} from "./progress"
import type { Pipeline } from "./types"

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

const feedLimit = 100
// A log message wraps rather than being cut off at one row, but one verbose
// entry must not push every other event off screen (nor swallow a comparison
// card's preview), so the tail past this many rows is elided.
const maxFeedRowsPerEvent = 3
const contentTabBarRows = 2
// Side-by-side panels become too cramped around a conventional 80-column
// terminal, so the dashboard switches to a stacked, single-column layout.
const compactDashboardMaxWidth = 84

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
        ? openStoredSessionWindow({ targetDir: context.targetDir, sessionID: context.sessionID, runDir: context.runDir })
        : undefined,
  "claude-code": (context) => openClaudeSessionWindow({ targetDir: context.targetDir, sessionID: context.sessionID, runDir: context.runDir }),
}

// The right-hand content panel is a three-tab view of the focused phase.
export type ContentTab = "logs" | "reports" | "session" | "advisor"
const contentTabOrder: readonly ContentTab[] = ["session", "reports", "logs", "advisor"]
const commandContentTab: Record<"tab-session" | "tab-reports" | "tab-logs" | "tab-advisor", ContentTab> = {
  "tab-session": "session",
  "tab-reports": "reports",
  "tab-logs": "logs",
  "tab-advisor": "advisor",
}

type FullscreenView = {
  phase: string
  tab: ContentTab
  scroll: number
  copyStatus?: ClipboardResult
}

type CommandPalette = {
  filter: string
  index: number
  view: "commands" | "help"
  /** First visible body row: the shortcut table outgrows a short terminal. */
  scroll: number
}

/** An action the palette can actually run — `label` is what makes it runnable. */
type CommandItem = Action & { label: string }

/**
 * The `Create pull request` flow on the finish screen (capability
 * run-finalization, design D5): the sole publication action, replacing the
 * removed finish modal. "working" covers the push and the `gh` calls, which
 * run with the terminal handed back so credential prompts can answer; while it
 * is up every key is swallowed, so a stray keystroke can't start a second push.
 */
type PublishModal =
  | { kind: "working"; message: string }
  | { kind: "blocked"; message: string }
  | { kind: "confirm"; plan: PublishPlan }
  | { kind: "done"; plan: PublishPlan; outcome: { pushed: boolean; url?: string }; note?: string }

function clipboardStatusLabel(status?: ClipboardResult): string {
  if (status === "copied-native" || status === "copied-osc52") return " · copied"
  if (status === "unsupported") return " · terminal clipboard (OSC52) unavailable"
  if (status === "transport-failed") return " · couldn't copy report; report is too large for this terminal transport"
  return ""
}

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
  advisorEvents: AdvisorEvent[]
}

type FeedEntry = {
  time: number
  phase: string
  kind: ActivityKind
  message: string
}

// One contiguous span of a phase's live transcript. Reasoning/response blocks
// grow as their verbatim deltas arrive; tool/bash blocks are single markers.
// `id` is the provider-side part the block came from: deltas only extend the
// open block while the id matches, so two reasoning summaries never merge into
// one paragraph. `lines` memoizes the block's wrapped output — every render
// re-derives the whole transcript, and only the block still streaming changes.
type TranscriptBlock = {
  channel: ProgressMessageChannel
  text: string
  id?: string
  lines?: { key: string; value: StyledText[] }
}

// Keep only the newest slice of a phase's stream in memory: reasoning can run
// to tens of thousands of characters, and the session tab only ever tails it.
const transcriptCap = 24_000

// The animation ticker's period. Deliberately shorter than the spinner's 100ms
// step (see spinnerFrame) so no frame of the rotation is ever skipped; the
// repaint it drives is cheap because the transcript, report and feed panels
// memoize their wrapped lines.
const animationTickMs = 80

type PermissionExplainState =
  | { status: "loading" }
  | { status: "ready"; lines: string[]; scroll: number }
  | { status: "error"; message: string }

type PendingPermission = {
  info: PermissionPromptInfo
  resolve: (reply: PermissionReply) => void
  /** State of [e]; absent until the user requests it. */
  explain?: PermissionExplainState
  /** Aborts an in-flight explanation when the request is answered or the queue is drained. */
  explainAbort?: AbortController
  /** Result of [i], for in-modal feedback (the feed is hidden behind the overlay). */
  inspect?: { backend?: SessionWindowBackend; error?: string }
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
  options?: {
    offlineSessions?: boolean
    observer?: boolean
    mode?: TuiDashboardMode
    /** Ctrl+C behavior on this dashboard: abort (first auto-attach) or detach (menu attach). */
    ctrlC?: "abort" | "detach"
    /** Shared renderer/session when reached from the zero-argument home UI. */
    route?: TuiRoute
  } & ProgressHostControls,
): Promise<ProgressUI> {
  if (options?.route) {
    const scene = sceneForRoute(options.route, "convoy-dashboard-scene")!
    return new TuiProgress(
      options.route.session.renderer,
      phases,
      onAbort,
      autoAccept,
      options.offlineSessions ?? false,
      options.observer ?? false,
      initialContentTab(options.mode ?? "live"),
      copyReportToClipboard,
      options.onPauseToggle,
      options.onKeepAwakeToggle,
      options.onBackground,
      options.onCycleAutoAccept,
      options.ctrlC,
      options.publish,
      scene,
    )
  }
  // No backgroundColor yet: the palette is only chosen after the terminal
  // answers the background query, so a light terminal never flashes dark.
  // No targetFps: opentui only honours it while its own loop runs (start() /
  // requestLive()), which convoy never starts — frames come on demand from
  // requestRender instead, and the cadence is the animation ticker's.
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
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
    copyReportToClipboard,
    options?.onPauseToggle,
    options?.onKeepAwakeToggle,
    options?.onBackground,
    options?.onCycleAutoAccept,
    options?.ctrlC,
    options?.publish,
  )
}

export class TuiProgress implements ProgressUI {
  private stopped = false
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
  private phases: PhaseState[]
  private readonly feed: FeedEntry[] = []
  // The live model transcript per phase (the session tab): verbatim reasoning
  // and response text, interleaved with tool/bash action markers. Streamed in
  // via phaseMessage and repainted on the animation ticker, not per delta.
  private readonly transcripts = new Map<string, TranscriptBlock[]>()
  private readonly ticker: ReturnType<typeof setInterval>
  // Set by scheduleRender(); drained once per opentui frame by flushRender.
  // Collapses a burst of agent events (N parallel phases each streaming) into a
  // single repaint per frame instead of one full rebuild per event.
  private dirty = false
  // When the screen was last rebuilt, so the animation ticker can idle instead
  // of repainting a dashboard where nothing moves.
  private lastRenderAt = 0
  // Subscription meters (GPT windows, OpenRouter credits) polled in the
  // background; the ticker just repaints whatever the last poll left.
  private readonly stopLimits: () => void
  /** @internal — tests inject snapshots directly instead of running the poller. */
  private limits?: LimitsSnapshot
  private readonly dirText: TextRenderable
  private readonly headerBox: BoxRenderable
  private readonly headerText: TextRenderable
  private readonly bodyBox: BoxRenderable
  private readonly pipelineBox: BoxRenderable
  private readonly pipelineText: TextRenderable
  private readonly rightBox: BoxRenderable
  // The detail panel: header (name, status, model, cost, tokens, diff) of the
  // one focused phase. A single pane now — concurrent phases are browsed via
  // the pipeline tab selector rather than each getting their own live pane.
  private readonly stepBox: BoxRenderable
  private readonly stepText: TextRenderable
  private readonly todosBox: BoxRenderable
  private readonly todosText: TextRenderable
  private readonly feedBox: BoxRenderable
  private readonly feedText: TextRenderable
  private readonly footerBox: BoxRenderable
  private readonly footerText: TextRenderable
  // Rebuilt on every pipeline render: panel row index → selectable tree target,
  // so group headers and concrete phases both resolve exactly as rendered.
  private pipelineRowTargets: (PipelineSelectionTarget | undefined)[] = []
  private readonly overlay: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  private readonly reportOverlay: BoxRenderable
  private readonly reportOverlayText: TextRenderable
  private readonly fullscreenScrollbar: ScrollBarRenderable
  // Panels repainted when the terminal reports a theme change mid-run.
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []
  private readonly permissionQueue: PendingPermission[] = []
  // Gates queue because parallel phases can both be armed with [i]; the head
  // entry owns the c/o/a keys, the rest wait their turn.
  private readonly humanReviewQueue: PendingHumanReview[] = []
  // Phases the user armed with [i]: the runner checks this set (via
  // isInteractiveTakeover) and gates instead of retrying or completing.
  private readonly interactiveTakeover = new Set<string>()
  // Completed phases whose (still-empty) session tab already asked the attach
  // runtime for a transcript backfill — one attempt per phase, mirroring
  // loadReport's laziness, so an attached dashboard can read steps that ran
  // before it attached without bursting a fetch per phase at open time.
  // resetPipeline clears it with the rest of the per-run state: a hosted run's
  // next iteration may reuse a phase name, and its completed steps deserve a
  // fresh backfill attempt of their own.
  private readonly sessionBackfillRequested = new Set<string>()
  private permissionChoice = 0
  // Suspension nests: outer scopes (human-review gate) and inner prompts may
  // both suspend; only the outermost transition touches the renderer.
  private suspendDepth = 0
  private finished?: FinishState
  // The goal loop's live view, painted by setGoalLoop and copied into the
  // finish state so the verdict and trajectory survive the hold.
  private goalLoop?: GoalLoopView
  // A subshell (lazygit / git log) owns the terminal while the renderer is
  // suspended; every key must reach it untouched.
  private inSubshell = false
  // The goal loop swaps this per run: each iteration's shutdown while it runs,
  // the loop's own between runs. Falls back to the constructor handler.
  private abortHandler?: () => void
  // Host callbacks (pause, keep-awake, finish seam), refreshed per hosted run.
  private hostControls: ProgressHostControls = {}
  // The goal loop's pipeline panel title carries the iteration's pipeline name.
  private pipelineName = ""
  // Usage accumulated across goal-loop iterations, so the header's cost/token
  // totals keep running even though resetPipeline replaces the phases.
  private priorUsage = {
    cost: 0,
    tokens: emptyTokens(),
    advisorCost: 0,
    advisorInput: 0,
    advisorOutput: 0,
    advisorAttempted: false,
  }
  // Phase reports read lazily from the run dir; the cache entry is dropped when
  // a phase finishes so a report written mid-run is picked up on the next view.
  private readonly reports = new Map<string, string[] | "loading" | "missing">()
  // Wrapped output for the reports on screen (see wrappedReport) and for each
  // phase's activity feed (see phaseFeedSourceLines). Keyed rather than single
  // slots because a selected group renders one card per member on every frame,
  // and single slots would have the members evicting each other — a miss now
  // costs a full re-lex, not just a re-wrap. The report memo is keyed on the
  // source array's identity, which is what `loadReport` swaps to invalidate it.
  // Each parsed document retains wraps for every active width so the inline
  // panel and fullscreen reader cannot evict one another each frame.
  private readonly reportLines = new WeakMap<string[], { doc: MarkdownDoc; values: Map<number, StyledText[]> }>()
  private readonly feedLines = new Map<string, { width: number; revision: number; value: StyledText[] }>()
  // Bumped by addEvent; keys the feed memo above.
  private feedRevision = 0
  private fullscreen?: FullscreenView
  private controlState: RunControlState = "running"
  private controlActivePhases = 0
  private keepAwake?: KeepAwakeState
  private commandPalette?: CommandPalette
  private usageModal = false
  private publishModal?: PublishModal
  // The palette's "Abort the run" confirm on a menu-opened controller. Default
  // No — a stray key must never kill the coordinator.
  private abortConfirm = false
  // ScrollBarRenderable emits change events for programmatic state updates as
  // well as mouse drags. Ignore the former so a layout recalculation cannot
  // overwrite the reader's just-computed scroll position.
  private syncingFullscreenScrollbar = false
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
    if (this.contentTab !== "logs" && this.contentTab !== "session" && this.contentTab !== "reports" && this.contentTab !== "advisor") return
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

  private readonly handleFullscreenWheel = (event: WheelEvent) => {
    const delta = wheelDelta(event)
    if (!this.fullscreen || delta === 0) return
    event.preventDefault()
    event.stopPropagation()
    this.scrollFullscreen(delta)
    this.scheduleRender()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    if (this.inSubshell) return
    if (this.abortConfirm) {
      // The abort confirm modal owns the keyboard while it is up (same as the
      // finish modal). Default No: only a deliberate "y" confirms — a stray
      // Enter, Ctrl+C, or any other key cancels, so reflexive keypresses can't
      // kill the coordinator.
      key.preventDefault()
      key.stopPropagation()
      if (key.name === "y") {
        this.abortConfirm = false
        this.addEvent("convoy", "system", "abort confirmed; shutting down")
        this.render()
        ;(this.abortHandler ?? this.onAbort)?.()
      } else {
        this.abortConfirm = false
        this.render()
      }
      return
    }
    if ((key.ctrl && key.name === "c") || key.raw === "\u0003") {
      key.preventDefault()
      key.stopPropagation()
      this.scene?.requestInterrupt()
      // After the run ended Ctrl+C just dismisses the finish screen; aborting
      // a finished run would only race the cleanup it already triggers.
      if (this.finished) {
        this.finished.resolve()
        return
      }
      // A menu-opened controller detaches to the runs menu instead of aborting
      // (abort lives in the palette under a confirm modal). The first auto-attach
      // keeps today's muscle memory: Ctrl+C aborts.
      if (this.ctrlC === "detach" && this.hostControls.onBackground) {
        this.addEvent("convoy", "system", "ctrl+c received; detaching to the runs menu")
        this.render()
        void this.hostControls.onBackground?.()
        return
      }
      this.addEvent("convoy", "system", "ctrl+c received; shutting down")
      this.render()
      ;(this.abortHandler ?? this.onAbort)?.()
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
    if (this.fullscreen) {
      this.handleFullscreenKey(key)
      return
    }
    if (this.humanReviewQueue.length > 0 && this.handleHumanReviewKey(key)) return
    if (this.humanReviewQueue.length > 0) {
      // A review gate must not be hidden behind the command palette, but keep
      // the existing non-gate navigation (including [p] pause) available.
      if (key.ctrl && key.name === "p") {
        key.preventDefault()
        key.stopPropagation()
      } else {
        this.handleNavKey(key)
      }
      return
    }
    // Above the palette: publication is a deliberate act, and it must not be
    // possible to stack another modal (or a second [f]) on top of one in flight.
    if (this.publishModal) {
      this.handlePublishKey(key)
      return
    }
    // Read-only info modal: anything closes it; [u] toggles, esc also exits
    // content focus so the modal doesn't leave a hidden focus state behind.
    if (this.usageModal) {
      this.usageModal = false
      this.render()
      return
    }
    if (this.commandPalette) {
      this.handleCommandPaletteKey(key)
      return
    }
    if (key.ctrl && key.name === "p") {
      key.preventDefault()
      key.stopPropagation()
      this.openCommandPalette()
      return
    }
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
    // Ctrl+P is handled above as the command palette. Other modified keystrokes
    // must never accidentally trigger their unmodified dashboard shortcut.
    if (key.ctrl || key.meta || key.option || key.super || key.hyper) return
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
        this.openActiveSessionWindow()
        return
      case "u":
        consume()
        this.openUsageModal()
        return
      case "v":
        if (!this.selectedGroup) {
          consume()
          this.openFullscreenView()
        }
        return
      case "i":
        consume()
        // The same key shifts meaning with the run: mid-run it takes over the
        // live session, on the finish screen it iterates in a fresh one.
        if (this.finished) void this.openIterateWindow()
        else this.toggleInteractiveTakeover()
        return
      case "p":
        if (finished) return
        consume()
        if (this.observer) {
          this.addEvent(this.focusedPhase()?.name ?? "convoy", "system", "pause isn't available while attached read-only")
          this.render()
          return
        }
        if (this.hostControls.onPauseToggle) this.hostControls.onPauseToggle()
        return
    }
    // Digit keys jump straight to a content tab (1 session · 2 reports · 3 logs · 4 advisor).
    const digitTab: Record<string, ContentTab> = { "1": "session", "2": "reports", "3": "logs", "4": "advisor" }
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
      } else if (key.name === "f" && this.hostControls.publish) {
        consume()
        void this.openPublishModal()
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

  private openFullscreenView() {
    const phase = this.focusedPhase()
    if (!phase) return
    const tab = this.contentTab
    const scroll = tab === "session" ? Number.MAX_SAFE_INTEGER : tab === "reports" ? this.reportScroll : this.logScroll
    this.fullscreen = { phase: phase.name, tab, scroll }
    if (tab === "reports" && !this.reports.get(phase.name) && this.runDir) this.loadReport(phase.name, this.runDir)
    this.render()
  }

  private handleFullscreenKey(key: KeyEvent) {
    const view = this.fullscreen
    if (!view) return
    key.preventDefault()
    key.stopPropagation()
    const page = Math.max(1, this.renderer.height - 5)
    let scroll = false
    switch (key.name) {
      case "up":
      case "k":
        this.scrollFullscreen(-1)
        scroll = true
        break
      case "down":
      case "j":
        this.scrollFullscreen(1)
        scroll = true
        break
      case "pageup":
        this.scrollFullscreen(-page)
        scroll = true
        break
      case "pagedown":
      case "space":
        this.scrollFullscreen(page)
        scroll = true
        break
      case "home":
        view.scroll = 0
        scroll = true
        break
      case "end":
        view.scroll = Number.MAX_SAFE_INTEGER
        scroll = true
        break
      case "g":
        view.scroll = key.shift ? Number.MAX_SAFE_INTEGER : 0
        scroll = true
        break
      case "c": {
        if (view.tab === "reports") {
          const report = this.reports.get(view.phase)
          if (Array.isArray(report)) {
            view.copyStatus = undefined
            void this.copyReport(report.join("\n"), writeClipboardOSC52).then((result) => {
              if (this.fullscreen === view) {
                view.copyStatus = result
                this.render()
              }
            })
          }
        }
        break
      }
      case "v":
      case "q":
      case "escape":
        this.fullscreen = undefined
        break
    }
    if (scroll) this.scheduleRender()
    else this.render()
  }

  private scrollFullscreen(delta: number) {
    const view = this.fullscreen
    if (!view) return
    view.scroll = Math.max(0, view.scroll + delta)
  }

  constructor(
    private readonly renderer: CliRenderer,
    phases: readonly ProgressPhase[],
    private readonly onAbort?: () => void,
    // Shared reference: the dashboard cycles `.mode` with shift+tab, and the
    // hosted runner reads this same object for the permission gate, so one
    // toggle reaches both surfaces.
    readonly autoAccept?: AutoAccept,
    // When true (a re-opened finished run), [o] opens the phase's stored
    // session from disk rather than attaching to a (nonexistent) live server.
    private readonly offlineSessions = false,
    // When true (attached read-only to another process's run), [i] is refused:
    // no runner reads this dashboard's takeover set.
    private readonly observer = false,
    initialTab: ContentTab = "session",
    private readonly copyReport = copyReportToClipboard,
    onPauseToggle?: () => void,
    onKeepAwakeToggle?: () => void,
    onBackground?: () => void | Promise<void>,
    onCycleAutoAccept?: (mode: AutoAcceptMode) => void,
    private readonly ctrlC: "abort" | "detach" = "abort",
    publishSeam?: PublishSeam,
    private readonly scene?: TuiScene,
  ) {
    this.contentTab = initialTab
    this.hostControls = {
      onPauseToggle,
      onKeepAwakeToggle,
      ...(onBackground ? { onBackground } : {}),
      ...(onCycleAutoAccept ? { onCycleAutoAccept } : {}),
      publish: publishSeam,
    }
    const mount = this.scene?.root ?? renderer.root
    this.phases = pendingPhases(phases)

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
    // bordered box. The header itself is one status row; a second row appears
    // for goal-loop progress or hot subscription meters (see headerContent).
    const dirLine = new TextRenderable(renderer, {
      id: "convoy-dir",
      content: "",
      fg: theme.text,
      width: "100%",
      height: 1,
    })

    const header = this.panel({
      id: "convoy-header",
      height: 3,
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
      width: this.pipelineWidth(),
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

    // The detail panel shows the focused phase. Clicks here used to open that
    // phase's opencode session, which fired on accidental clicks while reading;
    // the session opens via [o] or the command palette instead.
    const step = this.panel({
      id: "convoy-step",
      width: "100%",
      height: 8,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " step ",
      titleAlignment: "left",
    })

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
    })

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

    // The footer brands the run in its border title (◆ convoy + version,
    // right-aligned like the other panels' titles) and holds the key hints.
    const footer = this.panel({
      id: "convoy-footer",
      height: 3,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      titleAlignment: "right",
    })

    this.dirText = dirLine
    this.headerBox = header.box
    this.headerText = header.text
    this.bodyBox = body
    this.pipelineBox = pipeline.box
    this.pipelineText = pipeline.text
    this.rightBox = right
    this.stepBox = step.box
    this.stepText = step.text
    this.todosBox = todos.box
    this.todosText = todos.text
    this.feedBox = feed.box
    this.feedText = feed.text
    this.footerBox = footer.box
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
    mount.add(shell)

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
    mount.add(this.overlay)
    this.paletteTargets.push({ box: this.modal, background: "overlay", border: "yellow" })

    this.reportOverlay = new BoxRenderable(renderer, {
      id: "convoy-report-overlay",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 90,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.overlay,
      title: " report ",
      titleAlignment: "left",
      paddingX: 2,
      paddingY: 1,
      visible: false,
    })
    this.reportOverlayText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    this.reportOverlay.add(this.reportOverlayText)
    this.fullscreenScrollbar = new ScrollBarRenderable(renderer, {
      id: "convoy-fullscreen-scrollbar",
      position: "absolute",
      top: 2,
      right: 2,
      width: 1,
      height: Math.max(1, renderer.height - 4),
      orientation: "vertical",
      trackOptions: { backgroundColor: theme.faint, foregroundColor: theme.accent },
      onChange: (scroll) => {
        if (this.syncingFullscreenScrollbar || !this.fullscreen) return
        this.fullscreen.scroll = scroll
        this.scheduleRender()
      },
    })
    this.reportOverlay.add(this.fullscreenScrollbar)
    mount.add(this.reportOverlay)
    this.paletteTargets.push({ box: this.reportOverlay, background: "overlay", border: "accent" })

    // The full-screen reader owns the wheel just as the inline content panel
    // does. Attach to both the frame and text child because terminals can send
    // a wheel event to either depending on the pointer's exact cell.
    this.reportOverlay.onMouseScroll = this.handleFullscreenWheel
    this.reportOverlayText.onMouseScroll = this.handleFullscreenWheel

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("selection", this.handleSelection)
    renderer.on("theme_mode", this.handleThemeMode)

    this.ticker = setInterval(this.animationTick, animationTickMs)
    // Coalesced repaints run here, once per frame, driven by scheduleRender's
    // requestRender. The ticker animates the spinner when nothing is dirty.
    renderer.setFrameCallback(this.flushRender)
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
    this.scheduleRender()
  }

  serverReady(url: string) {
    this.serverUrl = url
    this.addEvent("convoy", "system", `opencode server at ${url}`)
    this.scheduleRender()
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
    this.scheduleRender()
  }

  phaseAttempt(name: string, info: ProgressAttempt) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.attempt = info.attempt
    if (info.model) phase.model = info.model
    phase.updatedAt = Date.now()
    this.activePhase = name
    this.addEvent(name, "step", `attempt ${info.attempt}${info.model ? ` · ${info.model}` : ""}`)
    this.scheduleRender()
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
    this.scheduleRender()
  }

  phaseActivity(name: string, detail: string, kind: ActivityKind = "info", pulse = false) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.now = { kind, message: detail }
    phase.updatedAt = Date.now()
    this.activePhase = name
    if (pulse) this.lastActivityAt = Date.now()
    else this.addEvent(name, kind, detail)
    this.scheduleRender()
  }

  // Appends a raw slice of the model's stream to the phase's transcript.
  // Deliberately does NOT render: text deltas arrive many-per-second, so the
  // animation ticker repaints the session tab instead of paying a layout pass
  // per delta. Bumping updatedAt keeps the "idle" detector honest between the
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
    // Consecutive deltas of the same channel *and* the same provider part are
    // one paragraph; anything else (a channel switch, the next reasoning
    // summary, or a tool/bash marker) starts a fresh block.
    if (streaming && last && last.channel === message.channel && last.id === message.partID) {
      last.text += message.text
      last.lines = undefined
    } else {
      blocks.push({ channel: message.channel, text: message.text, id: message.partID })
    }
    capTranscript(blocks)
    phase.updatedAt = Date.now()
  }

  phaseStepUsage(name: string, usage: ProgressStepUsage) {
    const phase = this.findPhase(name)
    if (!phase || !phase.usage.addStep(usage)) return

    phase.lastStepModel = usage.model || phase.lastStepModel
    phase.updatedAt = Date.now()
    this.recalculateUsage(phase)
    this.scheduleRender()
  }

  phaseUsageTotal(name: string, usage: ProgressUsage) {
    const phase = this.findPhase(name)
    if (!phase) return

    phase.usage.setTotal(usage)
    if (usage.model) phase.lastStepModel = usage.model
    phase.updatedAt = Date.now()
    this.recalculateUsage(phase)
    this.scheduleRender()
  }

  phaseAdvisorEvent(name: string, event: AdvisorEvent) {
    const phase = this.findPhase(name)
    if (!phase || phase.advisorEvents.some((existing) => existing.id === event.id)) return
    phase.advisorEvents.push(event)
    phase.updatedAt = Date.now()
    this.scheduleRender()
  }

  phaseTodos(name: string, todos: ProgressTodo[]) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.todos = todos
    phase.updatedAt = Date.now()
    this.scheduleRender()
  }

  phaseDiff(name: string, summary: ProgressDiffSummary) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.diff = summary
    phase.updatedAt = Date.now()
    this.scheduleRender()
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
    if (snapshot.advisorEvents) phase.advisorEvents = [...snapshot.advisorEvents]
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
    this.scheduleRender()
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
      this.addEvent(
        info.stepName,
        "permission",
        info.kind === "failure"
          ? "step failed — waiting for your decision"
          : info.kind === "budget-gate"
            ? "step budget reached — waiting for your decision"
            : info.kind === "interactive"
              ? "interactive session — waiting for your decision"
              : "waiting for human review action",
      )
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
      for (const pending of this.permissionQueue.splice(0)) {
        pending.explainAbort?.abort()
        pending.resolve("reject")
      }
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

  private markIterateRequested(): void {
    if (this.iterateRequested) return
    this.iterateRequested = true
    this.hostControls.onKeepRunDirRequested?.()
  }

  runControlState(state: RunControlState, activePhases: number): void {
    const previous = this.controlState
    this.controlState = state
    this.controlActivePhases = activePhases
    if (previous === "running" && state === "running") return
    const message = state === "pausing" ? `pausing · waiting for current batch (${activePhases} active)` : state === "paused" ? "paused · p resume" : "pipeline resumed"
    this.addEvent("convoy", "system", message)
    this.render()
  }

  keepAwakeState(state: KeepAwakeState): void {
    const previous = this.keepAwake
    this.keepAwake = state
    if (previous && (previous.status !== state.status || state.detail)) {
      const message = state.detail ?? (state.status === "on" ? "Caffeinate on — preventing display and idle sleep" : "Caffeinate off")
      this.addEvent("convoy", state.detail ? "error" : "system", message)
    }
    this.render()
  }

  /**
   * Publishes the run state to the terminal's window/tab title, and nothing
   * else: the dashboard itself never changes appearance because of this.
   *
   * Routed through OpenTUI rather than a raw OSC write to stdout, because the
   * renderer owns that stream in alternate-screen mode — setTerminalTitle goes
   * down the same native path as the paint, so the two cannot interleave.
   */
  runStatus(status: RunStatus): void {
    if (this.renderer.isDestroyed) return
    this.renderer.setTerminalTitle(formatTerminalTitle(status))
  }

  setGoalLoop(view: GoalLoopView): void {
    this.goalLoop = view
    this.scheduleRender()
  }

  setAbortHandler(handler?: () => void): void {
    this.abortHandler = handler
  }

  setHostControls(controls: ProgressHostControls): void {
    // Merge so a live attach can add pause/background without dropping a
    // finish seam that was already wired, and so a goal-loop hold can install
    // [f] without wiping the rest of the host callbacks.
    this.hostControls = { ...this.hostControls, ...controls }
  }

  /**
   * Repoints this dashboard at a hosted run's phases and identity. A goal
   * cycle runs as one logical run, so this is called once when the runner
   * starts with a shared hosted progress (and on a control `reset` for an
   * attaching client): it folds any already-rendered usage into `priorUsage`
   * (keeping the header's cost and tokens running), swaps in the run's phases
   * and identity, and clears everything that belonged to a previously rendered
   * run. `startedAt` and the accumulated totals survive deliberately.
   */
  resetPipeline(phases: readonly ProgressPhase[], next: { runID: string; targetDir: string; runDir: string; pipeline: Pipeline; retainMessage?: string }): void {
    const usage = totalUsage(this.phases)
    const advisor = aggregateAdvisorEvents(this.phases.flatMap((phase) => phase.advisorEvents))
    this.priorUsage.cost += usage.cost
    this.priorUsage.tokens = addTokens(this.priorUsage.tokens, usage.tokens)
    this.priorUsage.advisorCost += advisor.cost
    this.priorUsage.advisorInput += advisor.tokens.input + advisor.tokens.cacheRead + advisor.tokens.cacheWrite
    this.priorUsage.advisorOutput += advisor.tokens.output + advisor.tokens.reasoning
    this.priorUsage.advisorAttempted = this.priorUsage.advisorAttempted || advisor.attempted > 0

    this.phases = pendingPhases(phases)
    this.runID = next.runID
    this.targetDir = next.targetDir
    this.runDir = next.runDir
    this.pipelineName = next.pipeline.name
    this.serverUrl = ""
    this.transcripts.clear()
    this.reports.clear()
    // A hosted run's next iteration can reuse phase names; each one gets a
    // fresh lazy-backfill attempt, exactly like the report cache above.
    this.sessionBackfillRequested.clear()
    // The feed is emptied except for the loop's iteration announcement. When
    // the caller passes retainMessage explicitly, the matching entry is kept
    // rather than guessing that the last feed entry is the announcement — a
    // guess that breaks if anything appends between the announcement and this
    // call.
    const retained = next.retainMessage
      ? this.feed.find((entry) => entry.message === next.retainMessage)
      : this.feed[this.feed.length - 1]
    this.feed.splice(0, this.feed.length)
    if (retained) this.feed.push(retained)
    this.feedRevision++
    for (const pending of this.permissionQueue.splice(0)) {
      pending.explainAbort?.abort()
      pending.resolve("reject")
    }
    for (const pending of this.humanReviewQueue.splice(0)) pending.resolve("abort")
    this.interactiveTakeover.clear()
    // Focus returns to the first pending phase and auto-follow re-arms.
    this.selected = 0
    this.selectedGroup = undefined
    this.manualFocus = false
    this.pipelineScroll = 0
    this.fullscreen = undefined
    this.commandPalette = undefined
    this.publishModal = undefined
    this.finished = undefined
    this.contentFocused = false
    this.resetContentScroll()
    this.scheduleRender()
  }

  /**
   * Grows the panel additively to match the expected rows an attach poller
   * derives from durable run state (the goal scheduler's next invocation
   * starting under qualified phase ids). Merge is strictly by phase name:
   * existing rows — with their status, durations, costs, transcripts, reports
   * — are left untouched, missing rows are appended in the given order as
   * pending, and nothing is cleared. The terminal `Compact run` lifecycle row
   * always closes the merged list: the initial reset registered it before any
   * goal row existed, so when a sync appends rows that would sit below it, the
   * row object moves to the terminal position — never rebuilt, so its state
   * survives. Idempotent: re-syncing the same list is a no-op. Unlike
   * `resetPipeline` this never rebuilds or destroys anything; destructive view
   * swaps remain resetPipeline's exclusive job.
   */
  syncPhases(rows: readonly ProgressPhase[]): void {
    const known = new Set(this.phases.map((phase) => phase.name))
    const additions = rows.filter((row) => !known.has(row.name))
    if (additions.length === 0) return
    this.phases.push(...pendingPhases(additions))
    // Terminal-row invariant (capability run-finalization): the lifecycle row
    // closes the phase list. On the tick that appends the first goal rows it
    // is the only row that shifts, so the only selection that needs
    // repointing is one resting on the row itself — selections before it are
    // unaffected, and the appended rows are still-pending additions that
    // cannot be selected within this tick.
    const compactIndex = this.phases.findIndex((phase) => phase.name === compactRunRowName)
    if (compactIndex >= 0 && compactIndex !== this.phases.length - 1) {
      const compact = this.phases[compactIndex]!
      this.phases.splice(compactIndex, 1)
      this.phases.push(compact)
      if (this.selected === compactIndex) this.selected = this.phases.length - 1
    }
    this.scheduleRender()
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
      this.scheduleRender()
      return
    }
    switch (this.contentTab) {
      case "reports":
        this.reportScroll = Math.max(0, this.reportScroll + delta)
        break
      case "logs":
      case "advisor":
        this.logScroll = Math.max(0, this.logScroll + delta)
        break
      case "session":
        this.sessionScroll = Math.max(0, this.sessionScroll - delta)
        break
    }
    this.scheduleRender()
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
    // The row carries its own report path when it has one (goal invocations
    // write iteration-qualified paths); everything else keeps the canonical
    // name-derived location. Shared by the inline panel and the fullscreen
    // reader, which both funnel through this single resolution.
    const path = this.findPhase(name)?.reportPath ?? `reports/${name}.md`
    readFile(join(runDir, path), "utf8")
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
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.ticker)
    this.renderer.removeFrameCallback(this.flushRender)
    this.stopLimits()
    log.mute(false)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("selection", this.handleSelection)
    this.renderer.off("theme_mode", this.handleThemeMode)
    // A shutdown signal can tear the run down while the finish screen is still
    // up; resolving here keeps that promise from leaking.
    this.finished?.resolve()
    for (const pending of this.humanReviewQueue.splice(0)) pending.resolve("abort")
    for (const pending of this.permissionQueue.splice(0)) {
      pending.explainAbort?.abort()
      pending.resolve("reject")
    }
    if (!this.scene && !this.renderer.isDestroyed) this.renderer.destroy()
  }

  private applyPalette() {
    for (const target of this.paletteTargets) {
      target.box.backgroundColor = theme[target.background]
      if (target.border) target.box.borderColor = theme[target.border]
    }
    this.fullscreenScrollbar.slider.backgroundColor = theme.faint
    this.fullscreenScrollbar.slider.foregroundColor = theme.accent
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

  // Give the phase selector a full third of ordinary dashboards instead of a
  // narrow fixed sidebar, but cap it on wide terminals so the reader continues
  // to own most of the screen once names have ample room.
  private pipelineWidth() {
    const innerWidth = Math.max(40, this.renderer.width - 6)
    return Math.min(44, Math.max(22, Math.floor(innerWidth / 3)))
  }

  private usesCompactLayout() {
    return this.renderer.width <= compactDashboardMaxWidth
  }

  // The stacked pipeline keeps enough rows for its progress bar and a few
  // steps, while the rest of the dashboard remains usable. Existing pipeline
  // navigation automatically scrolls this window as selection moves.
  private compactPipelineHeight(bodyHeight: number) {
    return Math.max(5, Math.min(10, Math.floor(bodyHeight * 0.4)))
  }

  private openCommandPalette() {
    this.commandPalette = { filter: "", index: 0, view: "commands", scroll: 0 }
    this.render()
  }

  /**
   * The keyboard surface for the state the dashboard is in right now. One call
   * feeds the footer, the palette and the shortcuts view, so those three can no
   * longer disagree about what the dashboard can do.
   */
  private actionState(): DashboardActionState {
    const fullscreen = this.fullscreen
    return {
      finished: this.finished !== undefined,
      observer: this.observer,
      contentFocused: this.contentFocused,
      selectedGroup: this.selectedGroup !== undefined,
      fullscreen: fullscreen !== undefined,
      contentTab: fullscreen?.tab ?? this.contentTab,
      permissionPending: this.permissionQueue.length > 0,
      humanReviewGate:
        this.humanReviewQueue[0]?.info.kind === "interactive"
          ? "interactive"
          : this.humanReviewQueue[0]?.info.kind === "failure"
            ? "failure"
            : this.humanReviewQueue[0]?.info.kind === "budget-gate"
              ? "budget-gate"
              : this.humanReviewQueue.length > 0
                ? "review"
                : undefined,
      reviewCanRetry: this.humanReviewQueue[0]?.info.canRetry ?? false,
      ctrlC: this.ctrlC,
      autoAccept: this.autoAccept?.mode,
      keepAwake: this.keepAwake?.status,
      controlState: this.controlState,
      canPause: this.hostControls.onPauseToggle !== undefined,
      canKeepAwake: this.hostControls.onKeepAwakeToggle !== undefined && this.keepAwake?.status !== "unavailable",
      canBackground: this.hostControls.onBackground !== undefined,
      canPublish: this.hostControls.publish !== undefined,
      interactiveArmed: this.interactiveTakeover.has(this.focusedPhase()?.name ?? ""),
      reportCopyable: fullscreen !== undefined && Array.isArray(this.reports.get(fullscreen.phase)),
      autoAcceptChunk: this.autoAccept ? autoAcceptStatusChunk(this.autoAccept.mode) : undefined,
    }
  }

  private commandItems(): CommandItem[] {
    return dashboardActions(this.actionState())
      .filter((action): action is CommandItem => action.available && action.label !== undefined)
      .sort(comparePaletteActions)
  }

  private filteredCommandItems() {
    const palette = this.commandPalette
    if (!palette || palette.view !== "commands") return []
    const query = palette.filter.trim().toLowerCase()
    const items = this.commandItems().filter((item) => !query || `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(query))
    palette.index = Math.max(0, Math.min(items.length - 1, palette.index))
    return items
  }

  private handleCommandPaletteKey(key: KeyEvent) {
    const palette = this.commandPalette
    if (!palette) return
    key.preventDefault()
    key.stopPropagation()

    if (palette.view === "help") {
      switch (key.name) {
        case "escape":
          this.commandPalette = undefined
          break
        case "return":
        case "linefeed":
        case "backspace":
          palette.view = "commands"
          palette.scroll = 0
          break
        case "up":
        case "k":
          palette.scroll = Math.max(0, palette.scroll - 1)
          break
        case "down":
        case "j":
          palette.scroll += 1
          break
        case "pageup":
          palette.scroll = Math.max(0, palette.scroll - 10)
          break
        case "pagedown":
        case "space":
          palette.scroll += 10
          break
      }
      // renderCommandPalette clamps `scroll` against the rows it actually built.
      this.render()
      return
    }

    const items = this.filteredCommandItems()
    switch (key.name) {
      case "escape":
        this.commandPalette = undefined
        this.render()
        return
      case "up":
      case "k":
        palette.index = Math.max(0, palette.index - 1)
        break
      case "down":
      case "j":
        palette.index = Math.min(Math.max(0, items.length - 1), palette.index + 1)
        break
      case "backspace":
        palette.filter = palette.filter.slice(0, -1)
        palette.index = 0
        break
      case "return":
      case "linefeed": {
        const item = items[palette.index]
        if (item) this.runCommand(item)
        return
      }
      default: {
        const char = typedCharacter(key)
        if (char !== undefined) {
          palette.filter += char
          palette.index = 0
        }
      }
    }
    this.render()
  }

  // [u]: the subscription meters behind a modal, so the header only surfaces
  // them when one is hot. Content focus can't carry into a modal — the first
  // key closes it — so it is dropped on open.
  private openUsageModal() {
    this.usageModal = true
    this.contentFocused = false
    this.render()
  }

  private runCommand(item: CommandItem) {
    const close = () => {
      this.commandPalette = undefined
    }
    // The handlers below already repaint; the ones that fall through to the
    // bottom (and only those) need the explicit render.
    switch (item.id) {
      case "keep-awake":
        close()
        this.hostControls.onKeepAwakeToggle?.()
        break
      case "pause":
        close()
        this.hostControls.onPauseToggle?.()
        break
      case "permissions":
        // Stays open on purpose: cycling the policy is often done twice.
        this.cycleAutoAccept()
        return
      case "background":
        // Send to background: release this terminal. The host (attach) POSTs
        // /bye, stops the dashboard, and resolves the attach so the caller can
        // land on the runs browser with this run selected.
        close()
        void this.hostControls.onBackground?.()
        break
      case "abort":
        // Only reachable on a menu-opened controller (the abort action carries
        // a label exactly then — never for an observer). The list item is the
        // full phrase; Enter opens a confirm modal — it is not the kill itself.
        close()
        if (this.ctrlC === "detach" && !this.observer) {
          this.abortConfirm = true
          this.render()
        }
        return
      case "interactive":
        close()
        this.toggleInteractiveTakeover()
        return
      case "usage":
        close()
        this.openUsageModal()
        return
      case "session":
        close()
        this.openActiveSessionWindow()
        return
      case "fullscreen":
        close()
        this.openFullscreenView()
        return
      case "tab-session":
      case "tab-reports":
      case "tab-logs":
      case "tab-advisor":
        close()
        this.setContentTab(commandContentTab[item.id])
        return
      case "iterate":
        close()
        void this.openIterateWindow()
        return
      case "lazygit":
        close()
        void this.openGitSubshell()
        return
      case "create-pr":
        close()
        void this.openPublishModal()
        return
      case "close":
        close()
        this.finished?.resolve()
        return
      case "help":
        if (this.commandPalette) {
          this.commandPalette.view = "help"
          this.commandPalette.scroll = 0
        }
        break
    }
    this.render()
  }

  /**
   * [f] on the finish screen: the deliberate `Create pull request` publication
   * action (capability run-finalization, design D5). Nothing is squashed here —
   * automatic compaction owns the branch rewrite; this only publishes.
   */
  private async openPublishModal() {
    const seam = this.hostControls.publish
    if (!seam || this.publishModal) return
    this.publishModal = { kind: "working", message: "resolving the branch and destination…" }
    this.render()

    try {
      const prepared = await seam.prepare()
      this.publishModal = prepared.ok
        ? { kind: "confirm", plan: prepared.plan }
        : { kind: "blocked", message: prepared.message }
    } catch (error) {
      this.publishModal = { kind: "blocked", message: error instanceof Error ? error.message : String(error) }
    }
    this.render()
  }

  private handlePublishKey(key: KeyEvent) {
    const modal = this.publishModal
    if (!modal) return
    key.preventDefault()
    key.stopPropagation()
    // The push and the gh calls own the terminal while they run; input typed
    // here would otherwise land in whatever credential prompt they surfaced.
    if (modal.kind === "working") return

    if (modal.kind !== "confirm") {
      // Blocked and done states are read-only: any key dismisses.
      this.publishModal = undefined
      this.render()
      return
    }
    // Enter is the deliberate publication act; every other key — including
    // reflexive ones — cancels, same philosophy as the abort confirm.
    if (key.name === "return" || key.name === "linefeed") {
      void this.applyPublish(modal.plan)
      return
    }
    this.publishModal = undefined
    this.render()
  }

  private async applyPublish(plan: PublishPlan) {
    const seam = this.hostControls.publish
    if (!seam || this.inSubshell) return
    this.publishModal = { kind: "working", message: `pushing ${plan.branch} to ${plan.remote} and opening a pull request…` }
    this.render()

    // Suspended with the terminal handed back: push and gh credential prompts
    // write to, and may prompt on, the real terminal.
    this.inSubshell = true
    this.suspend()
    try {
      const result = await seam.apply(plan)
      if (result.ok) {
        const detail = result.outcome.url ? `pull request: ${result.outcome.url}` : "pull request opened"
        this.publishModal = { kind: "done", plan, outcome: result.outcome, note: detail }
        this.addEvent("convoy", "system", `pushed ${plan.branch} to ${plan.remote}${result.outcome.url ? ` · ${detail}` : ""}`)
      } else {
        this.publishModal = { kind: "blocked", message: result.message }
        this.addEvent("convoy", "error", `publication stopped: ${result.message.split("\n")[0]}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.publishModal = { kind: "blocked", message: `${message}\n\nnothing was published beyond what the push itself landed.` }
      this.addEvent("convoy", "error", `publication failed: ${message}`)
    } finally {
      this.inSubshell = false
      this.resume()
    }
    this.render()
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
      case "e":
        this.requestPermissionExplain()
        break
      case "i":
        this.openPermissionSessionWindow()
        break
      case "up":
      case "k":
        this.scrollPermissionExplain(-1)
        break
      case "down":
      case "j":
        this.scrollPermissionExplain(1)
        break
    }
    this.render()
  }

  /**
   * The [e] deep-explain: asks the judge for a prose explanation of the head
   * request and paints it inside the modal. o/a/r keep working while loading.
   */
  private requestPermissionExplain() {
    const pending = this.permissionQueue[0]
    if (!pending) return
    const explain = pending.info.explain
    if (!explain) {
      pending.explain = { status: "error", message: "no safety judge configured to explain this" }
      this.render()
      return
    }
    if (pending.explain?.status === "loading") return
    const controller = new AbortController()
    pending.explainAbort = controller
    pending.explain = { status: "loading" }
    this.addEvent("convoy", "permission", "asking the safety judge to explain")
    this.render()
    explain(controller.signal)
      .then((text) => {
        // The user may have answered while the judge was thinking; the modal
        // renders the head of the queue, so drop a stale result by identity.
        if (this.permissionQueue[0] !== pending) return
        pending.explain = { status: "ready", lines: wrapLines(text.split("\n"), permissionModalWidth(this.renderer.width) - 6), scroll: 0 }
        this.render()
      })
      .catch((error: unknown) => {
        if (this.permissionQueue[0] !== pending) return
        if (controller.signal.aborted) return
        pending.explain = { status: "error", message: error instanceof Error ? error.message : String(error) }
        this.render()
      })
  }

  private scrollPermissionExplain(delta: number) {
    const pending = this.permissionQueue[0]
    if (pending?.explain?.status !== "ready") return
    const lines = pending.explain.lines
    const maxRows = permissionExplainMaxRows(this.renderer.height)
    const maxScroll = Math.max(0, lines.length - maxRows)
    pending.explain = { status: "ready", lines, scroll: Math.max(0, Math.min(pending.explain.scroll + delta, maxScroll)) }
  }

  /**
   * The [i] inspect: opens the opencode session that asked for this permission
   * in a new window. The attached window sees the same pending request and can
   * answer it; whichever reply lands first wins, the other fails and is logged
   * by the existing error branch in `reply()` (src/permissions.ts). The gate
   * must NOT be paused: the request is already being held, and pause() only
   * affects requests that arrive afterwards.
   */
  private openPermissionSessionWindow() {
    const pending = this.permissionQueue[0]
    if (!pending) return
    if (!pending.info.sessionID) {
      pending.inspect = { error: "this request has no session to inspect" }
      this.render()
      return
    }
    if (!this.serverUrl) {
      pending.inspect = { error: "no live opencode server to attach to" }
      this.render()
      return
    }
    const targetDir = this.targetDir || process.cwd()
    this.addEvent("convoy", "permission", `[i]: opening session ${shortID(pending.info.sessionID)}`)
    openOpencodeSessionWindow({ url: this.serverUrl, targetDir, sessionID: pending.info.sessionID })
      .then((backend) => {
        pending.inspect = { backend }
        this.render()
      })
      .catch((error: unknown) => {
        pending.inspect = { error: error instanceof Error ? error.message : String(error) }
        this.render()
      })
    this.render()
  }

  private cycleAutoAccept() {
    if (!this.autoAccept) return
    const order = ["off", "all", "smart"] as const
    const next = order[(order.indexOf(this.autoAccept.mode) + 1) % order.length]!
    this.autoAccept.mode = next
    // A controller dashboard's toggle is authoritative on the coordinator: tell
    // the host (who POSTs it over the control channel) about the new mode.
    this.hostControls.onCycleAutoAccept?.(next)
    this.addEvent("convoy", "permission", autoAcceptAnnouncement[next])
    // Only "all" clears the backlog blindly; "smart" leaves already-escalated
    // prompts for the user (re-judging an open prompt would be surprising).
    if (next === "all") {
      for (const pending of this.permissionQueue.splice(0)) {
        pending.explainAbort?.abort()
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
    pending.explainAbort?.abort()
    this.permissionChoice = 0
    const verdict = reply === "once" ? "allowed once" : reply === "always" ? "always allowed" : "rejected"
    this.addEvent("convoy", "permission", `${verdict}: ${permissionSummary(pending.info)}`)
    pending.resolve(reply)
    this.render()
  }

  private handleHumanReviewKey(key: KeyEvent) {
    const gate = this.humanReviewQueue[0]
    const action = humanReviewActionForKey(key, gate?.info.kind, gate?.info.canRetry ?? false)
    if (!action) return false
    key.preventDefault()
    key.stopPropagation()
    this.resolveHumanReview(action)
    return true
  }

  private resolveHumanReview(action: HumanReviewAction) {
    const pending = this.humanReviewQueue.shift()
    if (!pending) return
    this.addEvent(pending.info.stepName, action === "abort" ? "error" : "permission", humanReviewActionLabel(action, pending.info.kind))
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
  private openActiveSessionWindow() {
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
    this.openSessionWindowForPhase(active.name)
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
    const takeoverGate = this.humanReviewQueue[0]?.info.kind
    if (takeoverGate === "failure" || takeoverGate === "budget-gate") {
      this.addEvent(
        "convoy",
        "system",
        takeoverGate === "failure"
          ? "use [o] in the step failed gate before taking over a session"
          : "answer the step budget gate with [r] or [a] before taking over a session",
      )
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
      this.addEvent(phase.name, "system", "interactive mode off — a clean finish commits and moves on")
      this.render()
      return
    }
    if (!phase.sessionID) {
      this.addEvent(phase.name, "system", "interactive mode needs the step's session; wait for it to appear")
      this.render()
      return
    }
    this.interactiveTakeover.add(phase.name)
    this.addEvent(phase.name, "system", "interactive mode armed — a clean finish holds the step here for you; esc in OpenCode holds it too")
    this.openSessionWindowForPhase(phase.name)
  }

  private openSessionWindowForPhase(name: string) {
    const openGate = this.humanReviewQueue[0]?.info.kind
    if (openGate === "failure" || openGate === "budget-gate") {
      // An active gate owns its choices. A failure gate's [o] flips it to
      // interactive only after the open succeeds — a plain open would leave
      // [r]'s clean restore able to erase those edits. A budget gate has no
      // [o] at all: only [r] or [a] may resolve it.
      this.addEvent(
        "convoy",
        "system",
        openGate === "failure"
          ? "use [o] in the step failed gate before opening a session"
          : "answer the step budget gate with [r] or [a] before opening a session",
      )
      this.render()
      return
    }
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

    if (!runner.capabilities.liveAttach) this.markIterateRequested()
    this.addEvent("convoy", "system", `[o]: opening ${name} ${runner.sessionName} session ${shortID(phase.sessionID)}`)
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

  // [i] on the finish screen: a fresh opencode window in the target project's directory,
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

    this.markIterateRequested()
    this.addEvent("convoy", "system", `[i]: opening a new opencode session with ${files.length} context file${files.length === 1 ? "" : "s"}`)
    openIterateOpencodeWindow({
      targetDir: this.targetDir || process.cwd(),
      prompt: iteratePrompt(this.runID, files),
      runDir: this.runDir,
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
    this.scheduleRender()
  }

  private findPhase(name: string) {
    return this.phases.find((item) => item.name === name)
  }

  private addEvent(phase: string, kind: ActivityKind, message: string) {
    this.lastActivityAt = Date.now()
    this.feedRevision++
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

  // Data events (agent activity, usage, todos, status changes) call this instead
  // of render() directly. It only marks the screen dirty and asks opentui for a
  // frame; flushRender does the one rebuild per frame. This decouples render
  // frequency from event frequency, so N parallel phases streaming events no
  // longer trigger N full-screen rebuilds each. Streamed token deltas already
  // rely on the same idea via the animation ticker (see phaseMessage); this
  // extends it to every data event. Input handlers still call render() directly
  // for zero-latency feedback.
  private scheduleRender() {
    if (this.stopped || this.renderer.isDestroyed || this.scene?.isClosed) return
    this.dirty = true
    this.renderer.requestRender()
  }

  // Runs once per opentui frame, before the native paint (see CliRenderer.loop).
  // Rebuilds the screen only when a data event marked it dirty.
  private readonly flushRender = async () => {
    if (!this.stopped && this.dirty) this.render()
  }

  // The animation clock. Data events repaint through the frame callback above;
  // this exists for what changes without an event — the spinners, the elapsed
  // clocks, and the transcript text phaseMessage appends silently. It runs
  // faster than the spinner's own step (see spinnerFrame) so every frame of the
  // animation is painted once instead of being sampled two or three frames late,
  // which is what made the spinners look slowed-down. Nothing running means
  // nothing to animate, so an idle dashboard falls back to a 1 Hz clock tick and
  // a finished one stops repainting altogether.
  private readonly animationTick = () => {
    if (this.stopped || this.renderer.isDestroyed || this.scene?.isClosed) return
    if (this.dirty || this.isAnimating()) {
      this.render()
      return
    }
    if (this.finished) return
    if (Date.now() - this.lastRenderAt >= 1_000) this.render()
  }

  private isAnimating() {
    // The publish modal is the one thing on a finished run that still animates:
    // its spinner covers the push and the gh calls.
    if (this.publishModal?.kind === "working") return true
    if (this.finished) return false
    if (this.permissionQueue[0]?.explain?.status === "loading") return true
    return this.phases.some((phase) => phase.status === "running")
  }

  private render() {
    // This repaint (frame flush, ticker, or immediate input render) satisfies any
    // pending schedule.
    this.dirty = false
    if (this.stopped || this.renderer.isDestroyed || this.scene?.isClosed) return
    this.lastRenderAt = Date.now()
    // The reader's opaque overlay hides the dashboard completely. Rebuilding
    // it would waste a full layout pass and, for reports, a second markdown
    // wrap at the inline panel's width. The dashboard catches up when the
    // reader closes.
    if (this.fullscreen) {
      this.renderFullscreenView()
      this.renderModal()
      this.renderer.requestRender()
      return
    }
    const now = Date.now()
    const innerWidth = Math.max(40, this.renderer.width - 6)
    const headerLines = this.headerContent(now, innerWidth)
    this.headerBox.height = headerLines.length + 2
    const compact = this.usesCompactLayout()
    const pipelineWidth = compact ? innerWidth + 4 : this.pipelineWidth()
    const rightWidth = compact ? innerWidth : Math.max(40, this.renderer.width - pipelineWidth - 9)
    // Body rows left after the dir line (1), the header (its rows plus the two
    // borders), and the footer (3); the detail and todos panels grow with
    // their content but never starve the content panel below them.
    const bodyHeight = Math.max(8, this.renderer.height - headerLines.length - 7)
    const pipelineHeight = compact ? this.compactPipelineHeight(bodyHeight) : bodyHeight
    const rightBodyHeight = compact ? Math.max(8, bodyHeight - pipelineHeight - 1) : bodyHeight

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
    this.bodyBox.flexDirection = compact ? "column" : "row"
    this.pipelineBox.width = compact ? "100%" : pipelineWidth
    this.pipelineBox.height = compact ? pipelineHeight : "100%"
    this.rightBox.height = compact ? "auto" : "100%"
    // The pipeline panel keeps its dim border even while it owns the keyboard:
    // the accent highlight lives on the content panel alone, so the focus
    // state reads as "reading" versus "piloting" rather than two competing
    // bright frames.
    this.pipelineBox.borderColor = theme.borderDim
    this.feedBox.borderColor = this.contentFocused ? theme.accent : theme.borderDim

    // Detail panel: either one concrete phase or an aggregate for a selected
    // parallel/multi-model/goal-invocation header.
    const detailLines = group
      ? this.groupDetailContent(group.selection, group.members, now, rightWidth)
      : this.detailContent(focus, now, rightWidth)
    this.stepBox.title = group ? groupPanelTitle(group.selection) : " step "
    this.stepBox.height = detailLines.length + 2
    this.stepText.content = joinLines(detailLines)

    // Todos panel: the focused phase's list, whenever it has one.
    const todoBudget = Math.max(3, Math.floor(rightBodyHeight * 0.5) - detailLines.length - 4)
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
    const feedRows = Math.max(3, rightBodyHeight - usedHeight - 2)
    const contentRows = feedRows - contentTabBarRows
    this.contentPageRows = contentRows

    this.dirText.content = this.dirContent(innerWidth)
    this.headerText.content = joinLines(headerLines)
    this.pipelineText.content = this.pipelineContent(now, pipelineHeight - 2, pipelineWidth)

    // Body first: the active content tab computes the scroll indicator the rail shows.
    const body = group
      ? this.groupContentLines(group.selection, group.members, now, rightWidth, contentRows)
      : this.contentTab === "reports"
        ? this.reportPanelLines(focus, rightWidth, contentRows)
        : this.contentTab === "advisor"
          ? this.advisorPanelLines(focus, rightWidth, contentRows)
        : this.contentTab === "session"
          ? this.sessionLines(focus, rightWidth, contentRows)
          : this.phaseFeedLines(focus, rightWidth, contentRows)
    this.feedText.content = joinLines([...this.contentTabBar(rightWidth), ...body])

    this.footerBox.title = this.footerTitle()
    this.footerText.content = this.footerContent(now, innerWidth)
    this.renderFullscreenView()
    this.renderModal()
    this.renderer.requestRender()
  }

  /**
   * The header is one status row — run state (a ◆ marks the live state) on
   * the left, session-wide totals (cost, tokens) on the right — plus a second
   * row that always leads with the elapsed clock in the bottom-left spot, the
   * same place in every run. In goal mode the loop's readout (target,
   * iteration, score trajectory) follows the clock on that row, with hot meter
   * chips right-aligned. Phase status lives in the pipeline panel and the full
   * meters behind [u].
   */
  private headerContent(now: number, width: number): StyledText[] {
    const usage = totalUsage(this.phases)
    const advisor = aggregateAdvisorEvents(this.phases.flatMap((phase) => phase.advisorEvents))
    const advisorInput = advisor.tokens.input + advisor.tokens.cacheRead + advisor.tokens.cacheWrite
    const advisorOutput = advisor.tokens.output + advisor.tokens.reasoning
    // Goal-loop iterations replace the phases each run, so the session totals
    // merge the accumulated prior usage (summed by resetPipeline) with the
    // current phases'.
    const merged = {
      cost: usage.cost + this.priorUsage.cost,
      input: usage.tokens.input + this.priorUsage.tokens.input,
      output: usage.tokens.output + this.priorUsage.tokens.output,
      advisorCost: advisor.cost + this.priorUsage.advisorCost,
      advisorInput: advisorInput + this.priorUsage.advisorInput,
      advisorOutput: advisorOutput + this.priorUsage.advisorOutput,
      advisorAttempted: advisor.attempted > 0 || this.priorUsage.advisorAttempted,
    }
    // Elapsed time freezes at the moment the run ended.
    const endAt = this.finished?.at ?? now
    const clock = fg(theme.text)(formatElapsed(endAt - this.startedAt))
    const goal = this.goalRowSegments()
    const chips = this.limitChips(now)
    const totals: TextChunk[] = [
      fg(theme.green)(formatMoney(merged.cost + merged.advisorCost)),
      ...(merged.advisorAttempted
        ? [fg(theme.faint)(` (${formatMoney(merged.cost)} exec + ${formatMoney(merged.advisorCost)} adv)`)]
        : []),
      fg(theme.faint)("  ·  "),
      fg(theme.dim)(`↑${formatCount(merged.input + merged.advisorInput)} ↓${formatCount(merged.output + merged.advisorOutput)} tokens`),
    ]

    const status: TextChunk[] = this.finished
      ? this.finished.status === "completed"
        ? [bold(fg(theme.green)("✓ run completed"))]
        : [bold(fg(theme.red)("✗ run failed"))]
      : this.controlState === "paused"
        ? [bold(fg(theme.yellow)("paused")), fg(theme.faint)(" · p resume")]
        : this.controlState === "pausing"
          ? [bold(fg(theme.cyan)("pausing")), fg(theme.faint)(` · ${this.controlActivePhases} active`)]
          : [fg(theme.accent)("◆ "), fg(theme.dim)("running")]
    if (this.keepAwake?.status === "on" && !this.finished) status.push(fg(theme.faint)("  ·  "), fg(theme.cyan)("☕ awake"))
    const rows = [padBetween(status, totals, width)]

    // The second row always leads with the clock in the bottom-left spot —
    // the same place in every run, goal or not — followed by the loop's
    // readout when there is one; hot meter chips right-align.
    const sep = fg(theme.faint)("  ·  ")
    const left: TextChunk[] = [clock]
    for (const segment of goal) {
      left.push(sep)
      left.push(...segment.chunks)
    }
    const right: TextChunk[] = []
    for (const segment of chips) {
      if (right.length > 0) right.push(sep)
      right.push(...segment.chunks)
    }
    rows.push(padBetween(left, right, width))
    return rows
  }

  /**
   * The header's second-row goal segments, each carrying how eagerly it gives
   * up columns when the row outgrows the panel. The verdict is pinned
   * (Infinity); everything else sacrifices in the PRD's order — delta first,
   * then the trajectory, then iter — with the goal target giving way last of
   * all. Higher priority drops first. Empty for pipelines without a goal
   * loop, so the header stays a single row.
   */
  private goalRowSegments(): { priority: number; chunks: TextChunk[] }[] {
    const segments: { priority: number; chunks: TextChunk[] }[] = []
    const view = this.finished?.goalLoop ?? this.goalLoop
    if (view?.outcome) {
      const best = view.scores.length > 0 ? Math.max(...view.scores) : undefined
      if (view.outcome.reason === "no-score") {
        segments.push({ priority: Infinity, chunks: [bold(fg(theme.red)("no score"))] })
      } else {
        const label = view.outcome.reason === "goal" ? "goal" : view.outcome.reason === "plateau" ? "plateau" : "cap"
        const chunks =
          view.outcome.reason === "goal" ? bold(fg(theme.green)(`✓ ${label} ${best ?? "?"}/100`)) : bold(fg(theme.text)(`${label} ${best ?? "?"}/100`))
        segments.push({ priority: Infinity, chunks: [chunks] })
      }
      if (view.outcome.reason !== "goal" && view.outcome.restored) {
        segments.push({ priority: Infinity, chunks: [fg(theme.dim)("restored to best")] })
      }
      if (view.scores.length > 0) segments.push(trajectorySegment(view.scores))
      return segments
    }
    if (!this.finished && view && !view.outcome) {
      segments.push({ priority: 2, chunks: [fg(theme.text)(`goal ${view.target}`)] })
      segments.push({ priority: 4, chunks: [fg(theme.dim)(`iter ${view.iteration}/${view.maxRuns}`)] })
      if (view.scores.length > 0) {
        const last = view.scores[view.scores.length - 1]!
        const prev = view.scores[view.scores.length - 2]
        // The loop's views name the iteration about to run, so the trajectory
        // trails off (`71 → 84 → …`) until that iteration scores. The delta
        // reports the last completed pair either way — a pending current
        // iteration has no score of its own to compare against.
        segments.push(trajectorySegment(view.scores, view.scores.length < view.iteration))
        if (prev !== undefined) {
          const delta = last - prev
          segments.push({
            priority: 6,
            chunks: [fg(delta >= 0 ? theme.green : theme.red)(`${delta >= 0 ? "+" : ""}${delta}`)],
          })
        }
      }
      return segments
    }
    // A failed goal-loop run keeps the trajectory it accumulated.
    if (this.finished?.status === "failed" && view && view.scores.length > 0) {
      segments.push(trajectorySegment(view.scores))
    }
    return segments
  }

  /**
   * Second-row warning chips for the subscription meters, right-aligned. A
   * meter only earns header space when it is about to stall the run (GPT
   * window ≥85%, OpenRouter below openRouterLowBalance, or an auth problem);
   * the full meters with their healthy states live behind [u].
   */
  private limitChips(now: number): { priority: number; chunks: TextChunk[] }[] {
    const chips: { priority: number; chunks: TextChunk[] }[] = []
    const gpt = this.limits?.gpt
    if (gpt) {
      const session = Math.round(gpt.sessionPct)
      const weekly = gpt.weeklyPct === undefined ? undefined : Math.round(gpt.weeklyPct)
      const resets = gpt.sessionResetsAt === undefined ? undefined : fmtCountdown(gpt.sessionResetsAt, now)
      const chunks: TextChunk[] = [fg(theme.yellow)("⚠ OpenAI")]
      if (session >= 85) chunks.push(fg(theme.yellow)(` ${session}%`), ...(resets ? [fg(theme.faint)(` resets ${resets}`)] : []))
      else if (weekly !== undefined && weekly >= 85) chunks.push(fg(theme.yellow)(` wk ${weekly}%`))
      if (session >= 85 && weekly !== undefined && weekly >= 85) chunks.push(fg(theme.yellow)(` · wk ${weekly}%`))
      if (chunks.length > 1) chips.push({ priority: 0, chunks })
    } else if (this.limits?.gptHint) {
      chips.push({ priority: 0, chunks: [fg(theme.yellow)(`⚠ OpenAI — ${this.limits.gptHint}`)] })
    }
    const openrouter = this.limits?.openrouter
    if (openrouter?.kind === "remaining" && openrouter.amount < openRouterLowBalance) {
      chips.push({ priority: 0, chunks: [fg(theme.yellow)(`⚠ OpenRouter ${formatMoney(openrouter.amount)} left`)] })
    }
    return chips
  }

  /**
   * The finish screen's one-line quality summary: the single score, or the
   * per-iteration trajectory of a score loop that ran without goal targets.
   * The goal loop's own verdict lives in the header's goal row instead.
   */
  private titleSegments(): { priority: number; chunks: TextChunk[] }[] {
    const segments: { priority: number; chunks: TextChunk[] }[] = []
    const finished = this.finished
    if (finished?.qualityScore !== undefined && !finished.goalLoop) {
      segments.push({ priority: 5, chunks: [bold(fg(theme.accent)(`score ${finished.qualityScore}/100`))] })
    }
    const trajectory = finished?.goalTrajectory
    if (trajectory && trajectory.length > 1 && finished && !finished.goalLoop) {
      segments.push(trajectorySegment(trajectory))
    }
    // The run-finalization outcome reads next to the pipeline result, never
    // instead of it (capability run-finalization): a blocked or failed
    // compaction must stay visible on an execution-successful finish screen.
    const finalization = finished?.finalization
    if (finalization) {
      const label =
        finalization.state === "completed"
          ? finalization.producedSha
            ? `compacted into ${finalization.producedSha.slice(0, 8)}`
            : "run compacted"
          : `compaction ${finalization.state}${finalization.reason ? `: ${finalization.reason.slice(0, 80)}` : ""}`
      segments.push({ priority: 4, chunks: [fg(finalization.state === "completed" ? theme.green : theme.yellow)(label)] })
    }
    return segments
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
  private pipelineContent(now: number, visibleRows: number, panelWidth: number) {
    const width = panelWidth - 4
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
    // models under a fan-out header — not always the raw member total. A count
    // of one (a single-step goal invocation) omits the suffix: the iteration
    // label is the information, `×1` would be noise. When the focused phase is
    // one of this header's members (directly or via a nested sub-header), the
    // label picks up the same accent as the focused leaf so the whole ancestor
    // chain reads as one highlighted path down the tree, instead of only the
    // leaf itself carrying any indication.
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
        suffix: count > 1 ? [fg(theme.faint)(` ×${count}`)] : undefined,
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
    const namePart = this.pipelineName ? ` · ${this.pipelineName}` : ""
    this.pipelineBox.title = allReadOnly ? ` pipeline${namePart} · read-only ` : ` pipeline${namePart} `

    // The step-level children every multi-phase group shares: singleton steps
    // render one leaf row, fanned-out steps nest a step header over model rows.
    const emitStepGroups = (stepGroups: PhaseState[][], memberBadges: (phase: PhaseState) => readonly string[]) => {
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

    for (const group of groupPhases(this.phases)) {
      // A goal invocation's display group id (`goal-measure-0`) names the tree
      // group by stage and round instead of the literal `parallel`, so
      // iteration boundaries stay visible — even when the fragment is a
      // single step, which still renders its header over one child.
      const goalLabel = goalInvocationLabel(group[0]!.groupId)
      if (group.length === 1 && !goalLabel) {
        const phase = group[0]!
        emitRow(phase, [], stepLabel(phase), phaseMetaChunks(phase, now), allReadOnly ? [] : phaseCapabilityBadges(phase))
        continue
      }

      const stepGroups = chunkByStepName(group)

      if (goalLabel) {
        const groupReadOnly = group.every((phase) => phase.readOnly)
        emitHeader(
          group,
          goalLabel,
          "parallel",
          stepGroups.length,
          [],
          { kind: "group", groupId: group[0]!.groupId! },
          allReadOnly || !groupReadOnly ? [] : phaseCapabilityBadges(group[0]!),
        )
        const memberBadges = (phase: PhaseState) => (allReadOnly || groupReadOnly ? [] : phaseCapabilityBadges(phase))
        emitStepGroups(stepGroups, memberBadges)
        continue
      }

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
      emitStepGroups(stepGroups, memberBadges)
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
    const label = selection.stepName ?? goalInvocationLabel(selection.groupId) ?? "parallel"
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
      meta.push(fg(theme.faint)("attempt "), fg(phase.attempt > 1 ? theme.yellow : theme.dim)(String(phase.attempt)))
    }
    if (phase.sessionID) {
      if (meta.length > 0) meta.push(fg(theme.faint)(" · "))
      meta.push(fg(theme.faint)(shortID(phase.sessionID)))
    }
    if (meta.length > 0) out.push(new StyledText(meta))

    if (phase.plannedAdvisor) {
      const advisor = aggregateAdvisorEvents(phase.advisorEvents)
      const triggers = Object.keys(advisor.byTrigger).join(", ") || "none yet"
      const feedback = Object.entries(advisor.feedback).map(([outcome, count]) => `${outcome}:${count}`).join(", ") || "unknown"
      // `attempted` aggregates every retry of the phase, while the cap is per
      // attempt — presenting them as `used/cap` would read as over-budget after
      // a single retry, so the cap is labeled with its real scope instead.
      out.push(new StyledText([
        fg(theme.teal)("advisor "),
        fg(theme.dim)(truncate(phase.plannedAdvisor, 28)),
        fg(theme.faint)(` · budget ${advisor.attempted} used · cap ${phase.advisorMaxCalls ?? defaultAdvisorMaxCalls}/attempt · triggers ${triggers} · adoption ${feedback}`),
      ]))
    }

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
      const isFailure = gate.info.kind === "failure"
      const isBudgetGate = gate.info.kind === "budget-gate"
      out.push(plain(""))
      out.push(new StyledText([fg(theme.yellow)(isFailure ? "step failed" : isBudgetGate ? "step budget reached" : gate.info.kind === "interactive" ? "interactive session" : "human review"), fg(theme.faint)(" · choose from the dashboard shortcuts")]))
      if (isFailure && gate.info.error) out.push(new StyledText([fg(theme.red)(truncate(gate.info.error, Math.max(20, width)))]))
      out.push(
        new StyledText(
          isBudgetGate
            ? [fg(theme.accent)("r"), fg(theme.dim)(" reset and continue   "), fg(theme.accent)("a"), fg(theme.dim)(" abort")]
            : isFailure && gate.info.canRetry
            ? [fg(theme.accent)("r"), fg(theme.dim)(" retry clean   "), fg(theme.accent)("o"), fg(theme.dim)(" open OpenCode   "), fg(theme.accent)("a"), fg(theme.dim)(" abort")]
            : isFailure
              ? [fg(theme.accent)("o"), fg(theme.dim)(" open OpenCode   "), fg(theme.accent)("a"), fg(theme.dim)(" abort")]
              : [fg(theme.accent)("c"), fg(theme.dim)(" continue pipeline   "), fg(theme.accent)("o"), fg(theme.dim)(" open OpenCode   "), fg(theme.accent)("a"), fg(theme.dim)(" abort")],
        ),
      )
      // A budget gate has no iterate action, so its counter is always zero —
      // showing it would be dead text. Other gates can actually iterate.
      if (!isBudgetGate) out.push(new StyledText([fg(theme.faint)("iterations "), fg(theme.dim)(String(gate.info.iterations))]))
    } else if (phase.status === "running" && this.interactiveTakeover.has(phase.name)) {
      out.push(plain(""))
      out.push(new StyledText([fg(theme.cyan)("interactive armed"), fg(theme.faint)(" · esc in OpenCode holds the step here; a clean finish waits for you — "), fg(theme.accent)("i"), fg(theme.faint)(" disarms")]))
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

    return this.wrappedReport(report, Math.max(20, width))
  }

  // Reports are re-derived on every repaint and can run to thousands of lines,
  // so the result is memoized against the loaded source array — `loadReport`
  // swaps that reference whenever the file is re-read, invalidating every
  // width. A resize re-wraps the parsed document once per width. Only a couple
  // of widths are ever live at once (the inline panel and, while open, the
  // reader), so the map is bounded to keep a resize drag from accumulating a
  // stale wrap per intermediate width — matching feedLines/summaryRows, which
  // hold a single width and replace it on change.
  private wrappedReport(report: string[], width: number): StyledText[] {
    let memo = this.reportLines.get(report)
    if (!memo) {
      memo = { doc: parseMarkdown(report), values: new Map() }
      this.reportLines.set(report, memo)
    }
    const cached = memo.values.get(width)
    if (cached) return cached
    const value = renderMarkdownDoc(memo.doc, width)
    memo.values.set(width, value)
    // Maps iterate in insertion order, so the oldest widths drop first. A single
    // frame only ever asks one width per report — the reader's while it is open,
    // the inline panel's otherwise — so eviction can never drop a wrap the frame
    // in flight still needs. Four covers both of those across the reader's
    // open/close transition plus a couple of resize intermediates. A long resize
    // drag under the open reader does age the inline panel's entry out; that
    // costs one re-wrap when the reader closes, which is the trade for not
    // retaining a full document wrap per width the drag passed through.
    while (memo.values.size > 4) {
      const oldest = memo.values.keys().next().value
      if (oldest === undefined) break
      memo.values.delete(oldest)
    }
    return value
  }

  private renderFullscreenView() {
    const view = this.fullscreen
    this.reportOverlay.visible = Boolean(view)
    if (!view) return
    // Reserve two blank cells between the text and the scrollbar, then keep
    // the bar against the reader's right edge rather than in the copy column.
    const width = Math.max(20, this.renderer.width - 9)
    const visible = Math.max(1, this.renderer.height - 4)
    const lines = this.fullscreenSourceLines(view, width)
    const maxScroll = Math.max(0, lines.length - visible)
    view.scroll = Math.max(0, Math.min(view.scroll, maxScroll))
    const position = scrollPosition(view.scroll, maxScroll) || "all"
    const copy = clipboardStatusLabel(view.copyStatus)
    const label = view.tab === "reports" ? "report" : view.tab
    const copyHint = view.tab === "reports" ? " · c copy" : ""
    this.reportOverlay.title = ` ${label} · ${view.phase} · ↑/↓ scroll${copyHint} · v/esc close · ${position}${copy} `
    this.reportOverlayText.content = joinLines(lines.slice(view.scroll, view.scroll + visible))
    this.syncingFullscreenScrollbar = true
    try {
      this.fullscreenScrollbar.top = 2
      this.fullscreenScrollbar.right = 1
      this.fullscreenScrollbar.height = visible
      this.fullscreenScrollbar.scrollSize = lines.length
      this.fullscreenScrollbar.viewportSize = visible
      this.fullscreenScrollbar.scrollPosition = view.scroll
      this.fullscreenScrollbar.resetVisibilityControl()
    } finally {
      this.syncingFullscreenScrollbar = false
    }
  }

  private fullscreenSourceLines(view: FullscreenView, width: number): StyledText[] {
    const phase = this.findPhase(view.phase)
    if (!phase) return [t`${fg(theme.dim)("this step is no longer available")}`]
    switch (view.tab) {
      case "reports":
        return this.reportSourceLines(phase, width)
      case "session":
        return this.sessionSourceLines(phase, width)
      case "logs":
        return this.phaseFeedSourceLines(phase, width)
      case "advisor":
        return this.advisorSourceLines(phase, width)
    }
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
    const memo = this.feedLines.get(phase.name)
    if (memo && memo.width === width && memo.revision === this.feedRevision) return memo.value
    const value = this.buildPhaseFeedSourceLines(phase, width)
    this.feedLines.set(phase.name, { width, revision: this.feedRevision, value })
    return value
  }

  private advisorPanelLines(phase: PhaseState | undefined, width: number, visible: number): StyledText[] {
    this.contentPosition = ""
    if (visible <= 0) return []
    if (!phase) return [t`${fg(theme.dim)("no step selected")}`]
    const lines = this.advisorSourceLines(phase, width)
    const maxScroll = Math.max(0, lines.length - visible)
    this.logScroll = Math.max(0, Math.min(this.logScroll, maxScroll))
    this.contentPosition = scrollPosition(this.logScroll, maxScroll)
    return lines.slice(this.logScroll, this.logScroll + visible)
  }

  private advisorSourceLines(phase: PhaseState, width: number): StyledText[] {
    if (!phase.plannedAdvisor && phase.advisorEvents.length === 0) return [t`${fg(theme.dim)("no advisor configured for this step")}`]
    if (phase.advisorEvents.length === 0) {
      return [
        new StyledText([fg(theme.faint)("advisor "), fg(theme.text)(truncate(phase.plannedAdvisor ?? "configured", Math.max(8, width - 8)))]),
        t`${fg(theme.dim)(`waiting for activity · budget 0/${phase.advisorMaxCalls ?? defaultAdvisorMaxCalls}`)}`,
      ]
    }
    return phase.advisorEvents.map((event) => {
      const at = Date.parse(event.timestamp)
      const time = Number.isFinite(at) ? formatTime(at) : "--:--"
      const status = event.type.slice("advisor.".length)
      const detail = event.type === "advisor.completed"
        ? `${event.latencyMs}ms${event.usage ? ` · ${formatMoney(event.usage.cost)}` : ""}`
        : event.type === "advisor.failed"
          ? event.error.code
          : event.type === "advisor.delivered"
            ? event.delivery
            : event.type === "advisor.feedback"
              ? event.outcome
              : `${event.budget.used}/${event.budget.max}`
      const color = event.type === "advisor.failed" || event.type === "advisor.budget_exhausted" ? theme.red : event.type === "advisor.completed" ? theme.green : theme.teal
      // Attempt marker: retried phases concatenate every attempt's events into
      // this one timeline, and per-attempt budget counters only make sense when
      // the attempt they belong to is visible.
      return new StyledText([fg(theme.faint)(`${time} `), fg(color)(truncate(status, 16).padEnd(17)), fg(theme.dim)(event.trigger.padEnd(12)), fg(theme.faint)(`a${event.attempt} `), fg(theme.text)(truncate(detail, Math.max(5, width - 43)))])
    })
  }

  private buildPhaseFeedSourceLines(phase: PhaseState, width: number): StyledText[] {
    const events = this.feed.filter((entry) => entry.phase === phase.name).reverse()
    if (events.length === 0) return [t`${fg(theme.dim)("no activity for this step yet…")}`]

    return events.flatMap((entry) => {
      const style = kindStyle(entry.kind)
      const gutter: TextChunk[] = [fg(theme.faint)(formatTime(entry.time)), raw(" "), fg(style.color)(style.icon), raw(" ")]
      // Inline markdown only: a message is one line of prose, not a document, so
      // a message starting with "- " stays a message and not a bullet. The
      // hanging indent lands continuation rows under the message column, which
      // is measured from the gutter rather than assumed.
      const body = markdownInlineChunks(entry.message, entry.kind === "error" ? theme.red : theme.text)
      const rows = indentStyled(new StyledText(body), width, gutter)
      if (rows.length <= maxFeedRowsPerEvent) return rows
      const last = rows[maxFeedRowsPerEvent - 1]!
      // clipChunks returns its input untouched when nothing had to be cut, so a
      // final row that already fits needs the elision marker added here.
      const clipped = clipChunks(last.chunks, Math.max(1, width - 1))
      const elided = clipped === last.chunks ? [...clipped, fg(theme.faint)("…")] : clipped
      return [...rows.slice(0, maxFeedRowsPerEvent - 1), new StyledText(elided)]
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
        : this.contentTab === "advisor"
          ? this.advisorSourceLines(phase, width)
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
      // A completed phase with nothing streamed was likely running before this
      // dashboard attached: ask the attach runtime once to reconstruct the
      // session from the run's live server. The placeholder stays until (and
      // unless) chunks actually land, so a server that cannot answer keeps the
      // honest "nothing captured" line.
      if (
        (phase.status === "completed" || phase.status === "failed") &&
        phase.sessionID &&
        !this.sessionBackfillRequested.has(phase.name)
      ) {
        this.sessionBackfillRequested.add(phase.name)
        this.hostControls.requestSessionBackfill?.(phase.name)
      }
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
      // A run of same-channel blocks is one stretch of thinking (or one answer)
      // split into provider parts: it carries a single channel label, and the
      // parts read as separate items under it.
      const continues = index > 0 && blocks[index - 1]!.channel === block.channel
      // Reasoning bullets stay tight under their label; everything else keeps a
      // blank line between blocks.
      if (index > 0 && !(continues && block.channel === "reasoning")) lines.push(plain(""))
      // A blinking-style cursor trails the final block only while it's still
      // being written, so you can see the stream is live.
      const live = running && index === blocks.length - 1
      lines.push(...transcriptBlockLines(block, width, live, !continues))
    })
    return lines
  }

  /**
   * Branding rides the footer's border (right-aligned, like the other panels'
   * titles) so the header row keeps its columns for live run status. When the
   * full title would outgrow the border it falls back to the bare wordmark —
   * the version is a nicety, not worth clipping mid-string.
   */
  private footerTitle() {
    const full = ` ◆ convoy ${shortVersion()} `
    // Border corners and a little slack on each side of the title.
    return displayWidth(full) + 6 <= this.renderer.width ? full : " ◆ convoy "
  }

  /**
   * The footer is one unwrapped line in a fixed-height box, so hints that don't
   * fit used to be chopped off against the border with nothing to say they
   * existed. Now the row sheds them by priority and the pinned [ctrl+p] hint
   * changes its wording to point at the palette, where all of them are listed.
   */
  private footerContent(now: number, width: number) {
    const state = this.actionState()
    const actions = dashboardActions(state)
    const hints: Hint[] = actions
      .filter((action) => action.available && action.hint !== undefined && action.keys !== undefined)
      .map((action) => ({
        keys: action.keys!,
        label: action.hint!,
        priority: action.priority,
        tone: action.tone,
        style: action.style,
        labelChunks: action.labelChunks,
      }))

    if (state.permissionPending) {
      const right: TextChunk[] = this.permissionQueue.length > 1 ? [fg(theme.yellow)(`${this.permissionQueue.length} pending`)] : []
      return hintsRow(hints, [right], width, { style: "spaced", overflow: moreHintsMarker, prefix: [fg(theme.yellow)("⚿ ")] })
    }

    const gate = this.humanReviewQueue[0]
    if (gate) {
      const right: TextChunk[] = []
      if (this.humanReviewQueue.length > 1) right.push(fg(theme.yellow)(`${this.humanReviewQueue.length - 1} more waiting`), fg(theme.faint)(" · "))
      if (gate.info.iterations > 0) right.push(fg(theme.faint)(`${gate.info.iterations} iteration${gate.info.iterations === 1 ? "" : "s"}`))
      const prefix = [fg(theme.yellow)(gate.info.kind === "failure" ? "step failed · " : gate.info.kind === "budget-gate" ? "step budget reached · " : gate.info.kind === "interactive" ? "interactive session · " : "human review · ")]
      return hintsRow(hints, [right], width, { style: "spaced", overflow: moreHintsMarker, prefix })
    }

    // Pinned: whatever else goes, the way to find the rest stays. The wording
    // switches to "all shortcuts" the moment a hint is actually dropped.
    const overflow: OverflowHint = { keys: "ctrl+p", label: "commands", moreLabel: "all shortcuts", priority: 0 }
    const prefix = state.contentFocused ? [fg(theme.dim)("read · ")] : []
    return hintsRow(hints, this.footerStatusCandidates(now), width, { overflow, prefix })
  }

  /**
   * Run metadata, longest first. Detail goes before precision: the quiet timer
   * drops, then the server URL, and the run id is kept whole rather than being
   * ellipsised mid-value.
   */
  private footerStatusCandidates(now: number): TextChunk[][] {
    const run = fg(theme.faint)(this.runID ? `run ${this.runID}` : "run …")
    if (this.finished) return [[run]]
    const quiet = now - this.lastActivityAt
    const sep = fg(theme.faint)(" · ")
    const server = fg(theme.faint)(this.serverUrl ? `⚡ ${shortUrl(this.serverUrl)}` : "⚡ starting…")
    const ago = fg(quiet > 60_000 ? theme.yellow : theme.faint)(formatAgo(quiet))
    return [[run, sep, server, sep, ago], [run, sep, server], [run]]
  }

  private renderModal() {
    const pending = this.permissionQueue[0]
    if (pending) {
      this.renderPermissionModal(pending)
      return
    }
    if (this.publishModal) {
      this.renderPublishModal(this.publishModal)
      return
    }
    if (this.abortConfirm) {
      this.renderAbortConfirmModal()
      return
    }
    if (this.usageModal) {
      this.renderUsageModal()
      return
    }
    if (this.commandPalette) {
      this.renderCommandPalette()
      return
    }
    this.overlay.visible = false
  }

  // The palette's "Abort the run" lands here: the coordinator is someone
  // else's process and an accidental kill is not recoverable, so the modal
  // defaults to No and only a deliberate y goes through. Same shape as the
  // runs browser's retry confirm — no title glyph (⚿ belongs to permission).
  private renderAbortConfirmModal() {
    this.overlay.visible = true
    this.modal.title = " abort run "
    const boxWidth = Math.max(44, this.renderer.width - 10)
    this.modal.width = boxWidth
    const lines: StyledText[] = [
      t`${bold(fg(theme.yellow)("Abort the running pipeline?"))}`,
      plain(""),
      t`${fg(theme.faint)("There is no undo: the current turn is cancelled")}`,
      t`${fg(theme.faint)("and the run lease is released.")}`,
      plain(""),
      t`${fg(theme.accent)("y")} ${fg(theme.text)("abort")}   ${fg(theme.faint)("n / esc")} ${fg(theme.dim)("cancel")}`,
    ]
    this.modal.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }

  /**
   * [u]: the subscription meters, moved out of the header so a healthy state
   * costs zero rows. Everything degrades: no GPT auth yet, no OpenRouter key,
   * and the first poll still in flight each say so in place.
   */
  private renderUsageModal() {
    this.overlay.visible = true
    this.modal.title = " usage "

    const boxWidth = Math.max(48, Math.min(76, this.renderer.width - 8))
    const width = boxWidth - 6
    const lines: StyledText[] = []
    const now = Date.now()

    const openrouter = this.limits?.openrouter
    const orLabel = "OpenRouter "
    if (openrouter) {
      const value = openrouter.kind === "remaining" ? `${formatMoney(openrouter.amount)} left` : `${formatMoney(openrouter.amount)} spent this month`
      const color = openrouter.kind === "remaining" && openrouter.amount < openRouterLowBalance ? theme.yellow : theme.text
      lines.push(new StyledText([fg(theme.dim)(orLabel), fg(color)(value)]))
    } else {
      lines.push(new StyledText([fg(theme.dim)(orLabel), fg(theme.faint)(truncate("not configured — `convoy auth openrouter` stores the balance key", width - orLabel.length))]))
    }

    const gpt = this.limits?.gpt
    const openaiLabel = "OpenAI     "
    if (gpt) {
      const pct = Math.round(gpt.sessionPct)
      const barColor = pct >= 85 ? theme.red : pct >= 60 ? theme.yellow : theme.accent
      const label = fg(theme.dim)(openaiLabel)
      const bar = [...progressBar(pct / 100, 10, barColor), raw(" "), fg(pct >= 60 ? barColor : theme.text)(`${pct}%`)]
      const tail: TextChunk[] = []
      if (gpt.sessionResetsAt !== undefined) tail.push(fg(theme.faint)(" · resets "), fg(theme.dim)(fmtCountdown(gpt.sessionResetsAt, now)))
      if (gpt.weeklyPct !== undefined) {
        const wk = Math.round(gpt.weeklyPct)
        tail.push(fg(theme.faint)(" · wk "), fg(wk >= 85 ? theme.red : wk >= 60 ? theme.yellow : theme.dim)(`${wk}%`))
      }
      const full = [...bar, ...tail]
      // Drop the weekly window first, then the reset countdown, before ever
      // clipping a value mid-token.
      const budget = width - chunksLength([label])
      let fitted = full
      if (chunksLength(fitted) > budget) fitted = gpt.weeklyPct === undefined ? bar : [...bar, ...tail.slice(0, 2)]
      if (chunksLength(fitted) > budget) fitted = bar
      lines.push(new StyledText([label, ...fitted]))
    } else if (this.limits?.gptHint) {
      lines.push(new StyledText([fg(theme.dim)(openaiLabel), fg(theme.yellow)(truncate(this.limits.gptHint, width - openaiLabel.length))]))
    } else {
      lines.push(new StyledText([fg(theme.dim)(openaiLabel), fg(theme.faint)(truncate("not configured — `codex login` meters the OpenAI windows", width - openaiLabel.length))]))
    }

    lines.push(plain(""))
    if (this.limits) {
      lines.push(new StyledText([fg(theme.faint)(`updated ${formatAgo(now - this.limits.fetchedAt)}`)]))
    } else {
      lines.push(new StyledText([fg(theme.faint)("first poll still in flight…")]))
    }
    lines.push(plain(""))
    lines.push(new StyledText([fg(theme.faint)("esc close")]))

    this.modalText.content = joinLines(lines)
  }

  private renderPublishModal(modal: PublishModal) {
    this.overlay.visible = true
    this.modal.title = " ⇪ create pull request "

    const boxWidth = Math.max(48, Math.min(76, this.renderer.width - 8))
    const width = boxWidth - 6
    const lines: StyledText[] = []

    if (modal.kind === "working") {
      lines.push(new StyledText([fg(theme.accent)(spinnerFrame(Date.now())), fg(theme.text)(` ${modal.message}`)]))
    } else if (modal.kind === "blocked") {
      for (const line of wrapLines(modal.message.split("\n"), width)) lines.push(t`${fg(theme.yellow)(line)}`)
      lines.push(plain(""))
      lines.push(t`${fg(theme.faint)("press any key to dismiss")}`)
    } else if (modal.kind === "confirm") {
      lines.push(new StyledText([fg(theme.text)(`push ${modal.plan.branch} to ${modal.plan.remote}/${modal.plan.branch}`)]))
      lines.push(t`${fg(theme.dim)(`normal push (never forced), then locate or create a pull request onto ${modal.plan.base}`)}`)
      lines.push(plain(""))
      lines.push(
        new StyledText([
          fg(theme.accent)("enter"),
          fg(theme.dim)(" publish · "),
          fg(theme.accent)("esc"),
          fg(theme.dim)(" cancel"),
        ]),
      )
    } else {
      const { outcome } = modal
      lines.push(new StyledText([fg(theme.green)("✓ "), fg(theme.text)(`${modal.plan.branch} pushed to ${modal.plan.remote}`)]))
      if (outcome.url) {
        for (const line of wrapLines([outcome.url], width)) lines.push(t`${fg(theme.dim)(line)}`)
      } else if (modal.note) {
        for (const line of wrapLines([modal.note], width)) lines.push(t`${fg(theme.dim)(line)}`)
      }
      lines.push(plain(""))
      lines.push(t`${fg(theme.faint)("press any key to close")}`)
    }

    this.modal.width = boxWidth
    this.modal.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }

  private renderPermissionModal(pending: PendingPermission) {
    this.overlay.visible = true
    this.modal.title = " ⚿ permission required "

    const boxWidth = permissionModalWidth(this.renderer.width)
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

    // [e] explain section: loading spinner, ready text, or error
    const explain = pending.explain
    if (explain) {
      if (explain.status === "loading") {
        lines.push(plain(""))
        lines.push(new StyledText([fg(theme.accent)(spinnerFrame(Date.now())), fg(theme.dim)(" judge  thinking…")]))
      } else if (explain.status === "ready") {
        lines.push(plain(""))
        const maxRows = permissionExplainMaxRows(this.renderer.height)
        const visible = explain.lines.slice(explain.scroll, explain.scroll + maxRows)
        for (const line of visible) {
          lines.push(t`${fg(theme.dim)(line)}`)
        }
        if (explain.lines.length > maxRows) {
          lines.push(plain(""), t`${fg(theme.dim)(`↑↓ scroll  (${explain.scroll + 1}–${Math.min(explain.scroll + maxRows, explain.lines.length)} of ${explain.lines.length})`)}`)
        }
      } else if (explain.status === "error") {
        lines.push(plain(""))
        lines.push(t`${fg(theme.yellow)(explain.message)}`)
      }
    }

    // [i] inspect feedback line
    if (pending.inspect) {
      lines.push(plain(""))
      if (pending.inspect.backend) {
        lines.push(t`${fg(theme.faint)(`inspect  opened in ${pending.inspect.backend}`)}`)
      } else if (pending.inspect.error) {
        lines.push(t`${fg(theme.yellow)(`inspect  ${pending.inspect.error}`)}`)
      }
    }

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

  private renderCommandPalette() {
    const palette = this.commandPalette
    if (!palette) return
    this.overlay.visible = true
    this.modal.title = palette.view === "help" ? " ? keyboard shortcuts " : " ⌘ commands "

    const boxWidth = Math.max(46, Math.min(72, this.renderer.width - 8))
    const width = boxWidth - 6
    const head: StyledText[] = []
    const body: StyledText[] = []
    // The shortcut table is longer than a short terminal, so the body scrolls
    // rather than growing the modal past the screen.
    const maxRows = Math.max(4, this.renderer.height - 10)

    if (palette.view === "help") {
      // The full reference, generated from the same catalog the footer and the
      // command list read. It deliberately lists keys the current state can't
      // reach — that is what a shortcut table is for — so each one says when it
      // applies rather than quietly disappearing.
      const documented = dashboardActions(this.actionState()).filter((action) => action.keys !== undefined && action.help !== undefined)
      const keyColumn = documented.reduce((widest, action) => Math.max(widest, displayWidth(action.keys!)), 0)
      shortcutGroupOrder.forEach((group) => {
        const actions = documented.filter((action) => action.group === group)
        if (actions.length === 0) return
        if (body.length > 0) body.push(plain(""))
        body.push(t`${bold(fg(theme.text)(shortcutGroupTitle(group)))}`)
        actions.forEach((action) => {
          const keys = action.keys!.padEnd(action.keys!.length + Math.max(0, keyColumn - displayWidth(action.keys!)))
          body.push(t`${fg(action.tone === "yellow" ? theme.yellow : theme.accent)(keys)}  ${fg(theme.dim)(truncate(action.help!, width - keyColumn - 2))}`)
        })
      })
    } else {
      head.push(t`${fg(theme.faint)("type to filter · ↑↓ select · enter run · esc close")}`)
      if (palette.filter) head.push(t`${fg(theme.dim)("filter ")}${fg(theme.text)(palette.filter)}`)
      head.push(plain(""))
      const items = this.filteredCommandItems()
      if (items.length === 0) {
        body.push(t`${fg(theme.dim)("no matching commands")}`)
      } else {
        items.forEach((item, index) => {
          const selected = index === palette.index
          const left: TextChunk[] = [fg(selected ? theme.accent : theme.faint)(selected ? "› " : "  "), selected ? bold(fg(theme.text)(item.label)) : fg(theme.dim)(item.label)]
          body.push(padBetween(left, item.detail ? [fg(selected ? theme.accent : theme.faint)(item.detail)] : [], width))
        })
        // The selection drives the window here; in the help view the user does.
        palette.scroll = Math.min(palette.scroll, palette.index)
        palette.scroll = Math.max(palette.scroll, palette.index - maxRows + 1)
      }
    }

    const rows = Math.max(0, body.length - maxRows)
    palette.scroll = Math.max(0, Math.min(palette.scroll, rows))
    const visible = body.slice(palette.scroll, palette.scroll + maxRows)

    const legend =
      palette.view === "help"
        ? rows > 0
          ? "↑↓ scroll · esc closes · enter returns to commands"
          : "esc closes · enter returns to commands"
        : rows > 0
          ? `${palette.scroll + 1}–${palette.scroll + visible.length} of ${body.length}`
          : undefined

    const lines = [...head, ...visible]
    if (legend) lines.push(plain(""), t`${fg(theme.faint)(legend)}`)

    this.modal.width = boxWidth
    this.modal.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }
}

/**
 * One-line editable field with a block cursor, for the finish modal's subject.
 * The window scrolls so the cursor stays visible in a value longer than the box,
 * matching the launcher's branch-name field.
 */
function textInput(value: string, cursor: number, width: number): StyledText[] {
  const inner = Math.max(1, width - 2)
  const start = Math.max(0, Math.min(cursor - inner + 1, Math.max(0, value.length - inner + 1)))
  const visible = value.slice(start, start + inner)
  const column = Math.max(0, Math.min(cursor - start, inner - 1))

  const chunks: TextChunk[] = [fg(theme.accent)("│")]
  const before = visible.slice(0, column)
  const at = visible[column] ?? " "
  const after = visible.slice(column + 1)
  chunks.push(fg(theme.text)(before), bg(theme.accent)(fg(theme.chipText)(at)), fg(theme.text)(after))
  chunks.push(raw(" ".repeat(Math.max(0, inner - before.length - 1 - after.length))))
  chunks.push(fg(theme.accent)("│"))
  return [new StyledText(chunks)]
}

function typedCharacter(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta || key.option || key.super || key.hyper) return undefined
  const raw = key.raw ?? ""
  return [...raw].length === 1 && raw >= " " && raw !== "\u007f" ? raw : undefined
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

function humanReviewActionForKey(key: KeyEvent, kind: "interactive" | "failure" | "budget-gate" | undefined, canRetry: boolean): HumanReviewAction | undefined {
  switch (key.name) {
    case "c":
      // [c] continue is never offered on a failure gate: reaching forward
      // (continue) from a broken step must require taking control via [o] first.
      return kind === "failure" || kind === "budget-gate" ? undefined : "continue"
    case "o":
      return kind === "budget-gate" ? undefined : "iterate"
    case "a":
      return "abort"
    case "r":
      return kind === "budget-gate" ? "reset" : kind === "failure" && canRetry ? "retry" : undefined
  }
  return undefined
}

function humanReviewActionLabel(action: HumanReviewAction, kind: "interactive" | "failure" | "budget-gate" | undefined) {
  const gate = kind === "failure" ? "step failed" : kind === "budget-gate" ? "step budget reached" : kind === "interactive" ? "interactive session" : "human review"
  switch (action) {
    case "continue":
      return `${gate}: continue`
    case "iterate":
      return `${gate}: open OpenCode`
    case "abort":
      return `${gate}: abort`
    case "retry":
      return `${gate}: retry clean`
    case "reset":
      return `${gate}: reset and continue`
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
      first.lines = undefined
      total -= excess
    } else {
      total -= first.text.length
      blocks.shift()
    }
  }
}

// Renders one transcript block. Tool/bash markers are a single labelled line;
// reasoning/response are the verbatim text wrapped under a two-space hang,
// headed by a channel label unless the previous block already carried it
// (`labelled` is false for the second and later parts of one stretch).
// Reasoning parts are bulleted — a model emits one summary per part, and run
// together they read as a single garbled paragraph. Reasoning is dimmed so the
// model's actual answer (response) stands out. `live` trails a cursor on the
// final line. Results are memoized on the block: the transcript is re-derived on
// every repaint, but only the block still streaming ever changes.
function transcriptBlockLines(block: TranscriptBlock, width: number, live: boolean, labelled: boolean): StyledText[] {
  const key = `${width}:${live ? 1 : 0}:${labelled ? 1 : 0}:${block.text.length}`
  if (block.lines?.key === key) return block.lines.value
  const value = buildTranscriptBlockLines(block, width, live, labelled)
  block.lines = { key, value }
  return value
}

function buildTranscriptBlockLines(block: TranscriptBlock, width: number, live: boolean, labelled: boolean): StyledText[] {
  const cursor: TextChunk[] = live ? [fg(theme.accent)("▌")] : []

  if (block.channel === "tool" || block.channel === "bash") {
    const marker = block.channel === "bash" ? { icon: "$", color: theme.green } : { icon: "⚒", color: theme.cyan }
    return [new StyledText([fg(marker.color)(`${marker.icon} `), fg(theme.text)(truncate(block.text, Math.max(8, width - 2))), ...cursor])]
  }

  const isReasoning = block.channel === "reasoning"
  const lines: StyledText[] = labelled
    ? [new StyledText([fg(isReasoning ? theme.magenta : theme.accent)(isReasoning ? "✻ " : "✎ "), fg(theme.faint)(isReasoning ? "reasoning" : "response")])]
    : []
  const bodyColor = isReasoning ? theme.dim : theme.text

  if (isReasoning) {
    // A part can still hold several summaries when the provider separates them
    // with blank lines instead of parts, so each paragraph gets its own bullet.
    const paragraphs = block.text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean)
    if (paragraphs.length === 0) {
      if (live) lines.push(new StyledText([raw("  "), ...cursor]))
      return lines
    }
    paragraphs.forEach((paragraph, paragraphIndex) => {
      const rendered = markdownLines(paragraph, Math.max(12, width - 4), bodyColor)
      rendered.forEach((segment, index) => {
        const chunks: TextChunk[] = [raw("  "), fg(theme.faint)(index === 0 ? "· " : "  "), ...segment.chunks]
        if (live && paragraphIndex === paragraphs.length - 1 && index === rendered.length - 1) chunks.push(...cursor)
        lines.push(new StyledText(chunks))
      })
    })
    return lines
  }

  const rendered = markdownLines(block.text, Math.max(12, width - 2), bodyColor)
  if (rendered.length === 0) {
    if (live) lines.push(new StyledText([raw("  "), ...cursor]))
    return lines
  }
  rendered.forEach((segment, index) => {
    const chunks: TextChunk[] = [raw("  "), ...segment.chunks]
    if (live && index === rendered.length - 1) chunks.push(...cursor)
    lines.push(new StyledText(chunks))
  })
  return lines
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

export function phaseCapabilityLabel(phase: Pick<ProgressPhase, "readOnly" | "plannedAdvisor">): string | undefined {
  if (phase.plannedAdvisor && phase.readOnly) return "advisor · audit · read-only"
  if (phase.plannedAdvisor) return "advisor"
  return phase.readOnly ? "audit · read-only" : undefined
}

// The same badge in shrinking forms for the pipeline tree, longest first.
export function phaseCapabilityBadges(phase: Pick<ProgressPhase, "readOnly" | "plannedAdvisor">): string[] {
  if (phase.plannedAdvisor && phase.readOnly) return ["advisor · read-only", "adv · ro", "adv"]
  if (phase.plannedAdvisor) return ["advisor", "adv"]
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
      // A one-step goal invocation still renders its iteration header, so the
      // header is a real target ahead of its single child row.
      if (goalInvocationLabel(group[0]!.groupId)) targets.push({ kind: "group", groupId: group[0]!.groupId! })
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

// A goal invocation's display group id (`goal-measure-0`, the shared
// `goal-<stage>-<n>` qualification prefix) renders as an iteration label
// instead of the literal `parallel`; undefined for every prefix group. Built on
// the shared parser so the label can never drift from the qualification rule.
function goalInvocationLabel(groupId: string | undefined): string | undefined {
  const parsed = groupId ? parseGoalInvocationId(groupId) : undefined
  return parsed ? `${parsed.stage} #${parsed.iteration}` : undefined
}

// Border title for a selected tree group. Goal invocations reuse the launcher's
// fragment word (`measure` / `improve`) instead of the leftover "parallel group"
// chrome; numbered instance stays in the panel body (`measure #0`).
function groupPanelTitle(selection: GroupSelection): string {
  if (selection.stepName !== undefined) return " step group "
  const goal = parseGoalInvocationId(selection.groupId)
  return goal ? ` ${goal.stage} ` : " parallel group "
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
// Goal reconstruction qualifies every physical name (`goal-measure-0-fix`), so
// `stepName !== name` is no longer a fan-out signal — only the `__` slug is.
function phaseDisplayName(phase: PhaseState): string {
  if (phase.stepName && phase.name.includes(`${phase.stepName}__`)) return `${phase.stepName} · ${modelLabel(phase)}`
  return phase.stepName ?? phase.name
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

/**
 * The fresh, nothing-has-happened-yet form of a pipeline's phases: the
 * constructor builds it for a new dashboard, and `resetPipeline` rebuilds it
 * for each goal-loop iteration, so the two can never drift apart.
 */
function pendingPhases(phases: readonly ProgressPhase[]): PhaseState[] {
  return phases.map((phase) => ({
    ...phase,
    status: "pending",
    sessionID: "",
    attempt: 0,
    model: "",
    cost: 0,
    tokens: emptyTokens(),
    stepCount: 0,
    lastStepModel: "",
    usageReported: false,
    usage: new PhaseUsage(),
    now: { kind: "info", message: "" },
    todos: [],
    advisorEvents: [],
    updatedAt: Date.now(),
  }))
}

/** The score trajectory (`71 → 84`, or `71 → …` while pending), among the first segments to sacrifice. */
function trajectorySegment(scores: number[], pending = false): { priority: number; chunks: TextChunk[] } {
  return { priority: 5, chunks: [fg(theme.dim)(`${scores.join(" → ")}${pending ? " → …" : ""}`)] }
}

async function fileReadable(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The box width for the permission modal, matching the extraction in renderPermissionModal. */
function permissionModalWidth(rendererWidth: number): number {
  return Math.max(44, Math.min(68, rendererWidth - 8))
}

/** Max rows of explain text visible in the permission modal. */
function permissionExplainMaxRows(rendererHeight: number): number {
  return Math.max(3, rendererHeight - 16)
}
