import { describe, expect, test } from "bun:test"

import { listModels } from "../src/model-catalog"
import type { Provider } from "../src/opencode-client"

type CatalogDeps = NonNullable<Parameters<typeof listModels>[1]>
type SdkScenario = "success" | "empty" | "error" | "reject" | "list-reject"
type FetchScenario = "success" | "empty" | "non-ok" | "reject"

const provider = {
  id: "anthropic",
  name: "Anthropic",
  source: "config",
  env: [],
  options: {},
  models: {
    "claude-sonnet-4-5": {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      providerID: "anthropic",
      api: { id: "claude-sonnet-4-5", url: "https://api.anthropic.test", npm: "@ai-sdk/anthropic" },
      status: "active",
      limit: { context: 200_000, output: 8_192 },
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      options: {},
      headers: {},
      release_date: "2025-09-29",
      variants: {},
    },
  },
} satisfies Provider

function createHarness(sdk: SdkScenario, fallback: FetchScenario) {
  const calls = {
    start: 0,
    list: 0,
    close: 0,
    fetch: 0,
    directories: [] as string[],
    sdkSignals: [] as AbortSignal[],
    fetchSignals: [] as AbortSignal[],
  }

  const deps: CatalogDeps = {
    async startOpencode(_config, signal) {
      calls.start++
      calls.sdkSignals.push(signal)
      if (sdk === "reject") throw new Error("SDK unavailable")

      return {
        client: {
          provider: {
            async list({ directory }) {
              calls.list++
              calls.directories.push(directory)
              if (sdk === "list-reject") throw new Error("provider request failed")
              if (sdk === "error") return { error: new Error("provider list error") }
              if (sdk === "empty") return { data: { all: [], connected: [] } }
              return { data: { all: [provider], connected: ["anthropic"] } }
            },
          },
        },
        close() {
          calls.close++
        },
      }
    },
    async fetch(url, { signal }) {
      calls.fetch++
      calls.fetchSignals.push(signal)
      expect(url).toBe("https://models.dev/api.json")
      if (fallback === "reject") throw new Error("network failure")
      if (fallback === "non-ok") return new Response(null, { status: 500 })
      if (fallback === "empty") return Response.json({})
      return Response.json({ fallback: { models: { "model-1": { name: "Fallback Model" } } } })
    },
  }

  return { calls, deps }
}

describe("listModels SDK catalog", () => {
  test("returns connected SDK models, forwards the directory, and closes the handle", async () => {
    const { calls, deps } = createHarness("success", "empty")

    const choices = await listModels("/test/repo", deps)

    expect(choices).toEqual([
      {
        value: "anthropic/claude-sonnet-4-5",
        label: "Claude Sonnet 4.5",
        providerID: "anthropic",
        contextK: 200,
      },
    ])
    expect(calls.directories).toEqual(["/test/repo"])
    expect(calls.close).toBe(1)
    expect(calls.fetch).toBe(0)
    expect(calls.sdkSignals[0]).toBeInstanceOf(AbortSignal)
  })

  test("does not read or populate the process cache when custom dependencies are supplied", async () => {
    const { calls, deps } = createHarness("success", "empty")

    const first = await listModels("/first", deps)
    const second = await listModels("/second", deps)

    expect(second).not.toBe(first)
    expect(calls.start).toBe(2)
    expect(calls.list).toBe(2)
    expect(calls.close).toBe(2)
    expect(calls.directories).toEqual(["/first", "/second"])
  })
})

describe("listModels fallback", () => {
  test("falls back to models.dev when starting the SDK rejects", async () => {
    const { calls, deps } = createHarness("reject", "success")

    expect((await listModels("/test", deps)).map((choice) => choice.value)).toEqual(["fallback/model-1"])
    expect(calls).toMatchObject({ start: 1, list: 0, close: 0, fetch: 1 })
    expect(calls.fetchSignals[0]).toBeInstanceOf(AbortSignal)
  })

  test("falls back when the SDK returns no models", async () => {
    const { calls, deps } = createHarness("empty", "success")

    expect((await listModels("/test", deps)).map((choice) => choice.value)).toEqual(["fallback/model-1"])
    expect(calls).toMatchObject({ close: 1, fetch: 1 })
  })

  test("falls back and closes the handle when the SDK returns an error", async () => {
    const { calls, deps } = createHarness("error", "success")

    expect((await listModels("/test", deps)).map((choice) => choice.value)).toEqual(["fallback/model-1"])
    expect(calls).toMatchObject({ close: 1, fetch: 1 })
  })

  test("falls back and closes the handle when listing providers rejects", async () => {
    const { calls, deps } = createHarness("list-reject", "success")

    expect((await listModels("/test", deps)).map((choice) => choice.value)).toEqual(["fallback/model-1"])
    expect(calls).toMatchObject({ list: 1, close: 1, fetch: 1 })
  })
})

describe("listModels source failures", () => {
  test("returns an empty array when both sources reject", async () => {
    const { deps } = createHarness("reject", "reject")
    expect(await listModels("/test", deps)).toEqual([])
  })

  test("returns an empty array when models.dev returns non-ok", async () => {
    const { deps } = createHarness("reject", "non-ok")
    expect(await listModels("/test", deps)).toEqual([])
  })

  test("returns an empty array when models.dev has no models", async () => {
    const { deps } = createHarness("reject", "empty")
    expect(await listModels("/test", deps)).toEqual([])
  })
})
