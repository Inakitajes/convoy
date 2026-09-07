import { BoxRenderable, StyledText, TextRenderable, TextareaRenderable, bold, createCliRenderer, fg, t } from "@opentui/core"

import {
  applyCloseEvent,
  initialCloseChecklistState,
  type CloseChecklistState,
  type CloseChecklistRowStatus,
} from "./close-presentation"
import type { CloseEvent, CloseMessageProposal } from "./feature-close"
import { stripControlBytes } from "./commit-text"
import {
  hintsRow,
  indentStyled,
  joinLines,
  moreHintsMarker,
  paletteForTerminal,
  plain,
  raw,
  setTheme,
  shortPath,
  statusIcon,
  terminalBackgroundHex,
  theme,
  truncate,
  wrapStyled,
  type PaletteColor,
} from "./tui-theme"
import { shortVersion } from "./version"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { Hint } from "./tui-theme"

export type CloseFollowUpId = "push" | "worktree" | "branch"
/**
 * The presentation states a cleanup action can carry (design D5): `blocked`
 * marks a same-session dependency (branch deletion waiting on worktree
 * removal) — it can become runnable in this session. Work that requires
 * leaving the worktree is not an action at all; it is `CloseDeferredCleanup`.
 */
export type CloseFollowUpStatus = "available" | "running" | "completed" | "failed" | "blocked"

export type CloseFollowUpItem = {
  id: CloseFollowUpId
  label: string
  detail: string
  command?: string
  status: CloseFollowUpStatus
  error?: string
}

/** One ordered, copyable cleanup command that must run after leaving the worktree. */
export type CloseDeferredStep = {
  label: string
  command: string
}

/** Cleanup guidance for work the current process cannot run (design D5): informational, never selectable. */
export type CloseDeferredCleanup = {
  /** Why the current session cannot run these — the shell location, named. */
  reason: string
  steps: readonly CloseDeferredStep[]
}

/** What the follow-up screen presents: selectable actions plus informational guidance. */
export type CloseFollowUpsView = {
  actions: readonly CloseFollowUpItem[]
  /** A concrete remediation line, e.g. push without a configured upstream. */
  notice?: string
  deferred?: CloseDeferredCleanup
}

export type CloseFollowUpResolution = { type: "run"; id: CloseFollowUpId } | { type: "done" }

type CloseTuiMode = "progress" | "message" | "edit" | "followups" | "failure"

/** Injectable timing seams, so tests can fake the clock and speed the cadence. */
export type CloseTuiOptions = {
  /** The time source behind the spinner frames. Defaults to Date.now. */
  clock?: () => number
  /** The render-tick cadence in milliseconds. Defaults to 100. */
  tickMs?: number
}

type CloseTuiInput = {
  on(event: "end" | "close", listener: () => void): unknown
  off(event: "end" | "close", listener: () => void): unknown
}

/**
 * The real interactive close surface. Unlike the former cursor-up writer this
 * owns an OpenTUI alternate screen and keeps progress, the commit gate,
 * optional cleanup, and failures inside one coherent interface.
 */
export class CloseTui {
  private destroyed = false
  private state: CloseChecklistState
  private mode: CloseTuiMode = "progress"
  private message?: CloseMessageProposal
  private messageNotice?: string
  private messageChoice = 0
  // The reviewed message (design D4): shown on the review screen and returned
  // only by Accept. The edit overlay keeps its draft inside the textarea.
  private reviewedMessage?: string
  private editNotice?: string
  private followUps: readonly CloseFollowUpItem[] = []
  private followUpsNotice?: string
  private followUpsDeferred?: CloseDeferredCleanup
  private selectedFollowUp = 0
  private failure?: string
  private inputClosed = false
  private resolveMessage?: (message: string | undefined) => void
  private resolveFollowUp?: (resolution: CloseFollowUpResolution) => void
  private resolveDismiss?: () => void

  // The independent animation cadence (design D2): a running checklist row's
  // spinner frame is recomputed on ticks, not sampled only when an operation
  // event happens to trigger a render. The ticker lives only while a row is
  // actually running, the renderer is live, and the progress view is showing.
  private ticker?: ReturnType<typeof setInterval>
  private suspended = false
  private readonly clock: () => number
  private readonly tickMs: number

  private readonly headerText: TextRenderable
  private readonly headerBox: BoxRenderable
  private readonly contentText: TextRenderable
  private readonly contentBox: BoxRenderable
  private readonly footerText: TextRenderable
  private readonly footerBox: BoxRenderable
  private readonly editOverlay: BoxRenderable
  private readonly editHintText: TextRenderable
  private readonly editArea: TextareaRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; border?: "border" | "borderDim" | "accent"; background?: PaletteColor }> = []

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.render()
  }

  private readonly handleInputEnd = () => {
    if (this.inputClosed) return
    this.inputClosed = true
    if (this.mode === "message" || this.mode === "edit") this.finishMessage("cancel")
    else if (this.mode === "followups") this.finishFollowUp({ type: "done" })
    else if (this.mode === "failure") {
      const resolve = this.resolveDismiss
      this.resolveDismiss = undefined
      resolve?.()
    }
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    // Edit mode routes only its own overlay commands before the normal
    // prevent-default path (design D4): ordinary editing keys are left
    // untouched so the focused textarea processes them.
    if (this.mode === "edit") {
      const interrupted = (key.ctrl && key.name === "c") || key.raw === "\u0003"
      if (interrupted) {
        key.preventDefault()
        key.stopPropagation()
        this.scene?.requestInterrupt()
        this.finishMessage("cancel")
        return
      }
      if (key.ctrl && key.name === "s") {
        key.preventDefault()
        key.stopPropagation()
        this.saveEditDraft()
        return
      }
      if (key.name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        this.discardEditDraft()
        return
      }
      return
    }
    key.preventDefault()
    key.stopPropagation()
    const interrupted = (key.ctrl && key.name === "c") || key.raw === "\u0003"
    if (this.mode === "message") {
      if (interrupted || key.name === "escape" || key.name === "q" || key.name === "n") {
        if (interrupted) this.scene?.requestInterrupt()
        this.finishMessage("cancel")
        return
      }
      if (key.name === "y") {
        this.finishMessage("accept")
        return
      }
      if (key.name === "e") {
        this.openEditOverlay()
        return
      }
      // The choices render as a vertical list (design D3), so vertical keys
      // lead; the horizontal keys and Tab remain as compatibility aliases.
      if (key.name === "up" || key.name === "k") this.moveMessageChoice(-1)
      else if (key.name === "down" || key.name === "j") this.moveMessageChoice(1)
      else if (key.name === "left" || key.name === "h" || (key.name === "tab" && key.shift)) this.moveMessageChoice(-1)
      else if (key.name === "right" || key.name === "l" || key.name === "tab") this.moveMessageChoice(1)
      else if (key.name === "return" || key.name === "linefeed") this.activateMessageChoice()
      return
    }
    if (this.mode === "followups") {
      if (interrupted || key.name === "escape" || key.name === "q") {
        if (interrupted) this.scene?.requestInterrupt()
        this.finishFollowUp({ type: "done" })
        return
      }
      if (key.name === "up" || key.name === "k") this.moveFollowUp(-1)
      else if (key.name === "down" || key.name === "j") this.moveFollowUp(1)
      else if (key.name === "return" || key.name === "linefeed") this.runSelectedFollowUp()
      else if (key.name === "p") this.runFollowUpShortcut("push")
      else if (key.name === "w") this.runFollowUpShortcut("worktree")
      else if (key.name === "b") this.runFollowUpShortcut("branch")
      return
    }
    if (this.mode === "failure" && (interrupted || key.name === "escape" || key.name === "q" || key.name === "return" || key.name === "linefeed")) {
      if (interrupted) this.scene?.requestInterrupt()
      const resolve = this.resolveDismiss
      this.resolveDismiss = undefined
      resolve?.()
    }
    // Progress intentionally ignores cancellation: git mutations cannot be
    // safely interrupted halfway through without a resumable engine signal.
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly targetDir: string,
    initialState: CloseChecklistState = initialCloseChecklistState(),
    private readonly input: CloseTuiInput = process.stdin,
    private readonly scene?: TuiScene,
    options: CloseTuiOptions = {},
  ) {
    this.state = initialState
    this.clock = options.clock ?? Date.now
    this.tickMs = options.tickMs ?? 100
    const mount = this.scene?.root ?? renderer.root

    const shell = new BoxRenderable(renderer, {
      id: "convoy-close-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
      gap: 0,
    })
    const header = this.panel({
      id: "convoy-close-header",
      height: 3,
      borderColor: theme.border,
      title: ` convoy close ${shortVersion()} `,
      titleAlignment: "left",
    })
    const content = this.panel({
      id: "convoy-close-content",
      flexGrow: 1,
      width: "100%",
      borderColor: theme.borderDim,
      title: " closing ",
      titleAlignment: "left",
    })
    const footer = this.panel({
      id: "convoy-close-footer",
      height: 3,
      borderColor: theme.borderDim,
    })

    this.headerText = header.text
    this.headerBox = header.box
    this.contentText = content.text
    this.contentBox = content.box
    this.footerText = footer.text
    this.footerBox = footer.box
    this.paletteTargets.push(
      { box: shell },
      { box: header.box, border: "border" },
      { box: content.box, border: "borderDim" },
      { box: footer.box, border: "borderDim" },
    )

    // The inline commit-message editor (design D4): OpenTUI's native textarea
    // in the same floating-modal language as launch/config/runs — accent
    // border, overlay paint — sized large enough for a commit message.
    this.editOverlay = new BoxRenderable(renderer, {
      id: "convoy-close-edit-overlay",
      position: "absolute",
      top: "16%",
      bottom: "10%",
      left: "8%",
      right: "8%",
      zIndex: 100,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.overlay,
      shouldFill: true,
      title: " edit commit message ",
      titleAlignment: "left",
      paddingX: 2,
      paddingY: 1,
      flexDirection: "column",
      visible: false,
    })
    this.editHintText = new TextRenderable(renderer, { content: "", fg: theme.yellow, height: 1, visible: false })
    this.editArea = new TextareaRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexGrow: 1,
      backgroundColor: theme.overlay,
      textColor: theme.text,
      focusedBackgroundColor: theme.overlay,
      focusedTextColor: theme.text,
      wrapMode: "word",
    })
    this.editOverlay.add(this.editHintText)
    this.editOverlay.add(this.editArea)
    this.paletteTargets.push({ box: this.editOverlay, border: "accent", background: "overlay" })

    shell.add(header.box)
    shell.add(content.box)
    shell.add(footer.box)
    shell.add(this.editOverlay)
    mount.add(shell)
    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    input.on("end", this.handleInputEnd)
    input.on("close", this.handleInputEnd)
    this.render()
  }

  onEvent(event: CloseEvent): void {
    this.state = applyCloseEvent(this.state, event)
    this.mode = "progress"
    this.syncTicker()
    this.render()
  }

  snapshot(): CloseChecklistState {
    return this.state
  }

  confirmMessage(proposal: CloseMessageProposal, notice?: string): Promise<string | undefined> {
    this.mode = "message"
    this.syncTicker()
    this.message = proposal
    this.reviewedMessage = proposal.message
    this.messageNotice = notice
    this.messageChoice = 0
    this.render()
    if (this.inputClosed) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      this.resolveMessage = resolve
    })
  }

  selectFollowUp(view: CloseFollowUpsView): Promise<CloseFollowUpResolution> {
    this.mode = "followups"
    this.syncTicker()
    this.setFollowUps(view)
    if (this.inputClosed) return Promise.resolve({ type: "done" })
    return new Promise((resolve) => {
      this.resolveFollowUp = resolve
    })
  }

  /** Refreshes action state while an operation runs, without opening a second input promise. */
  updateFollowUps(view: CloseFollowUpsView): void {
    this.mode = "followups"
    this.syncTicker()
    this.setFollowUps(view)
  }

  showFailure(message: string): Promise<void> {
    this.mode = "failure"
    this.syncTicker()
    // Preflight blockers are already present as structured rows. Repeating the
    // thrown aggregate below them would render every blocker twice.
    this.failure = this.state.preflightFailed ? undefined : message
    this.render()
    if (this.inputClosed) return Promise.resolve()
    return new Promise((resolve) => {
      this.resolveDismiss = resolve
    })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopTicker()
    // Release focus before teardown so the renderer's focus bookkeeping ends
    // clean even when the operator was mid-edit.
    if (this.editOverlay.visible) this.editArea.blur()
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    this.input.off("end", this.handleInputEnd)
    this.input.off("close", this.handleInputEnd)
    if (!this.scene && !this.renderer.isDestroyed) this.renderer.destroy()
  }

  /** Releases raw mode/alternate-screen ownership for git, $EDITOR, or credential prompts. */
  async withTerminal<T>(action: () => Promise<T>): Promise<T> {
    this.renderer.suspend()
    this.suspended = true
    this.syncTicker()
    try {
      return await action()
    } finally {
      if (!this.renderer.isDestroyed) {
        this.renderer.resume()
        // Resume restarts the ticker from current state (design D2).
        this.suspended = false
        this.syncTicker()
        this.render()
      }
    }
  }

  /**
   * Ends the message gate (design D4): Accept returns the reviewed message —
   * the value currently shown, whether accepted as-is or saved from the
   * editor — and cancel returns undefined. Nothing lands before this call.
   */
  private finishMessage(outcome: "accept" | "cancel") {
    const resolve = this.resolveMessage
    if (!resolve) return
    this.resolveMessage = undefined
    this.mode = "progress"
    this.syncTicker()
    this.render()
    resolve(outcome === "accept" ? this.reviewedMessage : undefined)
  }

  /** Opens the centered editor overlay seeded with the complete reviewed message. */
  private openEditOverlay() {
    this.editNotice = undefined
    this.editArea.setText(this.reviewedMessage ?? this.message?.message ?? "")
    this.editOverlay.visible = true
    this.mode = "edit"
    // Focus is acquired after the opening keystroke's dispatch finishes: the
    // key that opened the overlay must not leak into the textarea as text.
    queueMicrotask(() => {
      if (!this.destroyed && this.mode === "edit") this.editArea.focus()
    })
    this.render()
  }

  /** Ctrl+S: validate the draft, adopt it as the reviewed message, and return to review. */
  private saveEditDraft() {
    const draft = sanitizeCommitDraft(this.editArea.plainText)
    const subject = draft.split("\n")[0]?.trim() ?? ""
    if (subject === "") {
      this.editNotice = "the message needs a subject line"
      this.render()
      return
    }
    this.reviewedMessage = draft
    this.closeEditOverlay()
    this.render()
  }

  /** Escape: throw the draft away; the previously reviewed message is untouched. */
  private discardEditDraft() {
    this.closeEditOverlay()
    this.render()
  }

  private closeEditOverlay() {
    this.editArea.blur()
    this.editOverlay.visible = false
    this.editNotice = undefined
    this.mode = "message"
  }

  /**
   * Starts or stops the render ticker so it lives exactly while a checklist
   * row is running, the progress view is showing, and the renderer is live
   * (design D2). Idempotent: repeated calls with an unchanged condition are
   * no-ops, so every state change can simply call it.
   */
  private syncTicker() {
    const needed =
      !this.destroyed && !this.suspended && this.mode === "progress" && this.state.rows.some((row) => row.status === "running")
    if (needed && !this.ticker) {
      this.ticker = setInterval(() => {
        // A tick that finds its work gone (row finished, renderer suspended,
        // TUI destroyed) disposes itself rather than waiting for the next call.
        if (this.destroyed || this.suspended || this.mode !== "progress" || !this.state.rows.some((row) => row.status === "running")) {
          this.stopTicker()
          return
        }
        this.render()
      }, this.tickMs)
    } else if (!needed && this.ticker) {
      this.stopTicker()
    }
  }

  private stopTicker() {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = undefined
    }
  }

  /** @internal — tests observe the animation cadence directly. */
  get ticking(): boolean {
    return this.ticker !== undefined
  }

  private moveMessageChoice(delta: number) {
    this.messageChoice = (this.messageChoice + delta + 3) % 3
    this.render()
  }

  /** Enter on the review screen activates the highlighted choice (design D3). */
  private activateMessageChoice() {
    const choice = (["accept", "edit", "cancel"] as const)[this.messageChoice]!
    if (choice === "edit") this.openEditOverlay()
    else this.finishMessage(choice)
  }

  private setFollowUps(view: CloseFollowUpsView) {
    const selectedId = this.followUps[this.selectedFollowUp]?.id
    this.followUps = view.actions
    this.followUpsNotice = view.notice
    this.followUpsDeferred = view.deferred
    const retained = selectedId ? view.actions.findIndex((item) => item.id === selectedId) : -1
    this.selectedFollowUp = retained >= 0 ? retained : Math.min(this.selectedFollowUp, Math.max(0, view.actions.length - 1))
    this.render()
  }

  private moveFollowUp(delta: number) {
    if (this.followUps.length === 0) return
    this.selectedFollowUp = Math.max(0, Math.min(this.followUps.length - 1, this.selectedFollowUp + delta))
    this.render()
  }

  private runSelectedFollowUp() {
    const item = this.followUps[this.selectedFollowUp]
    // Only actions the current process can run now — or retry after a
    // failure — are selectable; blocked and informational rows are inert.
    if (!item || (item.status !== "available" && item.status !== "failed")) return
    this.finishFollowUp({ type: "run", id: item.id })
  }

  private runFollowUpShortcut(id: CloseFollowUpId) {
    const index = this.followUps.findIndex((item) => item.id === id)
    if (index < 0) return
    this.selectedFollowUp = index
    this.runSelectedFollowUp()
  }

  private finishFollowUp(resolution: CloseFollowUpResolution) {
    const resolve = this.resolveFollowUp
    if (!resolve) return
    this.resolveFollowUp = undefined
    resolve(resolution)
  }

  private render() {
    if (this.destroyed || this.renderer.isDestroyed || this.scene?.isClosed) return
    const width = Math.max(24, this.renderer.width - 6)
    this.headerText.content = t`${fg(theme.dim)("dir ")}${fg(theme.text)(shortPath(this.targetDir, Math.max(8, width - 4)))}`
    this.contentBox.title = this.contentTitle()
    this.contentText.content = this.content(width)
    // The centered editor overlays this area; hiding the underlying text keeps
    // the overlay's reading surface clean instead of blending two text layers.
    this.contentText.visible = this.mode !== "edit"
    this.footerText.content = this.footer(width)
    // Keys live in the footer (the product's hint row). The overlay only
    // spends a line on a validation error — repeating the same shortcuts
    // here was decoration.
    const editNotice = this.mode === "edit" ? this.editNotice : undefined
    this.editHintText.visible = Boolean(editNotice)
    this.editHintText.content = editNotice
      ? t`${fg(theme.yellow)(truncate(editNotice, Math.max(8, Math.floor(width * 0.8) - 2)))}`
      : ""
    this.renderer.requestRender()
  }

  private contentTitle(): string {
    // While the editor overlay is up its own title rides the shared border
    // row, so the covered panel draws none.
    if (this.mode === "edit") return ""
    if (this.mode === "message") return " commit message "
    if (this.mode === "followups") return " optional follow-ups "
    if (this.mode === "failure") return " close stopped "
    return " closing "
  }

  private content(width: number): StyledText {
    if (this.mode === "message" || this.mode === "edit") return this.messageContent(width)
    if (this.mode === "followups") return this.followUpsContent(width)
    return this.progressContent(width)
  }

  private progressContent(width: number): StyledText {
    const lines: StyledText[] = []
    if (this.state.preflightFailed) {
      lines.push(t`${bold(fg(theme.red)("Preflight failed"))}`)
      lines.push(plain(""))
      for (const blocker of this.state.preflightFailed) lines.push(t`${fg(theme.red)("✗")} ${fg(theme.text)(truncate(blocker, Math.max(8, width - 2)))}`)
    } else {
      if (this.state.preflight) {
        lines.push(t`${fg(theme.dim)("preflight  ")}${fg(theme.text)(truncate(this.state.preflight, Math.max(8, width - 11)))}`)
        lines.push(plain(""))
      }
      for (const row of this.state.rows) {
        const detail = row.detail ? `— ${row.status === "skipped" ? "skipped: " : ""}${row.detail}` : row.status === "running" ? "…" : ""
        // A bare running ellipsis glues to the step (`archive…`); a named
        // sub-phase needs the same gap the completed/skipped rows already use.
        const gap = row.status === "running" && !row.detail ? "" : " "
        lines.push(
          new StyledText([
            raw("  "),
            statusIcon(row.status, this.clock()),
            raw(" "),
            statusLabel(row.status)(row.step),
            ...(detail ? [raw(gap), fg(theme.dim)(truncate(detail, Math.max(0, width - row.step.length - 6)))] : []),
          ]),
        )
      }
      if (this.state.result) {
        lines.push(plain(""))
        lines.push(t`${bold(fg(theme.green)("Closed"))} ${fg(theme.text)(truncate(`${this.state.result.changeID}: ${this.state.result.branch} → ${this.state.result.baseRef}`, Math.max(8, width - 7)))}`)
      }
    }
    if (this.failure) {
      lines.push(plain(""))
      for (const [index, line] of this.failure.split("\n").entries()) {
        lines.push(t`${index === 0 ? bold(fg(theme.red)(truncate(line, width))) : fg(theme.dim)(truncate(line, width))}`)
      }
    }
    return joinLines(lines)
  }

  private messageContent(width: number): StyledText {
    const proposal = this.message
    if (!proposal) return plain("")
    // The reviewed message is the source of truth on this screen (design D4):
    // it starts as the proposal and changes only through a saved edit.
    const reviewed = this.reviewedMessage ?? proposal.message
    const lines: StyledText[] = [
      ...wrapStyled(new StyledText([bold(fg(theme.text)("Review the squashed commit message before it lands."))]), width),
    ]
    if (proposal.error) {
      lines.push(...wrapStyled(new StyledText([fg(theme.yellow)("The writing model failed; this is the deterministic fallback.")]), width))
    }
    if (this.messageNotice) {
      lines.push(...wrapStyled(new StyledText([fg(theme.yellow)(this.messageNotice)]), width))
    }
    lines.push(plain(""), t`${fg(theme.faint)("─".repeat(Math.max(1, width)))}`)
    for (const line of reviewed.split("\n")) {
      lines.push(...wrapStyled(new StyledText([fg(theme.text)(line)]), width))
    }
    lines.push(t`${fg(theme.faint)("─".repeat(Math.max(1, width)))}`, plain(""))
    const labels = ["Accept", "Edit", "Cancel"]
    labels.forEach((label, index) => {
      const selected = index === this.messageChoice
      lines.push(new StyledText([selected ? fg(theme.accent)("▸ ") : raw("  "), selected ? bold(fg(theme.text)(label)) : fg(theme.dim)(label)]))
    })
    return joinLines(lines)
  }

  private followUpsContent(width: number): StyledText {
    const lines: StyledText[] = []
    if (this.state.result) {
      lines.push(t`${bold(fg(theme.green)("Closed"))} ${fg(theme.text)(truncate(`${this.state.result.changeID}: ${this.state.result.branch} → ${this.state.result.baseRef}`, Math.max(8, width - 7)))}`)
      lines.push(plain(""))
    }
    const intro =
      this.followUps.length > 0
        ? "Nothing below runs automatically. Choose an action or press q when done."
        : "Nothing below runs automatically. Press q when done."
    lines.push(...wrapStyled(new StyledText([fg(theme.dim)(intro)]), width), plain(""))
    this.followUps.forEach((item, index) => {
      const selected = index === this.selectedFollowUp
      const icon = followUpIcon(item.status, this.clock())
      const status = followUpStatusLabel(item.status)
      const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), icon, raw(" "), selected ? bold(fg(theme.text)(item.label)) : fg(theme.text)(item.label)]
      lines.push(new StyledText([...left, fg(theme.dim)(`  ${status}`)]))
      if (selected) {
        const gutter = [raw("    ")]
        if (item.detail) lines.push(...indentStyled(new StyledText([fg(theme.dim)(item.detail)]), width, gutter))
        if (item.command) lines.push(...indentStyled(new StyledText([fg(theme.faint)(item.command)]), width, gutter))
        if (item.error) lines.push(...indentStyled(new StyledText([fg(theme.red)(item.error)]), width, gutter))
      }
    })
    if (this.followUpsNotice) {
      lines.push(plain(""))
      // The notice can carry several paragraphs (the PR fallback guidance plus
      // a push remediation), so each line wraps separately instead of blending
      // into one wrapped string.
      for (const paragraph of this.followUpsNotice.split("\n")) {
        lines.push(...wrapStyled(new StyledText([fg(theme.yellow)(paragraph)]), width))
      }
    }
    if (this.followUpsDeferred) {
      lines.push(plain(""))
      lines.push(...wrapStyled(new StyledText([bold(fg(theme.text)("Deferred cleanup — not runnable from this shell"))]), width))
      for (const paragraph of this.followUpsDeferred.reason.split("\n")) {
        lines.push(...wrapStyled(new StyledText([fg(theme.dim)(paragraph)]), width))
      }
      this.followUpsDeferred.steps.forEach((step, index) => {
        lines.push(...indentStyled(new StyledText([fg(theme.dim)(`${index + 1}. `), fg(theme.text)(step.label)]), width, [raw("  ")]))
        lines.push(...indentStyled(new StyledText([fg(theme.faint)(`$ ${step.command}`)]), width, [raw("       ")]))
      })
    }
    return joinLines(lines)
  }

  private footer(width: number): StyledText {
    if (this.mode === "message") {
      const hints: Hint[] = [
        { keys: "↑/↓", label: "choose", priority: 4 },
        { keys: "enter", label: "confirm", priority: 1 },
        { keys: "e", label: "dit", priority: 2, style: "glued" },
        { keys: "esc", label: "cancel", priority: 3 },
      ]
      return hintsRow(hints, [], width, { style: "spaced", overflow: moreHintsMarker })
    }
    if (this.mode === "edit") {
      const hints: Hint[] = [
        { keys: "ctrl+s", label: "save", priority: 1 },
        { keys: "enter", label: "newline", priority: 2 },
        { keys: "esc", label: "discard", priority: 3 },
      ]
      return hintsRow(hints, [], width, { style: "spaced", overflow: moreHintsMarker })
    }
    if (this.mode === "followups") {
      const hints: Hint[] = [
        { keys: "enter", label: "run / retry", priority: 1 },
        { keys: "p/w/b", label: "action", priority: 3 },
        { keys: "q", label: "done", priority: 2 },
      ]
      return hintsRow(hints, [], width, { style: "spaced", overflow: moreHintsMarker })
    }
    if (this.mode === "failure") {
      return hintsRow([{ keys: "enter/q", label: "close", priority: 1 }], [], width, { style: "spaced", overflow: moreHintsMarker })
    }
    return t`${fg(theme.dim)("Close is running. Git mutations finish before input is accepted.")}`
  }

  private applyPalette() {
    for (const target of this.paletteTargets) {
      target.box.backgroundColor = theme[target.background ?? "bg"]
      if (target.border) target.box.borderColor = theme[target.border]
    }
    this.editArea.backgroundColor = theme.overlay
    this.editArea.textColor = theme.text
    this.editArea.focusedBackgroundColor = theme.overlay
    this.editArea.focusedTextColor = theme.text
  }

  private panel(options: BoxOptions) {
    const box = new BoxRenderable(this.renderer, {
      border: true,
      borderStyle: "rounded",
      paddingX: 1,
      paddingY: 0,
      backgroundColor: theme.bg,
      ...options,
    })
    const text = new TextRenderable(this.renderer, {
      content: "",
      fg: theme.text,
      width: "100%",
      height: "100%",
    })
    box.add(text)
    return { box, text }
  }
}

export async function openCloseTui(targetDir: string, initialState?: CloseChecklistState, route?: TuiRoute): Promise<CloseTui> {
  if (route) {
    const scene = sceneForRoute(route, "convoy-close-scene")!
    return new CloseTui(route.session.renderer, targetDir, initialState, process.stdin, scene)
  }
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
  })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new CloseTui(renderer, targetDir, initialState)
}

/**
 * The inline editor's save sanitation (design D4): line endings normalized,
 * terminal-injection bytes stripped (newlines survive), and only the outer
 * blank lines trimmed so intentional interior spacing stays as written.
 */
function sanitizeCommitDraft(value: string): string {
  const normalized = stripControlBytes(value.replace(/\r\n?/g, "\n"))
  const lines = normalized.split("\n")
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift()
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop()
  return lines.join("\n")
}

function statusLabel(status: CloseChecklistRowStatus): ReturnType<typeof fg> {
  if (status === "completed") return fg(theme.green)
  if (status === "failed") return fg(theme.red)
  if (status === "running") return fg(theme.accent)
  if (status === "skipped") return fg(theme.dim)
  return fg(theme.faint)
}

function followUpIcon(status: CloseFollowUpStatus, now: number): TextChunk {
  if (status === "completed") return fg(theme.green)("✓")
  if (status === "running") return statusIcon("running", now)
  if (status === "failed") return fg(theme.red)("✗")
  if (status === "blocked") return fg(theme.faint)("⊘")
  return fg(theme.accent)("○")
}

function followUpStatusLabel(status: CloseFollowUpStatus): string {
  if (status === "available") return "available"
  if (status === "running") return "running…"
  if (status === "completed") return "done"
  if (status === "failed") return "failed — enter to retry"
  // Same-session dependency: runnable here once the blocking action succeeds.
  return "blocked until its dependency clears"
}
