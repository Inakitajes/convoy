/**
 * Claude child-environment authentication preparation (change
 * `runner-parity-opencode-v2`, design D3/D4, spec `runner-authentication`).
 *
 * Authentication and billing are independent. Subscription login does not imply
 * free usage; the separate `billingPolicy` decides whether paid usage credits may
 * be consumed. This module only prepares the child-local environment overlay: it
 * never mutates the parent environment, reads credential stores, or returns raw
 * secret values.
 *
 * The overlay is expressed as an explicit `set`/`unset` pair so an inherited
 * ambient credential cannot silently select a different billing source for the
 * child. Under `subscription`, an ambient `ANTHROPIC_API_KEY` /
 * `ANTHROPIC_AUTH_TOKEN` is removed so the operator's Claude CLI login is used.
 * Under `api-key`, the API credential is set and ambient OAuth/subscription
 * tokens are removed so the key is the effective source.
 *
 * Pure and dependency-free: it imports the shared contracts type and nothing
 * else, so it can run without the Claude CLI or any vendor SDK present.
 */

import type { AuthenticationMode, AuthenticationSelection } from "../contracts"

/** The resolved environment overlay for one Claude child process. */
export type ClaudeAuthResolution = {
  mode: AuthenticationMode
  /** Child env overlay (may set or delete vars). */
  set: Record<string, string>
  /** Env vars to remove for the child. */
  unset: string[]
  /** Non-secret description for review/logs. */
  description: string
}

/** The ambient credential variables considered when isolating a Claude child. */
export const claudeCredentialEnvVars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const

/** A rejected or unsatisfiable Claude authentication selection. */
export class ClaudeAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClaudeAuthError"
  }
}

const validBillingPolicies = ["included-only", "account-policy"] as const

/** Vars that would let an inherited credential override the API-key mode. */
const apiKeyBillingOverrides = ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]

/** Vars that would let an inherited credential override the subscription login. */
const subscriptionBillingOverrides = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]

/**
 * Resolves the reviewed authentication selection into a child-local environment
 * overlay. Throws `ClaudeAuthError` for a mode that cannot be safely isolated
 * rather than falling back to another billing source.
 */
export function resolveClaudeAuth(input: {
  selection: AuthenticationSelection
  env?: NodeJS.ProcessEnv
}): ClaudeAuthResolution {
  const { selection } = input
  const env = input.env ?? process.env

  if (selection.billingPolicy !== undefined && !isValidBillingPolicy(selection.billingPolicy)) {
    throw new ClaudeAuthError(
      `Unsupported billingPolicy "${String(selection.billingPolicy)}"; expected "included-only" or "account-policy".`,
    )
  }

  if (selection.mode === "subscription") {
    if (selection.credentialRef) {
      throw new ClaudeAuthError(
        `Subscription mode must not carry a credential reference (got "${selection.credentialRef}"). ` +
          `Remove credentialRef to use the operator's Claude CLI login, or select api-key mode explicitly.`,
      )
    }
    return {
      mode: "subscription",
      set: {},
      unset: [...subscriptionBillingOverrides],
      description:
        "Claude subscription: uses the operator's authenticated Claude CLI login; ambient API-key credentials are removed for this child.",
    }
  }

  if (selection.mode === "api-key") {
    const credentialRef = selection.credentialRef
    if (!credentialRef) {
      throw new ClaudeAuthError(
        `Claude api-key mode requires credentialRef naming the environment variable that holds the key.`,
      )
    }

    const value = env[credentialRef]
    if (value === undefined || value === "") {
      throw new ClaudeAuthError(
        `Claude api-key mode: environment variable "${credentialRef}" is missing or empty. ` +
          `Set it in the launch environment or choose a different credentialRef.`,
      )
    }

    return {
      mode: "api-key",
      set: { ANTHROPIC_API_KEY: value },
      unset: [...apiKeyBillingOverrides],
      description: `Claude API key from environment variable "${credentialRef}"; ambient OAuth/subscription tokens are removed for this child.`,
    }
  }

  throw new ClaudeAuthError(
    `Unsupported Claude authentication mode "${String(selection.mode)}"; expected "subscription" or "api-key".`,
  )
}

function isValidBillingPolicy(value: unknown): value is (typeof validBillingPolicies)[number] {
  return typeof value === "string" && (validBillingPolicies as readonly string[]).includes(value)
}
