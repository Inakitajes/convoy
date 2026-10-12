/**
 * Local OpenCode runtime compatibility gate (change `migrate-opencode-v2`,
 * spec "Runtime compatibility is explicit and non-destructive").
 *
 * Convoy talks to the operator's locally resolved `opencode` executable. V2
 * changed the server/client/plugin contracts, so before any model work or
 * repository-mutating hook Convoy verifies that the resolved runtime is a
 * supported V2. A missing, V1 or otherwise unsupported runtime fails with an
 * actionable error naming what was detected and what is supported.
 *
 * Convoy NEVER installs, updates or replaces OpenCode, and never silently
 * selects a different runtime to resolve an incompatibility.
 */

import { spawn } from "node:child_process"

/** Major version Convoy's V2 integration is written against. */
export const supportedOpencodeMajor = 2

/**
 * The concrete runtime Convoy's V2 integration was validated against. Kept
 * explicit (rather than "any 2.x") so the documented tested set is traceable;
 * the acceptance gate records the exact combination.
 */
export const testedOpencodeVersion = "2.0.26"

/** Environment override so an operator (or test) can point at an explicit binary. */
export const opencodeBinEnv = "CONVOY_OPENCODE_BIN"

export type OpencodeRuntimeInfo = {
  /** Detected semantic version, e.g. `2.0.26`. */
  version: string
  major: number
  /** The executable that was probed (name or absolute path). */
  executable: string
}

/** Raised when the resolved runtime is missing or not a supported V2. */
export class UnsupportedOpencodeRuntimeError extends Error {
  readonly detected?: string
  constructor(message: string, detected?: string) {
    super(message)
    this.name = "UnsupportedOpencodeRuntimeError"
    if (detected) this.detected = detected
  }
}

export type RuntimeProbeDeps = {
  /** Resolves the executable to probe; defaults to `CONVOY_OPENCODE_BIN` or `opencode`. */
  resolveBin?: () => string
  /** Runs `<bin> --version`; injectable for tests. */
  run?: (bin: string) => Promise<{ stdout: string; exitCode: number }>
  /** Short-circuits the check (used by fixtures that inject a spawn seam). */
  skip?: boolean
  /** Bound on the default `--version` probe; a hung binary is killed after it. */
  probeTimeoutMs?: number
}

const defaultProbeTimeoutMs = 5_000

/** The operator's resolved executable: an explicit override or `opencode` on PATH. */
export function resolveOpencodeBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[opencodeBinEnv]?.trim()
  return override && override.length > 0 ? override : "opencode"
}

/** Extracts a semantic version from `opencode --version` output (`v2.0.26`). */
export function parseOpencodeVersion(output: string): string | undefined {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined
}

async function defaultRun(bin: string, timeoutMs = defaultProbeTimeoutMs): Promise<{ stdout: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout?.on("data", (chunk) => { out += chunk.toString() })
    child.stderr?.on("data", (chunk) => { err += chunk.toString() })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout: `${out}${err}`.trim(), exitCode: code ?? 0 })
    })
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unsupportedMessage(bin: string, detected: string): string {
  return (
    `Unsupported OpenCode runtime ${detected} (from \`${bin} --version\`): Convoy's V2 integration ` +
    `requires OpenCode V${supportedOpencodeMajor}.x (tested ${testedOpencodeVersion}). ` +
    `Install a supported V2 and put it on PATH (or set ${opencodeBinEnv}). ` +
    `Convoy never installs, updates or replaces your OpenCode, and never changes your configuration.`
  )
}

/**
 * Probes the resolved runtime and asserts it is a supported V2. Rejects with an
 * actionable {@link UnsupportedOpencodeRuntimeError} for a missing binary, an
 * unparseable version, or a non-V2 major. Never mutates the installation.
 */
export async function assertSupportedOpencodeRuntime(deps: RuntimeProbeDeps = {}): Promise<OpencodeRuntimeInfo> {
  const bin = (deps.resolveBin ?? resolveOpencodeBin)()
  if (deps.skip) return { version: testedOpencodeVersion, major: supportedOpencodeMajor, executable: bin }

  let result: { stdout: string; exitCode: number }
  try {
    result = await (deps.run ?? ((path) => defaultRun(path, deps.probeTimeoutMs)))(bin)
  } catch (error) {
    throw new UnsupportedOpencodeRuntimeError(
      `OpenCode runtime not found: could not run \`${bin} --version\`. ` +
        `Convoy's V2 integration requires OpenCode V${supportedOpencodeMajor}.x (tested ${testedOpencodeVersion}) ` +
        `on PATH (or set ${opencodeBinEnv}). Convoy never installs or updates OpenCode. (${describe(error)})`,
    )
  }

  const version = parseOpencodeVersion(result.stdout)
  if (!version) {
    const detected = result.stdout.slice(0, 200)
    throw new UnsupportedOpencodeRuntimeError(
      `Could not determine the OpenCode version from \`${bin} --version\` (output: ${JSON.stringify(detected)}). ` +
        `Convoy's V2 integration requires OpenCode V${supportedOpencodeMajor}.x (tested ${testedOpencodeVersion}).`,
      detected,
    )
  }

  const major = Number(version.split(".")[0])
  if (major !== supportedOpencodeMajor) {
    throw new UnsupportedOpencodeRuntimeError(unsupportedMessage(bin, version), version)
  }

  return { version, major, executable: bin }
}
