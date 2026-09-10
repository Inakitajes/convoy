import { readFile } from "node:fs/promises"

import { bg, BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg, t } from "@opentui/core"

import { copyReportToClipboard, writeClipboardOSC52, type ClipboardResult } from "./clipboard"
import type { BoardWorktree } from "./control-board"
import { parseMarkdown, renderMarkdownDoc, type MarkdownDoc } from "./markdown-render"
import { stripYamlFrontmatter } from "./openspec"
import { groupChangeArtifacts, loadSpecsView, specGroupSource, worktreeDisplayName, type SpecGroup, type SpecsChangeEntry, type SpecsResolution, type SpecsView } from "./specs"
import {
  chunksLength,
  displayWidth,
  hintsRow,
  joinLines,
  moreHintsMarker,
  padBetween,
  paletteForTerminal,
  plain,
  raw,
  setTheme,
  terminalBackgroundHex,
  theme,
  truncate,
} from "./tui-theme"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { Hint } from "./tui-theme"

/**
 * The selection a returning browser restores (capability work-context /
 * specs-viewer: returning from a cancelled launcher, a dashboard, or an
 * authoring conversation SHALL restore the originating selection). Identity-
 * keyed — change id plus its containing checkout, or spec path — never a list
 * position, so a refreshed view still lands on the same subject.
 */
export type SpecsBrowserResume = {
  level: "root" | "detail"
  changeId?: string
  checkout?: string
  specPath?: string
}

/**
 * One row of the navigation list. The board has two top-level sections, each
 * named by a header divider: `changes` — every Git-registered checkout as a
 * divider with its local active changes hanging beneath it as the only
 * entries that worktree owns — and `specs` — the launch checkout's canonical
 * specs. Worktree sections are separated by a full blank line; neither the
 * headers nor the worktree rules are selectable. Selection only ever lands on
 * a change or a spec: the sections group, the children act.
 */
type ListRow =
  | { kind: "spacer" }
  | { kind: "worktree"; worktree: BoardWorktree }
  | { kind: "header"; label: string }
  | { kind: "sectionEnd" }
  | { kind: "change"; change: SpecsChangeEntry }
  | { kind: "spec"; path: string }

/** Rows the cursor may land on: sections and rules are dead structure. */
type SelectableRow = Extract<ListRow, { kind: "change" }> | Extract<ListRow, { kind: "spec" }>
function isSelectableRow(row: ListRow | undefined): row is SelectableRow {
  return row?.kind === "change" || row?.kind === "spec"
}

/**
 * One dispatchable or inspectable Actions-menu entry. Availability comes from
 * the same observed facts the CLI guards read — never a lifecycle stage.
 */
type MenuItem = {
  action: { id: string; label: string; enabled: boolean; blockers: readonly string[]; remediation?: readonly string[] }
  /** Present only when the browser can run the action itself. */
  dispatch?: "close" | "refresh"
}

export class SpecsBrowser {
  readonly result: Promise<SpecsResolution>

  private resolveResult!: (resolution: SpecsResolution) => void
  private finished = false
  /** "root": the worktree-rooted entity list; "detail": one subject's reading pane. */
  private level: "root" | "detail" = "root"
  /** Set while the immersive reader replaces the chrome (detail level only). */
  private fullscreen = false
  // The first selectable row sits under the leading header when changes exist;
  // the constructor moves the cursor past any header so an empty first section
  // still opens on a reachable row (same rule as runs).
  private selectedRow = 1
  private scroll = 0
  /** Set while a change/spec was entered: the detail level's subject. */
  private subject?: { kind: "change"; change: SpecsChangeEntry } | { kind: "spec"; path: string }
  private groups: SpecGroup[] = []
  private selectedGroup = 0
  private detailScroll = 0
  /** Outcome of the last copy attempt, reported in the reader's title bar. */
  private copyStatus?: ClipboardResult
  /** Set while the Actions menu overlays the current level. */
  private menuOpen = false
  private menuIndex = 0
  /**
   * Set while the close confirm modal owns the keyboard: the exact resolution
   * a confirm would emit plus the display facts the modal names. Nothing is
   * emitted until the operator confirms (close confirmation, capability
   * specs-viewer) — a stray `x` can no longer start the close sequence.
   */
  private pendingClose?: { resolution: SpecsResolution; worktree: string; branch: string; base: string; archiveSet: string }
  /** Scroll position for the fullscreen reader's title bar (`top` / `end` / `%` / `all`). */
  private readerPosition = ""
  /** Artifact markdown read lazily, keyed by absolute file; failures become placeholders. */
  private readonly bodies = new Map<string, string>()
  private readonly docs = new Map<string, MarkdownDoc>()

  private readonly bodyBox: BoxRenderable
  private readonly listText: TextRenderable
  private readonly listBox: BoxRenderable
  private readonly detailsText: TextRenderable
  private readonly detailsBox: BoxRenderable
  private readonly footerText: TextRenderable
  private readonly footerBox: BoxRenderable
  // The close confirm modal's overlay shell (the runs-browser retry-confirm
  // pattern): one centered bordered box over a masking backdrop.
  private readonly overlay: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: "bg" | "overlay"; border?: "border" | "borderDim" | "accent" }> = []

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
    key.preventDefault()
    key.stopPropagation()
    // The close confirm modal owns the keyboard while it is up (same rule as
    // the Actions menu): only y/enter confirm or n/esc cancel answer it.
    if (this.pendingClose) {
      this.handleConfirmKey(key)
      return
    }
    if (this.level === "root") this.handleRootKey(key)
    else this.handleDetailKey(key)
  }

  constructor(
    private readonly renderer: CliRenderer,
    private view: SpecsView,
    // Clipboard deps are constructor-injected exactly like the dashboard's
    // copyReport, so tests swap the transport instead of shelling out.
    private readonly copyReport: typeof copyReportToClipboard = copyReportToClipboard,
    private readonly scene?: TuiScene,
    /** The selection to restore on re-entry (returning from an action). */
    private readonly resume?: SpecsBrowserResume,
  ) {
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })
    const mount = this.scene?.root ?? renderer.root
    // Land on the first selectable row (the first change, or the first spec
    // when there are no changes). Sections and rules are dead rows —
    // enter/apply/iterate no-op on them — so the browser must never park the
    // cursor there.
    const firstSelectable = this.rows.findIndex(isSelectableRow)
    this.selectedRow = firstSelectable >= 0 ? firstSelectable : 0

    const shell = new BoxRenderable(renderer, {
      id: "convoy-specs-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
      gap: 0,
    })

    // No header row: the board opens straight on its sections — the screen's
    // name is the session's own context, and the section containers identify
    // everything else.
    const body = new BoxRenderable(renderer, {
      id: "convoy-specs-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
    })

    const wheel = (event: WheelEvent) => {
      const delta = wheelDelta(event)
      if (delta === 0) return
      event.preventDefault()
      event.stopPropagation()
      if (this.level === "root") this.moveSelection(delta)
      else this.detailScroll += delta
      this.render()
    }

    // The list's own rows carry the section containers, so the panel adds no
    // padding of its own — the containers reach within the shell's 1-column
    // margin on both edges.
    const list = this.panel({
      id: "convoy-specs-list",
      height: "100%",
      flexGrow: 1,
      paddingX: 0,
      backgroundColor: theme.bg,
      onMouseScroll: wheel,
    })
    list.text.onMouseScroll = wheel

    const details = this.panel({
      id: "convoy-specs-details",
      width: this.detailsWidth(),
      height: "100%",
      backgroundColor: theme.bg,
      onMouseScroll: wheel,
    })
    details.text.onMouseScroll = wheel

    const footer = this.panel({
      id: "convoy-specs-footer",
      height: 1,
      paddingX: 0,
      backgroundColor: theme.bg,
    })

    // Sections are dividers, not containers — the same rule the home screen
    // lives by. The border must go through the runtime setter: opentui's
    // constructor path funnels `border: false` through initializeBorder(),
    // which forces it back on.
    list.box.border = false
    details.box.border = false
    footer.box.border = false

    this.bodyBox = body
    this.listText = list.text
    this.listBox = list.box
    this.detailsText = details.text
    this.detailsBox = details.box
    this.footerText = footer.text
    this.footerBox = footer.box

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

    // The close confirm modal (close confirmation): a centered bordered box
    // over a masking backdrop, owning the keyboard until answered.
    this.overlay = new BoxRenderable(renderer, {
      id: "convoy-specs-close-overlay",
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
      id: "convoy-specs-close-modal",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.overlay,
      title: " close ",
      titleAlignment: "left",
      paddingX: 2,
      paddingY: 1,
    })
    this.modalText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    this.modal.add(this.modalText)
    this.overlay.add(this.modal)
    mount.add(this.overlay)
    this.paletteTargets.push({ box: this.modal, background: "overlay", border: "accent" })

    this.applyResume()
    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    this.render()
  }

  /**
   * Restores a returning selection by identity: the row matching the
   * remembered change (in its checkout) or spec is selected again, and a
   * detail-level resume re-enters that subject. A subject the refreshed view
   * no longer contains falls back to the root row it had — never to a
   * different execution target.
   */
  private applyResume() {
    if (!this.resume) return
    const rows = this.rows
    const matchIndex = rows.findIndex((row) => {
      if (this.resume!.changeId && row.kind === "change") {
        return row.change.id === this.resume!.changeId && (!this.resume!.checkout || row.change.checkout === this.resume!.checkout)
      }
      if (this.resume!.specPath && row.kind === "spec") return row.path === this.resume!.specPath
      return false
    })
    if (matchIndex >= 0) this.selectedRow = matchIndex
    if (this.resume.level !== "detail") return
    const row = rows[this.selectedRow]
    if (!isSelectableRow(row)) return
    this.enterSelected()
  }

  // ── keys ────────────────────────────────────────────────────────────────

  private handleRootKey(key: KeyEvent) {
    // The Actions menu owns the keyboard while open.
    if (this.menuOpen && this.handleMenuKey(key)) return
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
        this.jumpSelection(-this.rows.length)
        break
      case "end":
        this.jumpSelection(this.rows.length)
        break
      case "g":
        this.jumpSelection(key.shift ? this.rows.length : -this.rows.length)
        break
      case "return":
      case "linefeed":
      case "o":
        this.enterSelected()
        break
      case "a": {
        const change = this.selectedChange()
        if (change) this.finish({ type: "apply-change", changeID: change.id, checkout: change.checkout })
        break
      }
      case "i": {
        const change = this.selectedChange()
        if (change) {
          this.finish({
            type: "iterate-change",
            changeID: change.id,
            checkout: change.checkout,
            // Foreground (open the client in this terminal and return) is the
            // default; an external window is the explicit shift+I choice
            // (capability work-conversations).
            presentation: key.shift ? "external" : "foreground",
          })
        }
        break
      }
      case "s": {
        const change = this.selectedChange()
        // Spin out is the retained legacy transfer for a change stranded on
        // the launch checkout (capability feature-spin delta).
        if (change && change.checkout === this.view.targetDir) this.finish({ type: "spin-change", changeID: change.id })
        break
      }
      case "c": {
        const change = this.selectedChange()
        const worktree = change ? this.worktreeFor(change) : undefined
        if (change && worktree?.branch) {
          this.finish({ type: "continue-change", changeID: change.id, worktreeDir: worktree.path, branch: worktree.branch })
        }
        break
      }
      case "x": {
        const worktree = this.selectedChange() ? this.worktreeFor(this.selectedChange()!) : undefined
        if (worktree?.branch) {
          const change = this.selectedChange()
          const archiveSet = change && change.checkout === worktree.path ? change.id : "(none — whole branch only)"
          this.openCloseConfirm(
            {
              type: "close-change",
              changeID: change && change.checkout === worktree.path ? change.id : change?.id ?? "",
              worktreeDir: worktree.path,
              branch: worktree.branch,
            },
            worktree,
            change && change.checkout === worktree.path ? change.id : undefined,
          )
        }
        break
      }
      case "r": {
        // Explicit refresh: reload the whole view, invalidate the
        // artifact/document caches together, and keep the selection attached
        // to identity rather than list position.
        void this.refresh()
        break
      }
      case "!":
      case "exclamation":
        this.openActionsMenu()
        break
      case "q":
      case "escape":
        this.finish({ type: "exit" })
        break
    }
  }

  private handleDetailKey(key: KeyEvent) {
    // The Actions menu owns the keyboard while open; the fullscreen reader
    // keeps its copy/close/tab keys and never opens the menu.
    if (this.menuOpen && !this.fullscreen && this.handleMenuKey(key)) return
    // Digits 1–9 jump straight to a tab (the strip labels the numbers).
    if (this.digitTab(key)) {
      this.render()
      return
    }
    // Tabs: arrows/h/l switch. Inside the reader they still work, resetting
    // the pane's scroll; the reader's own close keys come first.
    const tabCount = this.groups.length
    switch (key.name) {
      case "right":
      case "l":
        if (tabCount > 1) this.switchTab(1)
        break
      case "left":
      case "h":
        if (tabCount > 1) this.switchTab(-1)
        break
      case "up":
      case "k":
        this.detailScroll -= 1
        break
      case "down":
      case "j":
        this.detailScroll += 1
        break
      case "pageup":
        this.detailScroll -= this.detailsHeight()
        break
      case "pagedown":
      case "space":
        this.detailScroll += this.detailsHeight()
        break
      case "home":
        this.detailScroll = 0
        break
      case "end":
        this.detailScroll = Number.MAX_SAFE_INTEGER
        break
      case "g":
        this.detailScroll = key.shift ? Number.MAX_SAFE_INTEGER : 0
        break
      case "v":
        // The fullscreen reader exists only at the detail level, so a plain
        // toggle here is exactly the reader's open/close key.
        this.toggleFullscreen()
        return
      case "c":
        if (this.fullscreen) {
          void this.copyActiveTab()
          return
        }
        break
      case "a": {
        const subject = this.subject
        if (subject?.kind === "change") this.finish({ type: "apply-change", changeID: subject.change.id, checkout: subject.change.checkout })
        return
      }
      case "i": {
        const subject = this.subject
        if (subject?.kind === "change") {
          this.finish({
            type: "iterate-change",
            changeID: subject.change.id,
            checkout: subject.change.checkout,
            presentation: key.shift ? "external" : "foreground",
          })
        }
        return
      }
      case "escape":
      case "q":
        if (this.fullscreen) {
          this.toggleFullscreen()
          return
        }
        this.leaveSubject()
        break
      case "b":
        if (!this.fullscreen) this.leaveSubject()
        break
      case "!":
      case "exclamation":
        // The Actions menu exists at the ordinary detail level too; the
        // fullscreen reader keeps its copy/close/tab keys untouched.
        if (!this.fullscreen) this.openActionsMenu()
        break
    }
    this.render()
  }

  // ── the Actions menu ─────────────────────────────────────────────────────

  /** The worktree the menu acts on, at the current level. */
  private menuTarget(): BoardWorktree | undefined {
    // Sections are not selectable, so the menu always targets the selected
    // change's containing worktree — at the root and in the reading pane.
    const change = this.level === "root" ? this.selectedChange() : this.subject?.kind === "change" ? this.subject.change : undefined
    return change ? this.worktreeFor(change) : undefined
  }

  /** The menu entries: the worktree's contextual actions plus refresh. */
  private menuItems(): MenuItem[] {
    const worktree = this.menuTarget()
    if (!worktree) return []
    const items: MenuItem[] = []
    if (worktree.branch) {
      const change = this.level === "root" ? this.selectedChange() : this.subject?.kind === "change" ? this.subject.change : undefined
      const inScope = change && change.checkout === worktree.path ? change.id : undefined
      items.push({
        action: {
          id: "close",
          label: "Close review",
          enabled: worktree.accessible,
          blockers: worktree.accessible ? [] : ["the registered checkout path is missing — repair or prune it first"],
        },
        dispatch: "close",
        ...(inScope ? {} : {}),
      })
      void inScope
    } else {
      items.push({
        action: {
          id: "close",
          label: "Close review",
          enabled: false,
          blockers: ["the checkout has a detached HEAD — close needs an attached branch to name the source"],
        },
      })
    }
    items.push({ action: { id: "refresh", label: "Refresh", enabled: true, blockers: [] }, dispatch: "refresh" })
    return items
  }

  private openActionsMenu() {
    if (this.menuItems().length === 0) return
    this.menuOpen = true
    this.menuIndex = Math.max(0, this.menuItems().findIndex((item) => item.dispatch && item.action.enabled))
    this.render()
  }

  private closeActionsMenu() {
    this.menuOpen = false
    this.render()
  }

  /** Menu keys; returns false when the key wasn't a menu key (root falls through). */
  private handleMenuKey(key: KeyEvent): boolean {
    const items = this.menuItems()
    switch (key.name) {
      case "up":
      case "k":
        this.menuIndex = (this.menuIndex - 1 + items.length) % Math.max(1, items.length)
        break
      case "down":
      case "j":
        this.menuIndex = (this.menuIndex + 1) % Math.max(1, items.length)
        break
      case "return":
      case "linefeed": {
        const item = items[this.menuIndex]
        if (item?.dispatch && item.action.enabled) {
          this.menuOpen = false
          this.dispatchMenuItem(item, this.menuTarget())
          return true
        }
        break
      }
      case "escape":
        this.closeActionsMenu()
        return true
      case "q":
        // q keeps its global meaning (quit/back) instead of closing the menu.
        return false
      default:
        return true
    }
    this.render()
    return true
  }

  private dispatchMenuItem(item: MenuItem, worktree: BoardWorktree | undefined) {
    if (!worktree) return
    switch (item.dispatch) {
      case "close": {
        const change = this.level === "root" ? this.selectedChange() : this.subject?.kind === "change" ? this.subject.change : undefined
        const inScope = change && change.checkout === worktree.path ? change : undefined
        if (worktree.branch) {
          this.openCloseConfirm(
            { type: "close-change", changeID: inScope?.id ?? "", worktreeDir: worktree.path, branch: worktree.branch },
            worktree,
            inScope?.id,
          )
        }
        return
      }
      case "refresh":
        void this.refresh()
        return
    }
  }

  // ── the close confirm modal (close confirmation) ──────────────────────────

  /**
   * Arms the close confirmation instead of emitting the resolution: the modal
   * names the source worktree/path/branch, the base, the explicit archive set
   * (including an empty one), and the whole-branch squash scope, so an
   * accidental `x` cannot start sync → archive → squash.
   */
  private openCloseConfirm(resolution: SpecsResolution, worktree: BoardWorktree, changeId?: string) {
    this.pendingClose = {
      resolution,
      worktree: `${worktreeDisplayName(worktree)} (${worktree.path})`,
      branch: worktree.branch ?? "(no local branch)",
      base: this.view.baseBranch ?? "the base branch",
      archiveSet: changeId ?? "none — zero selected changes",
    }
    this.render()
  }

  /** Only an explicit confirm emits the stored resolution; cancel leaves the browser untouched. */
  private handleConfirmKey(key: KeyEvent) {
    const pending = this.pendingClose
    if (!pending) return
    if (key.name === "y" || key.name === "return" || key.name === "linefeed") {
      this.pendingClose = undefined
      this.finish(pending.resolution)
      return
    }
    if (key.name === "n" || key.name === "escape") {
      this.pendingClose = undefined
      this.render()
    }
    // Any other key is ignored: the modal stays up until it is answered.
  }

  /** The confirm modal's body: what will run, on what, and the y/n choice. */
  private renderCloseConfirmModal(boxWidth: number) {
    const pending = this.pendingClose
    if (!pending) return
    const innerWidth = Math.max(36, boxWidth - 6)
    const lines: StyledText[] = [
      t`${bold(fg(theme.text)("Close this worktree?"))}`,
      plain(""),
      t`${fg(theme.faint)("Close runs sync → archive → squash: it archives the selected")}`,
      t`${fg(theme.faint)("changes and lands ONE commit covering the WHOLE branch on the")}`,
      t`${fg(theme.faint)("base — including edits outside the selected changes. Nothing is")}`,
      t`${fg(theme.faint)("pushed, merged, or deleted; push and cleanup stay separate.")}`,
      plain(""),
      new StyledText([fg(theme.faint)("worktree "), fg(theme.text)(truncate(pending.worktree, innerWidth - 10))]),
      new StyledText([fg(theme.faint)("branch   "), fg(theme.dim)(pending.branch)]),
      new StyledText([fg(theme.faint)("base     "), fg(theme.dim)(pending.base)]),
      new StyledText([fg(theme.faint)("archive  "), fg(theme.dim)(truncate(pending.archiveSet, innerWidth - 10))]),
      plain(""),
      t`${fg(theme.accent)("y")} ${fg(theme.text)("confirm")}   ${fg(theme.faint)("n/esc")} ${fg(theme.dim)("cancel")}`,
    ]
    this.modalText.content = joinLines(lines)
  }

  // ── selection ───────────────────────────────────────────────────────────

  private digitTab(key: KeyEvent): boolean {
    if (!key.sequence || !/^[1-9]$/.test(key.sequence)) return false
    const index = Number.parseInt(key.sequence, 10) - 1
    if (index >= this.groups.length) return false
    this.selectedGroup = index
    this.detailScroll = 0
    void this.loadSelectedGroup().then(() => this.render())
    return true
  }

  private switchTab(delta: number) {
    const next = (this.selectedGroup + delta + this.groups.length) % this.groups.length
    if (next === this.selectedGroup) return
    this.selectedGroup = next
    this.detailScroll = 0
    void this.loadSelectedGroup().then(() => this.render())
  }

  private toggleFullscreen() {
    if (this.level !== "detail") return
    this.fullscreen = !this.fullscreen
    if (!this.fullscreen) this.copyStatus = undefined
    this.render()
  }

  private async copyActiveTab() {
    const group = this.groups[this.selectedGroup]
    if (!group) return
    await this.loadSelectedGroup()
    const source = specGroupSource(group, (file) => this.bodies.get(file) ?? "")
    this.copyStatus = await this.copyReport(source, writeClipboardOSC52)
    this.render()
  }

  private moveSelection(delta: number) {
    const selectable = this.rows.map((row, index) => ({ row, index })).filter(({ row }) => isSelectableRow(row))
    if (selectable.length === 0) return
    const position = selectable.findIndex(({ index }) => index === this.selectedRow)
    // A jump larger than the list is a home/end request: land on the first
    // (negative) or last (positive) selectable row instead of wrapping.
    let nextIndex: number
    if (Math.abs(delta) >= this.rows.length) {
      nextIndex = delta < 0 ? 0 : selectable.length - 1
    } else if (position === -1) {
      nextIndex = 0
    } else {
      let cursor = position
      for (let step = 0; step < Math.abs(delta); step += 1) {
        cursor = (cursor + Math.sign(delta) + selectable.length) % selectable.length
      }
      nextIndex = cursor
    }
    this.selectedRow = selectable[nextIndex]!.index
    this.render()
  }

  private jumpSelection(delta: number) {
    this.moveSelection(delta)
  }

  private selectedChange(): SpecsChangeEntry | undefined {
    const row = this.rows[this.selectedRow]
    return row?.kind === "change" ? row.change : undefined
  }

  /**
   * Explicit refresh: reloads the view, invalidates cached artifact data
   * together, and re-anchors the selection to the same identity (change id in
   * its checkout, worktree path, or spec path). A failed refresh keeps the
   * current view — stale evidence stays visible as such instead of readiness
   * being presented as current.
   */
  private async refresh() {
    const previous = this.rows[this.selectedRow]
    const identity =
      previous?.kind === "change"
        ? { kind: "change" as const, changeId: previous.change.id, checkout: previous.change.checkout }
        : previous?.kind === "worktree"
          ? { kind: "worktree" as const, path: previous.worktree.path }
          : previous?.kind === "spec"
            ? { kind: "spec" as const, path: previous.path }
            : undefined
    try {
      const next = await loadSpecsView(this.view.targetDir)
      this.view = next
    } catch {
      // Keep the previous view: a failed refresh must not silently empty the
      // board or present stale readiness as current. The next refresh retries.
      this.render()
      return
    }
    this.bodies.clear()
    this.docs.clear()
    const rows = this.rows
    const matchIndex = rows.findIndex((row) => {
      if (!identity || !isSelectableRow(row)) return false
      if (row.kind === "change" && identity.kind === "change") return row.change.id === identity.changeId && row.change.checkout === identity.checkout
      if (row.kind === "spec" && identity.kind === "spec") return row.path === identity.path
      return false
    })
    if (matchIndex >= 0) this.selectedRow = matchIndex
    else {
      const firstSelectable = rows.findIndex(isSelectableRow)
      if (firstSelectable >= 0) this.selectedRow = Math.min(firstSelectable, this.selectedRow)
    }
    this.render()
  }

  /** The registered checkout containing this change copy — its only action target. */
  private worktreeFor(change: SpecsChangeEntry): BoardWorktree | undefined {
    return this.view.board.worktrees.find((worktree) => worktree.path === change.checkout)
  }

  /** Enters a change (its reading pane) or a spec (its rendered content). */
  private enterSelected() {
    const row = this.rows[this.selectedRow]
    if (!isSelectableRow(row)) return
    if (row.kind === "change") {
      this.subject = { kind: "change", change: row.change }
      this.groups = groupChangeArtifacts(row.change)
    } else {
      this.subject = { kind: "spec", path: row.path }
      this.groups = [{ label: "Spec", delta: false, entries: [{ file: row.path }] }]
    }
    this.level = "detail"
    this.selectedGroup = 0
    this.detailScroll = 0
    void this.loadSelectedGroup().then(() => this.render())
    this.render()
  }

  private leaveSubject() {
    if (!this.subject) return
    this.subject = undefined
    this.level = "root"
    this.fullscreen = false
    this.menuOpen = false
    this.render()
  }

  // ── loading ─────────────────────────────────────────────────────────────

  /** Reads the selected group's markdown lazily — nothing loads until entered. */
  private async loadSelectedGroup() {
    const group = this.groups[this.selectedGroup]
    if (!group) return
    await Promise.all(group.entries.map((entry) => this.loadBody(entry.file)))
  }

  /** Unreadable files degrade to a placeholder instead of failing the browser. */
  private async loadBody(file: string): Promise<string> {
    const cached = this.bodies.get(file)
    if (cached !== undefined) return cached
    let body: string
    try {
      body = stripYamlFrontmatter(await readFile(file, "utf8"))
    } catch {
      const name = file.replaceAll("\\", "/").split("/").pop() ?? file
      body = `(couldn't read ${name})`
    }
    this.bodies.set(file, body.replace(/\r\n/g, "\n"))
    return this.bodies.get(file)!
  }

  // ── layout ──────────────────────────────────────────────────────────────

  private get rows(): ListRow[] {
    const rows: ListRow[] = []
    // Two named sections, each drawn as its own rounded container so the
    // section headers never read like the worktree rules inside them.
    // `changes` opens the board: each checkout renders as a divider and its
    // local active changes hang beneath it — never a global deduplicated
    // list. The same change id landing in two checkouts is two entries (one
    // per section); an exact duplicate copy is noise and is collapsed. A full
    // blank line separates every worktree from the next so they read as
    // distinct blocks.
    if (this.view.board.worktrees.length > 0) {
      rows.push({ kind: "header", label: "changes" })
      const seen = new Set<string>()
      this.view.board.worktrees.forEach((worktree, worktreeIndex) => {
        if (worktreeIndex > 0) rows.push({ kind: "spacer" })
        rows.push({ kind: "worktree", worktree })
        for (const change of this.view.changes) {
          if (change.checkout !== worktree.path) continue
          const identity = `${change.id}\n${change.checkout}`
          if (seen.has(identity)) continue
          seen.add(identity)
          rows.push({ kind: "change", change })
        }
      })
      rows.push({ kind: "sectionEnd" })
    }
    // `specs` closes the board with the launch checkout's canonical specs,
    // opening immediately after the changes container — no gap row.
    if (this.view.specs.length > 0) {
      rows.push({ kind: "header", label: "specs" })
      for (const path of this.view.specs) rows.push({ kind: "spec", path })
      rows.push({ kind: "sectionEnd" })
    }
    // The final container claims the body's remaining height: blank rows
    // inside it (it is the last section, so they read as its own emptiness)
    // push its closing border down to the footer line.
    const deficit = this.listHeight() - rows.length
    if (deficit > 0 && rows[rows.length - 1]?.kind === "sectionEnd") {
      rows.splice(rows.length - 1, 0, ...Array.from({ length: deficit }, () => ({ kind: "spacer" as const })))
    }
    return rows
  }

  /** The Actions menu's borrowed root pane width — the reading pane reuses it at detail. */
  private detailsWidth() {
    return Math.max(34, Math.min(48, this.renderer.width - 64))
  }

  private bodyHeight() {
    // Footer (1) — the board has no header row.
    return Math.max(8, this.renderer.height - 1)
  }

  private listHeight() {
    // Borderless panel: the list's inner rows are its box height.
    return Math.max(3, this.bodyHeight())
  }

  private detailsHeight() {
    return Math.max(4, this.bodyHeight())
  }

  // Markdown re-wraps on resize but must not re-parse every frame.
  private docFor(source: string, width: number): StyledText[] {
    let doc = this.docs.get(source)
    if (!doc) {
      doc = parseMarkdown(source.split("\n"))
      this.docs.set(source, doc)
    }
    return renderMarkdownDoc(doc, width)
  }

  // ── rendering ───────────────────────────────────────────────────────────

  private render() {
    if (this.finished || this.renderer.isDestroyed || this.scene?.isClosed) return
    // The shell's 1-column padding on each edge is the board's only margin —
    // the section containers span it fully.
    const innerWidth = Math.max(40, this.renderer.width - 2)
    const detail = this.level === "detail"
    // The fullscreen reader replaces the footer and tab chrome with
    // its title bar (the details panel's border title) plus the full-width pane.
    const reader = detail && this.fullscreen
    this.footerBox.visible = !reader
    // The Actions menu overlays either level. At the root — where the details
    // panel no longer exists — it borrows the pane beside a narrowed list.
    const rootMenu = !detail && this.menuOpen
    const paneWidth = this.detailsWidth()
    const listWidth = Math.max(36, this.renderer.width - paneWidth - 7)

    if (detail) {
      // The reading pane is full width: the navigation list is hidden and the
      // details panel takes the whole body.
      this.listBox.visible = false
      this.detailsBox.visible = true
      this.detailsBox.width = "100%"
      this.detailsBox.height = "100%"
    } else {
      // Root is list-only: the navigation list fills the body. The details
      // panel reappears only while the Actions menu borrows it.
      this.listBox.visible = true
      this.listBox.width = rootMenu ? listWidth : "100%"
      this.listBox.height = "100%"
      this.detailsBox.visible = rootMenu
      this.detailsBox.width = paneWidth
      this.detailsBox.height = "100%"
    }

    this.listText.content = detail ? "" : this.listContent(rootMenu ? listWidth : innerWidth)
    this.detailsText.content = detail || rootMenu ? this.detailsContent(detail ? innerWidth : paneWidth - 4) : ""
    this.footerText.content = this.footerContent(innerWidth)
    // The close confirm modal overlays everything while it is armed.
    this.overlay.visible = Boolean(this.pendingClose)
    if (this.pendingClose) this.renderCloseConfirmModal(Math.max(44, this.renderer.width - 10))
    this.renderer.requestRender()
  }

  private listContent(width: number) {
    const rows = this.rows
    const visible = this.listHeight()
    if (this.selectedRow < this.scroll) this.scroll = this.selectedRow
    if (this.selectedRow >= this.scroll + visible) this.scroll = this.selectedRow - visible + 1

    // Container membership is positional: every row between a section header
    // and its closing rule rides inside the rounded container. Computed from
    // the full row list (not the visible slice) so a scrolled-off header still
    // wraps its rows.
    let inside = false
    const insideFlags = rows.map((row) => {
      if (row.kind === "header") inside = true
      else if (row.kind === "sectionEnd") inside = false
      return inside
    })

    const slice = rows.slice(this.scroll, this.scroll + visible)
    return joinLines(
      slice.map((row, offset) => {
        const absolute = this.scroll + offset
        const selected = absolute === this.selectedRow
        if (row.kind === "header") return this.sectionHeaderLine(row.label, width)
        if (row.kind === "sectionEnd") return this.sectionEndLine(width)
        if (insideFlags[absolute]) return this.containerRow(this.rowLine(row, selected, width - 4), width - 4)
        return this.rowLine(row, selected, width)
      }),
    )
  }

  /**
   * A section's top border: the label rides inside a rounded rule, accent-bold
   * so a section header never reads like the plain worktree rules beneath it.
   */
  private sectionHeaderLine(label: string, width: number): StyledText {
    const name = truncate(label, Math.max(4, width - 10))
    const fill = Math.max(1, width - name.length - 5)
    return new StyledText([fg(theme.dim)("╭─ "), bold(fg(theme.accent)(name)), fg(theme.dim)(` ${"─".repeat(fill)}╮`)])
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

  /**
   * One list row, speaking home's vocabulary: worktree sections render as
   * divider rules with their facts riding inside the rule (gray, quiet), and
   * the children — changes and specs — are the only selectable rows. The
   * selection is a full-width accent block hanging from an inverted marker in
   * the section's state color; nothing sits between a section and its
   * children but the rule itself.
   */
  private rowLine(row: ListRow, selected: boolean, width: number): StyledText {
    if (row.kind === "spacer") return new StyledText([raw("")])
    if (row.kind === "header") return this.dividerLine(row.label, width)
    if (row.kind === "worktree") {
      const worktree = row.worktree
      const name = worktreeDisplayName(worktree)
      const branchLabel = worktree.detached ? "detached" : (worktree.branch ?? "(no branch)")
      const facts: string[] = []
      // The branch is the rule's second fact — unless it merely restates the
      // checkout's name (`feat-add-foo` vs `feat/add-foo`), which reads as
      // stutter.
      if (name.replace(/[_/]/g, "-") !== branchLabel.replace(/[_/]/g, "-")) facts.push(branchLabel)
      const changes = this.view.changes.filter((entry) => entry.checkout === worktree.path)
      facts.push(changes.length > 0 ? `${changes.length} change${changes.length === 1 ? "" : "s"}` : "no changes")
      if (worktree.dirt?.kind === "known" && worktree.dirt.value.dirty) facts.push(`${worktree.dirt.value.fileCount} dirty`)
      if (worktree.activity?.kind === "known" && worktree.activity.value.total > 0) facts.push(`${worktree.activity.value.total} live`)
      if (!worktree.accessible) facts.push("inaccessible")
      return this.dividerLine(`${name} · ${facts.join(" · ")}`, width)
    }
    if (row.kind === "change") {
      const change = row.change
      // The marker rides the containing worktree's state color — the section
      // color its children hang from. Selected, it reads as a padded block
      // (glyph plus one cell either side), the home row's shape.
      const worktree = this.worktreeFor(change)
      const markerColor = worktree ? worktreeDotColor(worktree) : theme.accent
      // The marker rides the containing worktree's state color, one cell of
      // the same color on either side — so a selected row reads as a padded
      // three-cell block, the run-list checkbox's shape, rather than a lone
      // inverted diamond floating in the accent fill.
      const marker: TextChunk[] = selected
        ? [bg(markerColor)(" "), bg(markerColor)(fg(theme.chipText)("◆")), bg(markerColor)(" ")]
        : [raw(" "), fg(markerColor)("◆"), raw(" ")]
      const heading = change.title === change.id ? change.id : `${change.id} — ${change.title}`
      const title = truncate(heading, Math.max(12, width - 18))
      const counts = artifactCounts(change)
      const countText = counts === "—" ? "" : `  ${truncate(counts, Math.max(0, width - displayWidth(heading) - 8))}`
      // One column in from the container border, like every other child row;
      // a blank breathing column then separates the marker block from the
      // headline — on the selected row it rides the accent fill, so the block
      // reads as a marker followed by a blue square before the title.
      if (selected) {
        return this.highlighted([...marker, raw(" "), bold(fg(theme.chipText)(title)), fg(theme.chipText)(countText)], width)
      }
      return padBetween([...marker, raw(" "), fg(theme.text)(title)], [fg(theme.dim)(countText)], width)
    }
    if (row.kind === "sectionEnd") return this.sectionEndLine(width)
    // Canonical specs are stateless — already-integrated truth, not work in
    // any state — so they carry no state-coded diamond: a quiet gray bullet
    // riding one column in from the container border.
    const marker = selected ? fg(theme.chipText)("•") : fg(theme.dim)("•")
    const name = truncate(specDisplayPath(row.path), Math.max(12, width - 6))
    if (selected) {
      return this.highlighted([raw(" "), marker, raw(" "), bold(fg(theme.chipText)(name))], width)
    }
    return new StyledText([raw(" "), marker, raw(" "), fg(theme.dim)(name)])
  }

  /** A section divider: one dim rule with the label riding inside it. */
  private dividerLine(label: string, width: number): StyledText {
    // The label never pushes the rule past the pane's edge: it truncates
    // first, the rule keeps at least a stub so the divider still reads.
    const prefix = `── ${truncate(label, Math.max(4, width - 8))} `
    return new StyledText([fg(theme.dim)(prefix + "─".repeat(Math.max(0, width - prefix.length)))])
  }

  /**
   * The selected row's full-width accent block: every chunk rides the fill
   * unless it already carries its own background (the inverted marker cell),
   * and the filler reaches the pane's right edge.
   */
  private highlighted(chunks: TextChunk[], width: number): StyledText {
    const used = chunks.reduce((total, chunk) => total + displayWidth(typeof chunk === "string" ? chunk : (chunk as { text: string }).text), 0)
    const filler = bg(theme.accent)(fg(theme.chipText)(" ".repeat(Math.max(0, width - used))))
    const hasBg = (chunk: TextChunk) => typeof chunk !== "string" && (chunk as { bg?: unknown }).bg !== undefined
    return new StyledText(chunks.map((chunk) => (hasBg(chunk) ? chunk : bg(theme.accent)(chunk))).concat(filler))
  }

  /**
   * The reading pane. Its first content rows are the title row and — when the
   * subject spans more than one group — the tab strip; below them the active
   * tab's markdown scrolls. Single-group subjects render no strip at all.
   * The pane only exists at the detail level (or while the Actions menu
   * borrows it): the root list identifies its rows without a preview.
   */
  private detailsContent(width: number): StyledText {
    // The Actions menu overlays either level; the fullscreen reader never
    // shows it (its copy/close/tab keys are unchanged).
    if (this.menuOpen && !(this.level === "detail" && this.fullscreen)) return this.menuContent(width)
    if (this.level !== "detail") return plain("")

    const group = this.groups[this.selectedGroup]
    if (!group) {
      this.readerPosition = ""
      return plain("")
    }
    const subject = this.subject
    const name = subject?.kind === "change" ? (subject.change.title === subject.change.id ? subject.change.id : `${subject.change.id} — ${subject.change.title}`) : subject ? specDisplayPath(subject.path) : ""
    const loadingDivider = (): StyledText[] => {
      // The fullscreen reader folds its title bar into the divider rule:
      // group, copy status, and scroll position ride beside the name.
      if (this.fullscreen) {
        const status = this.copyStatus ? ` · ${copyStatusLabel(this.copyStatus)}` : ""
        return [this.dividerLine(`${name} · ${group.label.toLowerCase()} · c copy · v/esc close${status}${this.readerPosition ? ` · ${this.readerPosition}` : ""}`, width)]
      }
      return [this.dividerLine(name, width)]
    }

    // Sources that are still loading stay out of the pane so a pending read
    // doesn't flash the error placeholder; failures are written by loadBody.
    const source = specGroupSource(group, (file) => this.bodies.get(file) ?? "(loading…)")
    const known = group.entries.every((entry) => this.bodies.has(entry.file))
    const lines: StyledText[] = []
    if (!known && source.includes("(loading…)")) {
      this.readerPosition = this.fullscreen ? "all" : ""
      const blank: StyledText[] = []
      while (blank.length < this.detailsHeight() - 1) blank.push(plain(""))
      return joinLines(loadingDivider().concat(blank).slice(0, this.detailsHeight()))
    }
    const rendered = this.docFor(source, Math.max(20, width))
    const overhead = 1 + (this.groups.length > 1 && !this.fullscreen ? 2 : 0)
    const contentHeight = Math.max(1, this.detailsHeight() - overhead)
    const maxScroll = Math.max(0, rendered.length - contentHeight)
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll))
    this.readerPosition = this.fullscreen ? readerScrollPosition(this.detailScroll, maxScroll) : ""
    // The divider (and the tab strip) are built with the settled position so
    // the reader's title bar never runs a frame behind the content.
    lines.push(...loadingDivider())
    if (this.groups.length > 1 && !this.fullscreen) {
      lines.push(this.tabStrip(width))
      lines.push(plain(""))
    }
    const body = rendered.slice(this.detailScroll, this.detailScroll + contentHeight)
    lines.push(...body)
    while (lines.length < this.detailsHeight()) lines.push(plain(""))
    return joinLines(lines.slice(0, this.detailsHeight()))
  }

  /**
   * The reading pane's tab strip. The active tab is the same padded inverted
   * block the board's selected rows wear — one fill cell either side of the
   * label — so the group the reader is on reads as a chip rather than as
   * arbitrarily bolded text among its own siblings; the siblings stay quiet
   * (faint digit, dim label) so the eye lands on the fill, not on weight.
   * Digits keep their tab-jump meaning and ride inside the active chip, so
   * the affordance survives the highlight. The strip truncates within its
   * width: the active tab claims its budget first, siblings share the rest.
   */
  private tabStrip(width: number): StyledText {
    const usable = Math.max(8, width - 2)
    const active = this.groups[this.selectedGroup]!
    const activeDigit = ` ${this.selectedGroup + 1} `
    // The active chip claims its footprint first — separator, padded digit
    // cells, and label — so siblings can never crowd it off the strip. A
    // sibling that no longer fits drops into the `+N` marker (the footer's
    // position and the arrow keys still reach it) instead of wrapping the
    // strip into the body's line budget.
    const activeLabel = truncate(active.label, Math.max(1, usable - 10))
    let remaining = usable - activeDigit.length - activeLabel.length - 2
    const tabs: TextChunk[] = [raw(" ")]
    const dropped: string[] = []
    this.groups.forEach((candidate, index) => {
      const separator = index > 0 ? 2 : 0
      if (index === this.selectedGroup) {
        if (separator) tabs.push(raw("  "))
        tabs.push(bg(theme.accent)(fg(theme.chipText)(activeDigit)))
        tabs.push(bg(theme.accent)(bold(fg(theme.chipText)(activeLabel))))
        tabs.push(bg(theme.accent)(fg(theme.chipText)(" ")))
        return
      }
      const label = truncate(candidate.label, Math.max(1, remaining - separator - 2))
      const cost = separator + 2 + displayWidth(label)
      if (cost > remaining) {
        dropped.push(`${index + 1}`)
        return
      }
      remaining -= cost
      if (separator) tabs.push(raw("  "))
      tabs.push(fg(theme.faint)(`${index + 1}`))
      tabs.push(raw(" "))
      tabs.push(fg(theme.dim)(label))
    })
    if (dropped.length > 0) {
      const marker = ` +${dropped.length}`
      if (marker.length <= remaining) tabs.push(fg(theme.faint)(marker))
    }
    return new StyledText(tabs)
  }

  /** The Actions menu overlay: dispatchable entries plus blocked reasons/remediation. */
  private menuContent(width: number): StyledText {
    const worktree = this.menuTarget()
    const items = this.menuItems()
    if (this.menuIndex >= items.length) this.menuIndex = Math.max(0, items.length - 1)
    const lines: StyledText[] = []
    const title = worktree ? `Actions — ${worktreeDisplayName(worktree)}` : "Actions"
    lines.push(new StyledText([bold(fg(theme.accent)(` ${truncate(title, width)}`))]))
    lines.push(plain(""))
    items.forEach((item, index) => {
      const selected = index === this.menuIndex
      const marker = selected ? fg(theme.accent)("▸ ") : raw("  ")
      const label = truncate(item.action.label, Math.max(8, width - 4))
      if (item.dispatch && item.action.enabled) {
        lines.push(new StyledText([marker, selected ? bold(fg(theme.text)(label)) : fg(theme.text)(label)]))
      } else {
        lines.push(new StyledText([marker, fg(theme.dim)(`${label} — blocked`)]))
      }
      for (const blocker of item.action.blockers) {
        lines.push(new StyledText([raw("    "), fg(theme.yellow)(truncate(blocker, Math.max(8, width - 6)))]))
      }
      for (const remediation of item.action.remediation ?? []) {
        lines.push(new StyledText([raw("    "), fg(theme.dim)(truncate(remediation, Math.max(8, width - 6)))]))
      }
    })
    return joinLines(lines)
  }

  /** Only actions that are not universal navigation conventions get hints. */
  private footerContent(width: number) {
    // The close confirm modal owns the footer: only its two answers matter.
    if (this.pendingClose) {
      const hints: Hint[] = [
        { keys: "y", label: "close", priority: 2 },
        { keys: "n/esc", label: "cancel", priority: 1 },
      ]
      return hintsRow(hints, [], width, { style: "spaced", overflow: moreHintsMarker })
    }
    // The open menu owns the footer: it names what answers what.
    if (this.menuOpen) {
      const hints: Hint[] = [
        { keys: "↑↓", label: "move", priority: 1, style: "spaced" },
        { keys: "enter", label: "run", priority: 2, style: "spaced" },
        { keys: "esc", label: "back", priority: 3, style: "spaced" },
      ]
      return hintsRow(hints, [], width, { style: "spaced", overflow: moreHintsMarker })
    }
    // The discoverable action-menu entry is pinned (priority 0): footer
    // truncation may drop every other hint, but access to the menu — and
    // through it close review and its blockers — survives.
    const actionsHint: Hint = { keys: "!", label: "actions", priority: 0, style: "spaced" }
    if (this.level === "detail") {
      const subject = this.subject
      const hints: Hint[] = [
        actionsHint,
        ...(subject?.kind === "change"
          ? ([
              { keys: "a", label: "pply", priority: 2, style: "glued" },
              { keys: "i", label: "terate", priority: 5, style: "glued" },
            ] as Hint[])
          : []),
        { keys: "v", label: "full", priority: 3, style: "glued" },
        { keys: "esc", label: "back", priority: 4 },
        { keys: "q", label: this.scene ? "back" : "uit", priority: 1, style: this.scene ? undefined : "glued" },
      ]
      const position = `${this.selectedGroup + 1}/${Math.max(1, this.groups.length)}`
      return hintsRow(hints, [[fg(theme.faint)(position)]], width, { style: "spaced", overflow: moreHintsMarker })
    }

    const selected = this.rows[this.selectedRow]
    const canRead = isSelectableRow(selected)
    const change = this.selectedChange()
    const worktree = change ? this.worktreeFor(change) : undefined
    const hints: Hint[] = [
      actionsHint,
      ...(canRead ? ([{ keys: "enter", label: "read", priority: 2 }] as Hint[]) : []),
      ...(change
        ? ([
            { keys: "a", label: "pply", priority: 4, style: "glued" },
            { keys: "i", label: "terate", priority: 5, style: "glued" },
            ...(change.checkout === this.view.targetDir ? ([{ keys: "s", label: "pin out", priority: 6, style: "glued" }] as Hint[]) : []),
            ...(worktree?.branch ? ([{ keys: "c", label: "ontinue", priority: 6, style: "glued" }, { keys: "x", label: "close · y/n", priority: 7 }] as Hint[]) : []),
          ] as Hint[])
        : []),
      { keys: "r", label: "efresh", priority: 5, style: "glued" },
      { keys: "q", label: this.scene ? "back" : "uit", priority: 1, style: this.scene ? undefined : "glued" },
    ]
    const selectable = this.rows.filter(isSelectableRow).length
    const ordinal = this.rows.slice(0, this.selectedRow + 1).filter(isSelectableRow).length
    const right: TextChunk[] = [fg(theme.faint)(`${Math.max(1, ordinal)}/${selectable}`)]
    return hintsRow(hints, [right], width, { style: "spaced", overflow: moreHintsMarker })
  }

  private finish(resolution: SpecsResolution) {
    if (this.finished) return
    this.finished = true
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
    })
    box.add(text)
    return { box, text }
  }
}

/** Interactive specs browser: the worktree-rooted board — browse, read, apply, iterate, continue, close. */
export async function browseSpecsTui(view: SpecsView, route?: TuiRoute, resume?: SpecsBrowserResume): Promise<SpecsResolution> {
  if (route) {
    const scene = sceneForRoute(route, "convoy-specs-scene")!
    return new SpecsBrowser(route.session.renderer, view, copyReportToClipboard, scene, resume).result
  }
  // No backgroundColor yet: the palette is only chosen after the terminal
  // answers the background query, so a light terminal never flashes dark.
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
  })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new SpecsBrowser(renderer, view, copyReportToClipboard, undefined, resume).result
}

/**
 * A worktree row's dot color, speaking independent facts rather than a
 * lifecycle stage: live execution in green, dirt or a lock in yellow, and
 * everything else informational teal. Shared with Home's work list.
 */
export function worktreeDotColor(worktree: BoardWorktree): string {
  if (worktree.activity?.kind === "known" && worktree.activity.value.total > 0) return theme.green
  if ((worktree.dirt?.kind === "known" && worktree.dirt.value.dirty) || worktree.locked || !worktree.accessible) return theme.yellow
  return theme.teal
}

/** Same labels the run dashboard's fullscreen reader uses: `all` / `top` / `end` / `%`. */
function readerScrollPosition(offset: number, maxScroll: number): string {
  if (maxScroll <= 0) return "all"
  if (offset <= 0) return "top"
  if (offset >= maxScroll) return "end"
  return `${Math.round((offset / maxScroll) * 100)}%`
}

/** Path under `openspec/specs/`, whether the loader stored it relative or absolute. */
function specDisplayPath(path: string): string {
  const normalized = path.replaceAll("\\", "/")
  const marker = "/openspec/specs/"
  const at = normalized.indexOf(marker)
  if (at >= 0) return normalized.slice(at + marker.length)
  if (normalized.startsWith("openspec/specs/")) return normalized.slice("openspec/specs/".length)
  return normalized
}

function copyStatusLabel(status: ClipboardResult): string {
  switch (status) {
    case "copied-native":
      return "copied"
    case "copied-osc52":
      return "copied (osc52)"
    case "unsupported":
      return "no clipboard mechanism"
    case "transport-failed":
      return "clipboard failed"
  }
}

function artifactCounts(change: SpecsChangeEntry): string {
  const count = change.artifacts.length
  if (count === 0) return "—"
  return `${count} artifact${count === 1 ? "" : "s"}`
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
