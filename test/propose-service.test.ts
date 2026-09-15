import { describe, expect, test } from "bun:test"

import { findProposalCommand, startProposalCommand, type ProposalCommandDeps } from "../src/propose-service"

/**
 * Proposal-command ownership (change fix-opencode-server-lifecycle, design
 * D1/D6). These tests fail if the discovery helper is not stopped on an early
 * return or if the independent service is not established before the command
 * runs.
 */

function recorder(overrides: Partial<ProposalCommandDeps> = {}) {
  const events: string[] = []
  const base: ProposalCommandDeps = {
    listCommands: async () => {
      events.push("list")
      return ["opsx-propose"]
    },
    transfer: async () => {
      events.push("transfer")
      return { status: "live" as const, url: "http://service" }
    },
    stopHelper: async () => {
      events.push("stopHelper")
    },
    acquireClaim: async () => {
      events.push("claim")
      return { ok: true as const }
    },
    releaseClaim: async () => {
      events.push("releaseClaim")
    },
    createConversation: async () => {
      events.push("create")
      return { harness: "opencode" as const, sessionId: "ses_1" }
    },
    invokeCommand: async ({ command }) => {
      events.push(`invoke:${command}`)
    },
  }
  return { events, deps: { ...base, ...overrides } }
}

const helper = { kind: "helper", url: "http://helper" } as const
const independent = { kind: "independent", url: "http://service" } as const

describe("findProposalCommand", () => {
  test("prefers opsx-propose over any other propose-suffixed command", () => {
    expect(findProposalCommand(["propose", "opsx-propose"])).toBe("opsx-propose")
    expect(findProposalCommand(["help", "my-propose"])).toBe("my-propose")
    expect(findProposalCommand(["help"])).toBeUndefined()
  })
})

describe("startProposalCommand fallback ownership", () => {
  test("unknown command discovery stops the helper and never claims or invokes", async () => {
    const { events, deps } = recorder({
      listCommands: async () => {
        events.push("list")
        return "unknown"
      },
    })
    const outcome = await startProposalCommand(helper, deps)
    expect(outcome.status).toBe("blocked")
    expect(events).toEqual(["list", "stopHelper"])
    if (outcome.status === "blocked") expect(outcome.reason).toContain("could not be discovered")
  })

  test("no supported command stops the helper", async () => {
    const { events, deps } = recorder({
      listCommands: async () => {
        events.push("list")
        return ["help"]
      },
    })
    const outcome = await startProposalCommand(helper, deps)
    expect(outcome.status).toBe("blocked")
    expect(events).toEqual(["list", "stopHelper"])
  })

  test("a failed independent-service transfer stops the helper and releases the claim before blocking", async () => {
    const { events, deps } = recorder({
      transfer: async () => {
        events.push("transfer")
        return { status: "unavailable" as const, reason: "publish failed" }
      },
    })
    const outcome = await startProposalCommand(helper, deps)
    expect(outcome.status).toBe("blocked")
    // The helper is stopped before the claim is released, and the command
    // never runs.
    expect(events).toEqual(["list", "claim", "transfer", "stopHelper", "releaseClaim"])
    if (outcome.status === "blocked") expect(outcome.reason).toContain("publish failed")
  })

  test("a successful transfer stops the unused helper and invokes under the independent service", async () => {
    const { events, deps } = recorder()
    const outcome = await startProposalCommand(helper, deps)
    expect(outcome.status).toBe("started")
    // Transfer strictly precedes command invocation; the helper is stopped
    // before either the conversation is created or the command runs.
    expect(events).toEqual(["list", "claim", "transfer", "stopHelper", "create", "invoke:opsx-propose"])
    expect(events.indexOf("transfer")).toBeLessThan(events.indexOf("invoke:opsx-propose"))
    expect(events.indexOf("stopHelper")).toBeLessThan(events.indexOf("invoke:opsx-propose"))
    if (outcome.status === "started") expect(outcome.service.url).toBe("http://service")
  })

  test("an independent service is used as-is: no transfer and no helper stop", async () => {
    const { events, deps } = recorder()
    const outcome = await startProposalCommand(independent, deps)
    expect(outcome.status).toBe("started")
    expect(events).toEqual(["list", "claim", "create", "invoke:opsx-propose"])
    expect(events).not.toContain("transfer")
    expect(events).not.toContain("stopHelper")
    if (outcome.status === "started") expect(outcome.service.url).toBe("http://service")
  })

  test("a lost writer claim stops the helper before blocking", async () => {
    const { events, deps } = recorder({
      acquireClaim: async () => {
        events.push("claim")
        return { ok: false as const, reason: "a managed writer already owns this checkout", remediation: ["stop it first"] }
      },
    })
    const outcome = await startProposalCommand(helper, deps)
    expect(outcome.status).toBe("blocked")
    expect(events).toEqual(["list", "claim", "stopHelper"])
    if (outcome.status === "blocked") {
      expect(outcome.reason).toContain("managed writer")
      expect(outcome.remediation).toEqual(["stop it first"])
    }
  })

  test("a throwing discovery still stops the owned helper before the error escapes", async () => {
    let stops = 0
    const { deps } = recorder({
      listCommands: async () => {
        throw new Error("command discovery exploded")
      },
      stopHelper: async () => {
        stops += 1
      },
    })
    await expect(startProposalCommand(helper, deps)).rejects.toThrow("command discovery exploded")
    // The pre-claim path now shares the function-level finally, so a throw
    // can never skip the owned helper's bounded stop.
    expect(stops).toBe(1)
  })

  test("a throwing writer-claim acquisition still stops the owned helper", async () => {
    let stops = 0
    const { deps } = recorder({
      acquireClaim: async () => {
        throw new Error("claim store unavailable")
      },
      stopHelper: async () => {
        stops += 1
      },
    })
    await expect(startProposalCommand(helper, deps)).rejects.toThrow("claim store unavailable")
    expect(stops).toBe(1)
  })

  test("a conversation failure after a successful transfer stops the helper once and releases the claim", async () => {
    let stops = 0
    const { events, deps } = recorder({
      stopHelper: async () => {
        stops += 1
        events.push("stopHelper")
      },
      createConversation: async () => {
        events.push("create")
        throw new Error("session create failed")
      },
    })
    const outcome = await startProposalCommand(helper, deps)
    expect(outcome.status).toBe("blocked")
    expect(stops).toBe(1)
    expect(events).toEqual(["list", "claim", "transfer", "stopHelper", "create", "releaseClaim"])
    if (outcome.status === "blocked") expect(outcome.reason).toContain("session create failed")
  })
})
