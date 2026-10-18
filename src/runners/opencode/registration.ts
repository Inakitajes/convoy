/**
 * OpenCode's registration in the runner composition.
 *
 * An OpenCode attempt runs on the run's own server, which the engine owns
 * (boot, plugins, permission gate, shutdown), through `executeOpencodeAttempt`
 * — so the registry only needs OpenCode's resolved capabilities, the same
 * declaration preflight and config validation read.
 */

import { resolveEffectiveCapabilities } from "../capabilities"
import type { CapabilitySource, RunnerCapabilities } from "../contracts"
import { opencodeDeclaration } from "../declarations"

/** OpenCode's effective capabilities, optionally for an observed CLI version. */
export function opencodeCapabilities(version?: string): RunnerCapabilities {
  return resolveEffectiveCapabilities(opencodeDeclaration, version ? { version } : {})
}

export function createOpencodeRegistration(): CapabilitySource {
  return {
    id: "opencode",
    async capabilities() {
      return opencodeCapabilities()
    },
  }
}
