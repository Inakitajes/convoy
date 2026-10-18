/**
 * The config screen: the configuration files that shape this project, whether
 * each one loads, and a key to open it in the operator's own editor. Convoy
 * does not edit YAML through forms; the editor is better at that, and a file
 * that stops parsing is reported here the moment the editor closes.
 */

import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg } from "@opentui/core"

import { createConfigFile, displayPath, editorArgv, listConfigFiles, type ConfigFileEntry } from "./config-files"
import { runForegroundChild } from "./terminal-host"
import { hintsRow, joinLines, paletteForTerminal, setTheme, terminalBackgroundHex, theme, truncate, type Hint } from "./tui-theme"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { CliRenderer, KeyEvent, TextChunk } from "@opentui/core"

export async function editConfigTui(options: { targetDir: string; route?: TuiRoute }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("convoy config needs an interactive terminal")
  }
  const entries = await listConfigFiles(options.targetDir)
  if (options.route) {
    const scene = sceneForRoute(options.route, "convoy-config-scene")!
    await new ConfigScreen(options.route.session.renderer, options.targetDir, entries, scene).result
    return
  }
  const renderer = await createCliRenderer({ screenMode: "alternate-screen", consoleMode: "console-overlay", exitOnCtrlC: false, targetFps: 12 })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  await new ConfigScreen(renderer, options.targetDir, entries).result
}

type Notice = { tone: "ok" | "error" | "info"; text: string }

/** Test seam: how the editor takes the terminal. */
export type ConfigScreenDeps = { runEditor: typeof runForegroundChild }

export class ConfigScreen {
  readonly result: Promise<void>
  private resolveResult!: () => void
  private finished = false
  private busy = false
  private selected = 0
  private notice?: Notice
  private readonly bodyText: TextRenderable
  private readonly footerText: TextRenderable

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.render()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    if (this.busy) return
    key.preventDefault()
    key.stopPropagation()
    if ((key.ctrl && key.name === "c") || key.raw === "\u0003") return this.finish("interrupt")
    if (key.name === "q" || key.name === "escape") return this.finish("back")
    if (key.name === "up" || key.name === "k") this.move(-1)
    else if (key.name === "down" || key.name === "j") this.move(1)
    else if (key.name === "return" || key.name === "linefeed" || key.name === "e") void this.open()
    else if (key.name === "r") void this.reload()
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly targetDir: string,
    private entries: ConfigFileEntry[],
    private readonly scene?: TuiScene,
    private readonly deps: ConfigScreenDeps = { runEditor: runForegroundChild },
  ) {
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })
    const shell = new BoxRenderable(renderer, { id: "convoy-config-shell", width: "100%", height: "100%", backgroundColor: theme.bg, flexDirection: "column", paddingX: 1 })
    const body = new BoxRenderable(renderer, {
      id: "convoy-config-body",
      width: "100%",
      flexGrow: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      backgroundColor: theme.bg,
      title: " convoy config ",
      titleAlignment: "left",
      paddingX: 2,
      paddingY: 1,
    })
    this.bodyText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%" })
    body.add(this.bodyText)
    const footer = new BoxRenderable(renderer, { id: "convoy-config-footer", width: "100%", height: 3, border: true, borderStyle: "rounded", borderColor: theme.borderDim, backgroundColor: theme.bg, paddingX: 1 })
    this.footerText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    footer.add(this.footerText)
    shell.add(body)
    shell.add(footer)
    ;(scene?.root ?? renderer.root).add(shell)
    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    this.render()
  }

  private move(delta: number) {
    this.selected = Math.max(0, Math.min(this.entries.length - 1, this.selected + delta))
    this.render()
  }

  private async reload(notice?: Notice) {
    const path = this.entries[this.selected]?.path
    this.entries = await listConfigFiles(this.targetDir)
    const index = this.entries.findIndex((entry) => entry.path === path)
    this.selected = index >= 0 ? index : Math.min(this.selected, this.entries.length - 1)
    this.notice = notice
    this.render()
  }

  /** Opens the selected file in the editor, creating a missing config from the template first. */
  private async open() {
    const entry = this.entries[this.selected]
    if (!entry) return
    this.busy = true
    try {
      if (!entry.exists) await createConfigFile(entry, this.targetDir)
      const argv = editorArgv(entry.path)
      const code = await this.deps.runEditor({ argv, cwd: this.targetDir, suspend: () => this.renderer.suspend(), resume: () => this.renderer.resume() })
      const after = (await listConfigFiles(this.targetDir)).find((candidate) => candidate.path === entry.path)
      const label = displayPath(entry.path)
      await this.reload(
        code !== 0
          ? { tone: "error", text: `${argv[0]} exited with code ${code}` }
          : after?.error
            ? { tone: "error", text: `${label} no longer loads: ${after.error}` }
            : { tone: "ok", text: entry.kind === "config" ? `${label} loads` : `saved ${label}` },
      )
    } catch (error) {
      this.notice = { tone: "error", text: error instanceof Error ? error.message : String(error) }
      this.render()
    } finally {
      this.busy = false
    }
  }

  private render() {
    if (this.finished || this.renderer.isDestroyed || this.scene?.isClosed) return
    const width = Math.max(20, this.renderer.width - 8)
    const lines: StyledText[] = []
    let scope: string | undefined
    for (const [index, entry] of this.entries.entries()) {
      if (entry.scope !== scope) {
        scope = entry.scope
        if (lines.length > 0) lines.push(new StyledText([]))
        lines.push(new StyledText([bold(fg(theme.dim)(entry.scope === "global" ? "GLOBAL · every project" : `PROJECT · ${displayPath(this.targetDir)}`))]))
      }
      lines.push(this.row(entry, index === this.selected, width))
    }
    const current = this.entries[this.selected]
    lines.push(new StyledText([]))
    if (current?.error) lines.push(new StyledText([fg(theme.red)(truncate(current.error, width * 3))]))
    if (this.notice) {
      const color = this.notice.tone === "ok" ? theme.green : this.notice.tone === "error" ? theme.red : theme.dim
      lines.push(new StyledText([fg(color)(truncate(this.notice.text, width * 3))]))
    }
    this.bodyText.content = joinLines(lines)
    const hints: Hint[] = [
      { keys: "↑/↓", label: "move", priority: 3, tone: "dim" },
      { keys: "enter", label: current?.exists === false ? "create and edit" : "open in editor", priority: 1 },
      { keys: "r", label: "efresh", priority: 4, style: "glued" },
      { keys: "q", label: this.scene ? "back" : "uit", priority: 2, style: this.scene ? undefined : "glued" },
    ]
    this.footerText.content = hintsRow(hints, [], Math.max(1, this.renderer.width - 6), { style: "spaced" })
    this.renderer.requestRender()
  }

  private row(entry: ConfigFileEntry, selected: boolean, width: number): StyledText {
    const marker: TextChunk = selected ? fg(theme.accent)("▸ ") : fg(theme.faint)("  ")
    const name = entry.kind === "config" ? "config" : `agent ${entry.name}`
    const state: TextChunk = !entry.exists
      ? fg(theme.faint)("not created")
      : entry.error
        ? fg(theme.red)("✗ doesn't load")
        : fg(theme.green)(entry.kind === "config" ? "✓ loads" : "✓")
    const nameText = (selected ? bold : (chunk: TextChunk) => chunk)(fg(selected ? theme.text : theme.dim)(name.padEnd(22)))
    const path = truncate(displayPath(entry.path), Math.max(10, width - 40))
    return new StyledText([marker, nameText, fg(theme.faint)(path.padEnd(Math.max(10, width - 40) + 2)), state])
  }

  private finish(cause: "back" | "interrupt") {
    if (this.finished) return
    this.finished = true
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    if (cause === "interrupt") this.scene?.requestInterrupt()
    if (!this.scene && !this.renderer.isDestroyed) this.renderer.destroy()
    this.resolveResult()
  }
}
