import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import pipelineCommandTemplate from "../skills/commands/pipeline.md" with { type: "text" }
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
 * Alongside it go the pipeline commands: `/convoy-review`, `/convoy-implement`,
 * and the rest of `pipelineCommands`, each a shortcut that runs one built-in
 * pipeline through the skill. Claude Code and Codex take them as user-invoked
 * skills (`disable-model-invocation`), OpenCode as global commands.
 *
 * Ownership follows `convoy opencode install`: a skill directory is Convoy's
 * when its SKILL.md carries the `convoy:skill` marker, a command when it carries
 * `convoy:command`. Only such a file is ever refreshed or removed; a `convoy`
 * skill or `convoy-review` command someone else wrote is left alone.
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

/** The marker every Convoy-written pipeline command carries. */
const commandMarker = "<!-- convoy:command -->"

const commandPrefix = "convoy-"

export type PipelineCommand = {
  pipeline: string
  /** What the pipeline does, for the command's description and first line. */
  summary: string
  /** How the command gets its prompt. */
  prompt: string
  /** The permission mode the launch uses. */
  permissions: string
  /** Whether the user confirms the plan before the launch. */
  launch: string
}

// A read-only pipeline has nothing worth escalating, so it runs unattended; a
// pipeline that writes code keeps the smart judge between it and the user.
const permissionsReadOnly =
  "Pass `--yolo`: the pipeline only reads the repository, so nothing it asks is worth stopping the user for. If the show output says `writes code` (a project pipeline replaced the built-in), pass `--smart` and confirm before launching instead; a mode the user asked for wins."
const permissionsWrites =
  "Pass `--smart`: a judge auto-allows safe requests and escalates risky ones. Use `--yolo` only when the user asks for it."
const launchReadOnly =
  "This pipeline only reads the repository and the user asked for it by name: launch without another round-trip, unless the plan shows something they wouldn't expect (a model, a cost, a checkout)."
const launchWrites =
  "This pipeline changes code. Confirm with the user first: the plan summary, where it runs (the current branch or a new worktree), and that it bills their providers."
const promptDefault =
  "The pipeline has a default prompt. Pass the request as `--prompt-file` (written to a scratch file) only when it adds focus or scope; with a change selected, the spec is the contract."
const promptTask =
  "With a change selected, the spec is the contract and the request, if any, is extra guidance. Without one, the request is the task: if it is empty, ask the user what to build before going on. Write the prompt to a scratch file for `--prompt-file`."

/** The built-in pipelines that get a `/convoy-<pipeline>` command. */
export const pipelineCommands: readonly PipelineCommand[] = [
  { pipeline: "review", summary: "findings plus a verified quality score for the current branch; it doesn't change code.", prompt: promptDefault, permissions: permissionsReadOnly, launch: launchReadOnly },
  { pipeline: "implement", summary: "implement a task, OpenSpec change, or Spec Kit feature, then audit it, with a one-page recap.", prompt: promptTask, permissions: permissionsWrites, launch: launchWrites },
  { pipeline: "full-cycle", summary: "implement, audit, and test a task, OpenSpec change, or Spec Kit feature, then score and fix it to 90/100.", prompt: promptTask, permissions: permissionsWrites, launch: launchWrites },
  { pipeline: "ship", summary: "sync the branch with its base, review it, fix the accepted findings, and reach 90/100.", prompt: promptDefault, permissions: permissionsWrites, launch: launchWrites },
  {
    pipeline: "fixer",
    summary: "prove supplied findings with regression tests, fix them, and verify.",
    prompt:
      "The prompt is the findings to fix: from the request, the files it names (attach them with `--file`), or the reports of a run the user points to. If there is nothing to fix, ask. Write the prompt to a scratch file for `--prompt-file`.",
    permissions: permissionsWrites,
    launch: launchWrites,
  },
  { pipeline: "hunter", summary: "a maximum-coverage audit of the branch across six tracks and five models; it doesn't change code.", prompt: promptDefault, permissions: permissionsReadOnly, launch: launchReadOnly },
]

export function commandName(command: PipelineCommand): string {
  return `${commandPrefix}${command.pipeline}`
}

/**
 * How a harness keeps its commands: Claude Code and Codex read user-invoked
 * skills from the skills directory, OpenCode reads `commands/` beside it.
 */
type CommandLayout = {
  dir: (skillsDir: string) => string
  /** The entry, relative to the commands directory, that holds one command. */
  entry: (name: string) => string
  /** The command file inside that entry. */
  file: (name: string) => string
  /** The command a directory entry holds, if it can hold one. */
  nameOf: (entry: string) => string | undefined
  frontmatter: (name: string, description: string) => string[]
}

const skillCommandLayout: CommandLayout = {
  dir: (skillsDir) => skillsDir,
  entry: (name) => name,
  file: (name) => join(name, "SKILL.md"),
  nameOf: (entry) => entry,
  frontmatter: (name, description) => [
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    `argument-hint: "[focus, task, or change id]"`,
    "disable-model-invocation: true",
  ],
}

const commandLayouts: Record<SkillTarget, CommandLayout> = {
  claude: skillCommandLayout,
  codex: skillCommandLayout,
  opencode: {
    dir: (skillsDir) => join(dirname(skillsDir), "commands"),
    entry: (name) => `${name}.md`,
    file: (name) => `${name}.md`,
    nameOf: (entry) => (entry.endsWith(".md") ? entry.slice(0, -".md".length) : undefined),
    frontmatter: (_name, description) => [`description: ${JSON.stringify(description)}`],
  },
}

export function commandsDirFor(target: SkillTarget, skillsDir: string): string {
  return commandLayouts[target].dir(skillsDir)
}

/** One command's file for one harness: its frontmatter, the marker, then the shared body. */
export function pipelineCommandText(target: SkillTarget, command: PipelineCommand): string {
  const description = `Run the Convoy ${command.pipeline} pipeline headless from this session: ${command.summary}`
  const frontmatter = commandLayouts[target].frontmatter(commandName(command), description)
  const body = pipelineCommandTemplate
    .replaceAll("{{pipeline}}", command.pipeline)
    .replaceAll("{{summary}}", command.summary)
    .replaceAll("{{prompt}}", command.prompt)
    .replaceAll("{{permissions}}", command.permissions)
    .replaceAll("{{launch}}", command.launch)
  return `---\n${frontmatter.join("\n")}\n---\n${commandMarker}\n\n${body}`
}

export type CommandInstallResult = {
  target: SkillTarget
  dir: string
  /** Command names, by what happened to each. */
  written: string[]
  current: string[]
  skipped: string[]
  removed: string[]
}

/** The Convoy-owned commands in a directory, by name, whatever pipelines they name. */
async function ownedCommands(layout: CommandLayout, dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const owned: string[] = []
  for (const entry of entries) {
    const name = entry.startsWith(commandPrefix) ? layout.nameOf(entry) : undefined
    if (name !== undefined && (await readIfExists(join(dir, layout.file(name))))?.includes(commandMarker)) owned.push(name)
  }
  return owned.sort()
}

/**
 * Installs or refreshes every pipeline command for one harness, and removes
 * Convoy-owned commands for pipelines the list no longer carries.
 */
export async function installCommands(target: SkillTarget, skillsDir = skillsDirFor(target)): Promise<CommandInstallResult> {
  const layout = commandLayouts[target]
  const dir = layout.dir(skillsDir)
  const result: CommandInstallResult = { target, dir, written: [], current: [], skipped: [], removed: [] }
  const names = new Set<string>()
  for (const command of pipelineCommands) {
    const name = commandName(command)
    names.add(name)
    const path = join(dir, layout.file(name))
    const text = pipelineCommandText(target, command)
    const existing = await readIfExists(path)
    if (existing !== undefined && !existing.includes(commandMarker)) result.skipped.push(name)
    else if (existing === text) result.current.push(name)
    else {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text, "utf8")
      result.written.push(name)
    }
  }
  for (const name of await ownedCommands(layout, dir)) {
    if (names.has(name)) continue
    await rm(join(dir, layout.entry(name)), { recursive: true, force: true })
    result.removed.push(name)
  }
  return result
}

/** Removes every Convoy-owned pipeline command for one harness. */
export async function uninstallCommands(target: SkillTarget, skillsDir = skillsDirFor(target)): Promise<CommandInstallResult> {
  const layout = commandLayouts[target]
  const dir = layout.dir(skillsDir)
  const result: CommandInstallResult = { target, dir, written: [], current: [], skipped: [], removed: [] }
  for (const name of await ownedCommands(layout, dir)) {
    await rm(join(dir, layout.entry(name)), { recursive: true, force: true })
    result.removed.push(name)
  }
  return result
}

export function describeCommandResult(result: CommandInstallResult): string[] {
  const label = targetLabels[result.target]
  const slash = (names: string[]) => names.map((name) => `/${name}`).join(", ")
  const lines: string[] = []
  const installed = [...result.written, ...result.current]
  if (installed.length > 0) {
    if (result.written.length === 0) lines.push(`${label}: the pipeline commands are already current at ${result.dir}`)
    else lines.push(`${label}: pipeline commands ${slash(installed)} → ${result.dir}`)
  }
  if (result.removed.length > 0) lines.push(`${label}: removed the commands ${slash(result.removed)} from ${result.dir}`)
  if (result.skipped.length > 0) {
    lines.push(`${label}: skipped ${slash(result.skipped)} — ${result.dir} holds commands of that name Convoy didn't write, so they were left untouched`)
  }
  return lines
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
    const commands = action === "install" ? await installCommands(target) : await uninstallCommands(target)
    if (commands.skipped.length > 0) code = 1
    for (const line of describeCommandResult(commands)) write(`${line}\n`)
  }
  if (action === "install" && code === 0) {
    write(
      `Start a new agent session and ask it to run a Convoy pipeline (it loads the skill on demand), or type a command: ${pipelineCommands.map((command) => `/${commandName(command)}`).join(", ")}.\n`,
    )
  }
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
                and the pipeline commands beside it, one per built-in pipeline
                (${pipelineCommands.map((command) => `/${commandName(command)}`).join(", ")}):
                  Claude Code, Codex  user-invoked skills in the same directory
                  OpenCode            ~/.config/opencode/commands/convoy-<pipeline>.md
                Without flags, every harness found on this machine. Re-run it after
                convoy update to refresh the skill; it is idempotent.
  uninstall     Remove the skill and the commands (without flags: from every harness).
  show [file]   Print the skill (SKILL.md, or ${Object.keys(skillFiles)
    .filter((file) => file !== "SKILL.md")
    .join(", ")}).

Convoy only refreshes or removes a skill or command it wrote; a convoy skill or
convoy-<pipeline> command you wrote yourself is left untouched.
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
