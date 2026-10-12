import { describe, expect, test } from "bun:test"

import type { OpencodeClient } from "../src/opencode-client"

import { startPermissionGate } from "../src/permissions"
import { noopProgress, type PermissionPromptInfo, type PermissionReply, type ProgressUI } from "../src/progress"

type ReplyCall = { reply: PermissionReply; message?: string }

const askedRequest = {
  id: "perm-1",
  sessionID: "sess-1",
  permission: "bash",
  patterns: ["bash"],
  metadata: { command: "ls -la" },
  always: [],
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for gate")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Emits one permission.asked and answers it with a toggleable askPermission:
 * the prompt promise stays open until the test resolves it, exactly what the
 * control adapter will do while no controller is attached.
 */
function holdHarness() {
  const replies: ReplyCall[] = []
  const asked: PermissionPromptInfo[] = []
  let resolveAsk!: (reply: PermissionReply) => void
  const open = new Promise<PermissionReply>((resolve) => {
    resolveAsk = resolve
  })
  let delivered = false

  const client = {
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          if (!delivered) {
            delivered = true
            yield { type: "permission.asked", properties: askedRequest }
          }
        })(),
      }),
    },
    permission: {
      reply: async ({ reply, message }: { reply: PermissionReply; message?: string }) => {
        replies.push({ reply, ...(message ? { message } : {}) })
        return { data: undefined, error: undefined }
      },
    },
    session: { create: async () => ({ data: { id: "judge-session" }, error: undefined }) },
  } as unknown as OpencodeClient

  const progress: ProgressUI = {
    ...noopProgress,
    askPermission: (info) => {
      asked.push(info)
      return open
    },
  }

  return {
    client,
    progress,
    replies,
    asked,
    resolveAsk,
    gate: () =>
      startPermissionGate({
        client,
        progress,
        interactive: false,
        directory: "/tmp",
        autoAccept: { mode: "off" },
      }),
  }
}

describe("permission hold without a TTY or auto-accept", () => {
  test("never auto-rejects while the controller has not answered", async () => {
    const h = holdHarness()
    const gate = h.gate()
    try {
      await waitFor(() => h.asked.length > 0)
      // Give a hypothetical auto-reject branch time to fire; none should.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(h.asked).toHaveLength(1)
      expect(h.replies).toEqual([])
    } finally {
      await gate.stop()
    }
  })

  test("completes with the reply once the controller answers", async () => {
    const h = holdHarness()
    const gate = h.gate()
    try {
      await waitFor(() => h.asked.length > 0)
      expect(h.asked[0]).toMatchObject({ id: "perm-1", permission: "bash", patterns: ["bash"] })

      h.resolveAsk("once")
      await waitFor(() => h.replies.length > 0)
      expect(h.replies).toEqual([{ reply: "once" }])
    } finally {
      await gate.stop()
    }
  })
})
