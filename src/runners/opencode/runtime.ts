/**
 * Convoy-owned OpenCode runtime version gate (change `runner-parity-opencode-v2`).
 *
 * OpenCode V2 is a released protocol, not a pinned artifact: the operator
 * installs and upgrades the CLI themselves, so Convoy must prove at the boundary
 * that the binary it is about to drive is a V2 runtime before any adapter uses
 * it. Convoy never installs, updates, or replaces the operator's binary — a
 * mismatch is a refusal with remediation, never a silent download or an implicit
 * downgrade.
 *
 * The gate is dependency-free and seam-injectable (`resolveBin`/`run`/`skip`)
 * so the launcher can substitute a fixture in tests and operators can override
 * the binary location without Convoy mutating global state.
 */

import { spawn } from "node:child_process"

export const supportedOpencodeMajor = 2

/** The exact release Convoy's adapters were exercised against; `2.x` is accepted. */
export const testedOpencodeVersion = "2.0.26"

/** Override for the OpenCode executable, for installs not on `PATH`. */
export const opencodeBinEnv = "CONVOY_OPENCODE_BIN"

export type OpencodeRuntimeInfo = {
  version: string
  major: number
  executable: string
}

export class UnsupportedOpencodeRuntimeError extends Error {
  /** What Convoy observed: the version, the raw output, or the executable tried. */
  detected?: string

  constructor(message: string, detected?: string) {
    super(message)
    this.name = "UnsupportedOpencodeRuntimeError"
    this.detected = detected
  }
}

/** Resolves the binary to probe: an explicit non-empty override, else `PATH`. */
export function resolveOpencodeBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[opencodeBinEnv]?.trim()
  return override && override.length > 0 ? override : "opencode"
}

/** Extracts the first `major.minor.patch` token from `--version` output. */
export function parseOpencodeVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/)?.[0]
}

type RuntimeProbeResult = { stdout: string; exitCode: number }

type RuntimeDeps = {
  resolveBin?(): string
  run?(bin: string): Promise<RuntimeProbeResult>
  /** Operator-declared MCP/runtime skip: trust the caller, never spawn. */
  skip?: boolean
  probeTimeoutMs?: number
}

const defaultProbeTimeoutMs = 5_000

/**
 * Spawns `<bin> --version`, killing it after the timeout so a hung or
 * interactive binary can never wedge the launcher. `--version` only; the gate
 * makes no model or server call.
 */
function defaultRun(bin: string, timeoutMs: number): Promise<RuntimeProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(new Error(`timed out after ${timeoutMs}ms waiting for \`${bin} --version\``))
    }, timeoutMs)
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    // A missing binary surfaces as an `error` event, not a non-zero exit.
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, exitCode: code ?? 1 })
    })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Every refusal carries the same fixed remedy: what Convoy needs, that Convoy
 * never installs/updates OpenCode, and the override for a non-`PATH` install.
 */
function unsupportedRuntime(detail: string, detected?: string): UnsupportedOpencodeRuntimeError {
  const detectedText = detected ? ` Detected: ${detected}.` : ""
  const message =
    `${detail}.${detectedText} Convoy requires OpenCode V${supportedOpencodeMajor}.x (tested ${testedOpencodeVersion}) ` +
    `and never installs or updates OpenCode. Install or select a supported OpenCode V${supportedOpencodeMajor}.x yourself, ` +
    `or set ${opencodeBinEnv} to the path of the binary Convoy should use.`
  return new UnsupportedOpencodeRuntimeError(message, detected)
}

/**
 * Probes the resolved OpenCode binary and refuses anything that is not a V2
 * runtime. `skip` short-circuits to the tested baseline without spawning, for
 * callers that have already resolved the runtime out of band.
 */
export async function assertSupportedOpencodeRuntime(deps: RuntimeDeps = {}): Promise<OpencodeRuntimeInfo> {
  const executable = deps.resolveBin ? deps.resolveBin() : resolveOpencodeBin()
  if (deps.skip) {
    return { version: testedOpencodeVersion, major: supportedOpencodeMajor, executable }
  }

  const probeTimeoutMs = deps.probeTimeoutMs ?? defaultProbeTimeoutMs
  const run = deps.run ?? ((bin: string) => defaultRun(bin, probeTimeoutMs))

  let result: RuntimeProbeResult
  try {
    result = await run(executable)
  } catch (error) {
    throw unsupportedRuntime(`OpenCode could not be executed (\`${executable} --version\`: ${errorMessage(error)})`, executable)
  }

  if (result.exitCode !== 0) {
    throw unsupportedRuntime(
      `\`${executable} --version\` exited with code ${result.exitCode}`,
      parseOpencodeVersion(result.stdout) ?? (result.stdout.trim() || executable),
    )
  }

  const version = parseOpencodeVersion(result.stdout)
  if (!version) {
    throw unsupportedRuntime(
      `could not parse an OpenCode version from \`${executable} --version\` output`,
      result.stdout.trim() || executable,
    )
  }

  const major = Number(version.split(".")[0])
  if (major !== supportedOpencodeMajor) {
    throw unsupportedRuntime(`OpenCode ${version} is not a V${supportedOpencodeMajor} runtime`, version)
  }

  return { version, major, executable }
}
