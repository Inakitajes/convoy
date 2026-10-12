import { describe, expect, test } from "bun:test"

import type { OpencodeClient } from "../src/opencode-client"

import { explainCommand, judgeCommand, parseVerdict } from "../src/safety-judge"

describe("parseVerdict", () => {
  test("reads a clean JSON verdict", () => {
    expect(parseVerdict('{"safe": true, "reason": "read-only listing"}')).toEqual({ safe: true, reason: "read-only listing" })
    expect(parseVerdict('{"safe": false, "reason": "rm -rf is destructive"}')).toEqual({ safe: false, reason: "rm -rf is destructive" })
  })

  test("tolerates code fences and surrounding prose", () => {
    const fenced = "Here is my call:\n```json\n{\"safe\": true, \"reason\": \"runs the test suite\"}\n```\nDone."
    expect(parseVerdict(fenced)).toEqual({ safe: true, reason: "runs the test suite" })
  })

  test("supplies a default reason when missing", () => {
    expect(parseVerdict('{"safe": true}')).toEqual({ safe: true, reason: "judged safe" })
    expect(parseVerdict('{"safe": false, "reason": "   "}')).toEqual({ safe: false, reason: "judged unsafe" })
  })

  test("fails closed on unparseable or non-boolean answers", () => {
    expect(parseVerdict("")).toBeUndefined()
    expect(parseVerdict("looks fine to me")).toBeUndefined()
    expect(parseVerdict("{ not json")).toBeUndefined()
    expect(parseVerdict('{"safe": "yes"}')).toBeUndefined()
    expect(parseVerdict("[]")).toBeUndefined()
  })
})

type FakeClientOptions = {
  promptText?: string
  promptThrows?: boolean
  promptHangs?: boolean
  onDelete?: (id: string) => void
  onCreate?: (input: unknown) => void
}

function fakeClient(opts: FakeClientOptions): OpencodeClient {
  return {
    session: {
      create: async (input: unknown) => {
        opts.onCreate?.(input)
        return { data: { id: "judge-session" }, error: undefined }
      },
      prompt: async (_args: unknown, { signal }: { signal?: AbortSignal } = {}) => {
        if (opts.promptThrows) throw new Error("provider unavailable")
        if (opts.promptHangs) {
          // Never resolves on its own; the timeout fires the abort and the SDK
          // rejects with the abort reason ("safety judge timed out").
          return new Promise<never>((_resolve, reject) => {
            if (!signal) return
            if (signal.aborted) reject(signal.reason)
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          })
        }
        return { data: { info: {}, parts: [{ type: "text", text: opts.promptText ?? "" }] }, error: undefined }
      },
      delete: async ({ sessionID }: { sessionID: string }) => {
        opts.onDelete?.(sessionID)
        return { data: undefined, error: undefined }
      },
    },
  } as unknown as OpencodeClient
}

const request = { permission: "bash", command: "ls -la" }
const model = { providerID: "openai", modelID: "gpt-5.5" }

describe("judgeCommand", () => {
  test("opens a tool-less judge session (V2 denies every action at creation)", async () => {
    let createInput: unknown
    const client = fakeClient({ promptText: '{"safe": true}', onCreate: (input) => { createInput = input } })
    await judgeCommand(client, { request, model, directory: "/tmp" })
    expect((createInput as { permissions?: Array<{ action: string; resource: string; effect: string }> }).permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
    ])
  })

  test("returns the model's verdict on a clean answer", async () => {
    const client = fakeClient({ promptText: '{"safe": true, "reason": "lists files"}' })
    expect(await judgeCommand(client, { request, model, directory: "/tmp" })).toEqual({ safe: true, reason: "lists files" })
  })

  test("fails closed when the judge call throws", async () => {
    const client = fakeClient({ promptThrows: true })
    const verdict = await judgeCommand(client, { request, model, directory: "/tmp" })
    expect(verdict.safe).toBe(false)
    expect(verdict.reason).toContain("safety check failed")
  })

  test("fails closed when the answer is unparseable", async () => {
    const client = fakeClient({ promptText: "I think it is probably fine" })
    expect((await judgeCommand(client, { request, model, directory: "/tmp" })).safe).toBe(false)
  })

  test("cleans up the throwaway session", async () => {
    let deleted: string | undefined
    const client = fakeClient({ promptText: '{"safe": true}', onDelete: (id) => (deleted = id) })
    await judgeCommand(client, { request, model, directory: "/tmp" })
    expect(deleted).toBe("judge-session")
  })
})

describe("explainCommand", () => {
  test("returns the model's prose explanation", async () => {
    const client = fakeClient({ promptText: "This command lists files in the current directory. It is safe because it is read-only and does not modify any data." })
    const text = await explainCommand(client, { request, model, directory: "/tmp" })
    expect(text).toContain("lists files")
    expect(text).toContain("read-only")
  })

  test("cleans up the throwaway session", async () => {
    let deleted: string | undefined
    const client = fakeClient({ promptText: "safe command", onDelete: (id) => (deleted = id) })
    await explainCommand(client, { request, model, directory: "/tmp" })
    expect(deleted).toBe("judge-session")
  })

  test("returns a readable fallback on error, does not throw", async () => {
    const client = fakeClient({ promptThrows: true })
    const text = await explainCommand(client, { request, model, directory: "/tmp" })
    expect(text).toContain("the judge could not explain it")
  })

  test("returns a readable fallback on timeout", async () => {
    // A prompt that hangs until the abort fires: the timeout expires and the
    // SDK rejects with the abort reason ("safety judge timed out").
    const client = fakeClient({ promptHangs: true })
    const text = await explainCommand(client, { request, model, directory: "/tmp", timeoutMs: 50 })
    expect(text).toContain("the judge could not explain it (timed out)")
  })

  test("includes verdictReason in the rendered request when provided", async () => {
    let capturedText = ""
    const client: OpencodeClient = {
      session: {
        create: async () => ({ data: { id: "judge-session" }, error: undefined }),
        prompt: async ({ parts }: { parts: Array<{ type: string; text?: string }> }) => {
          capturedText = parts.find((p) => p.type === "text")?.text ?? ""
          return { data: { info: {}, parts: [{ type: "text", text: "explanation" }] }, error: undefined }
        },
        delete: async ({ sessionID }: { sessionID: string }) => {
          return { data: undefined, error: undefined }
        },
      },
    } as unknown as OpencodeClient
    await explainCommand(client, { request, model, directory: "/tmp", verdictReason: "deletes files" })
    expect(capturedText).toContain("deletes files")
    expect(capturedText).toContain("previously escalated")
  })
})
