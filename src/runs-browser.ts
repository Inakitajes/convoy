import { stdout } from "node:process"

import { BoxRenderable, StyledText, TextRenderable, bg, bold, fg, t } from "@opentui/core"

import { parseMarkdown, renderMarkdownDoc, type MarkdownDoc } from "./markdown-render"
import { loadRunSummary, refreshRunWaiting, runRowTitle } from "./runs"
import {
  chunksLength,
  clipChunks,
  displayWidth,
  formatElapsed,
  formatMoney,
  hintsRow,
  joinLines,
  moreHintsMarker,
  padBetween,
  paletteForTerminal,
  plain,
  raw,
  setTheme,
  statusIcon,
  terminalBackgroundHex,
  theme,
  truncate,
} from "./tui-theme"
import type { TuiScene } from "./tui-session"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { RunEntry, RunStatusKind, RunsResolution } from "./runs"
import type { Hint, PaletteColor } from "./tui-theme"

/**
 * The compact floor: below this total width the run list and details always
 * stack vertically. On wider terminals the board still stacks whenever the run
 * list's hugging width would leave the details pane less than its minimum
 * column (see {@link RunsBrowser.isCompact}) — a narrow sidebar would draw the
 * details content wider than its flex box and spill past the terminal edge.
 */
const compactRunsMaxWidth = 84

/**
 * The run list's status vocabulary, shared with the home detail's recent-runs
 * rows: the same glyphs, in the same state colors, so a run reads the same
 * everywhere it is listed.
 */
export const runStatusStyles: Record<RunStatusKind, { icon: string; color: PaletteColor }> = {
  completed: { icon: "✓", color: "green" },
  failed: { icon: "✗", color: "red" },
  incomplete: { icon: "◐", color: "yellow" },
  empty: { icon: "○", color: "faint" },
  unknown: { icon: "·", color: "faint" },
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const dateColumnWidth = 12 // "10 Jun 12:00"

export class RunsBrowser {
  readonly result: Promise<RunsResolution>

  private resolveResult!: (resolution: RunsResolution) => void
  private finished = false
  private selected: number
  private scroll = 0
  private summary?: { runID: string; lines: string[]; scroll: number }
  private summaryLines?: { source: string[]; doc: MarkdownDoc; width: number; value: StyledText[] }
  // A pending retry confirmation: keeps the selected run's id/target until the
  // user answers y/n. Lives in the same modal as the summary (only one modal at
  // a time), so it's set/cleared together with the overlay visibility.
  private confirm?: { runID: string; targetDir?: string; title: string }
  // A subshell owns the terminal while the renderer is suspended; ignore keys.
  private inSubshell = false
  private readonly ticker: ReturnType<typeof setInterval>
  // The run list is a snapshot; the selected live run's waiting state is the
  // one part worth keeping fresh while the browser is open.
  private readonly waitingTicker: ReturnType<typeof setInterval>
  private readonly bodyBox: BoxRenderable
  private readonly listText: TextRenderable
  private readonly listBox: BoxRenderable
  private readonly detailsText: TextRenderable
  private readonly footerText: TextRenderable
  private readonly detailsBox: BoxRenderable
  private readonly overlay: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  // Panels repainted when the terminal reports a theme change mid-session.
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []

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
      this.scene?.requestInterrupt()
      this.finish({ type: "exit" })
      return
    }
    if (this.inSubshell) return
    key.preventDefault()
    key.stopPropagation()
    if (this.confirm) this.handleConfirmKey(key)
    else if (this.summary) this.handleSummaryKey(key)
    else this.handleListKey(key)
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly runs: RunEntry[],
    initialIndex: number,
    private readonly scene?: TuiScene,
  ) {
    this.selected = initialIndex
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })
    const mount = this.scene?.root ?? renderer.root

    const shell = new BoxRenderable(renderer, {
      id: "convoy-runs-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
      gap: 0,
    })

    const body = new BoxRenderable(renderer, {
      id: "convoy-runs-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
    })

    const selectFromList = (event: { y: number; preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      if (this.summary) return
      // The container's header rule rides above the rows: text line 0 is the
      // section rule, the first run row is line 1.
      const row = this.scroll + event.y - this.listText.y - 1
      if (row < 0 || row >= this.runs.length) return
      this.selected = row
      this.render()
    }

    // The wheel steps the run selection, one row per tick, list and details alike.
    const wheelFromList = (event: WheelEvent) => {
      const delta = wheelDelta(event)
      if (delta === 0 || this.summary) return
      event.preventDefault()
      event.stopPropagation()
      this.moveSelection(Math.sign(delta))
    }

    // The list's rows carry the section container, so the panel adds no
    // padding of its own — the container reaches within the shell's 1-column
    // margin on both edges.
    const list = this.panel({
      id: "convoy-runs-list",
      height: "100%",
      flexGrow: 1,
      paddingX: 0,
      backgroundColor: theme.bg,
      onMouseDown: selectFromList,
      onMouseScroll: wheelFromList,
    })
    list.text.onMouseDown = selectFromList
    list.text.onMouseScroll = wheelFromList

    const details = this.panel({
      id: "convoy-runs-details",
      width: this.detailsWidth(),
      height: "100%",
      paddingX: 0,
      backgroundColor: theme.bg,
      onMouseScroll: wheelFromList,
    })
    details.text.onMouseScroll = wheelFromList

    const footer = this.panel({
      id: "convoy-runs-footer",
      height: 1,
      paddingX: 0,
      backgroundColor: theme.bg,
    })

    this.bodyBox = body
    this.listText = list.text
    this.listBox = list.box
    this.detailsText = details.text
    this.detailsBox = details.box
    this.footerText = footer.text

    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: list.box, background: "bg" },
      { box: details.box, background: "bg" },
      { box: footer.box, background: "bg" },
    )

    body.add(list.box)
    body.add(details.box)
    shell.add(body)
    shell.add(footer.box)
    mount.add(shell)

    // Sections are containers drawn in text, not box borders — the same rule
    // the specs board lives by. The border must go through the runtime
    // setter: opentui's constructor path funnels `border: false` through
    // initializeBorder(), which forces it back on.
    list.box.border = false
    details.box.border = false
    footer.box.border = false

    this.overlay = new BoxRenderable(renderer, {
      id: "convoy-runs-summary-overlay",
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
      id: "convoy-runs-summary-modal",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.overlay,
      title: " summary ",
      titleAlignment: "left",
      paddingX: 2,
      paddingY: 1,
    })
    this.modalText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    this.modal.add(this.modalText)
    this.overlay.add(this.modal)
    mount.add(this.overlay)
    this.paletteTargets.push({ box: this.modal, background: "overlay", border: "accent" })

    // While the summary is up its full-screen overlay owns the wheel.
    const wheelFromSummary = (event: WheelEvent) => {
      const summary = this.summary
      const delta = wheelDelta(event)
      if (!summary || delta === 0) return
      event.preventDefault()
      event.stopPropagation()
      summary.scroll += delta
      this.render()
    }
    this.overlay.onMouseScroll = wheelFromSummary
    this.modal.onMouseScroll = wheelFromSummary
    this.modalText.onMouseScroll = wheelFromSummary

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)

    this.ticker = setInterval(() => this.render(), 250)
    this.waitingTicker = setInterval(() => void this.refreshWaiting(), 1000)
    this.waitingTicker.unref?.()
    this.render()
  }

  // A live run can park on a permission or review gate at any moment; the
  // details line should say so without waiting for a browser reopen.
  private refreshWaiting() {
    if (this.finished) return
    const run = this.selectedRun()
    if (!run.live || this.inSubshell) return
    void refreshRunWaiting(run)
      .then(() => this.render())
      .catch(() => {})
  }

  private handleListKey(key: KeyEvent) {
    switch (key.name) {
      case "up":
      case "k":
        this.moveSelection(-1)
        break
      case "down":
      case "j":
        this.moveSelection(1)
        break
      case "pageup":
        this.moveSelection(-this.listHeight())
        break
      case "pagedown":
        this.moveSelection(this.listHeight())
        break
      case "home":
        this.moveSelection(-this.runs.length)
        break
      case "end":
        this.moveSelection(this.runs.length)
        break
      case "g":
        this.moveSelection(key.shift ? this.runs.length : -this.runs.length)
        break
      case "return":
      case "linefeed":
      case "o": {
        // Re-enter the run's dashboard: attach if it's live, else inspect it.
        const run = this.selectedRun()
        this.finish({ type: "open", runID: run.runID, targetDir: run.targetDir })
        break
      }
      case "r": {
        // `r` retries: a brand-new run from step 0 with the original config,
        // gated by a confirmation modal. `R` (shift+r) keeps the old resume
        // behavior, which continues the run from where it stopped.
        const run = this.selectedRun()
        if (key.shift) {
          this.finish({ type: "resume", runID: run.runID, targetDir: run.targetDir })
        } else {
          this.confirm = { runID: run.runID, targetDir: run.targetDir, title: run.title }
          this.render()
        }
        break
      }
      case "s":
        this.openSummary()
        break
      case "d":
        void this.openSubshell()
        break
      case "q":
      case "escape":
        this.finish({ type: "exit" })
        break
    }
  }

  private handleSummaryKey(key: KeyEvent) {
    const summary = this.summary
    if (!summary) return
    const page = Math.max(1, this.summaryHeight())
    switch (key.name) {
      case "up":
      case "k":
        summary.scroll -= 1
        break
      case "down":
      case "j":
        summary.scroll += 1
        break
      case "pageup":
        summary.scroll -= page
        break
      case "pagedown":
      case "space":
        summary.scroll += page
        break
      case "home":
        summary.scroll = 0
        break
      case "end":
        summary.scroll = Number.MAX_SAFE_INTEGER
        break
      case "g":
        summary.scroll = key.shift ? Number.MAX_SAFE_INTEGER : 0
        break
      case "q":
      case "escape":
      case "s":
      case "b":
        this.summary = undefined
        break
    }
    this.render()
  }

  private handleConfirmKey(key: KeyEvent) {
    const confirm = this.confirm
    if (!confirm) return
    switch (key.name) {
      case "y":
      case "return":
      case "linefeed":
        this.finish({ type: "retry", runID: confirm.runID, targetDir: confirm.targetDir })
        break
      case "n":
      case "escape":
      case "q":
        this.confirm = undefined
        this.render()
        break
    }
  }

  private moveSelection(delta: number) {
    this.selected = Math.max(0, Math.min(this.runs.length - 1, this.selected + delta))
    this.render()
  }

  private selectedRun() {
    return this.runs[this.selected]!
  }

  private openSummary() {
    const run = this.selectedRun()
    this.summary = { runID: run.runID, lines: ["loading…"], scroll: 0 }
    this.render()
    loadRunSummary(run)
      .then((body) => {
        if (this.summary?.runID !== run.runID) return
        this.summary.lines = body.replace(/\r\n/g, "\n").split("\n")
        this.render()
      })
      .catch((error: unknown) => {
        if (this.summary?.runID !== run.runID) return
        this.summary.lines = [`couldn't read summary: ${error instanceof Error ? error.message : String(error)}`]
        this.render()
      })
  }

  // A child process can't change the parent shell's cwd, so "go to the run dir"
  // means dropping the user into their own shell already positioned there.
  private async openSubshell() {
    const run = this.selectedRun()
    const shell = process.env.SHELL || "/bin/sh"
    this.inSubshell = true
    this.renderer.suspend()
    stdout.write(`opening ${shell} in ${run.dir}; type "exit" to return to convoy\n`)
    try {
      const proc = Bun.spawn([shell], {
        cwd: run.dir,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      })
      await proc.exited
    } finally {
      this.inSubshell = false
      this.renderer.resume()
      this.render()
    }
  }

  private finish(resolution: RunsResolution) {
    if (this.finished) return
    this.finished = true
    clearInterval(this.ticker)
    clearInterval(this.waitingTicker)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
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

  // Squeezes on narrow terminals so the run list always keeps the wider half.
  private detailsWidth() {
    return Math.max(30, Math.min(46, this.renderer.width - 64))
  }

  // The board has no header row and no bordered footer: the history stats
  // ride the runs container's header, the hints ride a bare one-row footer.
  private bodyHeight() {
    return Math.max(8, this.renderer.height - 1)
  }

  private compactListHeight(bodyHeight: number) {
    return Math.max(5, Math.min(9, Math.floor(bodyHeight * 0.35)))
  }

  /**
   * True when the board stacks the run list above the details pane. The side-by-
   * side layout only holds while the shell chrome (2 columns), the body gap (1),
   * the list at its hugging width, and a minimum 30-column details pane all fit:
   * `width - listWidth - 3 >= 30`. Below either the compact floor or that line
   * the two-pane layout would overflow, so the board reflows to a column.
   */
  private isCompact(): boolean {
    if (this.renderer.width <= compactRunsMaxWidth) return true
    return this.renderer.width - this.runsListWidth() - 3 < 30
  }

  /** Run rows visible: the container's header and closing rule spend two. */
  private listHeight() {
    if (this.isCompact()) return Math.max(3, this.compactListHeight(this.bodyHeight()) - 2)
    return Math.max(3, this.bodyHeight() - 2)
  }

  private summaryHeight() {
    return Math.max(4, this.renderer.height - 8)
  }

  private summaryWidth() {
    return this.modalWidth() - 6
  }

  // The modal body and its scroll indicator both need the rendered summary, so
  // without a memo every frame parsed the same markdown twice. Keyed on the
  // loaded line array, and holding the parsed document so a resize re-wraps
  // without re-parsing.
  private summaryRows(lines: string[], width: number): StyledText[] {
    const memo = this.summaryLines
    if (memo?.source === lines && memo.width === width) return memo.value
    const doc = memo?.source === lines ? memo.doc : parseMarkdown(lines)
    const value = renderMarkdownDoc(doc, width)
    this.summaryLines = { source: lines, doc, width, value }
    return value
  }

  private render() {
    if (this.finished || this.renderer.isDestroyed || this.scene?.isClosed) return
    const now = Date.now()
    // The shell's 1-column padding on each edge is the board's only margin.
    const innerWidth = Math.max(40, this.renderer.width - 2)
    const compact = this.isCompact()
    const bodyHeight = this.bodyHeight()

    // Narrow terminals stack the containers: the list keeps its rows and the
    // details pane gets whatever the body has left. Panels sit flush — the
    // 1-column gap of the side-by-side layout would overflow the stacked body
    // by the separator row and push the details' bottom border under the footer.
    this.bodyBox.flexDirection = compact ? "column" : "row"
    this.bodyBox.gap = compact ? 0 : 1
    let detailsHeight: number
    let detailsPaneWidth: number
    let listPaneWidth: number
    if (compact) {
      const listHeight = this.compactListHeight(bodyHeight)
      this.listBox.width = "100%"
      this.listBox.height = listHeight
      detailsHeight = Math.max(3, bodyHeight - listHeight)
      this.detailsBox.width = "100%"
      this.detailsBox.height = detailsHeight
      this.detailsBox.flexGrow = 0
      detailsPaneWidth = innerWidth
      listPaneWidth = innerWidth
    } else {
      // The list hugs its widest row — measured over every run, so scrolling
      // never resizes the pane — capped so the details pane stays useful. A
      // wide terminal can't stretch a dead void between the rows and their
      // closing border; the details pane absorbs the slack instead, and its
      // phases ride it with their costs at the right edge.
      listPaneWidth = this.runsListWidth()
      this.listBox.width = listPaneWidth
      this.listBox.height = "100%"
      detailsPaneWidth = Math.max(30, this.renderer.width - listPaneWidth - 3)
      this.detailsBox.width = "auto"
      this.detailsBox.flexGrow = 1
      this.detailsBox.height = "100%"
      detailsHeight = bodyHeight
    }

    this.listText.content = this.listContent(listPaneWidth)
    this.detailsText.content = this.detailsContent(now, detailsPaneWidth - 4, detailsHeight)
    this.footerText.content = this.footerContent(innerWidth)
    this.renderSummaryModal()
    this.renderer.requestRender()
  }

  /** The pane width the run rows actually use — the widest row, clamped. */
  private runsListWidth(): number {
    const rowWidth = (run: RunEntry) => {
      const statusLabel = run.live ? "running" : run.statusKind === "failed" || run.statusKind === "incomplete" ? run.status : ""
      // The selected row's 3-cell checkbox is the widest marker, one blank
      // cell follows it; two cells of slack keep the hugging width honest
      // across selection changes.
      return 3 + 1 + dateColumnWidth + 2 + 7 + 2 + Math.min(displayWidth(runRowTitle(run)), 60) + (statusLabel ? 2 + displayWidth(statusLabel) : 0) + 2
    }
    const widest = this.runs.reduce((max, run) => Math.max(max, rowWidth(run)), 0)
    return Math.max(40, Math.min(90, widest + 4))
  }

  /** The list: one runs container — header with stats, the run rows, closing rule. */
  private listContent(width: number) {
    const visible = this.listHeight()
    if (this.selected < this.scroll) this.scroll = this.selected
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1

    const slice = this.runs.slice(this.scroll, this.scroll + visible)
    const lines = [
      this.runsSectionHeader(width),
      ...slice.map((run, offset) => this.containerRow(this.runRow(run, this.scroll + offset === this.selected, width - 4), width - 4)),
      this.sectionEndLine(width),
    ]
    // The container claims the pane's full height: blank rows inside it (fewer
    // runs than rows) push the closing rule down to the pane's bottom edge.
    while (lines.length < visible + 2) lines.splice(lines.length - 1, 0, this.containerRow(plain(""), width - 4))
    return joinLines(lines)
  }

  /** The runs container's header: the section name plus the colored history stats. */
  private runsSectionHeader(width: number): StyledText {
    const completed = this.runs.filter((run) => run.statusKind === "completed").length
    const failed = this.runs.filter((run) => run.statusKind === "failed").length
    const cost = this.runs.reduce((sum, run) => sum + (run.cost ?? 0), 0)
    const stats: TextChunk[] = [
      fg(theme.dim)(` · ${this.runs.length} run${this.runs.length === 1 ? "" : "s"} · `),
      fg(theme.green)(`✓ ${completed}`),
      raw("  "),
      fg(failed > 0 ? theme.red : theme.dim)(`✗ ${failed}`),
      raw("  "),
      fg(theme.dim)("· "),
      fg(theme.green)(formatMoney(cost)),
    ]
    const fill = Math.max(1, width - displayWidth("runs") - chunksLength(stats) - 5)
    return new StyledText([fg(theme.dim)("╭─ "), bold(fg(theme.accent)("runs")), ...stats, fg(theme.dim)(` ${"─".repeat(Math.max(1, fill))}╮`)])
  }

  /** A section's closing border. */
  private sectionEndLine(width: number): StyledText {
    return new StyledText([fg(theme.dim)(`╰${"─".repeat(Math.max(1, width - 2))}╯`)])
  }

  /**
   * Wraps one row inside the section container: dim side borders, the content
   * padded to the inner width so the right border stays aligned, and the
   * selection fill (applied by the row itself) stopping short of the borders.
   */
  private containerRow(line: StyledText, innerWidth: number): StyledText {
    const used = chunksLength(line.chunks)
    const filler = used < innerWidth ? [raw(" ".repeat(innerWidth - used))] : []
    return new StyledText([fg(theme.dim)("│ "), ...line.chunks, ...filler, fg(theme.dim)(" │")])
  }

  private runRow(run: RunEntry, selected: boolean, width: number) {
    const style = runStatusStyles[run.statusKind]
    const cost = run.cost !== undefined ? formatMoney(run.cost) : "—"
    // A live run reads as "running" with a green ● regardless of how many
    // phases have finished so far, so it stands out as attachable.
    const stateColor = run.live ? theme.green : theme[style.color]
    const glyph = run.live ? "●" : style.icon
    // The checkbox is the selection: the glyph's 3-cell block — one cell
    // either side — paints in the state color, flush against the container's
    // inset (no accent cell before it). Selected, the accent banner fills the
    // rest of the row and the facts ride the chip color; the block alone sits
    // in its state color, and every row shares the same columns.
    const marker: TextChunk[] = selected
      ? [bg(stateColor)(" "), bg(stateColor)(fg(theme.chipText)(glyph)), bg(stateColor)(" ")]
      : [raw(" "), fg(stateColor)(glyph), raw(" ")]
    const left: TextChunk[] = [
      ...marker,
      // One blank cell of breathing between the checkbox and the date — on
      // the selected row it rides the accent fill.
      raw(" "),
      fg(selected ? theme.chipText : theme.dim)(formatRunDate(run).padEnd(dateColumnWidth)),
      raw("  "),
      fg(selected ? theme.chipText : theme.dim)(cost.padStart(7)),
      raw("  "),
    ]
    // The headline is semantic: the pipeline that ran, joined to its
    // worktree — never the prompt's first line.
    const headline = runRowTitle(run)
    // The icon already says the state; the status word rides along only when
    // it adds information — a live run, or a failure with its quality.
    const statusLabel = run.live ? "running" : run.statusKind === "failed" || run.statusKind === "incomplete" ? run.status : ""
    const titleWidth = Math.max(12, width - 27 - (statusLabel ? 2 + statusLabel.length : 0))
    const title = truncate(headline, titleWidth)
    left.push(selected ? bold(fg(theme.chipText)(title)) : fg(theme.text)(title))
    if (statusLabel) left.push(raw("  "), selected ? fg(theme.chipText)(statusLabel) : fg(stateColor)(statusLabel))
    return selected ? this.highlighted(left, width) : new StyledText(left)
  }

  /**
   * The selected row's full-width accent block: every chunk rides the fill
   * unless it already carries its own background (the checkbox's state-color
   * cells), and the filler reaches the pane's right edge.
   */
  private highlighted(chunks: TextChunk[], width: number): StyledText {
    const used = chunks.reduce((total, chunk) => total + displayWidth(typeof chunk === "string" ? chunk : (chunk as { text: string }).text), 0)
    const filler = bg(theme.accent)(fg(theme.chipText)(" ".repeat(Math.max(0, width - used))))
    const hasBg = (chunk: TextChunk) => typeof chunk !== "string" && (chunk as { bg?: unknown }).bg !== undefined
    return new StyledText(chunks.map((chunk) => (hasBg(chunk) ? chunk : bg(theme.accent)(chunk))).concat(filler))
  }

  private detailsContent(now: number, width: number, height: number) {
    const run = this.selectedRun()
    const style = runStatusStyles[run.statusKind]
    const lines: StyledText[] = []

    // The subject: the pipeline-worktree headline over one quiet line with
    // the start date — the semantic identity, not the prompt's first line.
    const date = runDate(run)
    lines.push(t`${bold(fg(theme.text)(truncate(runRowTitle(run), width)))}`)
    lines.push(t`${fg(theme.dim)(date ? formatRunDateLong(date) : "")}`)

    // The fold's fact rhythm: a nine-column label, one space, the value —
    // every value clipped to its column, so no fact can wrap and break the
    // container's border.
    const valueW = Math.max(8, width - 10)
    const fact = (label: string, value: TextChunk[]) => lines.push(new StyledText([fg(theme.dim)(label.padEnd(9)), raw(" "), ...clipChunks(value, valueW)]))
    lines.push(plain(""))
    fact("run id", [fg(theme.text)(truncate(run.runID, valueW))])
    if (run.targetDir) fact("worktree", [fg(theme.text)(truncatePath(run.targetDir, valueW))])
    fact("directory", [fg(theme.text)(truncatePath(run.dir, valueW))])
    // The pipeline is the headline fact of this pane: what executed.
    fact("pipeline", [fg(theme.text)(truncate(run.pipeline ?? "—", valueW))])
    const statusChunks: TextChunk[] = [run.live ? fg(theme.green)("● running") : fg(theme[style.color])(`${style.icon} ${run.status}`)]
    if (run.cost !== undefined) {
      statusChunks.push(fg(theme.dim)(" · "), fg(theme.green)(formatMoney(run.cost)))
      if (run.advisorCost) statusChunks.push(fg(theme.dim)(` (${formatMoney(run.executorCost ?? 0)} + ${formatMoney(run.advisorCost)} adv)`))
    }
    fact("status", statusChunks)
    if (run.live) {
      // Notes ride under the status value, where the facts' column starts.
      const note = (chunks: TextChunk[]) => lines.push(new StyledText([fg(theme.dim)(" ".repeat(10)), ...clipChunks(chunks, valueW)]))
      note([fg(theme.dim)("enter to attach live")])
      // A coordinated run parked on an unanswered gate says so — that is the
      // case where attaching is urgent, not just interesting.
      if (run.waiting === "permission") note([fg(theme.yellow)("waiting for a permission")])
      else if (run.waiting === "review") note([fg(theme.yellow)("waiting for review")])
    }

    // Phases close the pane — one blank line, then the list. No rule of
    // their own: the container is the pane's only chrome.
    lines.push(plain(""))
    if (run.phases.length === 0) {
      lines.push(t`${fg(theme.dim)("no phase metadata for this run")}`)
    } else {
      for (const phase of run.phases) {
        const left: TextChunk[] = [statusIcon(phase.status, now), raw(" "), fg(theme.text)(truncate(phase.name, 16))]
        const right: TextChunk[] = []
        if (phase.durationMs !== undefined) right.push(fg(theme.dim)(formatElapsed(phase.durationMs)))
        if (phase.cost !== undefined) right.push(fg(theme.faint)(` ${formatMoney(phase.cost + (phase.advisorCost ?? 0))}`))
        if (phase.advisorCost) right.push(fg(theme.teal)(` (${formatMoney(phase.advisorCost)} adv)`))
        lines.push(padBetween(left, right, width))
      }
    }
    // The pane is its own rounded container, with one blank of breathing
    // above its closing rule. Every line is clipped to the inner width: the
    // closing rule is the pane's last line and the borders never break.
    const inner = lines.slice(0, Math.max(1, height - 4)).map((line) => this.containerRow(this.clipLine(line, width), width))
    while (inner.length < height - 4) inner.push(this.containerRow(plain(""), width))
    const blank = this.containerRow(plain(""), width)
    const paneWidth = width + 4
    return joinLines([this.detailsSectionHeader(paneWidth), ...inner, blank, this.sectionEndLine(paneWidth)])
  }

  /** Hard-clip a rendered line to the container's inner width. */
  private clipLine(line: StyledText, width: number): StyledText {
    return chunksLength(line.chunks) <= width ? line : new StyledText(clipChunks(line.chunks, width))
  }

  /** The details container's header: the pane's label riding its own rule. */
  private detailsSectionHeader(width: number): StyledText {
    const fill = Math.max(1, width - 12)
    return new StyledText([fg(theme.dim)("╭─ "), bold(fg(theme.accent)("details")), fg(theme.dim)(` ${"─".repeat(fill)}╮`)])
  }

  private footerContent(width: number) {
    if (this.confirm) {
      const hints: Hint[] = [
        { keys: "y", label: "retry", priority: 2 },
        { keys: "n/esc", label: "cancel", priority: 1 },
      ]
      return hintsRow(hints, [], width, { style: "spaced", overflow: moreHintsMarker })
    }
    if (this.summary) {
      const summary = this.summary
      const rendered = this.summaryRows(summary.lines, this.summaryWidth())
      const maxScroll = Math.max(0, rendered.length - this.summaryHeight())
      const position = maxScroll === 0 ? "all" : `${Math.min(100, Math.round((Math.min(summary.scroll, maxScroll) / maxScroll) * 100))}%`
      const hints: Hint[] = [
        { keys: "↑/↓", label: "scroll", priority: 2, tone: "dim" },
        { keys: "pgup/pgdn", label: "page", priority: 3 },
        { keys: "esc", label: "back", priority: 1 },
      ]
      return hintsRow(hints, [[fg(theme.faint)(position)]], width, { style: "spaced", overflow: moreHintsMarker })
    }

    const hints: Hint[] = [
      { keys: "↑/↓", label: "select", priority: 3, tone: "dim" },
      { keys: "enter", label: "open", priority: 2 },
      { keys: "r", label: "etry", priority: 4, style: "glued" },
      { keys: "R", label: "resume", priority: 5 },
      { keys: "s", label: "ummary", priority: 6, style: "glued" },
      { keys: "d", label: "ir", priority: 7, style: "glued" },
      { keys: "q", label: this.scene ? "back" : "uit", priority: 1, style: this.scene ? undefined : "glued" },
    ]
    const right: TextChunk[] = [fg(theme.faint)(`${this.selected + 1}/${this.runs.length}`)]
    return hintsRow(hints, [right], width, { style: "spaced", overflow: moreHintsMarker })
  }

  private modalWidth() {
    return Math.max(44, this.renderer.width - 10)
  }

  private renderSummaryModal() {
    const summary = this.summary
    const confirm = this.confirm
    this.overlay.visible = Boolean(summary || confirm)
    if (!summary && !confirm) return

    const boxWidth = this.modalWidth()
    if (confirm) {
      this.renderConfirmModal(boxWidth)
      return
    }

    const visible = this.summaryHeight()
    const rendered = this.summaryRows(summary!.lines, this.summaryWidth())
    summary!.scroll = Math.max(0, Math.min(summary!.scroll, rendered.length - visible))

    const lines = rendered.slice(summary!.scroll, summary!.scroll + visible)
    while (lines.length < visible) lines.push(plain(""))

    this.modal.title = ` summary · ${summary!.runID} `
    this.modal.width = boxWidth
    this.modal.height = visible + 4
    this.modalText.content = joinLines(lines)
  }

  // The retry confirmation reuses the summary modal: it's a small, focused
  // prompt that spells out what "retry" does (a fresh run from step 0) so the
  // user doesn't confuse it with resume, which continues the old run.
  private renderConfirmModal(boxWidth: number) {
    const confirm = this.confirm!
    const innerWidth = Math.max(36, boxWidth - 6)
    const lines: StyledText[] = [
      t`${bold(fg(theme.text)("Retry this run from the start?"))}`,
      plain(""),
      t`${fg(theme.faint)("A new run starts at step 0 using the original")}`,
      t`${fg(theme.faint)("prompt and pipeline config — a fresh copy, not a resume.")}`,
      plain(""),
      new StyledText([fg(theme.faint)("run     "), fg(theme.dim)(confirm.runID)]),
      new StyledText([fg(theme.faint)("prompt  "), fg(theme.text)(truncate(confirm.title, innerWidth - 9))]),
      plain(""),
      t`${fg(theme.accent)("y")} ${fg(theme.text)("retry")}   ${fg(theme.faint)("n / esc")} ${fg(theme.dim)("cancel")}`,
    ]
    this.modal.title = " retry "
    this.modal.width = boxWidth
    this.modal.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }
}

// The run ID's timestamp is authoritative; createdAt only covers runs whose
// metadata survived.
function runDate(run: RunEntry): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(run.runID)
  if (match) return new Date(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!)
  if (run.createdAt) return new Date(run.createdAt)
  return undefined
}

function formatRunDate(run: RunEntry): string {
  const date = runDate(run)
  if (!date) return "—"
  return `${date.getDate()} ${months[date.getMonth()]} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function formatRunDateLong(date: Date): string {
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function pad2(value: number) {
  return value.toString().padStart(2, "0")
}

// Paths overflow on the left so the project/run name stays readable.
function truncatePath(value: string, max: number) {
  if (value.length <= max) return value
  return `…${value.slice(-(Math.max(1, max - 1)))}`
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
