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

class RemovalConfirmTui {
  readonly result: Promise<RemovalChoice>
  private resolveResult!: (choice: RemovalChoice) => void
  private finished = false
  private readonly contentText: TextRenderable
  private readonly footerText: TextRenderable

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

    const shell = new BoxRenderable(renderer, {
      id: "convoy-removal-confirm-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
    })
    const content = new BoxRenderable(renderer, {
      id: "convoy-removal-confirm-content",
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
      alignItems: "center",
      justifyContent: "center",
    })
    this.contentText = new TextRenderable(renderer, { content: "", fg: theme.text })
    content.add(this.contentText)
    const footer = new BoxRenderable(renderer, {
      id: "convoy-removal-confirm-footer",
      width: "100%",
      height: 3,
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
    this.contentText.content = new StyledText([bold(fg(theme.text)(this.options.message))])
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
    this.footerText.content = hintsRow(hints, [], Math.max(1, this.renderer.width - 6))
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
