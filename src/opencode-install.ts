import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { stdout } from "node:process"

import { log } from "./log"

/**
 * The reborn `opencode-install`: exactly one file (design D8), opt-in via the
 * explicit `convoy opencode install` — no path through spin or config save
 * writes into the operator's global config implicitly. Convoy writes a single
 * global OpenCode command — `~/.config/opencode/commands/convoy-spin.md` —
 * whose template tells the agent to run `convoy spin` and relay its output.
 * The `convoy-` prefix keeps the `/convoy-spin` command from colliding with an
 * operator-authored `/spin`. No plugin, no bin shim, no per-repo artifacts;
 * the old install's scope was its failure. Idempotent, versioned, and touches
 * nothing it does not own.
 */

/** Bumped when the template changes so a re-install refreshes stale copies. */
const spinCommandVersion = 2

/** The marker line identifying the file as convoy-owned and versioned. */
const spinCommandMarker = `<!-- convoy:spin v${spinCommandVersion} -->`

/** Marker family: any convoy-owned copy carries this regardless of version. */
const spinCommandMarkerFamily = "convoy:spin"

const spinCommandBody = `${spinCommandMarker}
---
description: Spin the current change of the configured spec tool into an isolated worktree
---

Run \`convoy spin\` in the repository with the shell and report its output verbatim.
Convoy uses the configured spec tool (OpenSpec or Spec Kit).

Do not run git commands yourself, do not infer or name branches, and do not create
worktrees — convoy owns all of that. If the output lists several changes to pick
from, ask me which one and run \`convoy spin --change <id>\`. If it reports a
refusal (dirty tree, no change), relay the message as-is.`

/** The absolute path of the command file Convoy owns, given the commands dir. */
export function spinCommandPath(commandsDir?: string): string {
  return join(commandsDir ?? defaultOpencodeCommandsDir(), "convoy-spin.md")
}

function defaultOpencodeCommandsDir(): string {
  // Relocatable for tests and exotic setups; production resolves to the
  // user's global OpenCode config.
  return process.env.CONVOY_OPENCODE_COMMANDS_DIR || join(homedir(), ".config", "opencode", "commands")
}

export type SpinCommandInstall = {
  path: string
  /** true = written/refreshed; false = already current, nothing written. */
  updated: boolean
  /**
   * true when `convoy-spin.md` exists at the install path without the convoy
   * marker (an operator-authored command) and was deliberately left untouched.
   */
  skipped?: boolean
  /** The pre-rename command file (`spin.md`), removed when convoy-owned. */
  legacyPath?: string
  /** true when a convoy-owned legacy `spin.md` was removed by this install. */
  legacyRemoved?: boolean
}

/**
 * Installs or refreshes the global `/convoy-spin` command. Only
 * `convoy-spin.md` is ever written; any other command file in the directory
 * is never read-modified-or-deleted. A missing file, a stale convoy version,
 * or an edited copy that still carries the convoy marker is refreshed to the
 * current template — the file is convoy-owned once it carries the marker. A
 * file present *without* the marker is the operator's own command: it is
 * never overwritten (SC-3), the install backs off with a warning, and
 * `/convoy-spin` stays whatever the operator wrote. A legacy convoy-owned
 * `spin.md` (the pre-rename name) is removed as part of the migration; an
 * operator-authored `spin.md` is left alone — it is no longer convoy's name.
 */
export async function installSpinCommand(commandsDir?: string): Promise<SpinCommandInstall> {
  const dir = commandsDir ?? defaultOpencodeCommandsDir()
  const path = spinCommandPath(dir)
  await mkdir(dir, { recursive: true })

  let current: string | undefined
  try {
    current = await readFile(path, "utf8")
  } catch {
    // First install.
  }
  if (current !== undefined) {
    // Any prior convoy-owned file carries the `convoy:spin` marker regardless
    // of its version number, so a stale copy is recognized (and refreshed) even
    // when its version tag differs from the current one.
    if (current.includes(spinCommandMarkerFamily)) {
      // Already owned and current. A stale copy (older version) is refreshed
      // below; anything else in the directory stays byte-identical to before.
      if (current === spinCommandBody) {
        const legacy = await removeLegacySpinCommand(dir)
        return { path, updated: false, ...legacy }
      }
    } else {
      // An operator-authored conv-spin.md. Never clobber their file; when
      // backing off, nothing else in the directory is touched either.
      log.warn(
        `opencode-install: ${path} exists without the convoy marker — leaving the operator's command untouched and skipping the /convoy-spin install`,
      )
      return { path, updated: false, skipped: true }
    }
  }

  await writeFile(path, spinCommandBody, "utf8")
  log.info(`opencode-install: wrote ${path}`)
  const legacy = await removeLegacySpinCommand(dir)
  return { path, updated: true, ...legacy }
}

/**
 * The migration half of the rename: a `spin.md` carrying the convoy marker is
 * a leftover of the pre-rename install (a stale duplicate of
 * `/convoy-spin`), so it is removed. A `spin.md` without the marker is the
 * operator's own command under a name convoy no longer claims — untouched.
 */
async function removeLegacySpinCommand(dir: string): Promise<Pick<SpinCommandInstall, "legacyPath" | "legacyRemoved">> {
  const legacyPath = join(dir, "spin.md")
  let body: string | undefined
  try {
    body = await readFile(legacyPath, "utf8")
  } catch {
    return {}
  }
  if (!body.includes(spinCommandMarkerFamily)) return {}
  await rm(legacyPath, { force: true })
  log.info(`opencode-install: removed the legacy convoy-owned ${legacyPath}`)
  return { legacyPath, legacyRemoved: true }
}

/** Diagnostics for tests: the command file names Convoy leaves untouched. */
export async function listCommandFiles(commandsDir: string): Promise<string[]> {
  try {
    return (await readdir(commandsDir)).sort()
  } catch {
    return []
  }
}

export function opencodeInstallHelp(): string {
  return `convoy opencode install

Install the global /convoy-spin OpenCode command: a thin wrapper at
~/.config/opencode/commands/convoy-spin.md that tells the agent in the current
session to run \`convoy spin\` and relay its output — nothing else, no plugin.

Opt-in and idempotent: nothing installs this behind your back (spin never
touches your global config), and re-running refreshes a stale template. A
convoy-spin.md without the convoy marker is treated as yours and never
overwritten. A legacy convoy-owned spin.md is removed as part of the rename;
a spin.md you wrote yourself is left alone.
`
}

/**
 * The `convoy opencode install` command body: install, then report what
 * happened. A foreign conv-spin.md is a soft failure (exit code 1) so a
 * scripted install can tell it apart from success.
 */
export async function runOpencodeInstallCommand(): Promise<void> {
  const result = await installSpinCommand()
  if (result.skipped) {
    stdout.write(
      `skipped: ${result.path} exists without the convoy marker — it looks operator-owned; remove or rename it and run \`convoy opencode install\` again\n`,
    )
    process.exitCode = 1
    return
  }
  stdout.write(result.updated ? `installed /convoy-spin → ${result.path}\n` : `/convoy-spin already current at ${result.path}\n`)
  if (result.legacyRemoved && result.legacyPath) {
    stdout.write(`removed the legacy /spin command → ${result.legacyPath}\n`)
  }
}
