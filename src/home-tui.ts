import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg } from "@opentui/core"

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

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { BoardWorktree } from "./control-board"
import type { Hint, PaletteColor } from "./tui-theme"

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
 * Chrome matches the rest of Convoy: a lean identity masthead, rounded
 * panels (list + preview), and a one-row hints strip — never a dedicated
 * footer panel, never a destination poster.
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

/** Below this width the home stacks the worktree list above the preview. */
export const compactHomeMaxWidth = 72

const CHROME_PADDING_COLS = 1
export const WORDMARK_GAP = "  "
/** Rounded border + paddingX:1 on each side of a panel. */
const PANEL_GUTTER = 4

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
  | { kind: "rule" }
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

  private readonly mastheadText: TextRenderable
  private readonly mastheadBox: BoxRenderable
  private readonly noticeText: TextRenderable
  private readonly noticeBox: BoxRenderable
  private readonly bodyBox: BoxRenderable
  private readonly listText: TextRenderable
  private readonly listBox: BoxRenderable
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
    } = {},
  ) {
    this.scene = options.scene
    this.resumeNotice = options.resumeNotice
    this.proposeBranchName = options.proposeBranchName
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
      flexDirection: "row",
      gap: 1,
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
    const preview = this.panel({
      id: "convoy-home-preview",
      width: 48,
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " next ",
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
    this.previewText = preview.text
    this.previewBox = preview.box
    this.hintsText = hintsText
    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: mastheadBox, background: "bg" },
      { box: noticeBox, background: "bg" },
      { box: bodyBox, background: "bg" },
      { box: list.box, background: "bg", border: "accent" },
      { box: preview.box, background: "bg", border: "borderDim" },
      { box: hintsBox, background: "bg" },
    )

    bodyBox.add(list.box)
    bodyBox.add(preview.box)
    shell.add(mastheadBox)
    shell.add(noticeBox)
    shell.add(bodyBox)
    shell.add(hintsBox)
    mount.add(shell)

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    renderer.on("resize", this.handleResize)
    this.render()
  }

  /** The list always shows the worktree surface: checkouts, New worktree, destinations. */
  private buildRows(worktrees: BoardWorktree[]): ListRow[] {
    const rows: ListRow[] = []
    for (const worktree of worktrees) rows.push({ kind: "worktree", worktree })
    rows.push({ kind: "new" })
    rows.push({ kind: "rule" })
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

  private isSelectable(row: ListRow | undefined): boolean {
    return row !== undefined && row.kind !== "rule"
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
    this.render()
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
    return this.wideMasthead() ? 3 : 2
  }

  /** Rows under the masthead (and resume notice, when shown), above the hints strip. */
  private bodyHeight(): number {
    const notice = this.resumeNotice ? 1 : 0
    return Math.max(3, this.renderer.height - this.mastheadHeight() - notice - 1)
  }

  private compactListHeight(bodyHeight: number): number {
    return Math.max(5, Math.min(9, Math.floor(bodyHeight * 0.35)))
  }

  private previewWidth(): number {
    return Math.max(36, Math.min(56, this.renderer.width - 44))
  }

  private listInnerHeight(): number {
    if (this.level !== "list") return 1
    const body = this.bodyHeight()
    const panel = this.renderer.width <= compactHomeMaxWidth ? this.compactListHeight(body) : body
    return Math.max(1, panel - 2)
  }

  /** Rows the detail pane can hold inside its bordered panel. */
  private detailVisible(): number {
    return Math.max(3, this.bodyHeight() - 2)
  }

  private render() {
    if (this.renderer.isDestroyed || this.scene?.isClosed) return
    const width = Math.max(1, this.renderer.width)
    const compact = width <= compactHomeMaxWidth
    const immersed = this.level !== "list"
    const mastheadRows = this.mastheadHeight()
    const previewWidth = this.previewWidth()
    const listWidth = Math.max(32, width - previewWidth - 7)
    const bodyHeight = this.bodyHeight()

    this.mastheadBox.height = mastheadRows
    this.mastheadText.content = this.mastheadContent(width - CHROME_PADDING_COLS * 2)
    this.noticeBox.visible = Boolean(this.resumeNotice)
    if (this.resumeNotice) {
      this.noticeText.content = new StyledText([fg(theme.yellow)(truncate(this.resumeNotice, Math.max(1, width - CHROME_PADDING_COLS * 2)))])
    }

    this.bodyBox.flexDirection = !immersed && compact ? "column" : "row"
    this.bodyBox.gap = !immersed && compact ? 0 : 1

    if (immersed) {
      this.listBox.visible = false
      this.previewBox.visible = true
      this.previewBox.width = "100%"
      this.previewBox.height = "100%"
      this.previewBox.borderColor = theme.accent
    } else if (compact) {
      this.listBox.visible = true
      this.previewBox.visible = true
      const listHeight = this.compactListHeight(bodyHeight)
      this.listBox.width = "100%"
      this.listBox.height = listHeight
      this.previewBox.width = "100%"
      this.previewBox.height = Math.max(3, bodyHeight - listHeight)
      this.listBox.borderColor = theme.accent
      this.previewBox.borderColor = theme.borderDim
    } else {
      this.listBox.visible = true
      this.previewBox.visible = true
      this.listBox.width = "auto"
      this.listBox.height = "100%"
      this.previewBox.width = previewWidth
      this.previewBox.height = "100%"
      this.listBox.borderColor = theme.accent
      this.previewBox.borderColor = theme.borderDim
    }

    const listInnerWidth = Math.max(8, (compact || immersed ? width : listWidth) - PANEL_GUTTER)
    const previewInnerWidth = Math.max(8, (immersed || compact ? width : previewWidth) - PANEL_GUTTER)

    this.listBox.title = " worktrees "
    this.previewBox.title = this.previewTitle()
    this.listText.content = immersed ? "" : this.listContent(listInnerWidth)
    this.previewText.content = this.previewContent(previewInnerWidth)
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

  private listContent(width: number): StyledText {
    const visible = Math.max(1, this.listInnerHeight())
    if (this.selectedRow < this.scroll) this.scroll = this.selectedRow
    if (this.selectedRow >= this.scroll + visible) this.scroll = this.selectedRow - visible + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.rows.length - visible)))
    const lines = this.rows
      .map((row, index) => ({ row, index }))
      .slice(this.scroll, this.scroll + visible)
      .map(({ row, index }) => this.rowLine(row, index === this.selectedRow, width))
    return joinLines(lines)
  }

  /**
   * One list row, speaking the board's row vocabulary: an observation-colored
   * dot on worktree rows, and the selected title in bold text with the accent
   * `▸` marker carrying the selection. Destinations sit under a faint rule
   * instead of a shouted section header — the panel title already says
   * worktrees.
   */
  private rowLine(row: ListRow, selected: boolean, width: number): StyledText {
    if (row.kind === "rule") {
      return new StyledText([fg(theme.faint)("─".repeat(Math.max(1, width)))])
    }
    if (row.kind === "worktree") {
      const worktree = row.worktree
      const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), fg(worktreeDotColor(worktree))("◇"), raw(" ")]
      const title = truncate(worktreeDisplayNameOf(worktree), Math.max(12, width - 18))
      left.push(selected ? bold(fg(theme.text)(title)) : fg(theme.text)(title))
      const state: TextChunk[] = [fg(theme.dim)(worktreeSummary(worktree))]
      return padBetween(left, state, width)
    }
    if (row.kind === "new") {
      const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), fg(theme.green)("+"), raw(" ")]
      left.push(selected ? bold(fg(theme.text)("New worktree")) : fg(theme.text)("New worktree"))
      return new StyledText(left)
    }
    const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), fg(theme.teal)("◇"), raw(" ")]
    left.push(selected ? bold(fg(theme.text)(row.label)) : fg(theme.text)(row.label))
    left.push(fg(theme.faint)(`  [${row.shortcut.toUpperCase()}]`))
    return new StyledText(left)
  }

  private previewTitle(): string {
    if (this.level === "form") return " new worktree "
    if (this.level === "detail") return " actions "
    const row = this.rows[this.selectedRow]
    if (row?.kind === "new") return " new "
    if (row?.kind === "auxiliary") return ` ${row.label.toLowerCase()} `
    return " next "
  }

  private previewContent(width: number): StyledText {
    if (this.level === "detail") return this.detailContent(width)
    if (this.level === "form") return this.formContent(width)
    const row = this.rows[this.selectedRow]
    if (row?.kind === "worktree") return this.worktreePreview(row.worktree, width)
    if (row?.kind === "new") return this.newPreview(width)
    if (row?.kind === "auxiliary") return this.destinationPreview(row, width)
    return new StyledText([raw("")])
  }

  /** List-level preview: observed facts, not a lifecycle summary. Enter still opens actions. */
  private worktreePreview(worktree: BoardWorktree, width: number): StyledText {
    const lines: StyledText[] = []
    lines.push(new StyledText([bold(fg(theme.text)(truncate(worktreeDisplayNameOf(worktree), width)))]))
    lines.push(new StyledText([fg(worktreeDotColor(worktree))("◇ "), fg(theme.dim)(truncate(worktreeSummary(worktree), Math.max(8, width - 2)))]))
    lines.push(new StyledText([raw("")]))
    lines.push(new StyledText([fg(theme.dim)(truncate(worktree.detached ? "detached HEAD" : (worktree.branch ?? "(no branch)"), width))]))
    lines.push(new StyledText([fg(theme.faint)(truncate(shortPath(worktree.path, Math.max(8, width)), width))]))
    const meta: string[] = []
    if (worktree.dirt?.kind === "known") meta.push(worktree.dirt.value.dirty ? `${worktree.dirt.value.fileCount} uncommitted` : "clean")
    if (worktree.activity?.kind === "known" && worktree.activity.value.total > 0) meta.push(`${worktree.activity.value.total} live`)
    if (worktree.changes.length > 0) meta.push(`${worktree.changes.length} change${worktree.changes.length === 1 ? "" : "s"}`)
    if (worktree.archiveCount) meta.push(`${worktree.archiveCount} archived`)
    const prShort = shortPrFact(worktree.pr)
    if (prShort) meta.push(prShort)
    if (meta.length > 0) {
      lines.push(new StyledText([raw("")]))
      for (const line of wrapLines([meta.join(" · ")], width)) lines.push(new StyledText([fg(theme.dim)(line)]))
    }
    for (const local of worktree.changes.slice(0, 3)) {
      const title = local.title ? `${local.changeId} — ${local.title}` : local.changeId
      lines.push(new StyledText([fg(theme.dim)(truncate(`◆ ${title}`, Math.max(8, width))) ]))
    }
    const next = this.actionsFor(worktree).find((action) => action.enabled)
    lines.push(new StyledText([raw("")]))
    if (next) {
      lines.push(new StyledText([fg(theme.accent)("enter  "), fg(theme.text)(truncate(next.label, Math.max(8, width - 7)))]))
    } else {
      lines.push(new StyledText([fg(theme.faint)("enter  inspect")]))
    }
    return joinLines(lines)
  }

  private newPreview(width: number): StyledText {
    const lines: StyledText[] = []
    lines.push(new StyledText([bold(fg(theme.text)("New worktree"))]))
    lines.push(new StyledText([fg(theme.accent)("Start here")]))
    lines.push(new StyledText([raw("")]))
    if (this.emptyWork) {
      for (const line of wrapLines(["No checkouts in this repository yet."], width)) {
        lines.push(new StyledText([fg(theme.dim)(line)]))
      }
      lines.push(new StyledText([raw("")]))
    }
    for (const line of wrapLines(["An isolated checkout before any proposal — no commit, no pull request, no registration."], width)) {
      lines.push(new StyledText([fg(theme.dim)(line)]))
    }
    lines.push(new StyledText([raw("")]))
    lines.push(new StyledText([fg(theme.accent)("n  "), fg(theme.text)("name it")]))
    return joinLines(lines)
  }

  private destinationPreview(row: Extract<ListRow, { kind: "auxiliary" }>, width: number): StyledText {
    const lines: StyledText[] = []
    lines.push(new StyledText([bold(fg(theme.text)(truncate(row.label, width)))]))
    lines.push(new StyledText([fg(theme.accent)(truncate(row.kicker, width))]))
    lines.push(new StyledText([raw("")]))
    for (const line of wrapLines([row.description], width)) {
      lines.push(new StyledText([fg(theme.dim)(line)]))
    }
    lines.push(new StyledText([raw("")]))
    lines.push(new StyledText([fg(theme.accent)(`${row.shortcut}  `), fg(theme.text)("open")]))
    return joinLines(lines)
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
    lines.push(new StyledText([raw("")]))
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
    if (worktree.pr) {
      // PR evidence keeps its availability: unknown is never rendered as
      // "no PR" and a merged PR never reads as completed work.
      add("pr", prObservationText(worktree.pr), worktree.pr.availability === "known" ? theme.text : theme.yellow)
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

/** The row's right-column summary: independent facts, never a lifecycle stage. */
function worktreeSummary(worktree: BoardWorktree): string {
  const parts: string[] = []
  parts.push(worktree.detached ? "detached" : (worktree.branch ?? "(no branch)"))
  if (worktree.changes.length > 0) parts.push(`${worktree.changes.length} change${worktree.changes.length === 1 ? "" : "s"}`)
  if (worktree.dirt?.kind === "known" && worktree.dirt.value.dirty) parts.push(`${worktree.dirt.value.fileCount} dirty`)
  if (worktree.activity?.kind === "known" && worktree.activity.value.total > 0) parts.push(`${worktree.activity.value.total} live`)
  if (!worktree.accessible) parts.push("inaccessible")
  return parts.join(" · ")
}

/** Compact PR fact for the preview's meta line; unknown stays unknown. */
function shortPrFact(pr: BoardWorktree["pr"]): string | undefined {
  if (!pr) return undefined
  if (pr.availability === "known") return pr.pr ? `PR #${pr.pr.number} ${pr.pr.state}` : "no PR"
  if (pr.availability === "ambiguous") return `PR ambiguous (${pr.matches.length})`
  return "PR unknown"
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
