import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { bootOwnedServer } from "../src/runners/opencode/boot"
import { createSession, createV2Client, listMessages, sendPrompt, waitForIdle } from "../src/runners/opencode/v2-client"

/**
 * Opt-in live prompt acceptance against the authorized free model. Gated so the
 * ordinary suite stays offline and deterministic; run with:
 *   CONVOY_V2_LIVE=1 bun test test/runner-opencode-v2-live.test.ts
 */
const live = process.env.CONVOY_V2_LIVE === "1"

describe.if(live)("opencode v2 live prompt (nan/deepseek-v4-flash)", () => {
  test("admits a prompt, waits for idle, and records an assistant message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-live-"))
    const server = await bootOwnedServer({ cwd: dir })
    try {
      const client = createV2Client({ baseUrl: server.url, password: server.password })
      const session = await createSession(client, { directory: dir, title: "convoy live acceptance" })
      await sendPrompt(client, {
        sessionID: session.id,
        text: "Reply with exactly: OK",
        model: { providerID: "nan", modelID: "deepseek-v4-flash" },
      })
      await waitForIdle(client, session.id)
      const messages = await listMessages(client, session.id)
      const hasAssistant = messages.data.some((entry) => (entry as { type?: unknown }).type === "assistant")
      const hasIdle = messages.data.some((entry) => (entry as { type?: unknown }).type === "idle")
      // Admission + completion signalling, independent of whether the provider
      // could serve the turn (this model does not support tool use).
      expect(hasAssistant).toBe(true)
      expect(hasIdle).toBe(true)
    } finally {
      await server.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
