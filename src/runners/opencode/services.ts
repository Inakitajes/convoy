/**
 * OpenCode service binding.
 *
 * The engine owns Convoy's runtimes (report bridge, advisor bridge, loop
 * guard); this binds the ones OpenCode honors to the attempt's session, so
 * core never names an OpenCode transport. Only services the resolved
 * capabilities advertise are bound.
 */

import { supportsService } from "../capabilities"
import type { ExecutionServices, RunnerCapabilities } from "../contracts"
import type { ServiceRuntimes } from "../service-runtimes"
import { createOpencodeAdvisorService } from "./advisor"
import { createOpencodeDeliverableService } from "./deliverables"
import { createOpencodeLoopGuardService } from "./loop-guard"

export function bindOpencodeServices(runtimes: ServiceRuntimes, capabilities: RunnerCapabilities): ExecutionServices {
  const services: ExecutionServices = {}
  if (supportsService(capabilities, "loop-guard")) services.loopGuard = createOpencodeLoopGuardService(runtimes.loopGuard)
  if (runtimes.advisors && supportsService(capabilities, "advisor")) {
    services.advisor = createOpencodeAdvisorService({ runtime: runtimes.advisors, session: runtimes.session })
  }
  if (runtimes.reports && supportsService(capabilities, "deliverables")) {
    services.deliverables = createOpencodeDeliverableService({
      runtime: runtimes.reports,
      session: runtimes.session,
      expected: runtimes.expected,
      ...(runtimes.accepts ? { accepts: runtimes.accepts } : {}),
    })
  }
  return services
}
