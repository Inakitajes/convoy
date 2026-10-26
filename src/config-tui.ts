/**
 * The config screen: the feature switches as toggles, then the configuration
 * files that shape this project, whether each one loads, and a key to open it
 * in the operator's own editor. Beyond the switches, Convoy does not edit YAML
 * through forms; the editor is better at that, and a file that stops parsing
 * is reported here the moment the editor closes.
 */

import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg } from "@opentui/core"

import { createConfigFile, displayPath, editorArgv, featureStates, listConfigFiles, setProjectFeature, type ConfigFileEntry, type FeatureState } from "./config-files"
import { runForegroundChild } from "./terminal-host"
import { specToolById, specToolIds, type SpecToolId } from "./spec-tools"
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

type Item = { kind: "feature"; state: FeatureState } | { kind: "file"; entry: ConfigFileEntry }

const featureLabels: Record<FeatureState["key"], string> = { worktrees: "Worktrees", specs: "Specs" }

const featureSources: Record<FeatureState["source"], string> = {
  default: "default",
  global: "from the global config",
  project: "set in this project",
}

/** Test seam: how the editor takes the terminal. */
export type ConfigScreenDeps = { runEditor: typeof runForegroundChild }

export class ConfigScreen {
  readonly result: Promise<void>
  private resolveResult!: () => void
  private finished = false
  private busy = false
  private selected = 0
  private notice?: Notice
  private features: FeatureState[] = []
  /** False until the switches first load: that load puts the selection on the first row. */
  private loaded = false
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
    else if (key.name === "space" || key.name === "return" || key.name === "linefeed" || key.name === "e") void this.activate(key.name)
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
    // The switches load after the first paint, landing the selection on the first of them.
    void this.reload()
  }

  /** The selectable rows in order: the feature switches, then the files. */
  private items(): Item[] {
    return [...this.features.map((state) => ({ kind: "feature" as const, state })), ...this.entries.map((entry) => ({ kind: "file" as const, entry }))]
  }

  private move(delta: number) {
    this.selected = Math.max(0, Math.min(this.items().length - 1, this.selected + delta))
    this.render()
  }

  private async reload(notice?: Notice) {
    const identity = (item: Item | undefined) => (item?.kind === "feature" ? `feature:${item.state.key}` : item ? `file:${item.entry.path}` : undefined)
    const current = identity(this.items()[this.selected])
    ;[this.features, this.entries] = await Promise.all([featureStates(this.targetDir), listConfigFiles(this.targetDir)])
    const index = this.items().findIndex((item) => identity(item) === current)
    this.selected = !this.loaded ? 0 : index >= 0 ? index : Math.min(this.selected, this.items().length - 1)
    this.loaded = true
    this.notice = notice
    this.render()
  }

  private async activate(key: string) {
    const item = this.items()[this.selected]
    if (item?.kind === "feature") await this.toggle(item.state)
    else if (item && key !== "space") await this.open(item.entry)
  }

  /** Worktrees toggle; specs cycle through tools and off. Project choices win. */
  private async toggle(state: FeatureState) {
    this.busy = true
    try {
      const specChoices: readonly (SpecToolId | false)[] = [...specToolIds, false]
      const selectedTool = typeof state.enabled === "string" ? state.enabled : false
      const next = state.key === "specs" ? specChoices[(specChoices.indexOf(selectedTool) + 1) % specChoices.length]! : !state.enabled
      const path = await setProjectFeature(this.targetDir, state.key, next)
      const shown = path.startsWith(`${this.targetDir}/`) ? path.slice(this.targetDir.length + 1) : displayPath(path)
      const label = typeof next === "string" ? specToolById(next).label : next ? "on" : "off"
      await this.reload({ tone: "ok", text: `${featureLabels[state.key]} ${label} · saved in ${shown}` })
    } catch (error) {
      this.notice = { tone: "error", text: error instanceof Error ? error.message : String(error) }
      this.render()
    } finally {
      this.busy = false
    }
  }

  /** Opens a file in the editor, creating a missing config from the template first. */
  private async open(entry: ConfigFileEntry) {
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
    const nameWidth = Math.max(...this.entries.map((entry) => entryName(entry).length), 9) + 2
    if (this.features.length > 0) {
      lines.push(new StyledText([bold(fg(theme.dim)("FEATURES")), fg(theme.faint)(" · saved in this project's config")]))
      for (const [index, state] of this.features.entries()) lines.push(this.featureRow(state, index === this.selected, nameWidth))
    }
    const offset = this.features.length
    let scope: string | undefined
    for (const [position, entry] of this.entries.entries()) {
      const index = offset + position
      if (entry.scope !== scope) {
        scope = entry.scope
        if (lines.length > 0) lines.push(new StyledText([]))
        lines.push(new StyledText([bold(fg(theme.dim)(entry.scope === "global" ? "GLOBAL · every project" : `PROJECT · ${displayPath(this.targetDir)}`))]))
      }
      lines.push(this.row(entry, index === this.selected, width, nameWidth))
    }
    const selectedItem = this.items()[this.selected]
    const current = selectedItem?.kind === "file" ? selectedItem.entry : undefined
    lines.push(new StyledText([]))
    if (current?.error) lines.push(new StyledText([fg(theme.red)(truncate(current.error, width * 3))]))
    if (this.notice) {
      const color = this.notice.tone === "ok" ? theme.green : this.notice.tone === "error" ? theme.red : theme.dim
      lines.push(new StyledText([fg(color)(truncate(this.notice.text, width * 3))]))
    }
    this.bodyText.content = joinLines(lines)
    const hints: Hint[] = [
      { keys: "↑/↓", label: "move", priority: 3, tone: "dim" },
      selectedItem?.kind === "feature"
        ? { keys: "space", label: "toggle", priority: 1 }
        : { keys: "enter", label: current?.exists === false ? "create and edit" : "open in editor", priority: 1 },
      { keys: "r", label: "efresh", priority: 4, style: "glued" },
      { keys: "q", label: this.scene ? "back" : "uit", priority: 2, style: this.scene ? undefined : "glued" },
    ]
    this.footerText.content = hintsRow(hints, [], Math.max(1, this.renderer.width - 6), { style: "spaced" })
    this.renderer.requestRender()
  }

  private featureRow(state: FeatureState, selected: boolean, nameWidth: number): StyledText {
    const marker: TextChunk = selected ? fg(theme.accent)("▸ ") : fg(theme.faint)("  ")
    const label = featureLabels[state.key]
    const name = (selected ? bold : (chunk: TextChunk) => chunk)(fg(selected ? theme.text : theme.dim)(label.padEnd(nameWidth)))
    const valueLabel = typeof state.enabled === "string" ? specToolById(state.enabled).label : "on"
    const value = state.enabled ? fg(theme.green)(`● ${valueLabel}`) : fg(theme.faint)("○ off")
    return new StyledText([marker, name, value, fg(theme.faint)(`   ${featureSources[state.source]}`)])
  }

  private row(entry: ConfigFileEntry, selected: boolean, width: number, nameWidth: number): StyledText {
    const marker: TextChunk = selected ? fg(theme.accent)("▸ ") : fg(theme.faint)("  ")
    const name = entryName(entry)
    const state: TextChunk = !entry.exists
      ? fg(theme.faint)("not created")
      : entry.error
        ? fg(theme.red)("✗ doesn't load")
        : fg(theme.green)(entry.kind === "config" ? "✓ loads" : "✓")
    const nameText = (selected ? bold : (chunk: TextChunk) => chunk)(fg(selected ? theme.text : theme.dim)(name.padEnd(nameWidth)))
    const pathWidth = Math.max(10, width - nameWidth - 20)
    // Project files read relative to the PROJECT heading that names the checkout.
    const shown = entry.scope === "project" && entry.path.startsWith(`${this.targetDir}/`) ? entry.path.slice(this.targetDir.length + 1) : displayPath(entry.path)
    return new StyledText([marker, nameText, fg(theme.faint)(truncate(shown, pathWidth).padEnd(pathWidth + 2)), state])
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

function entryName(entry: ConfigFileEntry): string {
  return entry.kind === "config" ? "config" : `agent ${entry.name}`
}
