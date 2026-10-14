/**
 * Smart auto-accept judge routing (change `runner-parity-opencode-v2`, design
 * D5/D7, task 6.6).
 *
 * Smart approvals ask a judge model whether an ask-level request is safe. The
 * judge is a runner-qualified route, not an OpenCode-shaped assumption: a
 * Claude-only installation can judge with a Claude subscription, and an explicit
 * judge runner/model is preserved exactly. An unavailable judge is reported as
 * an error instead of being silently substituted (see the modified
 * `run-launcher-permissions` spec).
 *
 * This resolves the route and the non-secret authentication selection; it does
 * not call the judge and does not interpret billing. Subscription billing policy
 * is resolved separately (design D3).
 */

import type { AuthenticationMode, AuthenticationSelection, ModelReference, RunnerId } from "./contracts"

export type JudgeRoute = {
  runner: RunnerId
  model: ModelReference
  auth: AuthenticationSelection
}

export type JudgeConfig = {
  runner?: RunnerId
  model?: ModelReference
  authMode?: AuthenticationMode
}

/** Availability seam: which runners the current install can actually judge with. */
export type JudgeCapabilities = {
  hasRunner?(id: RunnerId): boolean
}

export type JudgeResolution = {
  route?: JudgeRoute
  error?: string
}

/**
 * Resolves the smart judge to a runner-qualified route:
 *  - an explicit judge runner and model are preserved;
 *  - a runner that is not available is an error, never a substitution;
 *  - Claude-only judging does not require OpenCode;
 *  - the authentication mode defaults to `subscription`.
 */
export function resolveJudgeRoute(
  config: { judge?: JudgeConfig },
  capabilities: JudgeCapabilities = {},
): JudgeResolution {
  const judge = config.judge ?? {}
  const hasRunner = capabilities.hasRunner ?? (() => true)

  const runner = judge.runner ?? judge.model?.runner
  if (!runner) {
    // No runner-qualified judge was selected. With no judge configured at all
    // the caller keeps its existing fallback; an auth-only selection cannot
    // form a route and must not be silently completed.
    if (judge.authMode === undefined) return {}
    return { error: "judge runner is not configured (no silent substitution)" }
  }

  if (judge.runner !== undefined && judge.model !== undefined && judge.model.runner !== judge.runner) {
    return { error: `judge runner ${judge.runner} does not match judge model runner ${judge.model.runner}` }
  }

  if (judge.model === undefined) {
    return { error: `judge model is required for runner ${runner}` }
  }

  if (!hasRunner(runner)) {
    return { error: `judge runner ${runner} is not available` }
  }

  return {
    route: {
      runner,
      model: { ...judge.model },
      auth: { mode: judge.authMode ?? "subscription" },
    },
  }
}
