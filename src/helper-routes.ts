/**
 * Helper inference routes (change `runner-parity-opencode-v2`, task 8.4).
 *
 * The branch namer and the commit writer are optional model helpers with a
 * deterministic fallback each. Their route is resolved from config, most
 * specific first: an explicit `defaults.helperRoutes.<role>` route, then an
 * explicit legacy `defaults.branchNameModel` / `defaults.commitMessageModel`
 * (an existing OpenCode selection is never silently converted), then the
 * run-wide `defaults.runner`, then the built-in OpenCode model. A Claude route
 * is spelled `claude-code/<model>` and runs through the Claude CLI under the
 * configured Claude authentication, so a Claude-only installation never needs
 * OpenCode for either helper. Run titles stay deterministic and are not a
 * helper route.
 */

import type { ConvoyDefaults } from "./config"
import type { AuthenticationSelection } from "./runners/contracts"

export type HelperRole = "branchName" | "commitMessage"

/** The cheap Claude model a helper uses when its Claude route names none. */
export const defaultClaudeHelperModel = "haiku"

const claudePrefix = "claude-code/"

/** True when a helper model string routes to the Claude CLI. */
export function isClaudeHelperModel(model: string | undefined): model is string {
  return typeof model === "string" && model.startsWith(claudePrefix)
}

/** The Claude model id of a `claude-code/<model>` route (the CLI default for an empty one). */
export function claudeHelperModelId(model: string): string {
  return model.slice(claudePrefix.length) || defaultClaudeHelperModel
}

/**
 * The model string a helper role runs on, runner-qualified for Claude.
 * `inherit` is the runner the run's own plan uses throughout (a Claude-only
 * pipeline), inherited after any configured choice.
 */
export function helperModel(
  role: HelperRole,
  defaults: Pick<ConvoyDefaults, "helperRoutes" | "branchNameModel" | "commitMessageModel" | "runner"> | undefined,
  builtIn: string,
  inherit?: "opencode" | "claude-code",
): string {
  const route = defaults?.helperRoutes?.[role]
  const legacy = role === "branchName" ? defaults?.branchNameModel : defaults?.commitMessageModel
  const runner = route?.runner ?? (route?.model || legacy ? undefined : (defaults?.runner ?? inherit))
  if (runner === "claude-code") {
    const model = route?.model ?? defaultClaudeHelperModel
    return isClaudeHelperModel(model) ? model : `${claudePrefix}${model}`
  }
  return route?.model ?? legacy ?? builtIn
}

/** The Claude authentication a helper runs under: the configured Claude auth, else subscription. */
export function helperClaudeAuth(defaults: Pick<ConvoyDefaults, "claudeAuth"> | undefined): AuthenticationSelection {
  const auth = defaults?.claudeAuth
  return auth
    ? { mode: auth.authMode, ...(auth.credentialRef ? { credentialRef: auth.credentialRef } : {}), ...(auth.billingPolicy ? { billingPolicy: auth.billingPolicy } : {}) }
    : { mode: "subscription" }
}
