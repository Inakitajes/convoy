/**
 * Helper port (change `runner-parity-opencode-v2`, task 8.4).
 *
 * Branch-naming and commit-message inference are optional helper roles routed by
 * config, so a Claude-only installation never falls back to OpenCode. Run titles
 * stay deterministic and gain no model dependency.
 */

import type { ModelReference, RunnerId } from "./contracts"

export type HelperRole = "branch-name" | "commit-message"

export const helperRoles: readonly HelperRole[] = ["branch-name", "commit-message"]

/** Run titles are deliberately deterministic; they are not a helper route. */
export const titleIsDeterministic = true

export type HelperRoute = {
  role: HelperRole
  runner: RunnerId
  /** Absent when the runner's default model is used. */
  model?: ModelReference
}

export type HelperRouteOverride = { runner?: RunnerId; model?: ModelReference }
export type HelperConfig = Partial<Record<HelperRole, HelperRouteOverride>>

export type ResolveHelperRoutesInput = {
  config?: HelperConfig
  /** The run's default runner/model, inherited by unspecified helper roles. */
  defaultRunner: RunnerId
  defaultModel?: ModelReference
}

/** Resolves each helper role, inheriting the run's route when unspecified. */
export function resolveHelperRoutes(input: ResolveHelperRoutesInput): Record<HelperRole, HelperRoute> {
  const routes = {} as Record<HelperRole, HelperRoute>
  for (const role of helperRoles) {
    const override = input.config?.[role]
    const model = override?.model ?? input.defaultModel
    routes[role] = {
      role,
      runner: override?.runner ?? input.defaultRunner,
      ...(model ? { model } : {}),
    }
  }
  return routes
}

export type HelperExecutor = (route: HelperRoute, prompt: string) => Promise<string>

/** Dispatches a helper call to the executor registered for its runner. */
export async function runHelper(
  route: HelperRoute,
  prompt: string,
  executors: Partial<Record<RunnerId, HelperExecutor>>,
): Promise<string> {
  const executor = executors[route.runner]
  if (!executor) throw new Error(`no helper executor is available for runner: ${route.runner}`)
  return executor(route, prompt)
}
