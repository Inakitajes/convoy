import { bg, BoxRenderable, decodePasteBytes, StyledText, stripAnsiSequences, TextRenderable, bold, createCliRenderer, fg } from "@opentui/core"

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
  spinnerFrame,
  terminalBackgroundHex,
  theme,
  truncate,
  wrapLines,
} from "./tui-theme"
import { versionDetails } from "./version"
import { homeRendererConfig, sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import { observeWorktreePr, type BoardWorktree } from "./control-board"
import { runStatusStyles } from "./runs-browser"
import type { LocalActiveChange } from "./checkout-openspec"
import type { RunStatusKind } from "./runs"

import type { BoxOptions, CliRenderer, KeyEvent, PasteEvent, TextChunk } from "@opentui/core"
import type { Hint, PaletteColor } from "./tui-theme"
import type { PrObservation } from "./pr-observations"

/**
 * Worktrees-first Home (capability home-launcher delta, tasks 3.1/3.4; gap
 * CC-1): the primary screen is the repository's Worktrees list — every
 * Git-registered checkout, main, external, detached, locked, missing-path,
 * and spec-less alike — led by an explicit New worktree entry (the primary
 * action, right above the base checkout) and auxiliary destinations as
 * navigation actions. A worktree is a Git checkout, not a
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
  | "fetch"
  | "sync"
  | "push"
  | "pr"
  | "squash"
  | "remove"
  | "close"

/**
 * The detail's action sections (capability home-launcher delta): work and
 * conversation actions first, then the guarded Git/publication operations,
 * then the destructive cluster — kept together so the dangerous entries are
 * never scattered between the safe ones.
 */
export type DetailSection = "work" | "git" | "destructive"

/** One recent run of this checkout, listed in the detail's observations. */
export type DetailRun = {
  runId: string
  title: string
  status: string
  /** The run-list's own status kind: the same glyphs and colors everywhere a run is listed. */
  statusKind: RunStatusKind
  live: boolean
}

/** What a closed Home asks the surrounding session to do. */
export type HomeResolution =
  | { type: "destination"; destination: HomeDestination }
  | { type: "work"; worktree: string; action: HomeWorkAction }
  | { type: "work-run"; worktree: string; runId: string }
  | { type: "work-change"; worktree: string; changeId: string }
  | { type: "new-work"; draft?: { displayName: string; branch: string; base: string; worktree: string } }
  | undefined

export type HomeSelection = HomeDestination | undefined

const CHROME_PADDING_COLS = 1
/** Blank rows between the CONVOY masthead and the first panel. */
const MASTHEAD_BREATHING_ROWS = 1
export const WORDMARK_GAP = "  "
/** Rounded border + paddingX:1 on each side of a panel. */
const PANEL_GUTTER = 4
/** Section headings: one divider line with the label, then a breathing blank. */
const HEADING_ROWS = 2
/** The destinations strip's resting height: heading + 4 rows + a trailing blank before the footer. */
const DESTINATION_PANEL_HEIGHT = HEADING_ROWS + 4 + 1
/** The inline detail block aligns with the row's name — only the dot indents. */
const INLINE_INDENT = 2

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
    description: "Compose agents into a repeatable path from intent to ship.",
  },
  {
    id: "specs",
    shortcut: "s",
    label: "Specs",
    kicker: "The living spec",
    description: "Explore, shape, and run work around the living spec.",
  },
  {
    id: "runs",
    shortcut: "r",
    label: "Runs",
    kicker: "Live and history",
    description: "Follow live runs and revisit their history and decisions.",
  },
  {
    id: "config",
    shortcut: "c",
    label: "Config",
    kicker: "Models and agents",
    description: "Tune models, agents, permissions, and project defaults.",
  },
]

type ListRow =
  | { kind: "worktree"; worktree: BoardWorktree }
  | { kind: "new" }
  | { kind: "auxiliary"; destination: HomeDestination; label: string; shortcut: string; kicker: string; description: string }

/** The worktree detail's action rows: distinct labels per action, grouped by section. */
type DetailAction = {
  id: HomeWorkAction
  section: DetailSection
  key: string
  label: string
  enabled: boolean
  blocker?: string
}

/**
 * One selectable detail row: an action, one of the checkout's recent runs,
 * or one of its linked local changes. Actions mutate; runs and changes only
 * navigate to their own focused view.
 */
type DetailEntry =
  | { kind: "action"; action: DetailAction }
  | { kind: "run"; run: DetailRun }
  | { kind: "change"; change: LocalActiveChange }

export async function launchHomeTui(
  targetDir: string,
  options: {
    route?: TuiRoute
    initialSelection?: HomeSelection
    kittyGraphics?: boolean
    /** The repository's worktree rows; loaded by the session loop and refreshed on every open. */
    worktrees?: BoardWorktree[]
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
    }).result
  }

  const renderer = await createCliRenderer(homeRendererConfig(false))
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new HomeLauncher(renderer, targetDir, { worktrees: options.worktrees }).result
}

export class HomeLauncher {
  readonly result: Promise<HomeResolution>

  private resolveResult!: (resolution: HomeResolution) => void
  private finished = false
  private readonly scene?: TuiScene
  /** "list": the worktree list; "detail": one worktree's actions; "form": new worktree. */
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
  /**
   * New-worktree form state, in one of two modes. "auto" (the default) is a
   * single description input: committing it asks the namer for a conventional
   * branch and shows the whole draft — name, branch, base, destination — as a
   * reviewed proposal. "manual" is the name → branch → base field sequence.
   */
  private form:
    | {
        mode: "auto" | "manual"
        /** Auto: the work description input. */
        description: string
        /** Auto: the naming proposal is being prepared. */
        proposing?: boolean
        /** Auto: the reviewed proposal, ready to accept. */
        proposal?: { displayName: string; branch: string; base: string; worktree: string }
        /** Manual: which field carries the caret. */
        field: 0 | 1 | 2
        displayName: string
        branch: string
        base: string
        error?: string
      }
    | undefined
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
  /**
   * On-demand recent-run evidence per checkout path (capability home-launcher
   * delta): `checking` while the listing runs, the recent runs once they
   * land, a failed read as its error. Entering a detail is what requests it —
   * the list never queries run history on the operator's behalf.
   */
  private readonly runsEvidence = new Map<string, DetailRun[] | "checking" | { error: string }>()
  private readonly runsInFlight = new Set<string>()
  private readonly listRunsForWorktree: (worktree: BoardWorktree) => Promise<DetailRun[]>

  private readonly mastheadText: TextRenderable
  private readonly mastheadBox: BoxRenderable
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
      /** Asks the naming model for a conventional branch name; injected so tests stay hermetic. */
      proposeBranchName?: (input: { prompt: string }) => Promise<{ branch: string }>
      /** The on-demand PR observation; injected so tests stay hermetic. */
      observePr?: (worktree: BoardWorktree) => Promise<PrObservation>
      /** The checkout's recent runs; injected so tests stay hermetic. */
      listRunsForWorktree?: (worktree: BoardWorktree) => Promise<DetailRun[]>
    } = {},
  ) {
    this.scene = options.scene
    this.proposeBranchName = options.proposeBranchName
    this.observePr = options.observePr ?? ((worktree) => observeWorktreePr({ targetDir: this.targetDir, worktree }))
    this.listRunsForWorktree = options.listRunsForWorktree ?? ((worktree) => this.defaultListRunsForWorktree(worktree))
    this.emptyWork = (options.worktrees ?? []).length === 0
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })
    this.rows = this.buildRows(options.worktrees ?? [])
    // The default selection is always the New worktree entry — the list's
    // first row, the primary action.

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
      backgroundColor: theme.bg,
    })
    const destinations = this.panel({
      id: "convoy-home-destinations",
      width: "100%",
      height: DESTINATION_PANEL_HEIGHT,
      flexShrink: 0,
      backgroundColor: theme.bg,
    })
    // Sections are dividers, not containers. The border must go through the
    // runtime setter: opentui's constructor path funnels `border: false`
    // through initializeBorder(), which forces it back on.
    list.box.border = false
    destinations.box.border = false
    const preview = this.panel({
      id: "convoy-home-preview",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
    })
    // The detail and the form float on the body like every section: divider
    // rules carry the chrome, no bordered panel wraps them. The border must
    // go through the runtime setter (see the list panel above).
    preview.box.border = false

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
      { box: bodyBox, background: "bg" },
      { box: list.box, background: "bg" },
      { box: destinations.box, background: "bg" },
      { box: preview.box, background: "bg" },
      { box: hintsBox, background: "bg" },
    )

    bodyBox.add(list.box)
    bodyBox.add(destinations.box)
    bodyBox.add(preview.box)
    shell.add(mastheadBox)
    shell.add(bodyBox)
    shell.add(hintsBox)
    mount.add(shell)

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.keyInput.on("paste", this.handlePaste)
    renderer.on("theme_mode", this.handleThemeMode)
    renderer.on("resize", this.handleResize)
    // The opening selection lands immediately: its PR evidence starts now,
    // the rest of the board never waits for it.
    this.landOnSelected()
    this.render()
  }

  /**
   * The list always shows the worktree surface: New worktree leads — the
   * primary action, right above the base checkout — then the checkouts; the
   * four destinations live in their own strip below, never mixed into the
   * checkout list.
   */
  private buildRows(worktrees: BoardWorktree[]): ListRow[] {
    const rows: ListRow[] = []
    rows.push({ kind: "new" })
    for (const worktree of worktrees) rows.push({ kind: "worktree", worktree })
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

  /**
   * The detail's default recent-runs source: the shared run history filtered
   * to this checkout — by the recorded execution directory when the record
   * carries one, else by its durable branch link (path absence is a fallback,
   * never a rename). Most recent first, capped to a readable handful.
   */
  private async defaultListRunsForWorktree(worktree: BoardWorktree): Promise<DetailRun[]> {
    const { listRuns } = await import("./runs")
    const all = await listRuns()
    const mine = all.filter(
      (run) =>
        run.targetDir === worktree.path ||
        (!run.targetDir && worktree.branch !== undefined && run.feature?.branch === worktree.branch),
    )
    return mine.slice(0, 5).map((run) => ({ runId: run.runID, title: run.title, status: run.status, statusKind: run.statusKind, live: run.live }))
  }

  /** Fires the recent-runs listing once per checkout: cached, deduped, hermetic. */
  private ensureRunsEvidence(worktree: BoardWorktree): void {
    const path = worktree.path
    if (this.runsInFlight.has(path) || this.runsEvidence.has(path)) return
    this.runsInFlight.add(path)
    this.runsEvidence.set(path, "checking")
    void this.listRunsForWorktree(worktree)
      .then((runs) => {
        this.runsInFlight.delete(path)
        if (this.finished || this.runsEvidence.get(path) !== "checking") return
        this.runsEvidence.set(path, runs)
        this.render()
      })
      .catch((error) => {
        this.runsInFlight.delete(path)
        if (this.finished || this.runsEvidence.get(path) !== "checking") return
        this.runsEvidence.set(path, { error: error instanceof Error ? error.message : String(error) })
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
      // Entering the detail is what requests the checkout's recent runs —
      // the same on-demand observation rhythm as the row's PR evidence.
      this.ensureRunsEvidence(row.worktree)
      return
    }
    if (row.kind === "new") {
      this.openNewWorkForm()
      return
    }
    if (row.kind !== "auxiliary") return
    this.finish({ type: "destination", destination: row.destination })
  }

  private actionsFor(worktree: BoardWorktree): DetailAction[] {
    // Shared per-action guards, projected as advisory enabled states: a
    // blocked action stays inspectable with its reason (design D4). The
    // handlers revalidate the same guards before any effect. The actions ride
    // three labeled sections — work, git, destructive — so the dangerous
    // cluster is never scattered between the safe ones.
    const verified = worktree.accessible && !worktree.bare
    const writerBusy = worktree.activity?.kind === "known" && worktree.activity.value.total > 0
    const attached = worktree.branch !== undefined
    const inaccessible = "the checkout is not accessible — repair or prune the registration first"
    const detached = "the checkout has a detached HEAD — this action needs an attached branch to name the source"
    const busy = "a managed writer is active in this checkout — inspect or stop it before mutating"
    return [
      // ── work ──────────────────────────────────────────────────────────────
      {
        id: "conversation",
        section: "work",
        key: "v",
        label: "Open conversation",
        enabled: verified,
        blocker: verified ? undefined : inaccessible,
      },
      {
        id: "conversation-external",
        section: "work",
        key: "w",
        label: "Open in window",
        enabled: verified,
        blocker: verified ? undefined : inaccessible,
      },
      {
        id: "propose",
        section: "work",
        key: "p",
        label: "Propose a change",
        enabled: verified,
        blocker: verified ? undefined : inaccessible,
      },
      {
        id: "pipeline",
        section: "work",
        key: "e",
        label: "Execute pipeline",
        enabled: verified,
        blocker: verified ? undefined : inaccessible,
      },
      // ── git ───────────────────────────────────────────────────────────────
      {
        id: "fetch",
        section: "git",
        key: "f",
        label: "Fetch remote",
        enabled: verified,
        blocker: verified ? undefined : inaccessible,
      },
      {
        id: "sync",
        section: "git",
        key: "y",
        label: "Sync with base",
        enabled: verified && attached && !writerBusy,
        blocker: !verified ? inaccessible : !attached ? detached : writerBusy ? busy : undefined,
      },
      {
        id: "push",
        section: "git",
        key: "u",
        label: "Push branch",
        enabled: verified && attached && !writerBusy,
        blocker: !verified ? inaccessible : !attached ? detached : writerBusy ? busy : undefined,
      },
      {
        id: "pr",
        section: "git",
        key: "g",
        label: "Compose pull request",
        enabled: verified && attached,
        blocker: !verified ? inaccessible : !attached ? detached : undefined,
      },
      {
        id: "squash",
        section: "git",
        key: "m",
        label: "Squash to base",
        enabled: verified && attached && !writerBusy,
        blocker: !verified ? inaccessible : !attached ? detached : writerBusy ? busy : undefined,
      },
      // ── destructive ───────────────────────────────────────────────────────
      // The deliberate composition leads the dangerous cluster; removal and
      // branch deletion follow it, in rising sharpness.
      {
        id: "close",
        section: "destructive",
        key: "x",
        label: "Close review",
        enabled: verified && attached && !writerBusy,
        blocker: !verified ? inaccessible : !attached ? detached : writerBusy ? busy : undefined,
      },
      {
        id: "remove",
        section: "destructive",
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
    ]
  }

  /**
   * The detail's selectable rows, in render order: the sectioned actions,
   * then the checkout's recent runs, then its linked local changes. Runs and
   * changes are observations, not mutations — selecting one only navigates
   * to its own focused view.
   */
  private detailEntries(): DetailEntry[] {
    const worktree = this.detailWorktree
    if (!worktree) return []
    const entries: DetailEntry[] = this.actionsFor(worktree).map((action) => ({ kind: "action", action }))
    const runs = this.runsEvidence.get(worktree.path)
    if (Array.isArray(runs)) {
      for (const run of runs) entries.push({ kind: "run", run })
    }
    if (!worktree.changesUnknown) {
      for (const change of worktree.changes) entries.push({ kind: "change", change })
    }
    return entries
  }

  /** Whether a detail entry can fire at all: only a blocked action cannot. */
  private entryEnabled(entry: DetailEntry): boolean {
    return entry.kind !== "action" || entry.action.enabled
  }

  private handleDetailKey(key: KeyEvent) {
    const entries = this.detailEntries()
    this.detailSelected = Math.max(0, Math.min(this.detailSelected, entries.length - 1))
    const selected = entries[this.detailSelected]
    // Direct keys fire actions from anywhere in the detail: the conversation
    // and Git shortcuts never depend on where the selection parks.
    const direct = entries.find((entry) => entry.kind === "action" && entry.action.key === key.name)
    if (direct?.kind === "action") {
      this.detailFollow = true
      this.resolveDetail(direct.action)
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
        this.detailSelected = Math.min(entries.length - 1, this.detailSelected + 1)
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
        if (!selected) break
        this.detailFollow = true
        if (selected.kind === "action") {
          this.resolveDetail(selected.action)
          return
        }
        this.activateDetailEntry(selected)
        return
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

  /** A run or change entry resolves to its focused view — navigation, never mutation. */
  private activateDetailEntry(entry: Exclude<DetailEntry, { kind: "action" }>) {
    const worktree = this.detailWorktree
    if (!worktree) return
    if (entry.kind === "run") {
      this.finish({ type: "work-run", worktree: worktree.path, runId: entry.run.runId })
      return
    }
    // The change's own checkout keys the focused specs view — never the
    // launch directory by fallback.
    this.finish({ type: "work-change", worktree: entry.change.checkout, changeId: entry.change.changeId })
  }

  private resolveDetail(action: DetailAction) {
    if (!this.detailWorktree) return
    if (!action.enabled) {
      // Blocked actions stay inspectable with their reason (shared guard
      // vocabulary) instead of disappearing or firing.
      this.render()
      return
    }
    this.finish({ type: "work", worktree: this.detailWorktree.path, action: action.id })
  }

  // ── new-worktree form ───────────────────────────────────────────────────

  private openNewWorkForm() {
    this.level = "form"
    // Auto mode is the default: describe the work, get a conventional
    // proposal. Tab reaches the manual name/branch/base sequence.
    this.form = { mode: "auto", description: "", field: 0, displayName: "", branch: "", base: "" }
    // The create button names the model the namer will call. Loaded once,
    // off the keypress path; the button re-renders when it lands.
    if (!this.branchModelLoaded) void this.loadBranchModel()
  }

  /** The configured branch-naming model, resolved once per session. */
  private branchModel?: string
  private branchModelLoaded = false

  private async loadBranchModel() {
    this.branchModelLoaded = true
    try {
      const { defaultBranchNameModel } = await import("./worktree")
      const { loadMergedConvoyConfig } = await import("./config")
      const config = await loadMergedConvoyConfig(this.targetDir)
      this.branchModel = config?.defaults.branchNameModel ?? defaultBranchNameModel
    } catch {
      // The note is advisory: without a resolvable model the button simply
      // doesn't name one, and the proposal path resolves its own.
      this.branchModel = undefined
    }
    if (!this.finished && this.level === "form") this.render()
  }

  private handleFormKey(key: KeyEvent) {
    const form = this.form
    if (!form) return
    if (key.name === "escape") {
      // From a shown (or in-flight) proposal, escape steps back to the
      // description input; from the inputs, cancelling makes no repository
      // effects.
      if (form.mode === "auto" && (form.proposal || form.proposing)) {
        this.proposeToken++
        form.proposing = false
        form.proposal = undefined
        this.render()
        return
      }
      this.form = undefined
      this.level = "list"
      this.render()
      return
    }
    if (key.name === "tab") {
      this.switchFormMode()
      return
    }
    if (form.mode === "auto") {
      this.handleAutoFormKey(form, key)
      return
    }
    this.handleManualFormKey(form, key)
  }

  /** Auto mode: one description input; enter proposes, enter again accepts. */
  private handleAutoFormKey(form: NonNullable<HomeLauncher["form"]>, key: KeyEvent) {
    // While the proposal is up (or being prepared) only enter/escape act.
    if (form.proposal) {
      if (key.name === "return" || key.name === "linefeed") this.acceptAutoProposal()
      return
    }
    if (form.proposing) return
    if (key.name === "backspace") {
      form.description = form.description.slice(0, -1)
      form.error = undefined
      this.render()
      return
    }
    if (key.name === "return" || key.name === "linefeed") {
      void this.proposeAutoDraft(form.description)
      return
    }
    const char = !key.ctrl && !key.meta && !key.option && key.sequence && key.sequence.length === 1 ? key.sequence : undefined
    // A description is prose: any printable character rides, not just the
    // name-safe set the manual fields accept.
    if (char && /^[\x20-\x7E\u00A0-\uFFFF]$/.test(char)) {
      form.description += char
      form.error = undefined
      this.render()
    }
  }

  /** Manual mode: the original one-field-at-a-time sequence. */
  private handleManualFormKey(form: NonNullable<HomeLauncher["form"]>, key: KeyEvent) {
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
   * Switching modes carries the work over: the auto description becomes the
   * manual name (its slug the branch prefill), the manual name becomes the
   * auto description. Every in-flight naming call is invalidated first, so a
   * late suggestion or proposal can never land in the other mode.
   */
  private switchFormMode() {
    const form = this.form
    if (!form) return
    this.proposeToken++
    this.suggestBranchNameToken++
    if (form.mode === "auto") {
      form.mode = "manual"
      form.proposing = false
      form.proposal = undefined
      if (!form.displayName) form.displayName = form.description.trim()
      if (form.displayName && !form.branch) form.branch = slugFromName(form.displayName)
      form.field = 0
    } else {
      form.mode = "auto"
      if (!form.description) form.description = form.displayName.trim()
    }
    form.error = undefined
    this.render()
  }

  /**
   * Asks the configured naming model for a conventional branch name for the
   * reviewed description (work-context delta, task 3.4). Bounded: the namer
   * has its own timeout and the deterministic prefill already on the field is
   * the editable fallback, so a slow or unavailable model never blocks the
   * form. The suggestion lands only while the operator is still in manual
   * mode on the branch field and has not typed a name of their own.
   */
  private suggestBranchNameToken = 0
  private async suggestBranchName(description: string): Promise<void> {
    const token = ++this.suggestBranchNameToken
    const form = this.form
    if (!form || form.mode !== "manual") return
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
      if (!current || current !== form || current.mode !== "manual" || current.field !== 1) return
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
      if (!target || target !== form || target.mode !== "manual" || target.field !== 1) return
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
      // Conventional prefix stays the allocation convention; a missing one is
      // prefilled rather than refused, so the review stays editable.
      form.branch = withConventionalPrefix(form.branch, slugFromName(form.displayName))
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

  // ── auto mode: describe, propose, review, accept ────────────────────────

  /** Proposal requests are token-guarded: a mode switch, a step-back, or a cancellation invalidates every in-flight call. */
  private proposeToken = 0

  /**
   * The form caret blinks so the input reads writable. One timer drives it
   * while a form is open; the guard makes the tick a no-op everywhere else,
   * and `finish` clears it. The tick must recompute the pane's content —
   * a bare requestRender() redraws the previous frame and the caret would
   * never appear to move.
   */
  private caretOn = true
  private readonly caretTimer: ReturnType<typeof setInterval> = setInterval(() => {
    if (this.finished || this.level !== "form" || !this.form) return
    this.caretOn = !this.caretOn
    this.render()
  }, 500)

  /**
   * While the namer proposes, a single spinner is repainted every 100ms
   * (the spinner's own step) so no frame of the rotation is skipped. The
   * guard makes the tick a no-op the rest of the time; `finish` clears it.
   */
  private readonly proposeTimer: ReturnType<typeof setInterval> = setInterval(() => {
    if (this.finished || this.level !== "form" || !this.form?.proposing) return
    this.render()
  }, 100)

  /**
   * Terminal paste (Ctrl+V / middle-click bracketed paste) rides opentui's
   * `paste` event — keypress never sees it. The form fields are the only
   * writable surface here: a paste lands in the description (auto) or the
   * focused field (manual), newlines flattened so the single-line fields
   * keep their cursor math.
   */
  private readonly handlePaste = (event: PasteEvent) => {
    if (this.finished || this.level !== "form" || !this.form || this.form.proposal) return
    const text = sanitizePastedText(stripAnsiSequences(decodePasteBytes(event.bytes)))
    if (!text) return
    const clean = text.replace(/\n+/g, " ").replace(/ {2,}/g, " ").trim()
    if (this.form.mode === "auto") {
      this.form.description = (this.form.description ? `${this.form.description} ` : "") + clean
    } else if (this.form.field === 0) {
      this.form.displayName = `${this.form.displayName}${clean}`
    } else if (this.form.field === 1) {
      this.form.branch = `${this.form.branch}${clean}`
    } else {
      this.form.base = `${this.form.base}${clean}`
    }
    this.form.error = undefined
    this.render()
  }

  /**
   * Auto mode's proposal: the description asks the namer for a conventional
   * branch (the same bounded namer the manual refinement uses; the
   * deterministic slug is the fallback so a slow or failed model never blocks
   * the draft), the base is the detected default, and the destination follows
   * the documented location conventions. Nothing is created here: the whole
   * draft is shown for review, and acceptance hands it to the session loop.
   */
  private async proposeAutoDraft(description: string): Promise<void> {
    const token = ++this.proposeToken
    const form = this.form
    if (!form || form.mode !== "auto" || form.proposal) return
    const trimmed = description.trim()
    if (trimmed.length < 2) {
      form.error = "describe the work in a few words (at least 2 characters)"
      this.render()
      return
    }
    form.proposing = true
    form.error = undefined
    this.render()
    try {
      const { ensureFreeBranchName, resolveWorktreeDir, defaultBranchNameModel, proposeBranchName } = await import("./worktree")
      let proposed = ""
      try {
        if (this.proposeBranchName) {
          proposed = (await this.proposeBranchName({ prompt: trimmed })).branch
        } else {
          const { loadMergedConvoyConfig } = await import("./config")
          const config = await loadMergedConvoyConfig(this.targetDir)
          proposed = (await proposeBranchName({ prompt: trimmed, targetDir: this.targetDir, model: config?.defaults.branchNameModel ?? defaultBranchNameModel })).branch
        }
      } catch {
        // The namer is advisory: its failure degrades to the deterministic
        // slug instead of blocking the proposal.
        proposed = ""
      }
      if (token !== this.proposeToken || this.form !== form || form.mode !== "auto") return
      const branch = withConventionalPrefix(proposed, slugFromName(trimmed))
      // The free-name check is advisory here, as in the manual path: the
      // reviewed creation re-checks occupancy either way.
      const free = await ensureFreeBranchName(branch, this.targetDir).catch(() => branch)
      if (token !== this.proposeToken || this.form !== form || form.mode !== "auto") return
      const base = (await detectBaseRef(this.targetDir).catch(() => undefined))?.ref ?? "main"
      const worktree = await resolveWorktreeDir(free, this.targetDir)
      if (token !== this.proposeToken || this.form !== form || form.mode !== "auto") return
      form.branch = free
      form.base = base
      form.proposing = false
      form.proposal = { displayName: trimmed, branch: free, base, worktree }
      this.render()
    } catch (error) {
      if (token !== this.proposeToken || this.form !== form || form.mode !== "auto") return
      form.proposing = false
      form.error = error instanceof Error ? error.message : String(error)
      this.render()
    }
  }

  /** Accepting the reviewed proposal is what resolves the draft — the only moment auto mode finishes. */
  private acceptAutoProposal() {
    const form = this.form
    if (!form?.proposal) return
    const draft = form.proposal
    this.form = undefined
    this.finish({ type: "new-work", draft })
  }

  // ── rendering ───────────────────────────────────────────────────────────

  private finish(resolution: HomeResolution) {
    if (this.finished) return
    this.finished = true
    clearInterval(this.caretTimer)
    clearInterval(this.proposeTimer)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.keyInput.off("paste", this.handlePaste)
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
    // The three-row wordmark (one text line when narrow) plus one blank row
    // below it: the worktrees panel never sits flush against the CONVOY
    // wordmark.
    return (this.wideMasthead() ? 3 : 1) + MASTHEAD_BREATHING_ROWS
  }

  /** Rows under the masthead, above the hints strip. */
  private bodyHeight(): number {
    return Math.max(3, this.renderer.height - this.mastheadHeight() - 1)
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
    // The selected destination's block plus its spacing line above.
    return DESTINATION_PANEL_HEIGHT + 1 + detail.length
  }

  private listPanelHeight(bodyHeight: number): number {
    return Math.max(3, bodyHeight - this.destPanelHeight())
  }

  private listInnerHeight(): number {
    if (this.level !== "list") return 1
    return Math.max(1, this.listPanelHeight(this.bodyHeight()) - HEADING_ROWS)
  }

  /** Rows the detail pane can hold: the full body — no panel border to subtract. */
  private detailVisible(): number {
    return Math.max(3, this.bodyHeight())
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
    // One vertical stack: worktrees on top (the selected row unfolding its
    // inline details beneath it), the destinations strip below.
    this.bodyBox.gap = 0

    if (immersed) {
      this.listBox.visible = false
      this.destBox.visible = false
      this.previewBox.visible = true
      this.previewBox.width = "100%"
      this.previewBox.height = "100%"
      // No bordered panel at either immersed level: the detail and the form
      // float on the body, their headings carried by divider rules.
      this.previewBox.border = false
    } else {
      this.listBox.visible = true
      this.destBox.visible = true
      this.previewBox.visible = false
      this.listBox.width = "100%"
      this.listBox.height = listHeight
      this.destBox.width = "100%"
      this.destBox.height = destHeight
      // No borderColor ever touches the section boxes: opentui's
      // initializeBorder() forces `_border` back to true the moment a color
      // is assigned, and the sections are dividers, not containers.
    }

    const innerWidth = Math.max(8, width - PANEL_GUTTER)

    this.listText.content = immersed ? "" : this.listContent(innerWidth)
    this.destText.content = immersed ? "" : this.destinationContent(innerWidth)
    this.previewText.content = this.previewContent(innerWidth)
    this.hintsText.content = this.hintsContent(width - CHROME_PADDING_COLS * 2)
    this.renderer.requestRender()
  }

  /** Masthead: identity, complete version, project path above the worktree list. */
  private mastheadContent(width: number): StyledText {
    if (this.wideMasthead()) {
      // The full three-row wordmark with the version beside it — the project
      // path is implied by the session the operator already sits in, no path
      // in the chrome.
      const lines = [0, 1, 2].map((glyphRow): StyledText => {
        const chunks: TextChunk[] = []
        CONVOY_LETTERS.forEach((letter, index) => {
          if (index > 0) chunks.push(raw(WORDMARK_GAP))
          chunks.push(bold(fg(theme.accent)(CONVOY_WORDMARK[letter]![glyphRow]!)))
        })
        if (glyphRow === 0) return padBetween(chunks, [fg(theme.faint)(versionDetails())], width)
        return new StyledText(chunks)
      })
      return joinLines(lines)
    }
    const versionLine = padBetween([bold(fg(theme.accent)("CONVOY"))], [fg(theme.faint)(versionDetails())], width)
    return joinLines([versionLine])
  }

  /**
   * The worktrees panel: checkouts and New worktree only — never the
   * destinations. The selected row unfolds its inline detail block right
   * beneath it (the pipeline-step accordion): moving the selection folds the
   * previous block and unfolds it under the new row. The window scrolls by
   * lines, sliding down until the selected row plus its block fit on screen,
   * so the fold never pushes the selection off the fold.
   */
  /**
   * The worktrees section: a heading divider (rule + label, both gray) and
   * the windowed rows. The selected row unfolds its inline block beneath it
   * — spacing above the block, the block, spacing below — so the selection
   * reads as one huge, breathing selector.
   */
  private listContent(width: number): StyledText {
    const inner = Math.max(1, this.listInnerHeight())
    const workRows = this.workRowCount()
    const selected = this.selectedRow < workRows ? this.selectedRow : -1
    const detail = selected >= 0 ? this.inlineDetailLines(this.rows[selected]!, width) : []
    const detailH = detail.length
    const rowHeight = (row: number) => (row === selected ? 2 + detailH : 1)
    let start = this.scroll
    const linesBetween = (from: number, to: number): number => {
      let count = 0
      for (let i = from; i < to; i++) count += rowHeight(i)
      return count
    }
    if (selected >= 0) {
      while (start < selected && linesBetween(start, selected) + 2 + detailH > inner) start++
    }
    start = Math.max(0, Math.min(start, Math.max(0, workRows - 1)))
    this.scroll = start
    const lines: StyledText[] = [...this.headingLines("worktrees", width)]
    let used = HEADING_ROWS
    for (let i = start; i < workRows; i++) {
      if (used >= inner) break
      if (i === selected && !(i === start && start === 0)) {
        // Spacing above the block, mirroring the blank below it — except
        // when the block opens the section: the heading already breathes
        // below the divider, and doubling it leaves a dead line.
        lines.push(new StyledText([raw("")]))
        used++
        if (used >= inner) break
      }
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

  /** A section heading: one dim divider line with the label riding inside it, then a breathing blank. */
  private headingLines(label: string, width: number): StyledText[] {
    const total = Math.max(12, width + 2)
    const prefix = `── ${label} `
    return [
      new StyledText([fg(theme.dim)(prefix + "─".repeat(Math.max(4, total - prefix.length)))]),
      new StyledText([raw("")]),
    ]
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
    const lines: StyledText[] = this.headingLines("go to", width)
    auxRows.forEach((row, index) => {
      if (index === localSelected && index !== 0) {
        // Spacing above the block, mirroring the blank below it — except
        // when the block opens the section, where the heading already
        // breathes below the divider.
        lines.push(new StyledText([raw("")]))
      }
      lines.push(this.rowLine(row, index === localSelected, width))
      if (index === localSelected) lines.push(...detail)
    })
    // One last breath between the section and the footer.
    lines.push(new StyledText([raw("")]))
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
      // Selected, the marker inverts: a dark glyph on its own state color —
      // the rail cell the block hangs from. Unselected, the plain diamond.
      const dot = selected ? bg(worktreeDotColor(worktree))(fg(theme.chipText)("◇")) : fg(worktreeDotColor(worktree))("◇")
      // The main checkout carries a `base` tag: it is the repository's own
      // checkout, not one more feature branch, and the row says so.
      const tag = worktree.main ? 7 : 0 // " · base"
      const title = truncate(worktreeDisplayNameOf(worktree), Math.max(12, width - 6 - tag))
      if (selected) {
        const left: TextChunk[] = [dot, raw(" "), bold(fg(theme.chipText)(title))]
        if (worktree.main) left.push(fg(theme.chipText)(" · base"))
        return this.highlighted(left, width)
      }
      const left: TextChunk[] = [dot, raw(" "), fg(theme.text)(title)]
      if (worktree.main) left.push(fg(theme.dim)(" · base"))
      return new StyledText(left)
    }
    if (row.kind === "new") {
      // The plus rides a true navy, not a state color: New is an action,
      // and the navy cell keeps it distinct from observations.
      const plus = selected ? bg(theme.navy)(fg(theme.chipText)("+")) : fg(theme.navy)("+")
      if (selected) return this.highlighted([plus, raw(" "), bold(fg(theme.chipText)("New worktree"))], width)
      return new StyledText([plus, raw(" "), fg(theme.text)("New worktree")])
    }
    const arrow = selected ? bg(theme.teal)(fg(theme.chipText)("»")) : fg(theme.teal)("»")
    // The shortcut rides every destination row: a bracketed key, visible but
    // quiet, saying that one press jumps straight there.
    const keyHint = fg(theme.faint)(` [${row.shortcut}]`)
    if (selected) {
      return this.highlighted([arrow, raw(" "), bold(fg(theme.chipText)(row.label)), fg(theme.chipText)(` [${row.shortcut}]`)], width)
    }
    return new StyledText([arrow, raw(" "), fg(theme.text)(row.label), keyHint])
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
    // Chunks that already carry a background keep it — the state-color rail
    // cell rides the accent fill instead of being repainted by it.
    const hasBg = (chunk: TextChunk) => typeof chunk !== "string" && (chunk as { bg?: unknown }).bg !== undefined
    return new StyledText(chunks.map((chunk) => (hasBg(chunk) ? chunk : bg(theme.accent)(chunk))).concat(filler))
  }

  private previewContent(width: number): StyledText {
    if (this.level === "detail") return this.detailContent(width)
    if (this.level === "form") return this.formContent(width)
    return new StyledText([raw("")])
  }

  /**
   * The inline detail block hanging under the selected row: observed facts
   * for checkouts, one short line for New, kicker plus one short line for
   * destinations. A blank row opens every fold — the block breathes below
   * the highlighted row instead of sitting glued to it — and no fold repeats
   * what Enter already does.
   */
  /**
   * The selected row's inline block. The accent fills every line — the row
   * above, the facts, and the padding — so the fold reads as one huge
   * selector instead of text glued beneath a bright line. Nothing sits
   * between the row and its facts; a padded blank closes the block and one
   * unpainted blank separates it from whatever follows.
   */
  private inlineDetailLines(row: ListRow, width: number): StyledText[] {
    const w = Math.max(8, width - INLINE_INDENT)
    // The block's left rail: the marker's column carries the marker's state
    // color down the whole block — the antagonist to the accent fill.
    const railColor = row.kind === "worktree" ? worktreeDotColor(row.worktree) : row.kind === "new" ? theme.navy : theme.teal
    const rail = bg(railColor)(" ")
    const indent = " ".repeat(Math.max(1, INLINE_INDENT - 1))
    const line = (chunks: TextChunk[]) => this.highlighted([rail, ...chunks], width)
    const lines: StyledText[] = []
    const fact = (label: string, value: string, warn = false) =>
      lines.push(line([raw(indent), fg(theme.chipText)(label.padEnd(9, " ")), raw(" "), fg(warn ? theme.yellow : theme.chipText)(truncate(value, Math.max(8, w - 10)))]))
    if (row.kind === "worktree") {
      const worktree = row.worktree
      fact("branch", worktree.detached ? "detached HEAD" : (worktree.branch ?? "(no branch)"))
      fact("path", shortPath(worktree.path, Math.max(8, w - 10)))
      // State speaks the commit/sync condition only: working tree, upstream,
      // base divergence. Counts live in the changes section below.
      const state: string[] = []
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
      fact("state", state.join(" · ") || (dirt?.kind === "known" ? "clean" : "unknown"), dirt?.kind !== "known")
      // Linked PR at the same level as state, on demand: "checking…" while
      // the row's own query runs, the honest fact once it lands — none is
      // honest, unknown is never "no PR", and a merged PR never reads as
      // completed work.
      const evidence = this.prEvidence.get(worktree.path)
      if (evidence && evidence !== "checking") {
        const pr = evidence
        const linked =
          pr.availability === "known" ? (pr.pr ? `#${pr.pr.number} ${pr.pr.state}` : "none") : pr.availability === "ambiguous" ? `ambiguous (${pr.matches.length})` : `unknown (${pr.reason})`
        fact("linked PR", linked, pr.availability !== "known")
      } else {
        fact("linked PR", "checking…")
      }
      // Spec changes carry their own counts (active, specs, archived, live)
      // and descend as a file-tree, one shallow indent under the title.
      if (worktree.changesUnknown) {
        fact("changes", `unknown (${worktree.changesUnknown})`, true)
      } else {
        const counts: string[] = []
        if (worktree.changes.length > 0) counts.push(`${worktree.changes.length} active`)
        if (worktree.specCount) counts.push(`${worktree.specCount} spec${worktree.specCount === 1 ? "" : "s"}`)
        if (worktree.archiveCount) counts.push(`${worktree.archiveCount} archived`)
        if (worktree.activity?.kind === "known" && worktree.activity.value.total > 0) counts.push(`${worktree.activity.value.total} live`)
        fact("changes", counts.join(" · ") || "none")
        const items = worktree.changes.slice(0, 6)
        items.forEach((local, index) => {
          const glyph = index === items.length - 1 ? "└─ " : "├─ "
          const entry = local.title ? `${local.changeId}  ${local.title}` : local.changeId
          // The tree connector rides a faded blue — present, but deliberately
          // blurred against the accent fill.
          lines.push(line([raw(indent + "  "), fg(theme.dim)(glyph), fg(theme.chipText)(truncate(entry, Math.max(8, w - 5)))]))
        })
        if (worktree.changes.length > items.length) {
          lines.push(line([raw(indent + "  "), fg(theme.dim)(`… ${worktree.changes.length - items.length} more`)]))
        }
      }
    } else if (row.kind === "new") {
      if (this.emptyWork) {
        for (const text of wrapLines(["No checkouts yet."], w)) {
          lines.push(line([raw(indent), fg(theme.chipText)(text)]))
        }
      }
      for (const text of wrapLines(["A fresh checkout to start something new."], w)) {
        lines.push(line([raw(indent), fg(theme.chipText)(text)]))
      }
    } else {
      lines.push(line([raw(indent), fg(theme.chipText)(truncate(row.kicker, w))]))
      for (const text of wrapLines([row.description], w)) {
        lines.push(line([raw(indent), fg(theme.chipText)(text)]))
      }
    }
    // The block closes unpainted: one transparent blank of breathing room —
    // spacing, not highlight.
    lines.push(new StyledText([raw("")]))
    return lines
  }

  /**
   * The detail screen, speaking the list's section language: a divider rule
   * names the worktree, the observed facts ride the fold's label rhythm, and
   * the selectable rows follow under labeled sections — the work actions,
   * the guarded Git operations, the destructive cluster, then the checkout's
   * recent runs and linked changes as focused observations. The selected row
   * is one full-width accent block hanging from an inverted navy marker.
   */
  private detailLines(width: number): { lines: StyledText[]; selectedLine: number } {
    const worktree = this.detailWorktree
    if (!worktree) return { lines: [], selectedLine: 0 }
    const entries = this.detailEntries()
    this.detailSelected = Math.max(0, Math.min(this.detailSelected, entries.length - 1))
    const lines: StyledText[] = [
      ...this.headingLines(truncate(worktreeDisplayNameOf(worktree), Math.max(8, width - 12)), width),
      new StyledText([fg(theme.dim)(truncate(shortPath(worktree.path, width), width))]),
    ]
    // The fold's fact-row rhythm: a faint nine-column label, one space, the
    // honest value.
    const fact = (label: string, value: string, color = theme.text) => {
      lines.push(new StyledText([fg(theme.faint)(label.padEnd(9, " ")), raw(" "), fg(color)(truncate(value, Math.max(8, width - 11)))]))
    }
    fact("branch", worktree.detached ? "detached HEAD" : (worktree.branch ?? "(no branch)"))
    if (worktree.dirt) {
      fact("dirt", worktree.dirt.kind === "known" ? (worktree.dirt.value.dirty ? `${worktree.dirt.value.fileCount} file(s) uncommitted` : "clean") : `unknown (${worktree.dirt.reason})`, worktree.dirt.kind === "known" && worktree.dirt.value.dirty ? theme.yellow : theme.text)
    }
    if (worktree.activity) {
      fact("activity", worktree.activity.kind === "known" ? `${worktree.activity.value.total} live run(s)` : `unknown (${worktree.activity.reason})`)
    }
    // PR evidence rides the same on-demand observation the row fired on
    // landing; the detail view never re-queries on its own. Unknown is never
    // "no PR" and a merged PR never reads as completed work.
    const prEvidence = this.prEvidence.get(worktree.path)
    if (prEvidence && prEvidence !== "checking") {
      fact("pr", prObservationText(prEvidence), prEvidence.availability === "known" ? theme.text : theme.yellow)
    } else {
      fact("pr", "checking…", theme.dim)
    }
    if (worktree.changesUnknown) fact("changes", `unknown (${worktree.changesUnknown})`, theme.yellow)
    else fact("changes", `${worktree.changes.length} active`)
    if (worktree.locked) fact("lock", worktree.locked.reason ? `locked: ${worktree.locked.reason}` : "locked", theme.yellow)
    if (worktree.prunable) fact("prunable", worktree.prunable.reason ?? "stale registration", theme.yellow)
    if (!worktree.accessible) fact("state", "inaccessible — the registered path is missing (repair or `git worktree prune`)", theme.yellow)
    lines.push(new StyledText([raw("")]))
    // Selectable rows under their labeled sections: the sectioned actions,
    // then the checkout's observations. Every section breathes — one blank
    // before each rule (the facts block already breathes before the first) —
    // and an observation section always renders its heading with an honest
    // status line: empty is a fact, never an omission.
    let selectedLine = lines.length
    let selectedIndex = 0
    const entryRows = (section: DetailSection) => entries.filter((entry) => entry.kind === "action" && entry.action.section === section)
    const pushEntry = (entry: DetailEntry) => {
      const selected = selectedIndex === this.detailSelected
      selectedIndex += 1
      if (selected) selectedLine = lines.length
      const label = selected ? bold(fg(theme.chipText)(this.entryLabel(entry, width))) : this.entryEnabled(entry) ? fg(theme.text)(this.entryLabel(entry, width)) : fg(theme.dim)(this.entryLabel(entry, width))
      const hint = this.entryHint(entry, width, selected)
      let chunks: TextChunk[]
      if (entry.kind === "run") {
        // The runs browser's own checkbox shape: the state glyph in its state
        // color, one cell either side; selected, the block inverts on the
        // state color while the rest of the row rides the accent fill — a
        // run reads the same here as it does in the runs list.
        const style = runStatusStyles[entry.run.statusKind]
        const stateColor = entry.run.live ? theme.green : theme[style.color]
        const glyph = entry.run.live ? "●" : style.icon
        const marker: TextChunk[] = selected
          ? [bg(stateColor)(" "), bg(stateColor)(fg(theme.chipText)(glyph)), bg(stateColor)(" ")]
          : [raw(" "), fg(stateColor)(glyph), raw(" ")]
        chunks = [...marker, raw(" "), label, hint]
      } else if (entry.kind === "change") {
        // The specs browser's own change-row shape: the diamond rides the
        // containing worktree's state color, one cell of the same color on
        // either side; selected, the block inverts on the marker color.
        const markerColor = worktreeDotColor(worktree)
        const marker: TextChunk[] = selected
          ? [bg(markerColor)(" "), bg(markerColor)(fg(theme.chipText)("◆")), bg(markerColor)(" ")]
          : [raw(" "), fg(markerColor)("◆"), raw(" ")]
        chunks = [...marker, raw(" "), label, hint]
      } else {
        // Actions keep the section rail: the marker inverts on selection — a
        // dark glyph in a navy cell, the block every action hangs from.
        const marker = selected ? bg(theme.navy)(fg(theme.chipText)("▸")) : this.entryEnabled(entry) ? fg(theme.faint)("▸") : fg(theme.dim)("▸")
        chunks = [marker, raw(" "), label, hint]
      }
      lines.push(selected ? this.highlighted(chunks, width) : new StyledText(chunks))
    }
    for (const section of ["work", "git", "destructive"] as const) {
      lines.push(...this.headingLines(section, width))
      for (const entry of entryRows(section)) pushEntry(entry)
      lines.push(new StyledText([raw("")]))
    }
    lines.push(...this.headingLines("recent runs", width))
    const runs = this.runsEvidence.get(worktree.path)
    if (runs === "checking") {
      lines.push(new StyledText([raw(" ".repeat(4)), fg(theme.dim)("checking…")]))
    } else if (runs && "error" in runs) {
      lines.push(new StyledText([raw(" ".repeat(4)), fg(theme.yellow)(`unknown — ${truncate(runs.error, Math.max(8, width - 8))}`)]))
    } else if (runs && runs.length > 0) {
      for (const run of runs) pushEntry({ kind: "run", run })
    } else if (runs) {
      lines.push(new StyledText([raw(" ".repeat(4)), fg(theme.dim)("no runs recorded for this checkout")]))
    }
    lines.push(new StyledText([raw("")]))
    lines.push(...this.headingLines("linked specs", width))
    if (worktree.changesUnknown) {
      lines.push(new StyledText([raw(" ".repeat(4)), fg(theme.yellow)(`unknown — ${truncate(worktree.changesUnknown, Math.max(8, width - 8))}`)]))
    } else if (worktree.changes.length > 0) {
      for (const change of worktree.changes) pushEntry({ kind: "change", change })
    } else {
      lines.push(new StyledText([raw(" ".repeat(4)), fg(theme.dim)("no active changes in this checkout")]))
    }
    return { lines, selectedLine }
  }

  /** The main text of a detail row: the action label, the run's title, or the change's id + title. */
  private entryLabel(entry: DetailEntry, width: number): string {
    if (entry.kind === "action") return entry.action.label
    if (entry.kind === "run") return entry.run.title ? `${entry.run.title} · ${entry.run.runId}` : entry.run.runId
    return entry.change.title ? `${entry.change.changeId} — ${entry.change.title}` : entry.change.changeId
  }

  /** The trailing hint of a detail row: the action's key or blocker, a run's status, a change's task count. */
  private entryHint(entry: DetailEntry, width: number, selected: boolean): TextChunk {
    if (entry.kind === "action") {
      const action = entry.action
      if (action.enabled) return fg(selected ? theme.chipText : theme.faint)(`  [${action.key}]`)
      return fg(theme.yellow)(`  blocked: ${truncate(action.blocker ?? "", Math.max(0, width - displayWidth(action.label) - 14))}`)
    }
    if (entry.kind === "run") {
      // The status word rides its state color — the same reading as the
      // runs list, where the label only repeats what the glyph already says.
      const style = runStatusStyles[entry.run.statusKind]
      const stateColor = entry.run.live ? theme.green : theme[style.color]
      const status = entry.run.live ? "running" : entry.run.status
      return fg(selected ? theme.chipText : stateColor)(`  ${truncate(status, Math.max(0, width - displayWidth(this.entryLabel(entry, width)) - 8))}`)
    }
    const tasks = entry.change.tasks
    const note = tasks === undefined ? "" : tasks === "unknown" ? "  tasks unknown" : `  tasks ${tasks.done}/${tasks.total}`
    return fg(selected ? theme.chipText : theme.dim)(truncate(note, Math.max(0, width - displayWidth(this.entryLabel(entry, width)) - 8)))
  }

  private detailLineCount(): number {
    if (!this.detailWorktree) return 0
    return this.detailLines(Math.max(1, this.renderer.width) - PANEL_GUTTER).lines.length
  }

  private detailContent(width: number): StyledText {
    const worktree = this.detailWorktree
    if (!worktree) return this.listContent(width)
    const { lines, selectedLine } = this.detailLines(width)
    const visible = this.detailVisible()
    // Selection navigation follows the selected row; explicit paging
    // (pgup/pgdn) reads the metadata above instead. Both re-clamp to bounds,
    // so a resize never strands the pane past its content.
    if (this.detailFollow) {
      if (selectedLine < this.detailScroll) this.detailScroll = selectedLine
      if (selectedLine >= this.detailScroll + visible) this.detailScroll = selectedLine - visible + 1
    }
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, lines.length - visible)))
    return joinLines(lines.slice(this.detailScroll, this.detailScroll + visible))
  }

  private formContent(width: number): StyledText {
    const form = this.form
    if (!form) return this.listContent(width)
    // The form speaks the section language: a divider rule names it and
    // carries the mode — no bold header floating over the input.
    const heading = this.headingLines(`new worktree · ${form.mode}`, width)
    const lines: StyledText[] = []
    // The action hangs from the well's left edge, flush with the section
    // rule above — no inset of its own.
    const cta = (word: string, note?: string): StyledText =>
      new StyledText([bg(theme.accent)(fg(theme.chipText)(` ↵ ${word} `)), ...(note ? [raw(" "), fg(theme.dim)(note)] : [])])
    const textW = Math.max(8, width - 4)
    const well = (rows: TextChunk[][]) => filledLines(rows, width, theme.well)
    // A blank line between the well and whatever follows: the action never
    // glues itself to the surface.
    const breathe = () => lines.push(new StyledText([raw("")]))
    if (form.mode === "auto") {
      if (form.proposal) {
        // The reviewed draft is the same well, now a labeled fact list —
        // name, branch, base, worktree — one row each. Muted labels, light
        // values on the dark gray.
        const p = form.proposal
        const valueW = Math.max(8, textW - 10)
        const fact = (label: string, value: string): TextChunk[] => [fg(theme.dim)(label.padEnd(9, " ")), raw(" "), fg(theme.text)(truncate(value, valueW))]
        lines.push(...well([[], fact("name", p.displayName), fact("branch", p.branch), fact("base", p.base), fact("worktree", shortPath(p.worktree, valueW)), []]))
        breathe()
        lines.push(cta("confirm"))
      } else {
        // A filled well, not a hollow border. A blank painted row pads the
        // placeholder above and the text below; nothing else rides along.
        const rows: TextChunk[][] = [[]]
        if (form.description) {
          const wrapped = wrapLines([form.description], textW)
          wrapped.forEach((text, index) => {
            const chunks: TextChunk[] = [fg(theme.text)(text)]
            if (index === wrapped.length - 1 && this.caretOn && !form.proposing) chunks.push(fg(theme.accent)("█"))
            rows.push(chunks)
          })
        } else {
          // The placeholder always leaves the caret's cell reserved — an
          // empty cell when the caret is off — or the text would shuffle
          // one column left on every blink.
          const placeholder = fg(theme.dim)("describe what you are about to work on…")
          const caret = this.caretOn && !form.proposing
          rows.push(caret ? [fg(theme.accent)("█"), placeholder] : [raw(" "), placeholder])
        }
        rows.push([])
        lines.push(...well(rows))
        breathe()
        // Proposing: one spinner, left-aligned with the button below it.
        if (form.proposing) {
          lines.push(new StyledText([fg(theme.accent)(spinnerFrame(Date.now())), raw(" "), fg(theme.dim)("proposing a conventional branch…")]))
        } else {
          // The button names its namer: the model about to propose the
          // conventional branch, so the call isn't a mystery.
          lines.push(cta("create", this.branchModel ? `using ${this.branchModel}` : undefined))
        }
      }
    } else {
      const fieldRow = (label: string, value: string, active: boolean): TextChunk[] => [
        fg(theme.dim)(label.padEnd(8)),
        fg(theme.text)(truncate(active ? `${value}${this.caretOn ? "█" : ""}` : value, Math.max(4, textW - 8))),
      ]
      lines.push(...well([fieldRow("name", form.displayName, form.field === 0), fieldRow("branch", form.branch, form.field === 1), fieldRow("base", form.base, form.field === 2), []]))
      breathe()
      lines.push(cta(form.field === 2 ? "create" : "next"))
      lines.push(new StyledText([fg(theme.dim)("a conventional prefix is added when missing")]))
    }
    if (form.error) lines.push(new StyledText([raw("")]), new StyledText([fg(theme.red)(form.error)]))
    // The section rule and the well stack from the top — a compose surface,
    // not a card floating in the remaining void.
    return joinLines([...heading, ...lines])
  }

  /**
   * Lean one-row chrome, not a dedicated footer panel: the same hints
   * machinery every destination screen uses, without a bordered box.
   */
  private hintsContent(width: number): StyledText {
    if (this.level === "form") {
      const form = this.form
      const proposalUp = form?.mode === "auto" && Boolean(form.proposal)
      // A long right-side note used to crowd the keys off the row, leaving
      // a bare "esc cancel · +2" that named nothing. The keys are the
      // legend; they keep the whole strip.
      if (form?.proposing) {
        return hintsRow([{ keys: "esc", label: "cancel", priority: 0 }], [], width, { style: "spaced" })
      }
      return hintsRow(
        [
          { keys: "enter", label: form?.mode === "auto" ? (proposalUp ? "confirm" : "create") : "confirm", priority: 1 },
          { keys: "tab", label: proposalUp ? "refine" : "mode", priority: 2 },
          { keys: "esc", label: proposalUp ? "back" : "cancel", priority: 0 },
        ],
        [],
        width,
        { style: "spaced", overflow: moreHintsMarker },
      )
    }
    if (this.level === "detail") {
      const hints: Hint[] = [
        { keys: "↑/↓", label: "select", priority: 3 },
        { keys: "enter", label: "open", priority: 1 },
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

/**
 * A filled well: each row is a full-width painted strip. The span runs two
 * columns past the text column — one into each padding gutter — so the fill
 * reaches the pane edges exactly like the section divider's rule. Empty rows
 * are padding; content rows get a two-space inset so the text isn't glued
 * to the edge. No border: the fill is the recuadro.
 */
function filledLines(rows: TextChunk[][], width: number, fill: string): StyledText[] {
  const span = Math.max(1, width + 2)
  const insetW = 2
  return rows.map((row) => {
    if (row.length === 0) return new StyledText([bg(fill)(fg(fill)(" ".repeat(span)))])
    const used = insetW + row.reduce((total, chunk) => total + displayWidth(typeof chunk === "string" ? chunk : (chunk as { text: string }).text), 0)
    const pad = Math.max(0, span - used)
    return new StyledText([bg(fill)(fg(fill)(" ".repeat(insetW))), ...row.map((chunk) => bg(fill)(chunk)), bg(fill)(fg(fill)(" ".repeat(pad)))])
  })
}

/**
 * The conventional-commit prefix is the allocation convention; a missing one
 * is prefilled rather than refused. Shared by the manual branch commit and
 * the auto proposal, so both modes speak the same naming rules.
 */
/**
 * Pasted text is hostile input: control bytes some terminals leak around
 * bracketed-paste frames are stripped, tabs collapse to spaces so the wrap
 * and cursor math stay true. The paste handler flattens newlines itself.
 */
function sanitizePastedText(text: string): string {
  return text.replace(/\t/g, " ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}

function withConventionalPrefix(branch: string, fallbackSlug: string): string {
  const cleaned = branch.replace(/^refs\/heads\//, "").replace(/\s+/g, "-")
  if (!cleaned || /^(feat|fix|refactor|perf|docs|test|chore|build|ci)(\/|$)/.test(cleaned) === false) {
    return `feat/${cleaned || fallbackSlug}`
  }
  return cleaned
}
