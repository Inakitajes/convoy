import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core"

import { hintsRow, paletteForTerminal, setTheme, terminalBackgroundHex, theme } from "./tui-theme"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { CliRenderer, KeyEvent } from "@opentui/core"

/** What the operator decided in the removal dialog. */
export type RemovalChoice = "confirm" | "force" | "cancel"

/**
 * The worktree-removal launch dialog (delta spec worktree-operations):
 * ordinary removal is confirmed at launch naming the checkout and its
 * branch-retention outcome; a blocked removal shows every blocker and offers
 * an explicit force path (as a separate deliberate confirmation) only when the
 * blockers are all content — the main checkout, the process's own checkout, a
 * locked/unverified registration, and unknown state never offer force.
 */
export function showRemovalConfirmTui(
  route: TuiRoute,
  options: {
    title: string
    message: string
    mode: "confirm" | "blocked"
    /** Offer force removal in the blocked dialog (only content blockers). */
    forceAvailable?: boolean
  },
): Promise<RemovalChoice> {
  const scene = sceneForRoute(route, "convoy-removal-confirm-scene")!
  return new RemovalConfirmTui(route.session.renderer, scene, options).result
}

/**
 * Word-wraps a dialog message to `width` columns, preserving the author's
 * blank lines and leading indentation (blocker bodies indent remediations),
 * with continuation lines hanging under the text: a "- reason" line wraps
 * aligned to its reason, and an indented remediation keeps its indent.
 */
function wrapMessage(message: string, width: number): string[] {
  const lines: string[] = []
  for (const logical of message.split("\n")) {
    if (logical.length <= width) {
      lines.push(logical)
      continue
    }
    const lead = /^ */.exec(logical)?.[0] ?? ""
    const body = logical.slice(lead.length)
    const hang = body.startsWith("- ") ? `${lead}  ` : lead
    const inner = Math.max(8, width - hang.length)
    let current = ""
    let first = true
    const lineLen = () => (first ? lead.length : 0) + current.length
    for (const word of body.split(" ")) {
      let piece = word
      const budget = first ? width : inner
      // A token wider than the remaining space (a long path) hard-breaks.
      while (piece.length > budget - lineLen() - (current === "" ? 0 : 1)) {
        if (current !== "") {
          lines.push((first ? lead : hang) + current)
          current = ""
          first = false
        } else {
          const room = Math.max(1, (first ? width - lead.length : inner))
          lines.push((first ? lead : hang) + piece.slice(0, room))
          piece = piece.slice(room)
          first = false
        }
      }
      const activeBudget = first ? width : inner
      if (current === "") current = piece
      else if (lineLen() + 1 + piece.length <= activeBudget) current += ` ${piece}`
      else {
        lines.push((first ? lead : hang) + current)
        first = false
        current = piece
      }
    }
    lines.push((first ? lead : hang) + current)
  }
  return lines
}

class RemovalConfirmTui {
  readonly result: Promise<RemovalChoice>
  private resolveResult!: (choice: RemovalChoice) => void
  private finished = false
  private readonly contentText: TextRenderable
  private readonly footerText: TextRenderable
  /** Inner column count available to the hint bar (footer minus padding/border). */
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
      this.finish("cancel")
      return
    }
    if (this.options.mode === "confirm") {
      if (key.name === "y" || key.name === "return" || key.name === "linefeed") {
        key.preventDefault()
        key.stopPropagation()
        this.finish("confirm")
        return
      }
    } else if (this.options.forceAvailable) {
      if (key.name === "f" || key.name === "return" || key.name === "linefeed") {
        key.preventDefault()
        key.stopPropagation()
        this.finish("force")
        return
      }
    }
    if (key.name === "n" || key.name === "escape" || key.name === "q") {
      key.preventDefault()
      key.stopPropagation()
      this.finish("cancel")
    }
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly scene: TuiScene,
    private readonly options: { title: string; message: string; mode: "confirm" | "blocked"; forceAvailable?: boolean },
  ) {
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })

    // A compact dialog, not a full-screen panel: the box hugs its wrapped
    // message and floats centered, with the hint bar attached right below it.
    const wrapped = wrapMessage(options.message, Math.max(24, this.renderer.width - 10))
    const boxWidth = Math.min(
      this.renderer.width - 4,
      Math.max(...wrapped.map((line) => line.length)) + 6, // paddingX 2 per side + border
    )
    this.footerInnerWidth = Math.max(1, boxWidth - 4) // paddingX 1 per side + border
    const shell = new BoxRenderable(renderer, {
      id: "convoy-removal-confirm-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      alignItems: "center",
    })
    const above = new BoxRenderable(renderer, { id: "convoy-removal-confirm-space-above", flexGrow: 1 })
    const content = new BoxRenderable(renderer, {
      id: "convoy-removal-confirm-content",
      width: boxWidth,
      flexShrink: 0,
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
      id: "convoy-removal-confirm-footer",
      width: boxWidth,
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
    const below = new BoxRenderable(renderer, { id: "convoy-removal-confirm-space-below", flexGrow: 1 })
    shell.add(above)
    shell.add(content)
    shell.add(footer)
    shell.add(below)
    scene.root.add(shell)

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    this.render()
  }

  private render() {
    if (this.finished || this.renderer.isDestroyed || this.scene.isClosed) return
    this.contentText.content = new StyledText([
      bold(fg(theme.text)(wrapMessage(this.options.message, Math.max(24, this.renderer.width - 10)).join("\n"))),
    ])
    const hints =
      this.options.mode === "confirm"
        ? [
            { keys: "y", label: "remove", priority: 2 },
            { keys: "n/esc", label: "cancel", priority: 1 },
          ]
        : this.options.forceAvailable
          ? [
              { keys: "f", label: "force remove", priority: 2 },
              { keys: "n/esc", label: "cancel", priority: 1 },
            ]
          : [{ keys: "q", label: "back", priority: 1 }]
    this.footerText.content = hintsRow(hints, [], this.footerInnerWidth)
    this.renderer.requestRender()
  }

  private finish(choice: RemovalChoice) {
    if (this.finished) return
    this.finished = true
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    this.resolveResult(choice)
  }
}
