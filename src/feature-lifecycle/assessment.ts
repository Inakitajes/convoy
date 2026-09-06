import type { FeatureRecord } from "./records"

/**
 * The pure lifecycle assessment (capability `feature-lifecycle`, design D5):
 * a function over typed observations that derives orthogonal facts, the
 * human summary, and the applicable actions. No I/O, no clocks, no mutation —
 * every input is an observation the adapters gathered, so the same assessment
 * serves the board, the specs viewer, the launcher, publication, and close
 * (task 2.1/2.5).
 *
 * Facts are orthogonal and evidence-based (design D5): association validity,
 * artifact state per contract, task completion, execution/liveness, local
 * integration certainty, remote publication observations, and cleanup
 * progress never imply one another. Unknown/unreadable evidence is modeled
 * explicitly — it must never be flattened into "none" or "clean" (design D5:
 * missing evidence is not success).
 */

/** Artifact/lifecycle state of one contract (design D5). */
export type ContractState = "active" | "verified-archived" | "missing" | "ambiguous" | "unreadable"

export type ContractObservation = {
  changeId: string
  state: ContractState
  tasks?: { done: number; total: number } | "unknown"
  /** Why the state is degraded, when it is. */
  reason?: string
}

/** How the feature's implementation context verified (design D5). */
export type ContextVerification = "verified" | "unassociated" | "ambiguous" | "missing" | "unreadable"

export type ExecutionObservation =
  | { kind: "known"; liveRunIds: readonly string[]; totalRuns: number }
  | { kind: "unknown"; reason: string }

export type IntegrationObservation = "pending" | "probable" | "verified" | "stale" | "unknown"

export type PublicationObservation =
  | { kind: "known"; upstream?: string; published: boolean }
  | { kind: "unknown"; reason: string }

export type CleanupObservation =
  | { kind: "known"; worktreePresent: boolean; branchPresent: boolean }
  | { kind: "unknown"; reason: string }

export type LifecycleObservations = {
  feature?: FeatureRecord
  context: { verification: ContextVerification; branch?: string; checkoutPath?: string; reason?: string }
  contracts: readonly ContractObservation[]
  execution: ExecutionObservation
  integration: IntegrationObservation
  publication: PublicationObservation
  cleanup: CleanupObservation
}

/** One applicable lifecycle action with its blockers and remediation (design D5). */
export type LifecycleAction = {
  id: "close" | "continue" | "adopt" | "bind" | "archive-on-main" | "push" | "cleanup-worktree" | "cleanup-branch" | "history" | "spin" | "propose" | "converse"
  label: string
  applicable: boolean
  enabled: boolean
  blockers: readonly string[]
  remediation: readonly string[]
  target?: { featureId: string }
}

export type LifecycleAssessment = {
  /** The derived summary (design D5's table). */
  summary: string
  tasks?: { done: number; total: number } | "unknown"
  liveRuns: number
  contracts: readonly ContractObservation[]
  integration: IntegrationObservation
  actions: readonly LifecycleAction[]
  /** True when the close-start prerequisites all pass (never implied by tasks alone). */
  closeStartPrerequisitesPass: boolean
  blockers: readonly string[]
}

/** A task count is only known when both numbers are non-negative integers. */
function totalTasks(contracts: readonly ContractObservation[]): { done: number; total: number } | "unknown" {
  let done = 0
  let total = 0
  let known = false
  for (const contract of contracts) {
    if (contract.tasks === "unknown" || contract.tasks === undefined) continue
    known = true
    done += contract.tasks.done
    total += contract.tasks.total
  }
  return known ? { done, total } : "unknown"
}

function contractProblems(contracts: readonly ContractObservation[]): string[] {
  const problems: string[] = []
  for (const contract of contracts) {
    if (contract.state === "missing") problems.push(`contract ${contract.changeId}: source missing${contract.reason ? ` (${contract.reason})` : ""}`)
    else if (contract.state === "ambiguous") problems.push(`contract ${contract.changeId}: ambiguous sources${contract.reason ? ` (${contract.reason})` : ""}`)
    else if (contract.state === "unreadable") problems.push(`contract ${contract.changeId}: source unreadable${contract.reason ? ` (${contract.reason})` : ""}`)
  }
  return problems
}

/**
 * The close-start prerequisites (design D5: "Ready to close" requires the
 * shared close-start prerequisites, complete tasks alone are "implementation
 * complete"): verified context, every contract readable (active or
 * verified-archived), all known tasks complete, no live runs, and no
 * unknowns where the close preflight needs evidence.
 */
export function closeStartPrerequisites(observations: LifecycleObservations): { pass: boolean; blockers: string[] } {
  const blockers: string[] = []
  if (!observations.feature) blockers.push("no registered feature: adopt or spin before closing")
  if (observations.context.verification !== "verified") {
    blockers.push(
      observations.context.verification === "missing"
        ? "implementation context is missing (worktree removed) — rebind or recover"
        : `implementation context is ${observations.context.verification}${observations.context.reason ? `: ${observations.context.reason}` : ""}`,
    )
  }
  for (const problem of contractProblems(observations.contracts)) blockers.push(problem)
  for (const contract of observations.contracts) {
    if (contract.state === "active" && contract.tasks === "unknown") blockers.push(`contract ${contract.changeId}: task completion unknown`)
    else if (contract.state === "active" && contract.tasks !== "unknown" && contract.tasks !== undefined) {
      if (contract.tasks.total === 0) blockers.push(`contract ${contract.changeId}: no task list`)
      else if (contract.tasks.done < contract.tasks.total) {
        blockers.push(`contract ${contract.changeId}: ${contract.tasks.total - contract.tasks.done} of ${contract.tasks.total} tasks incomplete`)
      }
    }
  }
  if (observations.execution.kind === "unknown") blockers.push(`live-run state unknown: ${observations.execution.reason}`)
  else if (observations.execution.liveRunIds.length > 0) blockers.push(`${observations.execution.liveRunIds.length} live run(s) attached`)
  return { pass: blockers.length === 0, blockers }
}

/**
 * The summary, in design D5's precedence order: recovery/unknown blockers are
 * favored over claimed readiness, and "ready to close" is only derived from
 * the shared prerequisites — never from task counts alone.
 */
export function summarize(observations: LifecycleObservations): { summary: string; blockers: string[]; closeStartPrerequisitesPass: boolean } {
  const blockers: string[] = []

  if (!observations.feature) {
    blockers.push("not associated with a registered feature")
    return { summary: "Association needed", blockers, closeStartPrerequisitesPass: false }
  }
  if (observations.context.verification === "missing") {
    blockers.push("implementation context missing (worktree removed)")
    return { summary: "Context missing", blockers, closeStartPrerequisitesPass: false }
  }
  if (observations.context.verification === "unreadable" || observations.context.verification === "ambiguous") {
    blockers.push(observations.context.reason ?? `context ${observations.context.verification}`)
    return { summary: "Context needs review", blockers, closeStartPrerequisitesPass: false }
  }

  const problems = contractProblems(observations.contracts)
  if (problems.length > 0) {
    blockers.push(...problems)
    return { summary: "Contract sources need review", blockers, closeStartPrerequisitesPass: false }
  }

  const tasks = totalTasks(observations.contracts)
  const archived = observations.contracts.length > 0 && observations.contracts.every((contract) => contract.state === "verified-archived")
  const prerequisites = closeStartPrerequisites(observations)

  // Pre-proposal state (capability work-context, task 6.2): a verified
  // zero-contract feature with no execution is awaiting proposal — never
  // "in implementation" and never close-ready (empty task counts imply
  // nothing). The close blocker names the concrete prerequisite.
  if (observations.contracts.length === 0) {
    blockers.push("no contracts: propose a change or associate an existing one before closing")
    blockers.push(...prerequisites.blockers)
    return { summary: "Awaiting proposal", blockers, closeStartPrerequisitesPass: false }
  }

  if (observations.integration === "stale") {
    blockers.push("landing evidence is stale (feature tip advanced or landing unreachable)")
    return { summary: "Integration evidence stale", blockers, closeStartPrerequisitesPass: false }
  }
  if (observations.integration === "verified") {
    const cleanupPending =
      observations.cleanup.kind === "known" && (observations.cleanup.worktreePresent || observations.cleanup.branchPresent)
    return {
      summary: cleanupPending ? "Integrated locally · cleanup pending" : "Completed",
      blockers,
      closeStartPrerequisitesPass: false,
    }
  }
  if (archived) {
    // Past archiving, not yet integrated: close review stays applicable
    // (landing work), but "ready to close" would misstate the lifecycle.
    blockers.push(...prerequisites.blockers.filter((blocker) => blocker.includes("live run")))
    return { summary: "Implementation complete · archive verified", blockers, closeStartPrerequisitesPass: false }
  }
  if (observations.integration === "probable") {
    blockers.push("integration is only probable (patch equivalence, no verified receipt)")
    return { summary: "Probably merged", blockers, closeStartPrerequisitesPass: false }
  }
  // A live run keeps the feature in implementation (design D5's table: tasks
  // incomplete OR a run live → In implementation), even with tasks complete.
  const liveRun = observations.execution.kind === "known" && observations.execution.liveRunIds.length > 0
  if (liveRun) {
    blockers.push(...prerequisites.blockers)
    return { summary: "In implementation", blockers, closeStartPrerequisitesPass: false }
  }
  if (tasks !== "unknown" && tasks.total > 0 && tasks.done >= tasks.total) {
    if (prerequisites.pass) return { summary: "Ready to close", blockers, closeStartPrerequisitesPass: true }
    blockers.push(...prerequisites.blockers)
    return { summary: "Implementation complete · blocked", blockers, closeStartPrerequisitesPass: false }
  }
  // Tasks incomplete, unknown, or runs live: implementation in progress.
  blockers.push(...prerequisites.blockers)
  return { summary: "In implementation", blockers, closeStartPrerequisitesPass: false }
}

/**
 * The shared assessment (design D5): every consumer of lifecycle facts —
 * board rows, specs viewer menus, launcher review, publication, close —
 * renders these actions and reasons, so eligibility rules have exactly one
 * definition (task 2.5).
 */
export function assessLifecycle(observations: LifecycleObservations): LifecycleAssessment {
  const { summary, blockers, closeStartPrerequisitesPass } = summarize(observations)
  const tasks = totalTasks(observations.contracts)
  const liveRuns = observations.execution.kind === "known" ? observations.execution.liveRunIds.length : 0
  const featureId = observations.feature?.featureId
  const actions: LifecycleAction[] = []

  const canClose = closeStartPrerequisitesPass
  actions.push({
    id: "close",
    label: "Close review",
    applicable: observations.feature !== undefined,
    enabled: canClose,
    blockers: canClose ? [] : blockers,
    remediation: canClose
      ? []
      : blockers.map((blocker) => `resolve: ${blocker}`),
    ...(featureId ? { target: { featureId } } : {}),
  })
  actions.push({
    id: "continue",
    label: "Continue implementation",
    applicable: observations.feature !== undefined && observations.context.verification === "verified",
    enabled: observations.feature !== undefined && observations.context.verification === "verified",
    blockers: observations.context.verification === "verified" ? [] : [observations.context.reason ?? "context not verified"],
    remediation: [],
    ...(featureId ? { target: { featureId } } : {}),
  })
  // Authoring actions (capability work-context/work-conversations): a
  // verified context can host a conversation; proposing is offered whenever
  // the project workflow can run in that checkout — for pre-proposal work it
  // is the primary action, for contract-bearing work it creates the next
  // candidate for explicit association review.
  const contextVerified = observations.context.verification === "verified"
  actions.push({
    id: "converse",
    label: "Open conversation",
    applicable: observations.feature !== undefined && contextVerified,
    enabled: observations.feature !== undefined && contextVerified,
    blockers: contextVerified ? [] : [observations.context.reason ?? "context not verified"],
    remediation: [],
    ...(featureId ? { target: { featureId } } : {}),
  })
  actions.push({
    id: "propose",
    label: observations.contracts.length === 0 ? "Propose a change" : "Propose next change",
    applicable: observations.feature !== undefined && contextVerified,
    enabled: observations.feature !== undefined && contextVerified,
    blockers: contextVerified ? [] : [observations.context.reason ?? "context not verified"],
    remediation: [],
    ...(featureId ? { target: { featureId } } : {}),
  })
  actions.push({
    id: "adopt",
    label: "Adopt this work",
    applicable: observations.feature === undefined,
    enabled: observations.feature === undefined,
    blockers: observations.feature === undefined ? [] : ["already associated with a registered feature"],
    remediation: [],
  })
  actions.push({
    id: "bind",
    label: "Rebind context",
    applicable: observations.feature !== undefined && observations.context.verification !== "verified",
    enabled: observations.feature !== undefined && observations.context.verification !== "missing",
    blockers: observations.context.verification === "missing" ? ["the recorded context is gone; rebind requires an existing checkout"] : [],
    remediation: observations.context.verification === "missing" ? ["run `convoy feature bind <feature-id> --branch <name> --worktree <path>` from the surviving checkout"] : [],
    ...(featureId ? { target: { featureId } } : {}),
  })
  actions.push({
    id: "archive-on-main",
    label: "Archive on main",
    applicable: observations.integration === "probable" && observations.contracts.some((contract) => contract.state === "active"),
    enabled: true,
    blockers: [],
    remediation: [],
    ...(featureId ? { target: { featureId } } : {}),
  })
  actions.push({
    id: "push",
    label: "Push base",
    applicable: observations.integration === "verified",
    enabled: observations.publication.kind === "known" ? observations.publication.upstream !== undefined : false,
    blockers: observations.publication.kind === "known" && observations.publication.upstream === undefined ? ["the base branch has no configured upstream"] : [],
    remediation: observations.publication.kind === "known" && observations.publication.upstream === undefined ? ["configure an upstream for the base branch (`git push -u <remote> <base>`)"] : [],
    ...(featureId ? { target: { featureId } } : {}),
  })
  actions.push({
    id: "history",
    label: "Open history",
    applicable: true,
    enabled: true,
    blockers: [],
    remediation: [],
  })
  actions.push({
    id: "spin",
    label: "Spin out",
    applicable: observations.feature === undefined && observations.contracts.some((contract) => contract.state === "active"),
    enabled: true,
    blockers: [],
    remediation: [],
  })

  return { summary, ...(tasks === "unknown" ? { tasks: "unknown" as const } : { tasks }), liveRuns, contracts: observations.contracts, integration: observations.integration, actions, closeStartPrerequisitesPass, blockers }
}
