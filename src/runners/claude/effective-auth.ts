/**
 * Claude effective-authentication validation (change
 * `runner-parity-opencode-v2`, task 3.2, design D3/D4, spec
 * `runner-authentication`).
 *
 * `resolveClaudeAuth` produces a child-local environment overlay, but an overlay
 * is only an intent. The effective billing source is whatever the Claude CLI
 * actually resolves under that exact environment. This module closes that gap:
 * it applies the overlay, asks the supported auth-status probe what method is
 * live, and compares that to the reviewed mode.
 *
 * An ambient API key that survived isolation, a key helper, a third-party
 * provider, or a probe that disagrees with the requested mode is a conflict and
 * fails closed rather than silently changing billing. The error and the returned
 * description never contain a secret value.
 *
 * Pure and dependency-free: the auth-status probe is injected, so no Claude CLI
 * or vendor SDK is required to exercise this module.
 */

import type { AuthenticationMode } from "../contracts"
import type { ClaudeAuthResolution } from "./auth"
import { redactSecrets } from "../redaction"

/** The validated effective authentication for a Claude child process. */
export type EffectiveAuth = {
  mode: AuthenticationMode
  /** Non-secret identifier of the effective credential source. */
  source: string
  /** Human-readable, secret-free summary for review and logs. */
  description: string
}

/** Auth-status methods that indicate a subscription login. */
export const subscriptionAuthMethods = ["claude.ai", "oauth_token"] as const

/** The only auth-status method that indicates an API key is the source. */
export const apiKeyAuthMethods = ["api_key"] as const

/** Methods that indicate a competing or unexpected billing source. */
export const conflictingAuthMethods = ["api_key", "api_key_helper", "third_party"] as const

/** Variables that a subscription isolation must remove so the key cannot win. */
export const ambientApiKeyVars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const

/** Queries the supported auth-status interface for the effective method. */
export type EffectiveAuthProbe = (env: NodeJS.ProcessEnv) => Promise<{ authMethod: string }>

export type EffectiveAuthInput = {
  /** The overlay the child will launch with. */
  resolution: ClaudeAuthResolution
  /** Probes the child environment for the method Claude will actually use. */
  probe: EffectiveAuthProbe
  /** The launch environment the overlay is applied to. */
  env: NodeJS.ProcessEnv
}

export type EffectiveAuthResult =
  | { ok: true; effective: EffectiveAuth }
  | { ok: false; error: string }

/** Applies the resolution's set/unset overlay to produce the child environment. */
export function applyAuthOverlay(env: NodeJS.ProcessEnv, resolution: ClaudeAuthResolution): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env }
  for (const key of resolution.unset) delete child[key]
  for (const [key, value] of Object.entries(resolution.set)) child[key] = value
  return child
}

function populatedVars(env: NodeJS.ProcessEnv, vars: readonly string[]): string[] {
  return vars.filter((key) => {
    const value = env[key]
    return typeof value === "string" && value.length > 0
  })
}

function normalizeMethod(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function includes(haystack: readonly string[], needle: string): boolean {
  return haystack.includes(needle)
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return redactSecrets(raw)
}

/**
 * Validates that `resolution` actually yields `resolution.mode` under `env`.
 * Fails closed on any ambiguity; never returns a secret.
 */
export async function validateEffectiveAuth(input: EffectiveAuthInput): Promise<EffectiveAuthResult> {
  const { resolution, probe, env } = input
  const child = applyAuthOverlay(env, resolution)

  if (resolution.mode === "subscription") {
    // A key that survived isolation would silently outrank the subscription login.
    const survived = populatedVars(child, ambientApiKeyVars)
    if (survived.length > 0) {
      return {
        ok: false,
        error:
          `Claude subscription isolation is incomplete: ambient credential variable(s) ` +
          `${survived.join(", ")} remained in the child environment and could select API billing. ` +
          `Refusing rather than bill the key; remove them from the child environment or select api-key mode explicitly.`,
      }
    }

    let probed: { authMethod: string }
    try {
      probed = await probe(child)
    } catch (error) {
      return {
        ok: false,
        error:
          `Claude subscription authentication could not be verified: ${errorText(error)}. ` +
          `Ensure the operator's Claude CLI login is available in this environment; Convoy never falls back to API credentials.`,
      }
    }

    const method = normalizeMethod(probed?.authMethod)
    if (includes(conflictingAuthMethods, method)) {
      return {
        ok: false,
        error:
          `Claude subscription mode resolved to auth method "${method}", which is not the operator's subscription login. ` +
          `Isolate the conflicting credential and retry, or select api-key mode explicitly.`,
      }
    }
    if (!includes(subscriptionAuthMethods, method)) {
      return {
        ok: false,
        error:
          `Claude subscription mode could not confirm a subscription login (auth method "${method || "unknown"}"). ` +
          `Authenticate the Claude CLI with the operator's subscription, or select api-key mode explicitly.`,
      }
    }

    return {
      ok: true,
      effective: {
        mode: "subscription",
        source: "claude-cli-login",
        description: `${resolution.description} Verified effective auth method "${method}" under the child environment.`,
      },
    }
  }

  if (resolution.mode === "api-key") {
    let probed: { authMethod: string }
    try {
      probed = await probe(child)
    } catch (error) {
      return {
        ok: false,
        error:
          `Claude api-key authentication could not be verified: ${errorText(error)}. ` +
          `Check the credential reference and that the key is exported in the launch environment.`,
      }
    }

    const method = normalizeMethod(probed?.authMethod)
    if (!includes(apiKeyAuthMethods, method)) {
      return {
        ok: false,
        error:
          `Claude api-key mode resolved to auth method "${method || "unknown"}" instead of "api_key". ` +
          `The API key is not the effective billing source; isolate the conflicting credential or fix the credential reference.`,
      }
    }

    return {
      ok: true,
      effective: {
        mode: "api-key",
        source: "external-api-key",
        description: `${resolution.description} Verified effective auth method "api_key" under the child environment.`,
      },
    }
  }

  return {
    ok: false,
    error: `Unsupported Claude authentication mode "${String((resolution as { mode?: unknown }).mode)}".`,
  }
}

/** The slice of a process spawner the auth-status probe needs. */
export type AuthStatusSpawn = (
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: Blob; stdout: "pipe"; stderr: "pipe" },
) => { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> }

/**
 * The supported auth-status interface, asked under the attempt's exact child
 * environment: `claude auth status --json` reports the method Claude will use.
 */
export function cliAuthProbe(spawn: AuthStatusSpawn, binary: string, cwd: string): EffectiveAuthProbe {
  return async (env) => {
    const proc = spawn([binary, "auth", "status", "--json"], { cwd, env, stdin: new Blob([]), stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    let status: { loggedIn?: unknown; authMethod?: unknown }
    try {
      status = JSON.parse(stdout) as typeof status
    } catch {
      throw new Error(`claude auth status returned no status${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`)
    }
    if (status.loggedIn === false) throw new Error("the Claude CLI is not logged in")
    return { authMethod: typeof status.authMethod === "string" ? status.authMethod : "" }
  }
}

