import { afterEach, describe, expect, test } from "bun:test"

import { connectOpencode } from "../src/opencode"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("connectOpencode", () => {
  test("sends SDK requests to the provided base URL", async () => {
    const urls: string[] = []
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        urls.push(input instanceof Request ? input.url : String(input))
        return Response.json({ location: { directory: "/repo" }, data: [] })
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    await connectOpencode("http://127.0.0.1:54321/custom").provider.list({ directory: "/repo" })

    // The boundary issues the split V2 provider/model inventory against the
    // caller's base URL, never the process default.
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((url) => url.startsWith("http://127.0.0.1:54321/custom/"))).toBe(true)
  })
})
