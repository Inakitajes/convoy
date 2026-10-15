import { describe, expect, test } from "bun:test"

import { PermissionLedger } from "../src/runners/permission-scope"
import { createOpencodeApprovalService } from "../src/runners/opencode/approvals"
import type { PolicyConfig } from "../src/runners/policy"

const identity = { runId: "run-1", phaseName: "implement", attempt: 1 }

function service(policy: PolicyConfig, extra: Partial<Parameters<typeof createOpencodeApprovalService>[0]> = {}) {
  return createOpencodeApprovalService({ policy, identity, ...extra })
}

const writePolicy: PolicyConfig = { mode: "write", approvals: "auto" }
const interactive: PolicyConfig = { mode: "write", approvals: "interactive" }

describe("OpenCode approval service", () => {
  test("a hard deny takes precedence over an ask that would allow", async () => {
    const approvals = service(
      { mode: "write", approvals: "interactive", hardDeny: [{ intent: "execute" }] },
      { ask: async () => "allow" },
    )
    expect(await approvals.decide({ requestId: "r1", tool: "bash", action: "execute", resources: ["rm -rf /"] })).toBe("deny")
  })

  test("a policy deny is returned without a decider", async () => {
    const approvals = service({ mode: "read-only", approvals: "interactive" })
    expect(await approvals.decide({ requestId: "r1", tool: "edit", action: "write" })).toBe("deny")
  })

  test("an auto-approved action is allowed", async () => {
    const approvals = service(writePolicy)
    expect(await approvals.decide({ requestId: "r1", tool: "edit", action: "write" })).toBe("allow")
  })

  test("an eligible ask is settled by the decider and is no longer pending", async () => {
    const approvals = service(interactive, { ask: async () => "allow" })
    expect(await approvals.decide({ requestId: "r1", tool: "edit", action: "write" })).toBe("allow")
    expect(approvals.isPending("r1")).toBe(false)
  })

  test("an ask with no decider fails closed", async () => {
    const approvals = service(interactive)
    expect(await approvals.decide({ requestId: "r1", tool: "edit", action: "write" })).toBe("deny")
  })

  test("a request can be cancelled while it is pending", async () => {
    let release: (outcome: "allow") => void = () => {}
    const pending = new Promise<"allow">((resolve) => {
      release = resolve
    })
    const approvals = service(interactive, { ask: () => pending })
    const deciding = approvals.decide({ requestId: "r1", tool: "edit", action: "write" })
    expect(approvals.isPending("r1")).toBe(true)
    approvals.cancel("r1")
    expect(approvals.isPending("r1")).toBe(false)
    release("allow")
    await deciding
  })

  test("parallel attempts sharing a ledger do not collide on a request id", async () => {
    const ledger = new PermissionLedger()
    const holding = () => new Promise<"allow">(() => {})
    const a = createOpencodeApprovalService({ policy: interactive, identity: { runId: "run-1", phaseName: "build", attempt: 1 }, ledger, ask: holding })
    const b = createOpencodeApprovalService({ policy: interactive, identity: { runId: "run-1", phaseName: "test", attempt: 1 }, ledger, ask: holding })
    void a.decide({ requestId: "r-a", tool: "edit", action: "write" })
    void b.decide({ requestId: "r-b", tool: "edit", action: "write" })
    expect(a.isPending("r-a")).toBe(true)
    expect(b.isPending("r-b")).toBe(true)
    a.cancel("r-a")
    // The sibling attempt's request is untouched.
    expect(a.isPending("r-a")).toBe(false)
    expect(b.isPending("r-b")).toBe(true)
  })
})
