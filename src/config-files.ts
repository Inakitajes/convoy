/**
 * The configuration files that shape a project, for the config screen: which
 * exist, whether each parses, and how to open one in the operator's editor.
 * Convoy does not edit configuration itself; YAML in a real editor is clearer
 * than a form for every key.
 */

import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { whichOnPath } from "./claude-code"
import { parseConvoyConfig, projectConfigPath, writeDefaultGlobalConfig, writeDefaultProjectConfig } from "./config"
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
