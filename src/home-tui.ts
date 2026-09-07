import { join } from "node:path"

import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg } from "@opentui/core"

import { detectBaseRef } from "./git"
import { lifecycleColor } from "./specs-browser"
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
} from "./tui-theme"
import { versionDetails } from "./version"
import { homeRendererConfig, sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { Hint } from "./tui-theme"
import type { LifecycleFeatureRow } from "./specs"

/**
 * Work-first Home (capability home-launcher / work-context, tasks 6.2–6.4):
 * the primary screen is the repository's work list — registered features and
 * an explicit New feature entry — with auxiliary destinations reachable as
 * navigation actions. Work vocabulary is the existing Feature domain; every
 * summary, blocker, and action comes from the shared lifecycle assessment
 * rows (`LifecycleFeatureRow`), never a locally inferred status.
 */

/** One of the auxiliary home destinations (pipelines, specs, runs, config). */
export type HomeDestination = "pipelines" | "specs" | "runs" | "config"

/** The action an opened work detail resolves to. */
export type HomeWorkAction = "conversation" | "conversation-external" | "propose" | "pipeline" | "specs" | "runs" | "close" | "history"

/** What a closed Home asks the surrounding session to do. */
export type HomeResolution =
  | { type: "destination"; destination: HomeDestination }
  | { type: "work"; featureId: string; action: HomeWorkAction }
  | { type: "new-work"; draft?: { displayName: string; branch: string; base: string; worktree: string } }
  | undefined

export type HomeSelection = HomeDestination | undefined

/** Below this width the home is considered compact (stacked rows). */
export const compactHomeMaxWidth = 72

const CHROME_PADDING_COLS = 1
const TOP_PAD_ROWS = 1
const WORDMARK_GAP = "  "

const CONVOY_WORDMARK: Readonly<Record<string, readonly [string, string, string]>> = {
  C: ["████", "██  ", "████"],
  O: ["████", "█  █", "████"],
  N: ["█  █", "██ █", "█ ██"],
  V: ["█  █", "█  █", " ██ "],
  Y: ["█  █", " ██ ", " ██ "],
}
const CONVOY_LETTERS = [..."CONVOY"]
const CONVOY_WORDMARK_WIDTH = CONVOY_LETTERS.reduce(
  (width, letter, index) => width + CONVOY_WORDMARK[letter]![0].length + (index > 0 ? WORDMARK_GAP.length : 0),
  0,
)

const AUXILIARY: ReadonlyArray<{ id: HomeDestination; shortcut: string; label: string }> = [
  { id: "pipelines", shortcut: "p", label: "Pipelines" },
  { id: "specs", shortcut: "s", label: "Specs" },
  { id: "runs", shortcut: "r", label: "Runs" },
  { id: "config", shortcut: "c", label: "Config" },
]

type ListRow =
  | { kind: "header"; label: string }
  | { kind: "work"; feature: LifecycleFeatureRow }
  | { kind: "new" }
  | { kind: "auxiliary"; destination: HomeDestination; label: string; shortcut: string }

/** The work detail's action rows: distinct labels per action (task 6.3). */
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
    /** The work selection to restore (task 6.4), when it still validates. */
    resumeFeature?: LifecycleFeatureRow
    kittyGraphics?: boolean
    /** The repository's feature rows; loaded by the session loop and refreshed on every open. */
    workRows?: LifecycleFeatureRow[]
    /** Why the remembered work could not be restored, shown above the list. */
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
      workRows: options.workRows,
      resumeFeature: options.resumeFeature,
      resumeNotice: options.resumeNotice,
    }).result
  }

  const renderer = await createCliRenderer(homeRendererConfig(false))
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new HomeLauncher(renderer, targetDir, { workRows: options.workRows, resumeFeature: options.resumeFeature, resumeNotice: options.resumeNotice }).result
}

export class HomeLauncher {
  readonly result: Promise<HomeResolution>

  private resolveResult!: (resolution: HomeResolution) => void
  private finished = false
  private readonly scene?: TuiScene
  /** "list": the work list; "detail": one work's actions; "form": new-work fields. */
  private level: "list" | "detail" | "form" = "list"
  private rows: ListRow[] = []
  private selectedRow = 1
  /** First visible list row; re-clamped on every render so navigation and resize both keep the selection on screen. */
  private scroll = 0
  private detailFeature?: LifecycleFeatureRow
  private detailSelected = 0
  /** First visible detail line; same re-clamping contract as `scroll`. */
  private detailScroll = 0
  /**
   * Whether the detail pane follows the selected action. Action navigation
   * sets it; explicit paging (pgup/pgdn) clears it so the metadata above the
   * actions — title, status, contracts, blockers — stays readable.
   */
  private detailFollow = true
  /** New-work form state: one input field at a time, committed in sequence. */
  private form: { field: 0 | 1 | 2; displayName: string; branch: string; base: string; error?: string } | undefined
  /** Why the remembered work could not be restored (task 6.4). */
  private readonly resumeNotice?: string

  private readonly bodyText: TextRenderable
  private readonly bodyBox: BoxRenderable
  private readonly mastheadText: TextRenderable
  private readonly mastheadBox: BoxRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: "bg" }> = []

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
      workRows?: LifecycleFeatureRow[]
      resumeFeature?: LifecycleFeatureRow
      resumeNotice?: string
    } = {},
  ) {
    this.scene = options.scene
    this.resumeNotice = options.resumeNotice
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })
    this.rows = this.buildRows(options.workRows ?? [])
    // Restored work lands on its row (task 6.4); a missing remembered work
    // falls back to the list with the explanation shown — never silently
    // selecting another execution target.
    if (options.resumeFeature) {
      const index = this.rows.findIndex((row) => row.kind === "work" && row.feature.featureId === options.resumeFeature!.featureId)
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
      height: 4,
      flexShrink: 0,
      backgroundColor: theme.bg,
      paddingX: CHROME_PADDING_COLS,
      paddingTop: TOP_PAD_ROWS,
    })
    const mastheadText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", wrapMode: "none" })
    mastheadBox.add(mastheadText)
    const bodyBox = new BoxRenderable(renderer, {
      id: "convoy-home-body",
      width: "100%",
      flexGrow: 1,
      backgroundColor: theme.bg,
      paddingX: CHROME_PADDING_COLS,
    })
    const bodyText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%", wrapMode: "none" })
    bodyBox.add(bodyText)

    this.mastheadText = mastheadText
    this.mastheadBox = mastheadBox
    this.bodyText = bodyText
    this.bodyBox = bodyBox
    this.paletteTargets.push({ box: shell, background: "bg" }, { box: mastheadBox, background: "bg" }, { box: bodyBox, background: "bg" })

    shell.add(mastheadBox)
    shell.add(bodyBox)
    mount.add(shell)

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    renderer.on("resize", this.handleResize)
    this.render()
  }

  /** The list always shows the work surface: features, New feature, auxiliary. */
  private buildRows(workRows: LifecycleFeatureRow[]): ListRow[] {
    const rows: ListRow[] = []
    rows.push({ kind: "header", label: "Work" })
    for (const feature of workRows) rows.push({ kind: "work", feature })
    rows.push({ kind: "new" })
    rows.push({ kind: "header", label: "Auxiliary" })
    for (const entry of AUXILIARY) rows.push({ kind: "auxiliary", destination: entry.id, label: entry.label, shortcut: entry.shortcut })
    return rows
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
    const selectable = this.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.kind !== "header")
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
    if (!row || row.kind === "header") return
    if (row.kind === "work") {
      this.detailFeature = row.feature
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
    this.finish({ type: "destination", destination: row.destination })
  }

  private detailActions(): DetailAction[] {
    const feature = this.detailFeature
    if (!feature) return []
    const actions = feature.actions ?? []
    const find = (id: string) => actions.find((action) => action.id === id)
    const close = find("close")
    const verified = feature.branch !== undefined && feature.checkoutPath !== undefined
    return [
      {
        id: "conversation",
        key: "v",
        label: feature.lastSelectedConversationId ? "Resume conversation" : "Open conversation",
        enabled: verified,
        blocker: verified ? undefined : "the work's checkout is not verified — rebind before authoring",
      },
      {
        id: "conversation-external",
        key: "w",
        label: "Open in window",
        enabled: verified,
        blocker: verified ? undefined : "the work's checkout is not verified — rebind before authoring",
      },
      {
        id: "propose",
        key: "p",
        label: feature.contracts.length === 0 ? "Propose a change" : "Propose next change",
        enabled: verified,
        blocker: verified ? undefined : "the work's checkout is not verified — rebind before authoring",
      },
      {
        id: "pipeline",
        key: "e",
        label: "Execute pipeline",
        enabled: verified,
        blocker: verified ? undefined : "the work's checkout is not verified",
      },
      { id: "specs", key: "s", label: "Open specs", enabled: true },
      { id: "runs", key: "r", label: "Open runs", enabled: true },
      {
        id: "close",
        key: "x",
        label: "Close review",
        enabled: close?.enabled === true,
        blocker: close?.enabled === true ? undefined : (close?.blockers ?? ["close prerequisites not met"])[0],
      },
      { id: "history", key: "h", label: "Open history", enabled: true },
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
    if (!this.detailFeature) return
    if (!action.enabled) {
      // Blocked actions stay inspectable with their reason (shared
      // assessment vocabulary) instead of disappearing or firing.
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
    this.finish({ type: "work", featureId: this.detailFeature.featureId, action: action.id })
  }

  // ── new-work form (task 5.1) ────────────────────────────────────────────

  private openNewWorkForm() {
    this.level = "form"
    this.form = { field: 0, displayName: "", branch: "", base: "" }
  }

  private handleFormKey(key: KeyEvent) {
    const form = this.form
    if (!form) return
    if (key.name === "escape") {
      // Cancelling before acceptance makes no repository effects (task 5.1).
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
      // A validated branch is prefilled from the name — editable, no naming
      // model call, no mutation (task 5.1).
      if (!form.branch) form.branch = slugFromName(name)
      form.field = 1
      this.render()
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
    // creation — nothing has been mutated yet (task 5.1).
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
    }
  }

  private render() {
    if (this.renderer.isDestroyed || this.scene?.isClosed) return
    const width = Math.max(1, this.renderer.width)
    this.mastheadText.content = this.mastheadContent(width - CHROME_PADDING_COLS * 2)
    this.bodyText.content = this.level === "list" ? this.listContent(width - CHROME_PADDING_COLS * 2) : this.level === "detail" ? this.detailContent(width - CHROME_PADDING_COLS * 2) : this.formContent(width - CHROME_PADDING_COLS * 2)
    this.renderer.requestRender()
  }

  /** Rows the body can hold: everything under the fixed 4-row masthead. */
  private bodyHeight(): number {
    return Math.max(1, this.renderer.height - 4)
  }

  /** Masthead: identity, complete version, project path above the work list. */
  private mastheadContent(width: number): StyledText {
    const project = shortPath(this.targetDir, Math.max(1, width - 9))
    if (width >= CONVOY_WORDMARK_WIDTH + Math.max(displayWidth(versionDetails()), 16) + 1) {
      const lines = [0, 1, 2].map((glyphRow): StyledText => {
        const chunks: TextChunk[] = []
        CONVOY_LETTERS.forEach((letter, index) => {
          if (index > 0) chunks.push(raw(WORDMARK_GAP))
          chunks.push(bold(fg(theme.text)(CONVOY_WORDMARK[letter]![glyphRow]!)))
        })
        if (glyphRow === 0) return padBetween(chunks, [fg(theme.faint)(versionDetails())], width)
        if (glyphRow === 1) return padBetween(chunks, [fg(theme.text)(shortPath(this.targetDir, Math.max(1, width - CONVOY_WORDMARK_WIDTH)))], width)
        return new StyledText(chunks)
      })
      return joinLines([...lines, new StyledText([raw("")])])
    }
    const versionLine = padBetween([bold(fg(theme.text)("CONVOY"))], [fg(theme.faint)(versionDetails())], width)
    return joinLines([versionLine, new StyledText([fg(theme.faint)("project  "), fg(theme.text)(project)]), new StyledText([raw("")])])
  }

  private listContent(width: number): StyledText {
    const lines: StyledText[] = []
    if (this.resumeNotice) lines.push(new StyledText([fg(theme.yellow)(truncate(this.resumeNotice, Math.max(1, width)))]))
    // One blank separator and one hints row are always reserved, so the work
    // list itself windows into what remains — the same scroll contract as the
    // specs board, keeping the selected row visible while navigating.
    const visible = Math.max(1, this.bodyHeight() - lines.length - 2)
    if (this.selectedRow < this.scroll) this.scroll = this.selectedRow
    if (this.selectedRow >= this.scroll + visible) this.scroll = this.selectedRow - visible + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.rows.length - visible)))
    for (const { row, index } of this.rows.map((row, index) => ({ row, index })).slice(this.scroll, this.scroll + visible)) {
      lines.push(this.rowLine(row, index === this.selectedRow, width))
    }
    lines.push(new StyledText([raw("")]))
    // The same footer machinery every destination screen uses: hints degrade
    // by priority instead of being chopped at the border.
    lines.push(
      hintsRow(
        [
          { keys: "↑/↓", label: "select", priority: 4 },
          { keys: "p/s/r/c", label: "auxiliary", priority: 3 },
          { keys: "n", label: "new work", priority: 2 },
          { keys: "enter", label: "open", priority: 1 },
          { keys: "q", label: "quit", priority: 0 },
        ],
        [],
        width,
        { style: "spaced", overflow: moreHintsMarker },
      ),
    )
    return joinLines(lines)
  }

  /**
   * One list row, speaking the board's row vocabulary: accent-bold uppercase
   * section headers, a lifecycle-colored dot on work rows, and the selected
   * title in bold text with the accent `▸` marker carrying the selection —
   * the anatomy of the specs board's feature rows for the very same rows.
   */
  private rowLine(row: ListRow, selected: boolean, width: number): StyledText {
    if (row.kind === "header") {
      return new StyledText([bold(fg(theme.accent)(` ${truncate(row.label.toUpperCase(), width)}`))])
    }
    if (row.kind === "work") {
      const feature = row.feature
      const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), fg(lifecycleColor(feature))("●"), raw(" ")]
      const title = truncate(feature.displayName, Math.max(12, width - 18))
      left.push(selected ? bold(fg(theme.text)(title)) : fg(theme.text)(title))
      const state: TextChunk[] = [fg(lifecycleColor(feature))(feature.summary)]
      const rest: string[] = []
      if (feature.branch) rest.push(feature.branch)
      if (feature.tasks && feature.tasks !== "unknown" && feature.tasks.total > 0) rest.push(`${feature.tasks.done}/${feature.tasks.total}`)
      if (feature.liveRuns > 0) rest.push(`${feature.liveRuns} live`)
      if (rest.length > 0) state.push(fg(theme.dim)(` · ${rest.join(" · ")}`))
      return padBetween(left, state, width)
    }
    if (row.kind === "new") {
      const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), fg(theme.green)("+"), raw(" ")]
      left.push(selected ? bold(fg(theme.text)("New feature")) : fg(theme.text)("New feature"))
      return new StyledText(left)
    }
    const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), fg(theme.teal)("◇"), raw(" ")]
    left.push(selected ? bold(fg(theme.text)(row.label)) : fg(theme.text)(row.label))
    left.push(fg(theme.faint)(`  [${row.shortcut.toUpperCase()}]`))
    return new StyledText(left)
  }

  /** Rows the detail pane can hold below its blank separator and hints row. */
  private detailVisible(): number {
    return Math.max(3, this.bodyHeight() - 2)
  }

  /** The detail pane's full line list plus the index of its first action row. */
  private detailLines(width: number): { lines: StyledText[]; actionStart: number } {
    const feature = this.detailFeature
    if (!feature) return { lines: [], actionStart: 0 }
    const lines: StyledText[] = []
    // The board's detail anatomy: bold title, dim identity line, then faint
    // `label: ` rows with the status speaking the lifecycle color.
    lines.push(new StyledText([bold(fg(theme.text)(truncate(feature.displayName, width)))]))
    lines.push(new StyledText([fg(theme.dim)(`feature ${feature.featureId}`)]))
    lines.push(new StyledText([raw("")]))
    const add = (label: string, value: string, color = theme.text) => {
      lines.push(new StyledText([fg(theme.faint)(`${label}: `), fg(color)(truncate(value, Math.max(8, width - label.length - 2)))]))
    }
    add("status", feature.summary, lifecycleColor(feature))
    if (feature.branch) add("branch", feature.branch)
    if (feature.checkoutPath) add("worktree", shortPath(feature.checkoutPath, Math.max(12, width - 10)))
    for (const contract of feature.contracts) add("contract", `${contract.changeId} (${contract.state})`)
    if (feature.contracts.length === 0) add("contracts", "none yet — awaiting proposal", theme.dim)
    if (feature.conversations && feature.conversations.length > 0) add("conversations", `${feature.conversations.length}`)
    for (const blocker of feature.blockers.slice(0, 4)) lines.push(new StyledText([fg(theme.yellow)(`! ${truncate(blocker, Math.max(8, width - 2))}`)]))
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
    if (!this.detailFeature) return 0
    return this.detailLines(Math.max(1, this.renderer.width) - CHROME_PADDING_COLS * 2).lines.length
  }

  private detailContent(width: number): StyledText {
    const feature = this.detailFeature
    if (!feature) return this.listContent(width)
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
    const slice = lines.slice(this.detailScroll, this.detailScroll + visible)
    slice.push(new StyledText([raw("")]))
    const hints: Hint[] = [
      { keys: "↑/↓", label: "select", priority: 3 },
      { keys: "enter", label: "run", priority: 1 },
      { keys: "esc", label: "back", priority: 0 },
    ]
    // The paging hint is only advertised when there is something to page.
    if (lines.length > visible) hints.splice(1, 0, { keys: "pgup/pgdn", label: "page", priority: 2 })
    slice.push(hintsRow(hints, [], width, { style: "spaced", overflow: moreHintsMarker }))
    return joinLines(slice)
  }

  private formContent(width: number): StyledText {
    const form = this.form
    if (!form) return this.listContent(width)
    const lines: StyledText[] = []
    lines.push(new StyledText([bold(fg(theme.text)("New feature"))]))
    lines.push(new StyledText([fg(theme.dim)("creates an isolated checkout before any proposal — no commit, no pull request")]))
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
    lines.push(
      hintsRow(
        [
          { keys: "enter", label: "confirm", priority: 1 },
          { keys: "esc", label: "cancel", priority: 0 },
        ],
        [[fg(theme.faint)("nothing is created until the destination is accepted")]],
        width,
        { style: "spaced", overflow: moreHintsMarker },
      ),
    )
    return joinLines(lines)
  }
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
