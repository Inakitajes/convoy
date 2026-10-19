import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import pipelineFilesReference from "../skills/convoy/references/pipeline-files.md" with { type: "text" }
import skillBody from "../skills/convoy/SKILL.md" with { type: "text" }

/**
 * `convoy skill`: installs the Convoy agent skill — the instructions that let
 * a Claude Code, OpenCode, or Codex session discover pipelines, compose one,
 * launch it detached, and monitor it with `convoy runs` — into each harness's
 * global skills directory. The files are embedded in the binary, so the
 * installed skill always describes the CLI that installed it; re-running the
 * install after `convoy update` refreshes it.
 *
 * Ownership follows `convoy opencode install`: a skill directory is Convoy's
 * when its SKILL.md carries the `convoy:skill` marker. Only such a directory is
 * ever refreshed or removed; a `convoy` skill someone else wrote is left alone.
 */

export const skillName = "convoy"

/** The marker every Convoy-written SKILL.md carries. */
const skillMarker = "<!-- convoy:skill -->"

/** Every file of the skill, by its path inside the skill directory. */
export const skillFiles: Readonly<Record<string, string>> = {
  "SKILL.md": skillBody,
  "references/pipeline-files.md": pipelineFilesReference,
}

export type SkillTarget = "claude" | "opencode" | "codex"

export const skillTargets: readonly SkillTarget[] = ["claude", "opencode", "codex"]

const targetLabels: Record<SkillTarget, string> = { claude: "Claude Code", opencode: "OpenCode", codex: "Codex" }

/** Each harness's global skills directory; the environment overrides match the harnesses' own. */
const skillDirResolvers: Record<SkillTarget, (env: NodeJS.ProcessEnv) => string> = {
  claude: (env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills"),
  opencode: (env) => join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "skills"),
  codex: (env) => join(env.CODEX_HOME || join(homedir(), ".codex"), "skills"),
}

export function skillsDirFor(target: SkillTarget, env: NodeJS.ProcessEnv = process.env): string {
  return skillDirResolvers[target](env)
}

/** The harness's config root: present means the harness has been used on this machine. */
function harnessHomeFor(target: SkillTarget, env: NodeJS.ProcessEnv): string {
  return dirname(skillsDirFor(target, env))
}

const harnessBinaries: Record<SkillTarget, string> = { claude: "claude", opencode: "opencode", codex: "codex" }

export type DetectDeps = {
  env: NodeJS.ProcessEnv
  exists: (path: string) => Promise<boolean>
  which: (binary: string) => string | null
}

const defaultDetectDeps: DetectDeps = {
  env: process.env,
  exists: async (path) => {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  },
  which: (binary) => Bun.which(binary),
}

/** The harnesses installed here: a config directory or a binary on PATH. */
export async function detectSkillTargets(deps: DetectDeps = defaultDetectDeps): Promise<SkillTarget[]> {
  const found: SkillTarget[] = []
  for (const target of skillTargets) {
    if ((await deps.exists(harnessHomeFor(target, deps.env))) || deps.which(harnessBinaries[target])) found.push(target)
  }
  return found
}

export type SkillInstallResult = {
  target: SkillTarget
  dir: string
  outcome: "installed" | "updated" | "current" | "skipped" | "removed" | "absent"
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

/** Whether every embedded file is already on disk, byte for byte. */
async function isCurrent(dir: string): Promise<boolean> {
  for (const [path, body] of Object.entries(skillFiles)) {
    if ((await readIfExists(join(dir, path))) !== body) return false
  }
  return true
}

/**
 * Installs or refreshes the skill for one harness. A refresh replaces the
 * whole directory, so a file the skill no longer ships doesn't linger.
 */
export async function installSkill(target: SkillTarget, skillsDir = skillsDirFor(target)): Promise<SkillInstallResult> {
  const dir = join(skillsDir, skillName)
  const existing = await readIfExists(join(dir, "SKILL.md"))
  if (existing !== undefined && !existing.includes(skillMarker)) return { target, dir, outcome: "skipped" }
  if (existing !== undefined && (await isCurrent(dir))) return { target, dir, outcome: "current" }
  if (existing !== undefined) await rm(dir, { recursive: true, force: true })
  for (const [path, body] of Object.entries(skillFiles)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), body, "utf8")
  }
  return { target, dir, outcome: existing === undefined ? "installed" : "updated" }
}

/** Removes the skill for one harness, only when Convoy wrote it. */
export async function uninstallSkill(target: SkillTarget, skillsDir = skillsDirFor(target)): Promise<SkillInstallResult> {
  const dir = join(skillsDir, skillName)
  const existing = await readIfExists(join(dir, "SKILL.md"))
  if (existing === undefined) return { target, dir, outcome: "absent" }
  if (!existing.includes(skillMarker)) return { target, dir, outcome: "skipped" }
  await rm(dir, { recursive: true, force: true })
  return { target, dir, outcome: "removed" }
}

export function describeSkillResult(result: SkillInstallResult): string {
  const label = targetLabels[result.target]
  switch (result.outcome) {
    case "installed":
      return `${label}: installed the convoy skill → ${result.dir}`
    case "updated":
      return `${label}: updated the convoy skill → ${result.dir}`
    case "current":
      return `${label}: the convoy skill is already current at ${result.dir}`
    case "skipped":
      return `${label}: skipped — ${result.dir} holds a convoy skill Convoy didn't write, so it was left untouched`
    case "removed":
      return `${label}: removed the convoy skill from ${result.dir}`
    case "absent":
      return `${label}: no convoy skill at ${result.dir}`
  }
}

/**
 * The `convoy skill install|uninstall` body. With no explicit targets,
 * install picks the harnesses found on this machine and uninstall cleans
 * every harness. Returns the exit code: 1 when a foreign skill was left in
 * place or there was nowhere to install, so a script can tell.
 */
export async function runSkillCommand(
  action: "install" | "uninstall",
  targets: SkillTarget[],
  write: (text: string) => void = (text) => process.stdout.write(text),
  detect: () => Promise<SkillTarget[]> = () => detectSkillTargets(),
): Promise<number> {
  let selected = targets
  if (selected.length === 0) {
    selected = action === "install" ? await detect() : [...skillTargets]
    if (selected.length === 0) {
      write("found no Claude Code, OpenCode, or Codex install; name one with --claude, --opencode, or --codex\n")
      return 1
    }
  }
  let code = 0
  for (const target of selected) {
    const result = action === "install" ? await installSkill(target) : await uninstallSkill(target)
    if (result.outcome === "skipped") code = 1
    write(`${describeSkillResult(result)}\n`)
  }
  if (action === "install" && code === 0) write("Start a new agent session and ask it to run a Convoy pipeline; it loads the skill on demand.\n")
  return code
}

/** `convoy skill show [file]`: one embedded file, SKILL.md by default. */
export function skillFileText(file = "SKILL.md"): string {
  const body = skillFiles[file]
  if (body === undefined) throw new Error(`no skill file "${file}" (files: ${Object.keys(skillFiles).join(", ")})`)
  return body.endsWith("\n") ? body : `${body}\n`
}

export function skillHelp(): string {
  return `convoy skill install [--claude] [--opencode] [--codex]
convoy skill uninstall [--claude] [--opencode] [--codex]
convoy skill show [<file>]

Install the Convoy agent skill, so a Claude Code, OpenCode, or Codex session can
discover pipelines, compose one for a task, launch it detached, and monitor it.

  install       Write the skill to each harness's global skills directory:
                  Claude Code  ~/.claude/skills/convoy        ($CLAUDE_CONFIG_DIR)
                  OpenCode     ~/.config/opencode/skills/convoy ($XDG_CONFIG_HOME)
                  Codex        ~/.codex/skills/convoy         ($CODEX_HOME)
                Without flags, every harness found on this machine. Re-run it after
                convoy update to refresh the skill; it is idempotent.
  uninstall     Remove the skill (without flags: from every harness).
  show [file]   Print the skill (SKILL.md, or ${Object.keys(skillFiles)
    .filter((file) => file !== "SKILL.md")
    .join(", ")}).

Convoy only refreshes or removes a skill directory it wrote; a convoy skill you
wrote yourself is left untouched.
`
}

export type SkillCliCommand =
  | { type: "help"; text: string }
  | { type: "skill"; action: "install" | "uninstall"; targets: SkillTarget[] }
  | { type: "skill-show"; file?: string }

/** Parses everything after `convoy skill`. */
export function parseSkillArgs(argv: string[]): SkillCliCommand {
  const [verb, ...rest] = argv
  if (verb === undefined || verb === "--help" || verb === "-h" || rest.includes("--help") || rest.includes("-h")) return { type: "help", text: skillHelp() }
  if (verb === "show") {
    if (rest.length > 1) throw new Error("usage: convoy skill show [<file>]")
    return { type: "skill-show", ...(rest[0] ? { file: rest[0] } : {}) }
  }
  if (verb !== "install" && verb !== "uninstall") throw new Error(`usage: convoy skill install|uninstall|show (unknown "${verb}")`)
  const targets: SkillTarget[] = []
  for (const arg of rest) {
    const target = arg.startsWith("--") ? (arg.slice(2) as SkillTarget) : undefined
    if (!target || !skillTargets.includes(target)) throw new Error(`unknown flag: ${arg} (--claude, --opencode, or --codex)`)
    if (!targets.includes(target)) targets.push(target)
  }
  return { type: "skill", action: verb, targets }
}
