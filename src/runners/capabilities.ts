/**
 * Effective capability resolution (change `runner-parity-opencode-v2`, task 8.1).
 *
 * Capabilities are described, not brand booleans: they depend on the resolved
 * runtime, the requested authentication, and whether mandatory enforcement is
 * installed. Core calls this to decide which selections are allowed, instead of
 * hardcoding "Claude cannot write".
 */

import type { AuthenticationSelection, Capability, CapabilityId, RunnerCapabilities, RunnerId, ServiceId } from "./contracts"

export type CapabilityInput = {
  /** Resolved harness version, when known. */
  version?: string
  auth?: AuthenticationSelection
  /** Whether the mandatory enforcement machinery is installed and healthy. */
  enforcementReady?: boolean
}

const opencodeCapabilities: readonly CapabilityId[] = [
  "read-only",
  "write",
  "verify",
  "model-fanout",
  "parallel",
  "approvals",
  "structured-deliverables",
  "advisor-bridge",
  "live-observation",
  "native-live-attach",
  "explicit-handoff",
  "post-exit-resume",
  "usage-reporting",
  "loop-guard",
]

const claudeAvailable: readonly CapabilityId[] = [
  "read-only",
  "write",
  "verify",
  "model-fanout",
  "parallel",
  "approvals",
  "structured-deliverables",
  "advisor-bridge",
  "live-observation",
  "post-exit-resume",
]

const available = (id: CapabilityId, semantics?: string): Capability => ({ id, availability: "available", ...(semantics ? { semantics } : {}) })
const restricted = (id: CapabilityId, reason: string, remediation?: string): Capability => ({
  id,
  availability: "restricted",
  reason,
  ...(remediation ? { remediation } : {}),
})

function supportedMajor(version?: string): number | undefined {
  if (!version) return undefined
  const major = Number(version.split(".")[0])
  return Number.isInteger(major) ? major : undefined
}

export function resolveRunnerCapabilities(runner: RunnerId, input: CapabilityInput = {}): RunnerCapabilities {
  if (runner === "opencode") {
    const major = supportedMajor(input.version)
    if (major !== undefined && major !== 2) {
      return {
        runner,
        ...(input.version ? { version: input.version } : {}),
        capabilities: opencodeCapabilities.map((id) => restricted(id, `OpenCode ${input.version} is not a supported V2 runtime`)),
      }
    }
    return {
      runner,
      ...(input.version ? { version: input.version } : {}),
      capabilities: opencodeCapabilities.map((id) => available(id)),
    }
  }

  const capabilities: Capability[] = []
  for (const id of claudeAvailable) {
    if (id === "approvals" && input.enforcementReady === false) {
      capabilities.push(restricted(id, "mandatory enforcement (hook + permission host) is not installed"))
      continue
    }
    capabilities.push(available(id, id === "live-observation" ? "streamed to the coordinator; not a native attach" : undefined))
  }
  capabilities.push({ id: "native-live-attach", availability: "unavailable", reason: "print mode has no attachable live session" })
  capabilities.push(restricted("explicit-handoff", "requires a verified quiesced handoff", "use post-exit resume or observe"))
  capabilities.push(available("usage-reporting", "subscription values are estimates"))
  return { runner, ...(input.version ? { version: input.version } : {}), capabilities }
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
