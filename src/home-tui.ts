import { bg, BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg } from "@opentui/core"

import { detectBaseRef } from "./git"
import { worktreeDotColor } from "./specs-browser"
import {
  displayWidth,
  hintsRow,
  joinLines,
  moreHintsMarker,
  padBetween,
  paletteForTerminal,
  raw,
  setTheme,
  shortPath,
  terminalBackgroundHex,
  theme,
  truncate,
  wrapLines,
} from "./tui-theme"
import { versionDetails } from "./version"
import { homeRendererConfig, sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import { observeWorktreePr, type BoardWorktree } from "./control-board"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { Hint, PaletteColor } from "./tui-theme"
import type { PrObservation } from "./pr-observations"

/**
 * Worktrees-first Home (capability home-launcher delta, tasks 3.1/3.4; gap
 * CC-1): the primary screen is the repository's Worktrees list — every
 * Git-registered checkout, main, external, detached, locked, missing-path,
 * and spec-less alike — plus an explicit New worktree entry and auxiliary
 * destinations as navigation actions. A worktree is a Git checkout, not a
 * domain record: rows carry observed facts (branch, path, dirt, activity,
 * local changes), never feature identities, lifecycle summaries, or
 * Completed history.
 *
 * Chrome matches the rest of Convoy: a lean identity masthead above a single
 * vertical stack — the worktrees panel on top, the destinations strip for
 * pipelines/specs/runs/config below it. The details are not a panel of their
 * own: the selected row unfolds its facts inline beneath it, the way a
 * pipeline step drops its body, and the fold travels with the selection —
 * one row's hints strip at the bottom, never a dedicated footer panel, never
 * a destination poster, never the destinations mixed into the checkout list.
 */

/** One of the auxiliary home destinations (pipelines, specs, runs, config). */
export type HomeDestination = "pipelines" | "specs" | "runs" | "config"

/** The action an opened worktree detail resolves to. */
export type HomeWorkAction =
  | "conversation"
  | "conversation-external"
  | "propose"
  | "pipeline"
  | "specs"
  | "runs"
  | "fetch"
  | "sync"
  | "push"
  | "pr"
  | "squash"
  | "remove"
  | "delete-branch"
  | "close"

/** What a closed Home asks the surrounding session to do. */
export type HomeResolution =
  | { type: "destination"; destination: HomeDestination }
  | { type: "work"; worktree: string; action: HomeWorkAction }
  | { type: "new-work"; draft?: { displayName: string; branch: string; base: string; worktree: string } }
  | undefined

export type HomeSelection = HomeDestination | undefined

const CHROME_PADDING_COLS = 1
/** Blank rows between the CONVOY masthead and the first panel. */
const MASTHEAD_BREATHING_ROWS = 1
export const WORDMARK_GAP = "  "
/** Rounded border + paddingX:1 on each side of a panel. */
const PANEL_GUTTER = 4
/** The destinations strip's resting height: 4 rows + rounded border. */
const DESTINATION_PANEL_HEIGHT = 6
/** The inline detail block hangs right of the row's marker + dot columns. */
const INLINE_INDENT = 6

/** The CONVOY block letters, shared with the loading transition's centered card. */
export const CONVOY_WORDMARK: Readonly<Record<string, readonly [string, string, string]>> = {
  C: ["████", "██  ", "████"],
  O: ["████", "█  █", "████"],
  N: ["█  █", "██ █", "█ ██"],
  V: ["█  █", "█  █", " ██ "],
  Y: ["█  █", " ██ ", " ██ "],
}
export const CONVOY_LETTERS = [..."CONVOY"]
export const CONVOY_WORDMARK_WIDTH = CONVOY_LETTERS.reduce(
  (width, letter, index) => width + CONVOY_WORDMARK[letter]![0].length + (index > 0 ? WORDMARK_GAP.length : 0),
  0,
)

const AUXILIARY: ReadonlyArray<{
  id: HomeDestination
  shortcut: string
  label: string
  kicker: string
  description: string
}> = [
  {
    id: "pipelines",
    shortcut: "p",
    label: "Pipelines",
    kicker: "From intent to ship",
    description: "Compose agents into a reviewed, repeatable path from intent to shipped code.",
  },
  {
    id: "specs",
    shortcut: "s",
    label: "Specs",
    kicker: "The living spec",
    description: "Explore, shape, run, and close work around the project's living specification.",
  },
  {
    id: "runs",
    shortcut: "r",
    label: "Runs",
    kicker: "Live and history",
    description: "Follow live execution and revisit the history, reports, and decisions behind every run.",
  },
  {
    id: "config",
    shortcut: "c",
    label: "Config",
    kicker: "Models and agents",
    description: "Tune models, agents, pipelines, permissions, hooks, and project defaults.",
  },
]

type ListRow =
  | { kind: "worktree"; worktree: BoardWorktree }
  | { kind: "new" }
  | { kind: "auxiliary"; destination: HomeDestination; label: string; shortcut: string; kicker: string; description: string }

/** The worktree detail's action rows: distinct labels per action. */
type DetailAction = {
  id: HomeWorkAction
  key: string
  label: string
  enabled: boolean
  blocker?: string
}

export async function launchHomeTui(
  targetDir: string,
  options: {
    route?: TuiRoute
    initialSelection?: HomeSelection
    /** The worktree selection to restore, when it still validates against Git. */
    resumeWorktree?: string
    kittyGraphics?: boolean
    /** The repository's worktree rows; loaded by the session loop and refreshed on every open. */
    worktrees?: BoardWorktree[]
    /** Why the remembered worktree could not be restored, shown above the list. */
    resumeNotice?: string
  } = {},
): Promise<HomeResolution> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("convoy needs an interactive terminal to open the home launcher")
  }

  if (options.route) {
    const scene = sceneForRoute(options.route, "convoy-home-scene")!
    return new HomeLauncher(options.route.session.renderer, targetDir, {
      scene,
      worktrees: options.worktrees,
      resumeWorktree: options.resumeWorktree,
      resumeNotice: options.resumeNotice,
    }).result
  }

  const renderer = await createCliRenderer(homeRendererConfig(false))
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new HomeLauncher(renderer, targetDir, { worktrees: options.worktrees, resumeWorktree: options.resumeWorktree, resumeNotice: options.resumeNotice }).result
}

export class HomeLauncher {
  readonly result: Promise<HomeResolution>

  private resolveResult!: (resolution: HomeResolution) => void
  private finished = false
  private readonly scene?: TuiScene
  /** "list": the worktree list; "detail": one worktree's actions; "form": new-worktree fields. */
  private level: "list" | "detail" | "form" = "list"
  private rows: ListRow[] = []
  private selectedRow = 0
  /** First visible list row; re-clamped on every render so navigation and resize both keep the selection on screen. */
  private scroll = 0
  private detailWorktree?: BoardWorktree
  private detailSelected = 0
  /** First visible detail line; same re-clamping contract as `scroll`. */
  private detailScroll = 0
  /**
   * Whether the detail pane follows the selected action. Action navigation
   * sets it; explicit paging (pgup/pgdn) clears it so the metadata above the
   * actions — name, branch, facts — stays readable.
   */
  private detailFollow = true
  /** New-worktree form state: one input field at a time, committed in sequence. */
  private form: { field: 0 | 1 | 2; displayName: string; branch: string; base: string; error?: string } | undefined
  /** Why the remembered worktree could not be restored. */
  private readonly resumeNotice?: string
  /** The injected naming-model callback; the real bounded namer is the default. */
  private readonly proposeBranchName?: (input: { prompt: string }) => Promise<{ branch: string }>
  private readonly emptyWork: boolean
  /**
   * On-demand PR evidence per checkout path: `checking` while the query runs,
   * the observation once it lands. The board arrives without PR evidence by
   * design — landing on a row is what requests it.
   */
  private readonly prEvidence = new Map<string, PrObservation | "checking">()
  private readonly prInFlight = new Set<string>()
  private readonly observePr: (worktree: BoardWorktree) => Promise<PrObservation>

  private readonly mastheadText: TextRenderable
  private readonly mastheadBox: BoxRenderable
  private readonly noticeText: TextRenderable
  private readonly noticeBox: BoxRenderable
  private readonly bodyBox: BoxRenderable
  private readonly listText: TextRenderable
  private readonly listBox: BoxRenderable
  private readonly destText: TextRenderable
  private readonly destBox: BoxRenderable
  private readonly previewText: TextRenderable
  private readonly previewBox: BoxRenderable
  private readonly hintsText: TextRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.render()
  }

  /**
   * A resize redraws the existing tree at the new size; without re-rendering,
   * the windowed list and detail would keep the old pane's content until the
   * next keypress. Re-clamping here keeps the selection visible immediately.
   */
  private readonly handleResize = () => {
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
    if (this.level === "list") this.handleListKey(key)
    else if (this.level === "detail") this.handleDetailKey(key)
    else this.handleFormKey(key)
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly targetDir: string,
    options: {
      scene?: TuiScene
      worktrees?: BoardWorktree[]
      resumeWorktree?: string
      resumeNotice?: string
      /** Asks the naming model for a conventional branch name; injected so tests stay hermetic. */
      proposeBranchName?: (input: { prompt: string }) => Promise<{ branch: string }>
      /** The on-demand PR observation; injected so tests stay hermetic. */
      observePr?: (worktree: BoardWorktree) => Promise<PrObservation>
    } = {},
  ) {
    this.scene = options.scene
    this.resumeNotice = options.resumeNotice
    this.proposeBranchName = options.proposeBranchName
    this.observePr = options.observePr ?? ((worktree) => observeWorktreePr({ targetDir: this.targetDir, worktree }))
    this.emptyWork = (options.worktrees ?? []).length === 0
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })
    this.rows = this.buildRows(options.worktrees ?? [])
    // A restored worktree lands on its row only when it still validates
    // against the live Git inventory; a missing remembered worktree falls
    // back to the list with the explanation shown — never silently selecting
    // another execution target.
    if (options.resumeWorktree) {
      const index = this.rows.findIndex((row) => row.kind === "worktree" && row.worktree.path === options.resumeWorktree)
      if (index >= 0) this.selectedRow = index
    }

    const mount = this.scene?.root ?? renderer.root
    const shell = new BoxRenderable(renderer, {
      id: "convoy-home-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
    })
    const mastheadBox = new BoxRenderable(renderer, {
      id: "convoy-home-masthead",
      width: "100%",
      height: 3,
      flexShrink: 0,
      backgroundColor: theme.bg,
      paddingX: CHROME_PADDING_COLS,
    })
    const mastheadText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", wrapMode: "none" })
    mastheadBox.add(mastheadText)

    const noticeBox = new BoxRenderable(renderer, {
      id: "convoy-home-notice",
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: theme.bg,
      paddingX: CHROME_PADDING_COLS,
      visible: Boolean(options.resumeNotice),
    })
    const noticeText = new TextRenderable(renderer, { content: "", fg: theme.yellow, width: "100%", wrapMode: "none" })
    noticeBox.add(noticeText)

    const bodyBox = new BoxRenderable(renderer, {
      id: "convoy-home-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      backgroundColor: theme.bg,
    })

    const list = this.panel({
      id: "convoy-home-list",
      height: "100%",
      flexGrow: 1,
      borderColor: theme.accent,
      backgroundColor: theme.bg,
      title: " worktrees ",
      titleAlignment: "left",
    })
    const destinations = this.panel({
      id: "convoy-home-destinations",
      width: "100%",
      height: DESTINATION_PANEL_HEIGHT,
      flexShrink: 0,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " destinations ",
      titleAlignment: "left",
    })
    const preview = this.panel({
      id: "convoy-home-preview",
      width: "100%",
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " details ",
      titleAlignment: "left",
    })

    const hintsBox = new BoxRenderable(renderer, {
      id: "convoy-home-hints",
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: theme.bg,
      paddingX: CHROME_PADDING_COLS,
    })
    const hintsText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", wrapMode: "none" })
    hintsBox.add(hintsText)

    this.mastheadText = mastheadText
    this.mastheadBox = mastheadBox
    this.noticeText = noticeText
    this.noticeBox = noticeBox
    this.bodyBox = bodyBox
    this.listText = list.text
    this.listBox = list.box
    this.destText = destinations.text
    this.destBox = destinations.box
    this.previewText = preview.text
    this.previewBox = preview.box
    this.hintsText = hintsText
    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: mastheadBox, background: "bg" },
      { box: noticeBox, background: "bg" },
      { box: bodyBox, background: "bg" },
      { box: list.box, background: "bg", border: "accent" },
      { box: destinations.box, background: "bg", border: "borderDim" },
      { box: preview.box, background: "bg", border: "borderDim" },
      { box: hintsBox, background: "bg" },
    )

    bodyBox.add(list.box)
    bodyBox.add(destinations.box)
    bodyBox.add(preview.box)
    shell.add(mastheadBox)
    shell.add(noticeBox)
    shell.add(bodyBox)
    shell.add(hintsBox)
    mount.add(shell)

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    renderer.on("resize", this.handleResize)
    // The opening selection lands immediately: its PR evidence starts now,
    // the rest of the board never waits for it.
    this.landOnSelected()
    this.render()
  }

  /**
   * The list always shows the worktree surface: checkouts and New worktree in
   * the worktrees panel; the four destinations live in their own strip below,
   * never mixed into the checkout list.
   */
  private buildRows(worktrees: BoardWorktree[]): ListRow[] {
    const rows: ListRow[] = []
    for (const worktree of worktrees) rows.push({ kind: "worktree", worktree })
    rows.push({ kind: "new" })
    for (const entry of AUXILIARY) {
      rows.push({
        kind: "auxiliary",
        destination: entry.id,
        label: entry.label,
        shortcut: entry.shortcut,
        kicker: entry.kicker,
        description: entry.description,
      })
    }
    return rows
  }

  /** Rows before the first auxiliary row: what the worktrees panel renders. */
  private workRowCount(): number {
    return this.rows.findIndex((row) => row.kind === "auxiliary")
  }

  private isSelectable(row: ListRow | undefined): boolean {
    return row !== undefined
  }

  // ── keys ────────────────────────────────────────────────────────────────

  private handleListKey(key: KeyEvent) {
    // Direct auxiliary shortcuts stay available from the list (and stay
    // unambiguous: they only fire when not typing into a form).
    const auxiliary = AUXILIARY.find((entry) => entry.shortcut === key.name)
    if (auxiliary) {
      this.finish({ type: "destination", destination: auxiliary.id })
      return
    }
    const selectable = this.rows.map((row, index) => ({ row, index })).filter(({ row }) => this.isSelectable(row))
    const position = selectable.findIndex(({ index }) => index === this.selectedRow)
    const move = (delta: number) => {
      if (selectable.length === 0) return
      const next = selectable[(position + delta + selectable.length) % selectable.length]!
      this.selectedRow = next.index
    }
    switch (key.name) {
      case "up":
      case "k":
        move(-1)
        break
      case "down":
      case "j":
        move(1)
        break
      case "return":
      case "linefeed":
      case "o":
        this.activateSelected()
        break
      case "n":
        this.openNewWorkForm()
        break
      case "q":
      case "escape":
        this.finish(undefined)
        break
    }
    // Landing on a row is what requests its PR evidence — never the board
    // load, and never a plain re-render while already parked on the row.
    this.landOnSelected()
    this.render()
  }

  /**
   * Fires the on-demand PR observation when the selection lands on a
   * worktree row: moving through the list queries only the checkouts the
   * operator actually visits, and the shared cache dedupes the request
   * within its TTL. A parked row never re-fires.
   */
  private landOnSelected() {
    if (this.level !== "list") return
    const row = this.rows[this.selectedRow]
    const worktree = row?.kind === "worktree" ? row.worktree : undefined
    if (!worktree) {
      this.lastLanded = undefined
      return
    }
    if (worktree.path === this.lastLanded) return
    this.lastLanded = worktree.path
    this.ensurePrEvidence(worktree)
  }

  private lastLanded?: string

  private ensurePrEvidence(worktree: BoardWorktree): void {
    const path = worktree.path
    if (this.prInFlight.has(path)) return
    if (!worktree.branch) {
      this.prEvidence.set(path, { availability: "unknown", reason: "the checkout has no attached branch to scope a pull-request query", observedAt: Date.now() })
      return
    }
    this.prInFlight.add(path)
    this.prEvidence.set(path, "checking")
    void this.observePr(worktree)
      .then((pr) => {
        this.prInFlight.delete(path)
        if (this.finished || this.prEvidence.get(path) !== "checking") return
        this.prEvidence.set(path, pr)
        this.render()
      })
      .catch(() => {
        this.prInFlight.delete(path)
        if (this.finished || this.prEvidence.get(path) !== "checking") return
        this.prEvidence.set(path, { availability: "unknown", reason: "the pull-request observation failed", observedAt: Date.now() })
        this.render()
      })
  }

  private activateSelected() {
    const row = this.rows[this.selectedRow]
    if (!this.isSelectable(row) || !row) return
    if (row.kind === "worktree") {
      this.detailWorktree = row.worktree
      this.detailSelected = 0
      this.detailScroll = 0
      this.detailFollow = true
      this.level = "detail"
      return
    }
    if (row.kind === "new") {
      this.openNewWorkForm()
      return
    }
    if (row.kind !== "auxiliary") return
    this.finish({ type: "destination", destination: row.destination })
  }

  private detailActions(): DetailAction[] {
    return this.detailWorktree ? this.actionsFor(this.detailWorktree) : []
  }

  private actionsFor(worktree: BoardWorktree): DetailAction[] {
    // Shared per-action guards, projected as advisory enabled states: a
    // blocked action stays inspectable with its reason (design D4). The
    // handlers revalidate the same guards before any effect.
    const verified = worktree.accessible && !worktree.bare
    const writerBusy = worktree.activity?.kind === "known" && worktree.activity.value.total > 0
    const attached = worktree.branch !== undefined
    const inaccessible = "the checkout is not accessible — repair or prune the registration first"
    const detached = "the checkout has a detached HEAD — this action needs an attached branch to name the source"
    const busy = "a managed writer is active in this checkout — inspect or stop it before mutating"
    return [
      {
        id: "conversation",
        key: "v",
        label: "Open conversation",
        enabled: verified,
        blocker: verified ? undefined : inaccessible,
      },
      {
        id: "conversation-external",
        key: "w",
        label: "Open in window",
        enabled: verified,
        blocker: verified ? undefined : inaccessible,
      },
      {
        id: "propose",
        key: "p",
        label: "Propose a change",
        enabled: verified,
        blocker: verified ? undefined : inaccessible,
      },
      {
        id: "pipeline",
        key: "e",
        label: "Execute pipeline",
        enabled: verified,
        blocker: verified ? undefined : inaccessible,
      },
      { id: "specs", key: "s", label: "Open specs", enabled: true },
      { id: "runs", key: "r", label: "Open runs", enabled: true },
      {
        id: "fetch",
        key: "f",
        label: "Fetch remote",
        enabled: verified,
        blocker: verified ? undefined : inaccessible,
      },
      {
        id: "sync",
        key: "y",
        label: "Sync with base",
        enabled: verified && attached && !writerBusy,
        blocker: !verified ? inaccessible : !attached ? detached : writerBusy ? busy : undefined,
      },
      {
        id: "push",
        key: "u",
        label: "Push branch",
        enabled: verified && attached && !writerBusy,
        blocker: !verified ? inaccessible : !attached ? detached : writerBusy ? busy : undefined,
      },
      {
        id: "pr",
        key: "g",
        label: "Compose pull request",
        enabled: verified && attached,
        blocker: !verified ? inaccessible : !attached ? detached : undefined,
      },
      {
        id: "squash",
        key: "m",
        label: "Squash to base",
        enabled: verified && attached && !writerBusy,
        blocker: !verified ? inaccessible : !attached ? detached : writerBusy ? busy : undefined,
      },
      {
        id: "remove",
        key: "d",
        label: "Remove worktree",
        enabled: verified && !worktree.main && !writerBusy,
        blocker: !verified
          ? inaccessible
          : worktree.main
            ? "the repository's main checkout is never removed"
            : writerBusy
              ? busy
              : undefined,
      },
      {
        id: "delete-branch",
        key: "z",
        label: "Delete branch",
        // The branch is checked out in this very worktree, so deletion is
        // refused here by Git's own safety — the honest projection of the
        // shared guard, not a hidden action.
        enabled: false,
        blocker: !attached
          ? "the checkout has no attached branch to delete"
          : `branch ${worktree.branch} is checked out in this worktree — remove the worktree (keeping the branch) before deleting it`,
      },
      {
        id: "close",
        key: "x",
        label: "Close review",
        enabled: verified && attached && !writerBusy,
        blocker: !verified ? inaccessible : !attached ? detached : writerBusy ? busy : undefined,
      },
    ]
  }

  private handleDetailKey(key: KeyEvent) {
    const actions = this.detailActions()
    const direct = actions.find((action) => action.key === key.name)
    if (direct) {
      this.detailFollow = true
      this.resolveDetail(direct)
      return
    }
    switch (key.name) {
      case "up":
      case "k":
        this.detailFollow = true
        this.detailSelected = Math.max(0, this.detailSelected - 1)
        break
      case "down":
      case "j":
        this.detailFollow = true
        this.detailSelected = Math.min(actions.length - 1, this.detailSelected + 1)
        break
      case "pageup":
      case "pagedown": {
        // Explicit scrolling: read the metadata above the actions without
        // moving the selection; the next action navigation re-follows it.
        this.detailFollow = false
        const page = this.detailVisible()
        const max = Math.max(0, this.detailLineCount() - page)
        this.detailScroll = key.name === "pageup" ? Math.max(0, this.detailScroll - page) : Math.min(max, this.detailScroll + page)
        break
      }
      case "return":
      case "linefeed": {
        const action = actions[this.detailSelected]
        if (action) {
          this.detailFollow = true
          this.resolveDetail(action)
          return
        }
        break
      }
      case "escape":
      case "q":
      case "backspace":
      case "b":
        this.level = "list"
        break
    }
    this.render()
  }

  private resolveDetail(action: DetailAction) {
    if (!this.detailWorktree) return
    if (!action.enabled) {
      // Blocked actions stay inspectable with their reason (shared guard
      // vocabulary) instead of disappearing or firing.
      this.render()
      return
    }
    if (action.id === "specs") {
      this.finish({ type: "destination", destination: "specs" })
      return
    }
    if (action.id === "runs") {
      this.finish({ type: "destination", destination: "runs" })
      return
    }
    this.finish({ type: "work", worktree: this.detailWorktree.path, action: action.id })
  }

  // ── new-worktree form ───────────────────────────────────────────────────

  private openNewWorkForm() {
    this.level = "form"
    this.form = { field: 0, displayName: "", branch: "", base: "" }
  }

  private handleFormKey(key: KeyEvent) {
    const form = this.form
    if (!form) return
    if (key.name === "escape") {
      // Cancelling before acceptance makes no repository effects.
      this.form = undefined
      this.level = "list"
      this.render()
      return
    }
    if (key.name === "backspace") {
      const value = form.field === 0 ? form.displayName : form.field === 1 ? form.branch : form.base
      const next = value.slice(0, -1)
      if (form.field === 0) form.displayName = next
      else if (form.field === 1) form.branch = next
      else form.base = next
      form.error = undefined
      this.render()
      return
    }
    if (key.name === "return" || key.name === "linefeed") {
      void this.commitFormField()
      return
    }
    const char = !key.ctrl && !key.meta && !key.option && key.sequence && key.sequence.length === 1 ? key.sequence : undefined
    if (char && /[A-Za-z0-9._\-/ ]/.test(char)) {
      if (form.field === 0) form.displayName += char
      else if (form.field === 1) form.branch += char
      else form.base += char
      form.error = undefined
      this.render()
    }
  }

  /**
   * Asks the configured naming model for a conventional branch name for the
   * reviewed description (work-context delta, task 3.4). Bounded: the namer
   * has its own timeout and the deterministic prefill already on the field is
   * the editable fallback, so a slow or unavailable model never blocks the
   * form. The suggestion lands only while the operator is still on the
   * branch field and has not typed a name of their own.
   */
  private suggestBranchNameToken = 0
  private async suggestBranchName(description: string): Promise<void> {
    const token = ++this.suggestBranchNameToken
    const form = this.form
    if (!form) return
    const deterministic = form.branch
    try {
      const { ensureFreeBranchName } = await import("./worktree")
      let proposed: string | undefined
      if (this.proposeBranchName) {
        proposed = (await this.proposeBranchName({ prompt: description })).branch
      } else {
        const { defaultBranchNameModel, proposeBranchName } = await import("./worktree")
        const { loadMergedConvoyConfig } = await import("./config")
        const config = await loadMergedConvoyConfig(this.targetDir)
        proposed = (await proposeBranchName({
          prompt: description,
          targetDir: this.targetDir,
          model: config?.defaults.branchNameModel ?? defaultBranchNameModel,
        })).branch
      }
      if (token !== this.suggestBranchNameToken) return
      const current = this.form
      if (!current || current !== form || current.field !== 1) return
      if (current.branch !== deterministic) return
      const cleaned = proposed.replace(/^refs\/heads\//, "").replace(/\s+/g, "-")
      if (!cleaned) return
      // The free-name check is advisory here: when it cannot run (e.g. the
      // target is not readable yet), the reviewed creation still re-checks
      // occupancy, and the field stays editable either way. It resolves into
      // a local value — the guards below are what decide the assignment.
      let resolved: string
      try {
        resolved = await ensureFreeBranchName(cleaned, this.targetDir)
      } catch {
        resolved = cleaned
      }
      // Re-check every guard after the await: an operator edit, a field
      // advance, a newer suggestion, or a cancellation during the free-name
      // check must survive — the suggestion never overwrites them.
      if (token !== this.suggestBranchNameToken) return
      const target = this.form
      if (!target || target !== form || target.field !== 1) return
      if (target.branch !== deterministic) return
      target.branch = resolved
      this.render()
    } catch {
      // The deterministic prefill stays; a naming failure is not a form error.
    }
  }

  private async commitFormField() {
    const form = this.form
    if (!form) return
    if (form.field === 0) {
      const name = form.displayName.trim()
      if (name.length < 2) {
        form.error = "give the work a short name (at least 2 characters)"
        this.render()
        return
      }
      // A validated branch is prefilled from the name — editable, no mutation.
      // The deterministic slug is the immediate fallback; the model-backed
      // suggestion (work-context delta, task 3.4) refines it below.
      if (!form.branch) form.branch = slugFromName(name)
      form.field = 1
      this.render()
      void this.suggestBranchName(name)
      return
    }
    if (form.field === 1) {
      const branch = form.branch.trim()
      const cleaned = branch.replace(/^refs\/heads\//, "").replace(/\s+/g, "-")
      if (!cleaned || /^(feat|fix|refactor|perf|docs|test|chore|build|ci)(\/|$)/.test(cleaned) === false) {
        // Conventional prefix stays the allocation convention; a missing one
        // is prefilled rather than refused, so the review stays editable.
        form.branch = `feat/${cleaned || slugFromName(form.displayName)}`
      } else {
        form.branch = cleaned
      }
      const { ensureFreeBranchName } = await import("./worktree")
      try {
        form.branch = await ensureFreeBranchName(form.branch, this.targetDir)
      } catch (error) {
        form.error = error instanceof Error ? error.message : String(error)
        this.render()
        return
      }
      form.field = 2
      if (!form.base) {
        const detected = await detectBaseRef(this.targetDir).catch(() => undefined)
        form.base = detected?.ref ?? "main"
      }
      this.render()
      return
    }
    // Field 2 confirmed: resolve the destination with the documented worktree
    // conventions and hand the draft to the session loop for the reviewed
    // creation — nothing has been mutated yet.
    const { resolveWorktreeDir } = await import("./worktree")
    try {
      const worktree = await resolveWorktreeDir(form.branch, this.targetDir)
      const draft = { displayName: form.displayName.trim(), branch: form.branch, base: form.base.trim() || "main", worktree }
      this.form = undefined
      this.finish({ type: "new-work", draft })
    } catch (error) {
      form.error = error instanceof Error ? error.message : String(error)
      this.render()
    }
  }

  // ── rendering ───────────────────────────────────────────────────────────

  private finish(resolution: HomeResolution) {
    if (this.finished) return
    this.finished = true
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    this.renderer.off("resize", this.handleResize)
    if (!this.scene && !this.renderer.isDestroyed) this.renderer.destroy()
    this.resolveResult(resolution)
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
      wrapMode: "none",
    })
    box.add(text)
    return { box, text }
  }

  private wideMasthead(): boolean {
    return this.renderer.width >= CONVOY_WORDMARK_WIDTH + Math.max(displayWidth(versionDetails()), 16) + 1
  }

  private mastheadHeight(): number {
    // The identity block plus one blank row below it: the worktrees panel
    // never sits flush against the CONVOY wordmark.
    return (this.wideMasthead() ? 3 : 2) + MASTHEAD_BREATHING_ROWS
  }

  /** Rows under the masthead (and resume notice, when shown), above the hints strip. */
  private bodyHeight(): number {
    const notice = this.resumeNotice ? 1 : 0
    return Math.max(3, this.renderer.height - this.mastheadHeight() - notice - 1)
  }

  /**
   * The destinations strip grows by the selected entry's inline detail block;
   * at rest it is a fixed 4-row strip. The worktree list takes whatever is
   * left, so the details' space follows the selection: highlighting a
   * worktree gives its block the list's slack, highlighting a destination
   * gives it the strip's.
   */
  private destPanelHeight(): number {
    if (this.selectedRow < this.workRowCount()) return DESTINATION_PANEL_HEIGHT
    const detail = this.inlineDetailLines(this.rows[this.selectedRow]!, Math.max(8, this.renderer.width - PANEL_GUTTER))
    return DESTINATION_PANEL_HEIGHT + detail.length
  }

  private listPanelHeight(bodyHeight: number): number {
    return Math.max(3, bodyHeight - this.destPanelHeight())
  }

  private listInnerHeight(): number {
    if (this.level !== "list") return 1
    return Math.max(1, this.listPanelHeight(this.bodyHeight()) - 2)
  }

  /** Rows the detail pane can hold inside its bordered panel. */
  private detailVisible(): number {
    return Math.max(3, this.bodyHeight() - 2)
  }

  private render() {
    if (this.renderer.isDestroyed || this.scene?.isClosed) return
    const width = Math.max(1, this.renderer.width)
    const immersed = this.level !== "list"
    const mastheadRows = this.mastheadHeight()
    const bodyHeight = this.bodyHeight()
    const destHeight = this.destPanelHeight()
    const listHeight = Math.max(3, bodyHeight - destHeight)

    this.mastheadBox.height = mastheadRows
    this.mastheadText.content = this.mastheadContent(width - CHROME_PADDING_COLS * 2)
    this.noticeBox.visible = Boolean(this.resumeNotice)
    if (this.resumeNotice) {
      this.noticeText.content = new StyledText([fg(theme.yellow)(truncate(this.resumeNotice, Math.max(1, width - CHROME_PADDING_COLS * 2)))])
    }

    // One vertical stack: worktrees on top (the selected row unfolding its
    // inline details beneath it), the destinations strip below.
    this.bodyBox.gap = 0

    if (immersed) {
      this.listBox.visible = false
      this.destBox.visible = false
      this.previewBox.visible = true
      this.previewBox.width = "100%"
      this.previewBox.height = "100%"
      this.previewBox.borderColor = theme.accent
    } else {
      this.listBox.visible = true
      this.destBox.visible = true
      this.previewBox.visible = false
      this.listBox.width = "100%"
      this.listBox.height = listHeight
      this.destBox.width = "100%"
      this.destBox.height = destHeight
      this.listBox.borderColor = theme.accent
      this.destBox.borderColor = theme.borderDim
    }

    const innerWidth = Math.max(8, width - PANEL_GUTTER)

    this.listBox.title = " worktrees "
    this.destBox.title = " destinations "
    this.previewBox.title = this.previewTitle()
    this.listText.content = immersed ? "" : this.listContent(innerWidth)
    this.destText.content = immersed ? "" : this.destinationContent(innerWidth)
    this.previewText.content = this.previewContent(innerWidth)
    this.hintsText.content = this.hintsContent(width - CHROME_PADDING_COLS * 2)
    this.renderer.requestRender()
  }

  /** Masthead: identity, complete version, project path above the worktree list. */
  private mastheadContent(width: number): StyledText {
    const project = shortPath(this.targetDir, Math.max(1, width - 9))
    if (this.wideMasthead()) {
      const lines = [0, 1, 2].map((glyphRow): StyledText => {
        const chunks: TextChunk[] = []
        CONVOY_LETTERS.forEach((letter, index) => {
          if (index > 0) chunks.push(raw(WORDMARK_GAP))
          chunks.push(bold(fg(theme.accent)(CONVOY_WORDMARK[letter]![glyphRow]!)))
        })
        if (glyphRow === 0) return padBetween(chunks, [fg(theme.faint)(versionDetails())], width)
        if (glyphRow === 1) return padBetween(chunks, [fg(theme.text)(shortPath(this.targetDir, Math.max(1, width - CONVOY_WORDMARK_WIDTH)))], width)
        return new StyledText(chunks)
      })
      return joinLines(lines)
    }
    const versionLine = padBetween([bold(fg(theme.accent)("CONVOY"))], [fg(theme.faint)(versionDetails())], width)
    return joinLines([versionLine, new StyledText([fg(theme.faint)("project  "), fg(theme.text)(project)])])
  }

  /**
   * The worktrees panel: checkouts and New worktree only — never the
   * destinations. The selected row unfolds its inline detail block right
   * beneath it (the pipeline-step accordion): moving the selection folds the
   * previous block and unfolds it under the new row. The window scrolls by
   * lines, sliding down until the selected row plus its block fit on screen,
   * so the fold never pushes the selection off the fold.
   */
  private listContent(width: number): StyledText {
    const inner = Math.max(1, this.listInnerHeight())
    const workRows = this.workRowCount()
    const selected = this.selectedRow < workRows ? this.selectedRow : -1
    const detail = selected >= 0 ? this.inlineDetailLines(this.rows[selected]!, width) : []
    const detailH = detail.length
    const rowHeight = (row: number) => (row === selected ? 1 + detailH : 1)
    let start = this.scroll
    const linesBetween = (from: number, to: number): number => {
      let count = 0
      for (let i = from; i < to; i++) count += rowHeight(i)
      return count
    }
    if (selected >= 0) {
      while (start < selected && linesBetween(start, selected) + 1 + detailH > inner) start++
    }
    start = Math.max(0, Math.min(start, Math.max(0, workRows - 1)))
    this.scroll = start
    const lines: StyledText[] = []
    let used = 0
    for (let i = start; i < workRows; i++) {
      if (used >= inner) break
      lines.push(this.rowLine(this.rows[i]!, i === selected, width))
      used++
      if (i === selected) {
        for (const line of detail) {
          if (used >= inner) break
          lines.push(line)
          used++
        }
      }
    }
    return joinLines(lines)
  }

  /**
   * The destinations strip: the four auxiliary entries. The highlighted
   * destination unfolds the same inline detail block beneath it — the strip
   * grows only while a destination carries the selection.
   */
  private destinationContent(width: number): StyledText {
    const workRows = this.workRowCount()
    const auxRows = this.rows.slice(workRows)
    const localSelected = this.selectedRow - workRows
    const detail = localSelected >= 0 ? this.inlineDetailLines(auxRows[localSelected]!, width) : []
    const lines: StyledText[] = []
    auxRows.forEach((row, index) => {
      lines.push(this.rowLine(row, index === localSelected, width))
      if (index === localSelected) lines.push(...detail)
    })
    return joinLines(lines)
  }

  /**
   * One list row, speaking the board's row vocabulary: an observation-colored
   * dot on worktree rows. The selection is a full-width highlight — the
   * accent blue carries the whole line, the text rides the contrasting chip
   * color — with no arrow marker. A worktree row carries only its name (the
   * branch it mirrors would repeat it, and the state lives in the inline
   * details beneath the selected row); the repository's main checkout
   * carries a `base` tag. Destinations keep their `»` marker — they are
   * places to go, not checkouts.
   */
  private rowLine(row: ListRow, selected: boolean, width: number): StyledText {
    if (row.kind === "worktree") {
      const worktree = row.worktree
      const dot = fg(worktreeDotColor(worktree))("◇")
      // The main checkout carries a `base` tag: it is the repository's own
      // checkout, not one more feature branch, and the row says so.
      const tag = worktree.main ? 7 : 0 // " · base"
      const title = truncate(worktreeDisplayNameOf(worktree), Math.max(12, width - 6 - tag))
      if (selected) {
        // The highlight never repaints the dot: its observation color is the
        // row's state, and the accent fill would erase it.
        const left: TextChunk[] = [dot, raw(" "), bold(fg(theme.chipText)(title))]
        if (worktree.main) left.push(fg(theme.chipText)(" · base"))
        return this.highlighted(left, width)
      }
      const left: TextChunk[] = [dot, raw(" "), fg(theme.text)(title)]
      if (worktree.main) left.push(fg(theme.dim)(" · base"))
      return new StyledText(left)
    }
    if (row.kind === "new") {
      const plus = fg(theme.green)("+")
      if (selected) return this.highlighted([plus, raw(" "), bold(fg(theme.chipText)("New worktree"))], width)
      return new StyledText([plus, raw(" "), fg(theme.text)("New worktree")])
    }
    const arrow = fg(theme.teal)("»")
    if (selected) {
      return this.highlighted([arrow, raw(" "), bold(fg(theme.chipText)(row.label)), fg(theme.chipText)(`  [${row.shortcut.toUpperCase()}]`)], width)
    }
    return new StyledText([arrow, raw(" "), fg(theme.text)(row.label), fg(theme.faint)(`  [${row.shortcut.toUpperCase()}]`)])
  }

  /**
   * The selected row's full-width highlight: the accent blue paints every
   * chunk and the filler to the edge. Chunk colors arrive already chosen —
   * the row decides what rides the chip color and what keeps its own
   * observation color — so the highlight only ever adds the background.
   */
  private highlighted(chunks: TextChunk[], width: number): StyledText {
    const used = chunks.reduce((total, chunk) => total + displayWidth(typeof chunk === "string" ? chunk : (chunk as { text: string }).text), 0)
    const filler = bg(theme.accent)(fg(theme.chipText)(" ".repeat(Math.max(0, width - used))))
    return new StyledText(chunks.map((chunk) => bg(theme.accent)(chunk)).concat(filler))
  }

  /** The full-screen pane's title; at the list level the details ride inline, never in a panel. */
  private previewTitle(): string {
    if (this.level === "form") return " new worktree "
    return " actions "
  }

  private previewContent(width: number): StyledText {
    if (this.level === "detail") return this.detailContent(width)
    if (this.level === "form") return this.formContent(width)
    return new StyledText([raw("")])
  }

  /**
   * The inline detail block hanging under the selected row: observed facts,
   * not a lifecycle summary, indented right of the marker + dot columns — the
   * same fold a pipeline step drops beneath itself. Enter still opens the
   * worktree's actions.
   */
  private inlineDetailLines(row: ListRow, width: number): StyledText[] {
    const w = Math.max(8, width - INLINE_INDENT)
    const indent = " ".repeat(INLINE_INDENT)
    const lines: StyledText[] = []
    if (row.kind === "worktree") {
      const worktree = row.worktree
      // The fact rows share one 9-column label grid with an explicit gap;
      // the tree hangs closer to the left edge than the value column.
      const add = (label: string, value: string, color = theme.text) => {
        lines.push(new StyledText([raw(indent), fg(theme.faint)(label.padEnd(9, " ")), raw(" "), fg(color)(truncate(value, Math.max(8, w - 10)))]))
      }
      add("branch", worktree.detached ? "detached HEAD" : (worktree.branch ?? "(no branch)"), theme.dim)
      add("path", shortPath(worktree.path, Math.max(8, w - 10)), theme.dim)
      // State speaks the commit/sync condition only: working tree, upstream,
      // base divergence. Counts live in the changes section below.
      const state: string[] = []
      const stateColor = theme.dim
      const dirt = worktree.dirt
      if (dirt?.kind === "known" && dirt.value.dirty) state.push(`${dirt.value.fileCount} uncommitted`)
      if (worktree.upstream?.kind === "known") {
        if (worktree.upstream.value.ahead) state.push(`${worktree.upstream.value.ahead} unpushed`)
        if (worktree.upstream.value.behind) state.push(`${worktree.upstream.value.behind} to pull`)
      }
      if (worktree.baseDivergence?.kind === "known") {
        if (worktree.baseDivergence.value.behind) state.push(`${worktree.baseDivergence.value.behind} behind base`)
        if (worktree.baseDivergence.value.ahead) state.push(`${worktree.baseDivergence.value.ahead} ahead of base`)
      }
      if (worktree.detached) state.push("detached")
      if (!worktree.accessible) state.push("inaccessible")
      if (worktree.locked) state.push("locked")
      if (worktree.prunable) state.push("prunable")
      add("state", state.join(" · ") || (dirt?.kind === "known" ? "clean" : "unknown"), dirt?.kind === "known" ? stateColor : theme.yellow)
      // Linked PR at the same level as state, on demand: "checking…" while
      // the row's own query runs, the honest fact once it lands — none is
      // honest, unknown is never "no PR", and a merged PR never reads as
      // completed work.
      const evidence = this.prEvidence.get(worktree.path)
      if (evidence && evidence !== "checking") {
        const pr = evidence
        const linked =
          pr.availability === "known" ? (pr.pr ? `#${pr.pr.number} ${pr.pr.state}` : "none") : pr.availability === "ambiguous" ? `ambiguous (${pr.matches.length})` : `unknown (${pr.reason})`
        const color = pr.availability === "known" ? (pr.pr ? theme.text : theme.dim) : theme.yellow
        add("linked PR", linked, color)
      } else {
        add("linked PR", "checking…", theme.dim)
      }
      // Spec changes carry their own counts (active, specs, archived, live)
      // and descend as a file-tree, one shallow indent under the title.
      if (worktree.changesUnknown) {
        add("changes", `unknown (${worktree.changesUnknown})`, theme.yellow)
      } else {
        const counts: string[] = []
        if (worktree.changes.length > 0) counts.push(`${worktree.changes.length} active`)
        if (worktree.specCount) counts.push(`${worktree.specCount} spec${worktree.specCount === 1 ? "" : "s"}`)
        if (worktree.archiveCount) counts.push(`${worktree.archiveCount} archived`)
        if (worktree.activity?.kind === "known" && worktree.activity.value.total > 0) counts.push(`${worktree.activity.value.total} live`)
        add("changes", counts.join(" · ") || "none", theme.dim)
        const items = worktree.changes.slice(0, 6)
        items.forEach((local, index) => {
          const glyph = index === items.length - 1 ? "└─ " : "├─ "
          const entry = local.title ? `${local.changeId}  ${local.title}` : local.changeId
          lines.push(new StyledText([raw(indent + "  " + glyph), fg(theme.dim)(truncate(entry, Math.max(8, w - 5)))]))
        })
        if (worktree.changes.length > items.length) {
          lines.push(new StyledText([raw(indent + "  "), fg(theme.faint)(`… ${worktree.changes.length - items.length} more`)]))
        }
      }
      lines.push(new StyledText([raw(indent), fg(theme.accent)("enter  "), fg(theme.text)("to see actions")]))
      lines.push(new StyledText([raw("")]))
      return lines
    }
    if (row.kind === "new") {
      if (this.emptyWork) {
        for (const line of wrapLines(["No checkouts in this repository yet."], w)) {
          lines.push(new StyledText([raw(indent), fg(theme.dim)(line)]))
        }
      }
      for (const line of wrapLines(["An isolated checkout before any proposal — no commit, no pull request, no registration."], w)) {
        lines.push(new StyledText([raw(indent), fg(theme.dim)(line)]))
      }
      lines.push(new StyledText([raw(indent), fg(theme.accent)("n  "), fg(theme.text)("name it")]))
      lines.push(new StyledText([raw("")]))
      return lines
    }
    lines.push(new StyledText([raw(indent), fg(theme.accent)(truncate(row.kicker, w))]))
    for (const line of wrapLines([row.description], w)) {
      lines.push(new StyledText([raw(indent), fg(theme.dim)(line)]))
    }
    lines.push(new StyledText([raw(indent), fg(theme.accent)(`${row.shortcut}  `), fg(theme.text)("open")]))
    lines.push(new StyledText([raw("")]))
    return lines
  }

  /** The detail pane's full line list plus the index of its first action row. */
  private detailLines(width: number): { lines: StyledText[]; actionStart: number } {
    const worktree = this.detailWorktree
    if (!worktree) return { lines: [], actionStart: 0 }
    const lines: StyledText[] = []
    // The board's detail anatomy: bold title, dim identity line, then faint
    // `label: ` rows with observed facts.
    lines.push(new StyledText([bold(fg(theme.text)(truncate(worktreeDisplayNameOf(worktree), width)))]))
    lines.push(new StyledText([fg(theme.dim)(truncate(shortPath(worktree.path, width), width))]))
    const add = (label: string, value: string, color = theme.text) => {
      lines.push(new StyledText([fg(theme.faint)(`${label}: `), fg(color)(truncate(value, Math.max(8, width - label.length - 2)))]))
    }
    add("branch", worktree.detached ? "detached HEAD" : (worktree.branch ?? "(no branch)"))
    if (worktree.dirt) {
      add("dirt", worktree.dirt.kind === "known" ? (worktree.dirt.value.dirty ? `${worktree.dirt.value.fileCount} file(s) uncommitted` : "clean") : `unknown (${worktree.dirt.reason})`, worktree.dirt.kind === "known" && worktree.dirt.value.dirty ? theme.yellow : theme.text)
    }
    if (worktree.activity) {
      add("activity", worktree.activity.kind === "known" ? `${worktree.activity.value.total} live run(s)` : `unknown (${worktree.activity.reason})`)
    }
    // PR evidence rides the same on-demand observation the row fired on
    // landing; the detail view never re-queries on its own.
    const prEvidence = this.prEvidence.get(worktree.path)
    if (prEvidence && prEvidence !== "checking") {
      // PR evidence keeps its availability: unknown is never rendered as
      // "no PR" and a merged PR never reads as completed work.
      add("pr", prObservationText(prEvidence), prEvidence.availability === "known" ? theme.text : theme.yellow)
    } else {
      add("pr", "checking…", theme.dim)
    }
    if (worktree.changesUnknown) add("changes", `unknown (${worktree.changesUnknown})`, theme.yellow)
    else add("changes", `${worktree.changes.length} active`)
    for (const local of worktree.changes.slice(0, 4)) {
      const title = local.title ? `${local.changeId} — ${local.title}` : local.changeId
      add("change", title, theme.dim)
    }
    if (worktree.locked) add("lock", worktree.locked.reason ? `locked: ${worktree.locked.reason}` : "locked", theme.yellow)
    if (worktree.prunable) add("prunable", worktree.prunable.reason ?? "stale registration", theme.yellow)
    if (!worktree.accessible) add("state", "inaccessible — the registered path is missing (repair or `git worktree prune`)", theme.yellow)
    lines.push(new StyledText([raw("")]))
    lines.push(new StyledText([bold(fg(theme.accent)("actions"))]))
    const actionStart = lines.length
    this.detailActions().forEach((action, index) => {
      const selected = index === this.detailSelected
      const marker = selected ? fg(theme.accent)("▸ ") : raw("  ")
      // A blocked action dims like the board's disabled entries; its reason
      // stays inspectable in the attention color instead of disappearing.
      const label = action.enabled ? (selected ? bold(fg(theme.text)(action.label)) : fg(theme.text)(action.label)) : fg(theme.dim)(action.label)
      const hint = action.enabled ? fg(theme.faint)(`  [${action.key}]`) : fg(theme.yellow)(`  blocked: ${truncate(action.blocker ?? "", Math.max(0, width - displayWidth(action.label) - 14))}`)
      lines.push(new StyledText([marker, label, hint]))
    })
    return { lines, actionStart }
  }

  private detailLineCount(): number {
    if (!this.detailWorktree) return 0
    return this.detailLines(Math.max(1, this.renderer.width) - PANEL_GUTTER).lines.length
  }

  private detailContent(width: number): StyledText {
    const worktree = this.detailWorktree
    if (!worktree) return this.listContent(width)
    const { lines, actionStart } = this.detailLines(width)
    const visible = this.detailVisible()
    // Action navigation follows the selection; explicit paging (pgup/pgdn)
    // reads the metadata above the actions instead. Both re-clamp to bounds,
    // so a resize never strands the pane past its content.
    if (this.detailFollow) {
      const selectedLine = actionStart + this.detailSelected
      if (selectedLine < this.detailScroll) this.detailScroll = selectedLine
      if (selectedLine >= this.detailScroll + visible) this.detailScroll = selectedLine - visible + 1
    }
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, lines.length - visible)))
    return joinLines(lines.slice(this.detailScroll, this.detailScroll + visible))
  }

  private formContent(width: number): StyledText {
    const form = this.form
    if (!form) return this.listContent(width)
    const lines: StyledText[] = []
    lines.push(new StyledText([bold(fg(theme.text)("New worktree"))]))
    lines.push(new StyledText([fg(theme.dim)("creates an isolated checkout before any proposal — no commit, no pull request, no registration")]))
    lines.push(new StyledText([raw("")]))
    const field = (label: string, value: string, active: boolean, hint?: string) => {
      const shown = active ? `${value}▏` : value
      lines.push(new StyledText([fg(active ? theme.accent : theme.faint)(`${label}`), fg(theme.text)(shown), ...(hint ? [fg(theme.faint)(`  ${hint}`)] : [])]))
    }
    field("name     ", form.displayName, form.field === 0, "a short title for the work")
    field("branch   ", form.branch, form.field === 1, "editable; conventional prefix added when missing")
    field("base     ", form.base, form.field === 2, "detected default")
    lines.push(new StyledText([raw("")]))
    if (form.error) lines.push(new StyledText([fg(theme.red)(form.error)]))
    return joinLines(lines)
  }

  /**
   * Lean one-row chrome, not a dedicated footer panel: the same hints
   * machinery every destination screen uses, without a bordered box.
   */
  private hintsContent(width: number): StyledText {
    if (this.level === "form") {
      return hintsRow(
        [
          { keys: "enter", label: "confirm", priority: 1 },
          { keys: "esc", label: "cancel", priority: 0 },
        ],
        [[fg(theme.faint)("nothing is created until the destination is accepted")]],
        width,
        { style: "spaced", overflow: moreHintsMarker },
      )
    }
    if (this.level === "detail") {
      const hints: Hint[] = [
        { keys: "↑/↓", label: "select", priority: 3 },
        { keys: "enter", label: "run", priority: 1 },
        { keys: "esc", label: "back", priority: 0 },
      ]
      if (this.detailLineCount() > this.detailVisible()) hints.splice(1, 0, { keys: "pgup/pgdn", label: "page", priority: 2 })
      return hintsRow(hints, [], width, { style: "spaced", overflow: moreHintsMarker })
    }
    return hintsRow(
      [
        { keys: "↑/↓", label: "select", priority: 4 },
        { keys: "p/s/r/c", label: "go", priority: 3 },
        { keys: "n", label: "new worktree", priority: 2 },
        { keys: "enter", label: "open", priority: 1 },
        { keys: "q", label: "quit", priority: 0 },
      ],
      [],
      width,
      { style: "spaced", overflow: moreHintsMarker },
    )
  }
}

/** The visible worktree name: the checkout folder basename (design D1). */
function worktreeDisplayNameOf(worktree: BoardWorktree): string {
  const base = worktree.path.split("/").filter(Boolean).pop() ?? worktree.path
  return base
}

/** The detail pane's PR line: number/title/URL/state when known, availability otherwise. */
function prObservationText(pr: NonNullable<BoardWorktree["pr"]>): string {
  if (pr.availability === "known") {
    if (!pr.pr) return "no pull request matches this branch and base"
    return `#${pr.pr.number} ${pr.pr.state} — ${pr.pr.title} (${pr.pr.url})`
  }
  if (pr.availability === "ambiguous") {
    return `ambiguous — ${pr.matches.length} matching pull requests (${pr.matches.map((match) => `#${match.number}`).join(", ")}): ${pr.reason}`
  }
  return `unknown (${pr.reason})`
}

/** A filesystem-safe slug from the operator's work name (allocation convention only). */
function slugFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "work"
  )
}
