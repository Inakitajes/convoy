/**
 * Credential-safe OpenCode v2 terminal invocation (change
 * `runner-parity-opencode-v2`, task 4.6 / 3.5).
 *
 * A terminal window connects to a run's owned v2 server. The per-boot password
 * is never placed in argv, the process list, or shell history: it is read from a
 * `0600` staged file by an `sh -c` wrapper that deletes the file before exec'ing
 * the client. Stored-session and iterate windows use `--standalone` so they stay
 * off the operator's background service.
 */

import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { openSessionCommand } from "../../terminal-host"

/** Minimal POSIX single-quote escaper. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export type V2TerminalRequest = {
  /** Directory the client opens (`opencode <dir>`). */
  directory: string
  /** Explicit server URL; omit for `--standalone`. */
  serverUrl?: string
  sessionId?: string
  continue?: boolean
  /** Run a private server instead of connecting to one. */
  standalone?: boolean
  /** Path to the staged `0600` password file (required with `serverUrl`). */
  passwordFile?: string
  /** Env var the client reads the password from. */
  passwordEnvVar?: string
  binary?: string
}

const defaultPasswordEnvVar = "OPENCODE_PASSWORD"
const defaultBinary = "opencode"

/** The argv for the client, excluding any credential handling. */
export function v2TerminalArgs(input: V2TerminalRequest): string[] {
  const args = [input.directory]
  if (input.standalone) args.push("--standalone")
  else if (input.serverUrl) args.push("--server", input.serverUrl)
  if (input.sessionId) args.push("--session", input.sessionId)
  else if (input.continue) args.push("--continue")
  return args
}

/**
 * Builds the shell command. When a `passwordFile` is given, the password is read
 * and the file removed inside the wrapper, so it never appears in argv.
 */
export function buildV2TerminalCommand(input: V2TerminalRequest): string {
  const binary = input.binary ?? defaultBinary
  const args = v2TerminalArgs(input).map(shellQuote).join(" ")

  if (input.serverUrl && input.passwordFile) {
    const envVar = input.passwordEnvVar ?? defaultPasswordEnvVar
    // $0 is the staged file; read it, remove it, then exec the client with the
    // password only in the child's environment.
    const script = `p=$(cat "$0") || exit 1; rm -f "$0"; exec env ${envVar}="$p" ${shellQuote(binary)} ${args}`
    return `sh -c ${shellQuote(script)} ${shellQuote(input.passwordFile)}`
  }

  return [binary, args].join(" ").trim()
}

/** Default file name (uniquified per call) for the one-shot staged password. */
export const stagedPasswordFilePrefix = "terminal-password"

/**
 * Stages a raw server password in a `0600` file inside a `0700` run-owned
 * directory. The shell wrapper reads the file and deletes it before exec'ing the
 * client, so the value never enters argv or the environment of any other
 * process. Callers pass a unique `fileName` per concurrent window so two
 * openers cannot consume each other's file.
 */
export async function stageV2PasswordFile(
  privateDir: string,
  password: string,
  fileName: string = `${stagedPasswordFilePrefix}-${randomUUID()}`,
): Promise<string> {
  await mkdir(privateDir, { recursive: true, mode: 0o700 })
  const path = join(privateDir, fileName)
  await writeFile(path, password, { mode: 0o600 })
  return path
}

/** Executes a built terminal command in a window or pane. Injected for tests. */
export type V2TerminalExec = (command: string, cwd: string, label: string) => Promise<unknown>

export type OpenV2TerminalDeps = {
  /** Window/pane seam. Defaults to terminal-host's `openSessionCommand`. */
  exec?: V2TerminalExec
  /** Test seam for password staging; defaults to {@link stageV2PasswordFile}. */
  stagePassword?: (privateDir: string, password: string) => Promise<string>
}

export type OpenV2TerminalInput = {
  /** Directory the client opens (`opencode <dir>`). */
  directory: string
  /** The owned server URL; omit for a `--standalone` stored/iterate window. */
  serverUrl?: string
  /** Per-boot password. Required with `serverUrl`; never placed in argv. */
  password?: string
  sessionId?: string
  continue?: boolean
  /** Force a private server instead of connecting to the owned one. */
  standalone?: boolean
  /** Run-owned directory the one-shot password file is staged in. */
  privateDir: string
  binary?: string
  passwordEnvVar?: string
}

async function defaultTerminalExec(command: string, cwd: string, label: string): Promise<unknown> {
  return await openSessionCommand(command, cwd, label)
}

/**
 * Opens a terminal for a run's owned v2 server. An exact-session window names
 * `--server`/`--session` and reads the staged password through the `sh -c`
 * wrapper; a stored/iterate window uses `--standalone` and stages nothing.
 * Returns after the window/pane backend has accepted the launch.
 */
export async function openV2Terminal(input: OpenV2TerminalInput, deps: OpenV2TerminalDeps = {}): Promise<void> {
  const exec = deps.exec ?? defaultTerminalExec

  if (input.standalone || !input.serverUrl) {
    const command = buildV2TerminalCommand({
      directory: input.directory,
      standalone: true,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.continue ? { continue: true } : {}),
      ...(input.binary ? { binary: input.binary } : {}),
    })
    await exec(command, input.directory, "opencode session")
    return
  }

  if (!input.password) {
    throw new Error("openV2Terminal: a server password is required for an exact-session window")
  }

  const stage = deps.stagePassword ?? stageV2PasswordFile
  const passwordFile = await stage(input.privateDir, input.password)
  const command = buildV2TerminalCommand({
    directory: input.directory,
    serverUrl: input.serverUrl,
    passwordFile,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.continue ? { continue: true } : {}),
    ...(input.binary ? { binary: input.binary } : {}),
    ...(input.passwordEnvVar ? { passwordEnvVar: input.passwordEnvVar } : {}),
  })
  try {
    await exec(command, input.directory, input.sessionId ? "opencode session" : "opencode interactive")
  } catch (error) {
    // The wrapper deletes the file before exec'ing the client; if it never ran,
    // the credential must not linger in the run directory.
    await rm(passwordFile, { force: true }).catch(() => {})
    throw error
  }
}
