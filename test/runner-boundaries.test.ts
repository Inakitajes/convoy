import { describe, expect, test } from "bun:test"
import { Glob } from "bun"

import { adapterBoundaryPrefix, boundaryViolations, findVendorImports, isAdapterBoundary } from "./helpers/dependency-boundary"

/**
 * Burn-down allowlist: the source modules that still import a vendor package
 * today. It may only shrink -- as each module moves behind the neutral ports it
 * is removed. A new entry is a review failure, not a fix.
 */
const allowlist = [
  "src/advisor-bridge.ts",
  "src/report-bridge.ts",
]

async function readSources(): Promise<{ path: string; text: string }[]> {
  const glob = new Glob("src/**/*.ts")
  const sources: { path: string; text: string }[] = []
  for await (const path of glob.scan({ cwd: process.cwd() })) {
    sources.push({ path, text: await Bun.file(path).text() })
  }
  return sources
}

describe("vendor dependency boundary", () => {
  test("no core module imports a vendor package outside the keep-list", async () => {
    const violations = boundaryViolations(await readSources(), allowlist)
    expect(violations).toEqual([])
  })

  test("the keep-list only names non-adapter modules and never grows silently", () => {
    expect(allowlist.every((path) => !isAdapterBoundary(path))).toBe(true)
    // Ratchet guard: if the count changes, a reviewer must reconcile the diff.
    expect(allowlist.length).toBe(2)
  })

  test("detects a vendor import outside the adapter boundary", () => {
    const violations = boundaryViolations(
      [{ path: "src/runner.ts", text: `import { OpenCode } from "@opencode/client"` }],
      [],
    )
    expect(violations).toEqual([{ path: "src/runner.ts", pkg: "@opencode/client" }])
  })

  test("permits vendor imports inside an adapter boundary", () => {
    const violations = boundaryViolations(
      [{ path: `${adapterBoundaryPrefix}opencode/adapter.ts`, text: `import { OpenCode } from "@opencode/client"` }],
      [],
    )
    expect(violations).toEqual([])
  })

  test("permits a keep-listed module", () => {
    const violations = boundaryViolations(
      [{ path: "src/opencode.ts", text: `import { x } from "@opencode-ai/sdk/v2"` }],
      ["src/opencode.ts"],
    )
    expect(violations).toEqual([])
  })

  test("matches subpath and bare specifiers", () => {
    const found = findVendorImports([
      { path: "src/a.ts", text: `import { y } from "@opencode/schema/session-message"` },
      { path: "src/b.ts", text: `const m = await import("@opencode/plugin")` },
      { path: "src/c.ts", text: `import { z } from "marked"` },
    ])
    expect(found).toEqual([
      { path: "src/a.ts", pkg: "@opencode/schema" },
      { path: "src/b.ts", pkg: "@opencode/plugin" },
    ])
  })
})
