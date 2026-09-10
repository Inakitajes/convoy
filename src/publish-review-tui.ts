import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core"

import { hintsRow, joinLines, paletteForTerminal, setTheme, terminalBackgroundHex, theme } from "./tui-theme"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"
import type { PublishPlan } from "./publish"

import type { CliRenderer, KeyEvent } from "@opentui/core"

/**
 * The Home `Create pull request` review gate. The action's composed title and
 * body are shown before any effect, the title is editable inline, and only an
 * explicit accept publishes — the same review contract the run dashboard's
 * finish screen already offers, so the two publication surfaces behave alike.
 */
export type PublishReviewResult = { kind: "publish"; title: string; text: string } | { kind: "cancel" }

export function showPublishReviewTui(
  route: TuiRoute,
  options: { plan: PublishPlan; title: string; text: string },
): Promise<PublishReviewResult> {
  const scene = sceneForRoute(route, "convoy-publish-review-scene")!
  return new PublishReviewTui(route.session.renderer, scene, options).result
}

/** Soft-wraps each logical line to `width` columns, preferring word boundaries. */
function wrapLine(text: string, width: number): string[] {
  if (width <= 1) return text.split("\n")
  const lines: string[] = []
  for (const logical of text.split("\n")) {
    if (logical.length <= width) {
      lines.push(logical)
      continue
    }
    let rest = logical
    while (rest.length > width) {
      const boundary = rest.lastIndexOf(" ", width)
      const cut = boundary > 0 ? boundary : width
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^\s+/, "")
    }
    lines.push(rest)
  }
  return lines
}

/** The single printable character a key event carries, or undefined for control/special keys. */
function typedCharacter(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta || key.option || key.super || key.hyper) return undefined
  const raw = key.raw ?? ""
  return [...raw].length === 1 && raw >= " " && raw !== "\u007f" ? raw : undefined
}

class PublishReviewTui {
  readonly result: Promise<PublishReviewResult>
  private resolveResult!: (result: PublishReviewResult) => void
  private finished = false
  private title: string
  private cursor: number
  private editing = false
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

    if (this.editing) {
      if (key.name === "return" || key.name === "linefeed" || key.name === "escape") {
        this.editing = false
        this.cursor = this.title.length
      } else if (key.name === "left") {
        this.cursor = Math.max(0, this.cursor - 1)
      } else if (key.name === "right") {
        this.cursor = Math.min(this.title.length, this.cursor + 1)
      } else if (key.name === "backspace") {
        this.title = this.title.slice(0, Math.max(0, this.cursor - 1)) + this.title.slice(this.cursor)
        this.cursor = Math.max(0, this.cursor - 1)
      } else {
        const ch = typedCharacter(key)
        if (ch !== undefined) {
          this.title = this.title.slice(0, this.cursor) + ch + this.title.slice(this.cursor)
          this.cursor += 1
        }
      }
      this.render()
      return
    }

    // Only an explicit accept publishes; every other key cancels, so a stray
    // keystroke never pushes or opens a PR.
    if (key.name === "y" || key.name === "return" || key.name === "linefeed") {
      this.finish({ kind: "publish", title: this.title, text: this.options.text })
      return
    }
    if (key.name === "e") {
      this.editing = true
      this.cursor = this.title.length
      this.render()
      return
    }
    if (key.name === "n" || key.name === "escape" || key.name === "q") {
      this.finish({ kind: "cancel" })
    }
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly scene: TuiScene,
    private readonly options: { plan: PublishPlan; title: string; text: string },
  ) {
    this.title = options.title
    this.cursor = options.title.length
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })

    const shell = new BoxRenderable(renderer, {
      id: "convoy-publish-review-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
    })
    const boxWidth = Math.max(30, Math.min(renderer.width - 4, 96))
    this.footerInnerWidth = Math.max(1, boxWidth - 6)
    const content = new BoxRenderable(renderer, {
      id: "convoy-publish-review-content",
      width: "100%",
      flexGrow: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      backgroundColor: theme.bg,
      title: " ⇪ create pull request ",
      titleAlignment: "left",
      paddingX: 2,
      paddingY: 1,
    })
    this.contentText = new TextRenderable(renderer, { content: "", fg: theme.text })
    content.add(this.contentText)
    const footer = new BoxRenderable(renderer, {
      id: "convoy-publish-review-footer",
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
    const { plan } = this.options
    const lines: StyledText[] = []
    lines.push(
      new StyledText([
        fg(theme.text)(`push ${plan.branch} to ${plan.remote}/${plan.branch} and open a pull request onto ${plan.base}`),
      ]),
    )
    lines.push(new StyledText([fg(theme.dim)("normal push (never forced). Review the title and body below before publishing.")]))
    lines.push(new StyledText([fg(theme.faint)("")]))
    if (this.editing) {
      lines.push(new StyledText([fg(theme.accent)("title │")]))
      lines.push(new StyledText([fg(theme.text)(this.title.slice(0, this.cursor)), fg(theme.accent)("▏"), fg(theme.text)(this.title.slice(this.cursor))]))
    } else {
      lines.push(new StyledText([fg(theme.accent)("title│ "), fg(theme.text)(this.title || "—")]))
    }
    lines.push(new StyledText([fg(theme.faint)("")]))
    for (const line of wrapLine(this.options.text, width)) lines.push(new StyledText([fg(theme.faint)(line)]))
    this.contentText.content = joinLines(lines)

    this.footerText.content = hintsRow(
      this.editing
        ? [
            { keys: "enter", label: "accept title", priority: 2 },
            { keys: "esc", label: "keep reviewed title", priority: 1 },
          ]
        : [
            { keys: "y", label: "create pull request", priority: 3 },
            { keys: "e", label: "edit title", priority: 2 },
            { keys: "n/esc", label: "cancel", priority: 1 },
          ],
      [],
      this.footerInnerWidth,
    )
    this.renderer.requestRender()
  }

  private finish(result: PublishReviewResult) {
    if (this.finished) return
    this.finished = true
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    this.resolveResult(result)
  }
}
