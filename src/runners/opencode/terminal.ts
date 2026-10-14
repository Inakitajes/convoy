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
