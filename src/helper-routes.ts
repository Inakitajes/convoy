/**
 * Helper inference routes (change `runner-parity-opencode-v2`, task 8.4;
 * generalized by `generalize-runner-routes`).
 *
 * The branch namer and the commit writer are optional model helpers with a
 * deterministic fallback each. Their route is resolved from config, most
 * specific first: an explicit `defaults.helperRoutes.<role>` route, then an
 * explicit legacy `defaults.branchNameModel` / `defaults.commitMessageModel`
 * (an existing OpenCode selection is never silently converted), then the
 * run-wide `defaults.runner`, then the built-in OpenCode model. A CLI
 * runner's route is spelled `<runner>/<model>` (`claude-code/haiku`,
 * `codex/gpt-5.5#low`) and runs through that runner's CLI under its
 * configured authentication, so a Claude- or Codex-only installation never
 * needs OpenCode for either helper. Run titles stay deterministic and are not
 * a helper route.
 */

import { runnerAuthOf, type ConvoyConfig, type ConvoyDefaults } from "./config"
import { defaultHelperRoute } from "./run-plan"
import type { AuthenticationSelection } from "./runners/contracts"
import { normalizeQualifiedModel } from "./runners/descriptors"
import { qualifiedModelRoute, runnerOfModelReference, stepRunnerFor, type StepRunnerId } from "./step-runners"

export type HelperRole = "branchName" | "commitMessage"

/** A helper route on a CLI runner, split into its runner and native model; undefined for an OpenCode model. */
export function cliHelperRoute(model: string | undefined): { runner: StepRunnerId; model: string; variant?: string } | undefined {
  if (typeof model !== "string") return undefined
  const route = qualifiedModelRoute(model)
  if (!route) return undefined
  if (route.model && route.model !== "default") return route
  if (route.variant) return { ...route, model: "default" }
  return qualifiedModelRoute(defaultHelperRoute(route.runner)) ?? route
}

/**
 * The model string a helper role runs on, runner-qualified for a CLI runner.
 * `inherit` is the runner the run's own plan uses throughout (a pipeline on
 * one CLI runner), inherited after any configured choice.
 */
export function helperModel(
  role: HelperRole,
  defaults: Pick<ConvoyDefaults, "helperRoutes" | "branchNameModel" | "commitMessageModel" | "runner"> | undefined,
  builtIn: string,
  inherit?: StepRunnerId,
): string {
  const route = defaults?.helperRoutes?.[role]
  const legacy = role === "branchName" ? defaults?.branchNameModel : defaults?.commitMessageModel
  const runner = route?.runner ?? (route?.model || legacy ? undefined : (defaults?.runner ?? inherit))
  if (runner && stepRunnerFor(runner).qualifiedModels) {
    const model = route?.model
    if (!model) return defaultHelperRoute(runner)
    if (qualifiedModelRoute(model)) return model
    const normalized = normalizeQualifiedModel(runner, model)
    return `${runner}/${normalized.model}${normalized.variant ? `#${normalized.variant}` : ""}`
  }
  return route?.model ?? legacy ?? builtIn
}

/** The authentication a helper route runs under: its runner's configured auth, else subscription. */
export function helperAuth(config: Pick<ConvoyConfig, "defaults" | "runners"> | undefined, model: string | undefined): AuthenticationSelection {
  const runner = model ? runnerOfModelReference(model) : undefined
  return (runner ? runnerAuthOf(config)[runner] : undefined) ?? { mode: "subscription" }
}
