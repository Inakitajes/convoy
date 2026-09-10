import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core"

import { hintsRow, joinLines, paletteForTerminal, raw, setTheme, terminalBackgroundHex, theme } from "./tui-theme"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { CliRenderer, KeyEvent } from "@opentui/core"

/**
 * A small change selector for the explicit-selection operations (archive).
 * `openspec archive` acts on one explicitly named change and never by
 * discovery, so the operator picks the change here before the guarded archive
 * runs. Selecting resolves with the change id; every other key cancels.
 */
export type ChangePickerResult = { kind: "select"; changeId: string } | { kind: "cancel" }

export function showChangePickerTui(
  route: TuiRoute,
  options: { title: string; changes: ReadonlyArray<{ changeId: string; title?: string }> },
): Promise<ChangePickerResult> {
  const scene = sceneForRoute(route, "convoy-change-picker-scene")!
  return new ChangePickerTui(route.session.renderer, scene, options).result
}

class ChangePickerTui {
  readonly result: Promise<ChangePickerResult>
  private resolveResult!: (result: ChangePickerResult) => void
  private finished = false
  private index = 0
  private readonly contentText: TextRenderable
  private readonly footerText: TextRenderable
  private readonly footerInnerWidth: number

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.render()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    const interrupted = (key.ctrl && key.name === "c") || key.raw === "\u0003"
    if (interrupted) {
      key.preventDefault()
      key.stopPropagation()
      this.scene.requestInterrupt()
      this.finish({ kind: "cancel" })
      return
    }
    key.preventDefault()
    key.stopPropagation()
    const count = Math.max(1, this.options.changes.length)
    switch (key.name) {
      case "up":
      case "k":
        this.index = (this.index - 1 + count) % count
        this.render()
        return
      case "down":
      case "j":
        this.index = (this.index + 1) % count
        this.render()
        return
      case "return":
      case "linefeed": {
        const change = this.options.changes[this.index]
        if (change) this.finish({ kind: "select", changeId: change.changeId })
        return
      }
      case "escape":
      case "q":
      case "n":
        this.finish({ kind: "cancel" })
        return
    }
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly scene: TuiScene,
    private readonly options: { title: string; changes: ReadonlyArray<{ changeId: string; title?: string }> },
  ) {
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })

    const shell = new BoxRenderable(renderer, {
      id: "convoy-change-picker-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
    })
    const boxWidth = Math.max(30, Math.min(renderer.width - 4, 96))
    this.footerInnerWidth = Math.max(1, boxWidth - 6)
    const content = new BoxRenderable(renderer, {
      id: "convoy-change-picker-content",
      width: "100%",
      flexGrow: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      backgroundColor: theme.bg,
      title: ` convoy ${options.title} `,
      titleAlignment: "left",
      paddingX: 2,
      paddingY: 1,
    })
    this.contentText = new TextRenderable(renderer, { content: "", fg: theme.text })
    content.add(this.contentText)
    const footer = new BoxRenderable(renderer, {
      id: "convoy-change-picker-footer",
      width: "100%",
      height: 3,
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      paddingX: 1,
    })
    this.footerText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    footer.add(this.footerText)
    shell.add(content)
    shell.add(footer)
    scene.root.add(shell)

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    this.render()
  }

  private render() {
    if (this.finished || this.renderer.isDestroyed || this.scene.isClosed) return
    const width = Math.max(24, Math.min(this.renderer.width - 8, 92))
    const lines: StyledText[] = []
    lines.push(new StyledText([fg(theme.dim)(`select one of ${this.options.changes.length} active change(s):`)]))
    lines.push(new StyledText([raw("")]))
    this.options.changes.forEach((change, index) => {
      const selected = index === this.index
      const marker = selected ? fg(theme.accent)("▸ ") : raw("  ")
      const label = change.title ? `${change.changeId}  ${change.title}` : change.changeId
      const text = label.length > width - 2 ? `${label.slice(0, Math.max(1, width - 3))}…` : label
      lines.push(new StyledText([marker, selected ? bold(fg(theme.chipText)(text)) : fg(theme.text)(text)]))
    })
    this.contentText.content = joinLines(lines)
    this.footerText.content = hintsRow(
      [
        { keys: "enter", label: "archive", priority: 2 },
        { keys: "esc", label: "cancel", priority: 1 },
      ],
      [],
      this.footerInnerWidth,
    )
    this.renderer.requestRender()
  }

  private finish(result: ChangePickerResult) {
    if (this.finished) return
    this.finished = true
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    this.resolveResult(result)
  }
}
