/**
 * Claude runner authentication-mode resolution (change
 * `runner-parity-opencode-v2`, task 3.4, design D3, spec
 * `runner-authentication`).
 *
 * A Claude route may name a mode explicitly, or inherit a legacy configuration
 * that predates modes. This module resolves that legacy case conservatively:
 * subscription is only inferred from a verifiable subscription login, and any
 * ambiguity — missing evidence, a bare credential reference, an ambient API
 * credential, or an unattended launch that cannot be reviewed — fails with an
 * actionable migration message instead of inferring permission to bill an API
 * key.
 *
 * The selection it returns is an `AuthenticationSelection` to freeze in a plan;
 * the credential rules themselves (credentialRef required for api-key, forbidden
 * for subscription, key present and isolatable) are delegated to
 * `resolveClaudeAuth` so they live in exactly one place.
 *
 * Pure and dependency-free: no Claude CLI or vendor SDK is required.
 */

import type { AuthenticationMode, AuthenticationSelection } from "../contracts"
import { ClaudeAuthError, resolveClaudeAuth } from "./auth"

/** The resolved runner-level Claude configuration for one route or default. */
export type ClaudeRunnerConfig = {
  authMode?: AuthenticationMode
  credentialRef?: string
}

/** Environment variables that constitute a verifiable subscription login. */
export const subscriptionLoginEnvVars = ["CLAUDE_CODE_OAUTH_TOKEN"] as const

/** Environment variables whose presence makes the billing source ambiguous. */
export const ambiguousBillingEnvVars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const

export type ClaudeModeInput = {
  config?: ClaudeRunnerConfig
  /** Whether launch review can still ask the operator to choose a mode. */
  interactive: boolean
  env?: NodeJS.ProcessEnv
}

export type ClaudeModeResult =
  | { ok: true; selection: AuthenticationSelection }
  | { ok: false; error: string }

function populatedVars(env: NodeJS.ProcessEnv, vars: readonly string[]): string[] {
  return vars.filter((key) => {
    const value = env[key]
    return typeof value === "string" && value.length > 0
  })
}

/**
 * Resolves the reviewed authentication selection for a Claude route. Explicit
 * modes are honored (and validated by `resolveClaudeAuth`); a legacy route with
 * no mode is allowed only when a subscription login is verifiable and no
 * competing credential makes billing ambiguous.
 */
export function resolveClaudeMode(input: ClaudeModeInput): ClaudeModeResult {
  const env = input.env ?? process.env
  const config = input.config ?? {}

  if (config.authMode !== undefined) {
    const selection: AuthenticationSelection = {
      mode: config.authMode,
      ...(config.credentialRef !== undefined ? { credentialRef: config.credentialRef } : {}),
    }
    try {
      resolveClaudeAuth({ selection, env })
    } catch (error) {
      return { ok: false, error: error instanceof ClaudeAuthError ? error.message : String(error) }
    }
    return { ok: true, selection }
  }

  // A credential reference without a mode is ambiguous, not implicit API consent.
  if (config.credentialRef !== undefined) {
    return {
      ok: false,
      error:
        `Claude runner supplies credentialRef "${config.credentialRef}" but no authMode. ` +
        `Set authMode: "api-key" to bill that external key explicitly, or authMode: "subscription" and remove the reference; ` +
        `Convoy will not infer a billing mode from a credential reference.`,
    }
  }

  // Missing authMode: a legacy configuration. Only a verifiable subscription
  // login may be inferred, and only when no competing credential is present.
  const subscriptionLogins = populatedVars(env, subscriptionLoginEnvVars)
  const ambiguous = populatedVars(env, ambiguousBillingEnvVars)
  const where = input.interactive ? "launch review" : "this noninteractive launch"

  if (subscriptionLogins.length > 0 && ambiguous.length === 0) {
    return { ok: true, selection: { mode: "subscription" } }
  }

  if (ambiguous.length > 0) {
    return {
      ok: false,
      error:
        `Claude runner has no authMode and the billing source is ambiguous for ${where}: ` +
        `API credential variable(s) ${ambiguous.join(", ")} are present in the launch environment. ` +
        `Set authMode: "subscription" to use the operator's Claude CLI login, or authMode: "api-key" with credentialRef; ` +
        `Convoy will not choose a billing mode for you.`,
    }
  }

  return {
    ok: false,
    error:
      `Claude runner has no authMode and no verifiable subscription login was found for ${where} ` +
      `(expected a subscription credential such as ${subscriptionLoginEnvVars.join(", ")} or an authenticated Claude CLI login). ` +
      `Set authMode: "subscription" after authenticating the Claude CLI, or authMode: "api-key" with credentialRef, ` +
      `to choose a billing source explicitly. Convoy never infers permission to use API billing.`,
  }
}
