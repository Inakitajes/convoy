/**
 * The configuration files that shape a project, for the config screen: which
 * exist, whether each parses, and how to open one in the operator's editor.
 * Convoy does not edit configuration itself; YAML in a real editor is clearer
 * than a form for every key.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { whichOnPath } from "./claude-code"
import { defaultConvoyConfig, parseConvoyConfig, projectConfigPath, writeDefaultGlobalConfig, writeDefaultProjectConfig, type ConvoyConfig, type FeatureToggles } from "./config"
import { convoyRoot, globalAgentsDir, globalConfigPath } from "./workspace"

export type ConfigFileScope = "global" | "project"

export type ConfigFileEntry = {
  scope: ConfigFileScope
  kind: "config" | "agent"
  /** What the row is called: "config" for the YAML, the agent name for a prompt. */
  name: string
  path: string
  exists: boolean
  /** Why the file does not load; absent when it parses (or does not exist). */
  error?: string
}

const configFileNames = ["config.yaml", "config.yml"] as const

/** The config file a scope actually loads: the first existing name, else the default one. */
async function configFileFor(scope: ConfigFileScope, targetDir: string): Promise<{ path: string; body?: string }> {
  const dir = scope === "global" ? join(convoyRoot(), ".convoy") : join(targetDir, ".convoy")
  for (const name of configFileNames) {
    const path = join(dir, name)
    const body = await readFile(path, "utf8").catch(() => undefined)
    if (body !== undefined) return { path, body }
  }
  return { path: scope === "global" ? globalConfigPath() : projectConfigPath(targetDir) }
}

/**
 * Validates like the loaders do, but never writes: the global loader migrates
 * pipeline names in place, which a read-only listing must not trigger.
 */
function validationError(scope: ConfigFileScope, path: string, body: string, targetDir: string): string | undefined {
  try {
    parseConvoyConfig(body, displayPath(path), scope === "global" ? convoyRoot() : targetDir)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function agentPrompts(scope: ConfigFileScope, dir: string): Promise<ConfigFileEntry[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ scope, kind: "agent" as const, name: name.slice(0, -".md".length), path: join(dir, name), exists: true }))
}

/** Global then project: each scope's config file (present or not), then its agent prompt overrides. */
export async function listConfigFiles(targetDir: string): Promise<ConfigFileEntry[]> {
  const entries: ConfigFileEntry[] = []
  for (const scope of ["global", "project"] as const) {
    const file = await configFileFor(scope, targetDir)
    const error = file.body === undefined ? undefined : validationError(scope, file.path, file.body, targetDir)
    entries.push({ scope, kind: "config", name: "config", path: file.path, exists: file.body !== undefined, ...(error ? { error } : {}) })
    entries.push(...(await agentPrompts(scope, scope === "global" ? globalAgentsDir() : join(targetDir, ".convoy", "agents"))))
  }
  return entries
}

/** Creates a missing config file from the commented template `convoy init` writes. */
export async function createConfigFile(entry: ConfigFileEntry, targetDir: string): Promise<void> {
  if (entry.kind !== "config") throw new Error("only config files can be created here; eject agent prompts with `convoy agents eject <agent>`")
  if (entry.scope === "global") await writeDefaultGlobalConfig()
  else await writeDefaultProjectConfig(targetDir)
}

/**
 * The editor command for a file: `$VISUAL`, then `$EDITOR` (split on spaces so
 * `code -w` works), then the first of nano, vim, and vi on PATH.
 */
export function editorArgv(path: string, env: NodeJS.ProcessEnv = process.env, which: (bin: string) => string | null = whichOnPath): string[] {
  for (const value of [env.VISUAL, env.EDITOR]) {
    const words = value?.trim().split(/\s+/).filter(Boolean) ?? []
    if (words.length > 0) return [...words, path]
  }
  const fallback = ["nano", "vim", "vi"].find((bin) => which(bin) !== null)
  if (!fallback) throw new Error("no editor found: set $EDITOR (for example `export EDITOR=nano`)")
  return [fallback, path]
}

/** `~`-relative for display. */
export function displayPath(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export type FeatureKey = keyof FeatureToggles

export type FeatureState = {
  key: FeatureKey
  enabled: boolean
  /** Which file decided it: the project wins over the global config, else the built-in default. */
  source: "default" | "global" | "project"
}

const featureKeys: readonly FeatureKey[] = ["worktrees", "specs"]

async function loadedScope(scope: ConfigFileScope, targetDir: string): Promise<ConvoyConfig | undefined> {
  const file = await configFileFor(scope, targetDir)
  if (file.body === undefined) return undefined
  try {
    return parseConvoyConfig(file.body, displayPath(file.path), scope === "global" ? convoyRoot() : targetDir)
  } catch {
    return undefined
  }
}

/** Each switch's effective value and where it comes from. A config that doesn't load contributes nothing. */
export async function featureStates(targetDir: string): Promise<FeatureState[]> {
  const [global, project] = await Promise.all([loadedScope("global", targetDir), loadedScope("project", targetDir)])
  return featureKeys.map((key) => {
    const fromProject = project?.features?.[key]
    if (fromProject !== undefined) return { key, enabled: fromProject, source: "project" }
    const fromGlobal = global?.features?.[key]
    if (fromGlobal !== undefined) return { key, enabled: fromGlobal, source: "global" }
    return { key, enabled: true, source: "default" }
  })
}

/**
 * Sets one switch in the project config, which wins over the global one. The
 * file is edited in place, so its comments and layout survive: the key's line
 * inside a top-level `features:` block is replaced or added, or the block is
 * appended. A missing file starts from the init template. The result must
 * load before anything is written.
 */
export async function setProjectFeature(targetDir: string, key: FeatureKey, enabled: boolean): Promise<string> {
  const file = await configFileFor("project", targetDir)
  const before = file.body ?? defaultConvoyConfig
  if (file.body !== undefined) {
    try {
      parseConvoyConfig(before, displayPath(file.path), targetDir)
    } catch (error) {
      throw new Error(`fix ${displayPath(file.path)} first: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const after = withFeature(before, key, enabled)
  parseConvoyConfig(after, displayPath(file.path), targetDir)
  await mkdir(dirname(file.path), { recursive: true })
  await writeFile(file.path, after)
  return file.path
}

/** The YAML text with `features.<key>` set, touching only that line or appending the block. */
export function withFeature(body: string, key: FeatureKey, enabled: boolean): string {
  const lines = body.split("\n")
  const value = `  ${key}: ${enabled}`
  const start = lines.findIndex((line) => /^features:\s*(#.*)?$/.test(line))
  if (start === -1) {
    if (lines.some((line) => /^features:/.test(line))) {
      throw new Error("features is written inline in this config; set it in your editor")
    }
    const trimmed = body.replace(/\n*$/, "")
    return `${trimmed}${trimmed ? "\n\n" : ""}features:\n${value}\n`
  }
  let end = start + 1
  while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!) || lines[end]!.startsWith("#"))) end++
  // Trailing blank or comment lines belong to whatever follows the block.
  while (end > start + 1 && !/^\s+\S/.test(lines[end - 1]!)) end--
  const existing = lines.slice(start + 1, end).findIndex((line) => new RegExp(`^\\s+${key}:`).test(line))
  if (existing !== -1) lines[start + 1 + existing] = value
  else lines.splice(end, 0, value)
  return lines.join("\n")
}
