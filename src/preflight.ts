import { existsSync } from "node:fs"

import { claudeBinaryName } from "./claude-code"
import { whichOnPath } from "./runner-installation"
import { startOpencode, type OpencodeHandle } from "./opencode"
import { resolveOpencodeBin } from "./opencode-runtime"
import type { ReviewedRunnerAuth, RunPlan } from "./types"
import { type ProviderCatalog, preflightTargets, validatePreflightTargets } from "./preflight-validation"
import { resolveClaudeAuth } from "./runners/claude/auth"
import { cliAuthProbe, validateEffectiveAuth, type EffectiveAuthProbe } from "./runners/claude/effective-auth"
import { codexModelRequirements, preflightCodex, type CodexPreflightInput } from "./runners/codex/preflight"
import type { RunnerId } from "./runners/contracts"
import { runnerDescriptor } from "./runners/descriptors"
import { assertPlanDependenciesAvailable, planDependencyOptions } from "./runners/plan-dependencies"
import { stepRunnerIds } from "./step-runners"

const preflightTimeoutMs = 15_000
export type PreflightDiscovery = (directory: string, signal: AbortSignal) => Promise<ProviderCatalog>

export type PreflightOptions = {
  /** True when the operator reviewed and accepted this plan (its billing line included). */
  reviewed?: boolean
  /** Which runners this installation has; defaults to resolving their binaries. */
  available?: (runner: RunnerId) => boolean
  /** The Claude effective-auth probe; defaults to `claude auth status --json`. */
  claudeAuthProbe?: EffectiveAuthProbe
  /** The Codex account and model preflight; defaults to an owned app-server's `account/read` and `model/list`. */
  codexPreflight?: (input: CodexPreflightInput) => Promise<string | undefined>
  env?: NodeJS.ProcessEnv
}

/** True when the runner's CLI is on PATH (or, for OpenCode, its resolved binary exists). */
export function installedRunner(runner: RunnerId): boolean {
  const binary = runnerDescriptor(runner).binary
  if (binary) return whichOnPath(binary) !== null
  const bin = resolveOpencodeBin()
  return bin.includes("/") ? existsSync(bin) : whichOnPath(bin) !== null
}

/**
 * Validate the whole plan after approval and before run/worktree creation:
 * every runner it will need (steps, goal fragments, advisors, judge, commit
 * writer) is installed, a Claude route's billing decision was made, and its
 * effective Claude authentication is the reviewed one, then the exact
 * physical OpenCode targets. A dependency that would only fail in a later
 * goal fragment fails here, before earlier steps change the repository.
 */
export async function preflightRunPlan(plan: RunPlan, discover?: PreflightDiscovery, options: PreflightOptions = {}): Promise<void> {
  // An injected discovery is a test double for the whole installation: the
  // binary and auth probes then run only when injected too.
  const production = discover === undefined
  assertPlanDependenciesAvailable(plan.pipeline, planDependencyOptions(plan), options.available ?? (production ? installedRunner : () => true))
  for (const runner of stepRunnerIds) {
    const reviewed = plan.runnerAuth?.[runner]
    if (!reviewed) continue
    const injected: Partial<Record<RunnerId, unknown>> = { "claude-code": options.claudeAuthProbe, codex: options.codexPreflight }
    await preflightRunnerAuth(runner, reviewed, plan, { ...options, ...(production || injected[runner] ? {} : { skipProbe: true }) })
  }
  const targets = preflightTargets(plan)
  if (targets.length === 0) return

  const timeout = AbortSignal.timeout(preflightTimeoutMs)
  if (!discover) {
    // Production path: discovery owns a bounded helper whose stop must settle
    // before a timeout-returning caller resumes (design D2).
    const tracked = createTrackedDiscovery()
    try {
      const catalog = await withinPreflightTimeout(tracked.discover(plan.target.directory, timeout), timeout, tracked.cancel)
      validatePreflightTargets(targets, catalog)
    } finally {
      await tracked.cancel()
    }
    return
  }
  const catalog = await withinPreflightTimeout(discover(plan.target.directory, timeout), timeout)
  validatePreflightTargets(targets, catalog)
}

/**
 * Discovery owns a bounded helper server. The timeout path must not return
 * while that server is still shutting down (design D2): the helper handle is
 * recorded here and cancelled before the timeout rejection reaches the caller.
 */
export function createTrackedDiscovery(): { discover: PreflightDiscovery; cancel: () => Promise<void> } {
  let handle: OpencodeHandle | undefined
  return {
    discover: (directory, signal) => discoverProviderCatalog(directory, signal, (next) => (handle = next)),
    cancel: async () => {
      await handle?.stop()
      handle = undefined
    },
  }
}

async function discoverProviderCatalog(
  directory: string,
  signal: AbortSignal,
  track?: (handle: OpencodeHandle) => void,
): Promise<ProviderCatalog> {
  const handle = await startOpencode({}, signal)
  track?.(handle)
  try {
    const providerResult = await handle.client.provider.list({ directory })
    if (providerResult.error || !providerResult.data) throw new Error("OpenCode could not list connected providers and models")
    return providerResult.data
  } finally {
    await handle.close()
  }
}

/**
 * Races the operation against its timeout. On timeout the cancel hook runs to
 * completion *before* the rejection settles, so the caller never returns ahead
 * of the bounded owned-server stop — and never awaits the original request.
 * The operation's own `finally` also closes the handle; the stop is idempotent.
 */
export function withinPreflightTimeout<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  cancel?: () => Promise<void>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("OpenCode preflight timed out"))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    signal.addEventListener(
      "abort",
      () => {
        if (settled) return
        settled = true
        void (async () => {
          try {
            await cancel?.()
          } catch {
            // Cleanup failure never masks the timeout itself.
          }
          reject(new Error("OpenCode preflight timed out"))
        })()
      },
      { once: true },
    )
    operation.then(
      (value) => {
        if (settled) return
        settled = true
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        reject(error)
      },
    )
  })
}

/**
 * A CLI runner's launch gates (design D3). Neither CLI offers a control that
 * enforces included-only usage, so an explicit `included-only` request is
 * refused rather than promised; any other subscription launch may consume
 * usage credits under the account's policy, which the operator accepts by
 * reviewing the plan or, unattended, by configuring `account-policy`. Then
 * the effective authentication is probed under the exact child overlay, so a
 * legacy or ambiguous setup fails here instead of after earlier steps ran.
 */
async function preflightRunnerAuth(runner: RunnerId, reviewed: ReviewedRunnerAuth, plan: RunPlan, options: PreflightOptions & { skipProbe?: boolean }): Promise<void> {
  const { auth, billing } = reviewed
  const name = runnerDescriptor(runner).displayName
  if (auth.mode === "subscription" && auth.billingPolicy === "included-only") {
    throw new Error(
      `Cannot start run\n\n${name} billing: included-only was requested, but ${billing.reason}.\n\n` +
        `Set runners.${runner}.auth.billingPolicy: account-policy to accept the account's own usage policy (Convoy never changes provider spend settings), or select an explicit api-key route.`,
    )
  }
  if (auth.mode === "subscription" && auth.billingPolicy === undefined && !options.reviewed) {
    throw new Error(
      `Cannot start run\n\n${name} billing: an unattended launch must state its billing decision — subscription login alone is not a no-charge guarantee.\n\n` +
        `Set runners.${runner}.auth.billingPolicy: account-policy (subscription usage credits or paid features may apply), or review the plan interactively.`,
    )
  }
  if (options.skipProbe) return
  const env = options.env ?? process.env
  const probes: Partial<Record<RunnerId, () => Promise<string | undefined>>> = {
    "claude-code": async () => {
      const resolution = resolveClaudeAuth({ selection: auth, env })
      const probe = options.claudeAuthProbe ?? cliAuthProbe((command, spawnOptions) => Bun.spawn(command, spawnOptions), claudeBinaryName, process.cwd())
      const effective = await validateEffectiveAuth({ resolution, probe, env })
      return effective.ok ? undefined : effective.error
    },
    codex: async () => (options.codexPreflight ?? preflightCodex)({ selection: auth, models: codexModelRequirements(plan), cwd: plan.target.directory, env }),
  }
  const error = await probes[runner]?.()
  if (error) throw new Error(`Cannot start run\n\n${error}\n\nSet runners.${runner}.auth to choose ${name}'s billing source explicitly.`)
}
