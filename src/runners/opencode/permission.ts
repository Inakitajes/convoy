/**
 * OpenCode permission mapping (change `runner-parity-opencode-v2`, task 6.2).
 *
 * OpenCode v2 raises `permission.asked` with an action and resources. Mapping
 * those to the same neutral intents Claude uses lets one policy decide both
 * runners, so a hard denial or the first-write checkpoint cannot be bypassed by
 * switching harness.
 */

import { evaluateAction, type ActionIntent, type ActionRequest, type PolicyConfig, type PolicyDecision, type PolicyState } from "../policy"

/** Maps an OpenCode permission action to a neutral intent. */
export function opencodeActionToIntent(action: string): ActionIntent {
  switch (action) {
    case "edit":
    case "write":
    case "patch":
      return "write"
    case "bash":
    case "shell":
      return "execute"
    case "task":
    case "subagent":
      return "delegate"
    case "webfetch":
    case "websearch":
      return "network"
    case "read":
    case "grep":
    case "glob":
    case "list":
    case "view":
      return "read"
    default:
      return "other"
  }
}

/** The neutral action request for an OpenCode permission ask. */
export function toActionRequest(action: string, resources?: readonly string[]): ActionRequest {
  return {
    tool: action,
    intent: opencodeActionToIntent(action),
    ...(resources && resources.length > 0 ? { resource: resources.join(" ") } : {}),
  }
}

/** Convoy's decision for one OpenCode permission ask. */
export function decideOpencodePermission(
  action: string,
  resources: readonly string[] | undefined,
  config: PolicyConfig,
  state?: PolicyState,
): PolicyDecision {
  return evaluateAction(toActionRequest(action, resources), config, state ?? {})
}
