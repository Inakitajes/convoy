/**
 * Effective capability resolution (changes `runner-parity-opencode-v2` task 8.1
 * and `unify-runner-system` task 1.7).
 *
 * Capabilities are described, not brand booleans: the runner's own declaration
 * (`declarations.ts`) is authoritative, and runtime/auth/enforcement evidence
 * decides which declared capabilities are restricted. There is no second
 * brand-based table, so the surface preflight quotes and the one the running
 * adapter honors cannot disagree.
 */

import { runnerDescriptor } from "./descriptors"
import type {
  Capability,
  CapabilityDeclaration,
  CapabilityEvidence,
  CapabilityId,
  RunnerCapabilities,
  RunnerId,
  ServiceId,
  SessionOperation,
} from "./contracts"

/** Runtime/auth/enforcement evidence; same shape as the contract's `CapabilityEvidence`. */
export type CapabilityInput = CapabilityEvidence

/** The authoritative declaration for a runner, from its descriptor. */
export function declarationFor(runner: RunnerId): CapabilityDeclaration {
  return runnerDescriptor(runner).declaration
}

function reasonText(value: string | ((evidence: CapabilityEvidence) => string), evidence: CapabilityEvidence): string {
  return typeof value === "function" ? value(evidence) : value
}

/**
 * Resolves a declaration into described capabilities: an id hit by a matching
 * evidence rule or an unconditional restriction becomes `restricted`, an
 * unavailable id stays `unavailable`, and every other declared id is
 * `available` with its disclosed semantics.
 */
export function resolveEffectiveCapabilities(declaration: CapabilityDeclaration, evidence: CapabilityInput = {}): RunnerCapabilities {
  const capabilities: Capability[] = declaration.available.map((id) => {
    const rule = declaration.restrictions?.find((candidate) => candidate.ids.includes(id) && candidate.when(evidence))
    if (rule) {
      return {
        id,
        availability: "restricted",
        reason: reasonText(rule.reason, evidence),
        ...(rule.remediation ? { remediation: reasonText(rule.remediation, evidence) } : {}),
      }
    }
    const semantics = declaration.semantics?.[id]
    return { id, availability: "available", ...(semantics ? { semantics } : {}) }
  })
  for (const entry of declaration.restricted ?? []) {
    capabilities.push({ id: entry.id, availability: "restricted", reason: entry.reason, ...(entry.remediation ? { remediation: entry.remediation } : {}) })
  }
  for (const entry of declaration.unavailable ?? []) {
    capabilities.push({ id: entry.id, availability: "unavailable", reason: entry.reason, ...(entry.remediation ? { remediation: entry.remediation } : {}) })
  }
  return { runner: declaration.runner, ...(evidence.version ? { version: evidence.version } : {}), capabilities }
}

/** The effective capabilities for a runner, from its declaration and evidence. */
export function resolveRunnerCapabilities(runner: RunnerId, input: CapabilityInput = {}): RunnerCapabilities {
  return resolveEffectiveCapabilities(declarationFor(runner), input)
}

/** True when a required capability is fully available for the selection. */
export function capabilityAvailable(resolved: RunnerCapabilities, id: CapabilityId): boolean {
  return resolved.capabilities.some((entry) => entry.id === id && entry.availability === "available")
}

/** Maps an optional service to the capability that advertises it. */
const serviceCapability: Record<ServiceId, CapabilityId> = {
  approvals: "approvals",
  deliverables: "structured-deliverables",
  advisor: "advisor-bridge",
  "loop-guard": "loop-guard",
}

export function supportsService(resolved: RunnerCapabilities, service: ServiceId): boolean {
  return capabilityAvailable(resolved, serviceCapability[service])
}

export class UnsupportedServiceError extends Error {
  constructor(
    readonly runner: RunnerId,
    readonly service: ServiceId,
  ) {
    super(`runner ${runner} does not implement the ${service} service`)
    this.name = "UnsupportedServiceError"
  }
}

/** Refuses a plan that requires a service the runner does not implement. */
export function assertServicesSupported(resolved: RunnerCapabilities, required: readonly ServiceId[]): void {
  for (const service of required) {
    if (!supportsService(resolved, service)) throw new UnsupportedServiceError(resolved.runner, service)
  }
}

/** Selects a subset of services the runner supports (drops unsupported). */
export function filterSupportedServices<T extends Partial<Record<ServiceId, unknown>>>(
  resolved: RunnerCapabilities,
  services: T,
): { supported: Partial<T>; unsupported: ServiceId[] } {
  const supported: Partial<T> = {}
  const unsupported: ServiceId[] = []
  for (const service of Object.keys(services) as ServiceId[]) {
    if (services[service] === undefined) continue
    if (supportsService(resolved, service)) (supported as Record<string, unknown>)[service] = services[service]
    else unsupported.push(service)
  }
  return { supported, unsupported }
}

/** Maps a session operation to the capability that advertises it. */
const sessionCapability: Record<SessionOperation, CapabilityId> = {
  history: "session-history",
  resume: "post-exit-resume",
  attach: "native-live-attach",
}

export function supportsSessionOperation(resolved: RunnerCapabilities, operation: SessionOperation): boolean {
  return capabilityAvailable(resolved, sessionCapability[operation])
}

export class UnsupportedSessionOperationError extends Error {
  constructor(
    readonly runner: RunnerId,
    readonly operation: SessionOperation,
  ) {
    super(`runner ${runner} does not support the ${operation} session operation`)
    this.name = "UnsupportedSessionOperationError"
  }
}

/** Refuses a session operation the selected runner cannot honor. */
export function assertSessionOperationSupported(resolved: RunnerCapabilities, operation: SessionOperation): void {
  if (!supportsSessionOperation(resolved, operation)) {
    throw new UnsupportedSessionOperationError(resolved.runner, operation)
  }
}
