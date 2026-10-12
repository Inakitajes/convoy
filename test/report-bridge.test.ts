import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { installWriteReportTool, startReportBridge } from "../src/report-bridge"
import { createReportRuntime } from "../src/report-runtime"
import { loadCommitSidecar } from "../src/step-commit"
import { qualityDimensionWeights } from "../src/quality-score"
import type { AgentStep } from "../src/types"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-report-bridge-"))
  dirs.push(dir)
  return dir
}

const phase: AgentStep = {
  type: "agent", name: "review", stepName: "review", groupId: "g1", agentName: "bug-auditor", description: "Review", model: "openai/gpt-5.6-terra", inputFiles: ["prd.md"], inputDiff: false, reportPath: "reports/review.md",
}

async function post(url: string, token: string, body: unknown) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
}

describe("report bridge", () => {
  test("authenticates a session-owned report write", async () => {
    const dir = await scratch()
    const reports = createReportRuntime(dir)
    reports.begin("ses_1", phase, { kind: "markdown-report" }, qualityDimensionWeights)
    const bridge = await startReportBridge({ reports: () => reports })
    try {
      const response = await post(bridge.url, bridge.token, { sessionID: "ses_1", payload: { markdown: "# Findings" } })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ message: "Report saved." })
      expect(await readFile(join(dir, phase.reportPath), "utf8")).toBe("# Findings")
    } finally {
      bridge.close()
    }
  })

  test("rejects unauthorized, malformed, and unknown-session writes", async () => {
    const dir = await scratch()
    const reports = createReportRuntime(dir)
    const bridge = await startReportBridge({ reports: () => reports })
    try {
      expect((await post(bridge.url, "wrong", { sessionID: "ses_1", payload: { markdown: "report" } })).status).toBe(401)
      expect((await fetch(bridge.url, { method: "GET", headers: { authorization: `Bearer ${bridge.token}` } })).status).toBe(405)
      expect((await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}` }, body: "not json" })).status).toBe(400)
      expect((await post(bridge.url, bridge.token, { sessionID: "unknown", payload: { markdown: "report" } })).status).toBe(404)
    } finally {
      bridge.close()
    }
  })

  test("a write after end() is rejected as an unknown session", async () => {
    const dir = await scratch()
    const reports = createReportRuntime(dir)
    const handle = reports.begin("ses_1", phase, { kind: "markdown-report" }, qualityDimensionWeights)
    await handle.write({ markdown: "# First save" })
    handle.end()
    const bridge = await startReportBridge({ reports: () => reports })
    try {
      // After the phase released the session, a late write_report from the [o]
      // window must be a protocol miss, not silently overwrite the saved report.
      const response = await post(bridge.url, bridge.token, { sessionID: "ses_1", payload: { markdown: "late rewrite" } })
      expect(response.status).toBe(404)
      expect(await readFile(join(dir, phase.reportPath), "utf8")).toBe("# First save")
    } finally {
      bridge.close()
    }
  })

  test("requires a sessionID and rejects invalid report content with the error body", async () => {
    const dir = await scratch()
    const reports = createReportRuntime(dir)
    reports.begin("ses_1", phase, { kind: "markdown-report" }, qualityDimensionWeights)
    const bridge = await startReportBridge({ reports: () => reports })
    try {
      // A well-formed JSON request without a sessionID is a client error, not a
      // 404: the bridge never gets far enough to look up an owning phase. The
      // bridge answers protocol errors as plain text.
      const missing = await post(bridge.url, bridge.token, { payload: { markdown: "report" } })
      expect(missing.status).toBe(400)
      expect(await missing.text()).toBe("sessionID required")

      // Valid JSON reaching an owned session but with invalid report content
      // surfaces the runtime's rejection as JSON so the agent can correct it
      // in-turn without losing the turn.
      const invalid = await post(bridge.url, bridge.token, { sessionID: "ses_1", payload: { markdown: "   " } })
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toMatchObject({ error: "markdown must be a non-empty string" })

      // Structured commit metadata rides the same payload and is validated at
      // the same boundary: valid data lands in the sidecar, malformed data is
      // rejected in-turn without saving the report.
      const valid = await post(bridge.url, bridge.token, {
        sessionID: "ses_1",
        payload: { markdown: "# Findings", commit: { subject: "preserve report sessions", details: ["one detail"] } },
      })
      expect(valid.status).toBe(200)
      expect(await loadCommitSidecar(join(dir, phase.reportPath))).toEqual({
        subject: "preserve report sessions",
        details: ["one detail"],
      })

      const malformed = await post(bridge.url, bridge.token, {
        sessionID: "ses_1",
        payload: { markdown: "# Rewritten", commit: { subject: "" } },
      })
      expect(malformed.status).toBe(400)
      expect((await malformed.json()).error).toContain("commit.subject")
      expect(await readFile(join(dir, phase.reportPath), "utf8")).toBe("# Findings")
    } finally {
      bridge.close()
    }
  })
})

describe("write_report tool file", () => {
  test("registers the tool with the commit argument as a V2 plugin", async () => {
    const dir = await scratch()
    const path = await installWriteReportTool({ dir, url: "http://127.0.0.1:1234/report", token: "t" })
    const source = await readFile(path, "utf8")
    expect(source).toContain('import { Plugin } from "@opencode/plugin"')
    expect(source).toContain("ctx.tool.transform")
    expect(source).toContain("commit: { type: \"object\"")
    expect(source).toContain("subject: { type: \"string\" }")
    expect(source).toContain("imperative English subject")
  })

  test("is a valid plugin that registers the write_report tool", async () => {
    const dir = await scratch()
    const modulePath = join(dir, "write_report.mjs")
    const installedPath = await installWriteReportTool({ dir, url: "http://127.0.0.1:9/report", token: "tok" })
    const source = (await readFile(installedPath, "utf8")).replace(
      '"@opencode/plugin"',
      JSON.stringify(import.meta.resolve("@opencode/plugin")),
    )
    await writeFile(modulePath, source)
    const plugin = (await import(modulePath)).default

    let tool: { name: string; input: { required?: string[]; properties: Record<string, unknown> } } | undefined
    await plugin.setup({ tool: { transform: async (cb: (editor: { add: (t: typeof tool) => void }) => void) => { cb({ add: (t) => { tool = t } }) } } })
    expect(plugin.id).toBe("convoy-write-report")
    expect(tool?.name).toBe("write_report")
    expect(tool?.input.required).toEqual(["markdown"])
    expect(tool?.input.properties.markdown).toEqual({ type: "string" })
    expect(tool?.input.properties.commit).toBeDefined()
  })

  test("has the fixed-path schema and restrictive permissions", async () => {
    const dir = await scratch()
    const path = await installWriteReportTool({ dir, url: "http://127.0.0.1:1234/report", token: "bridge-token" })
    const source = await readFile(path, "utf8")

    expect(path).toBe(join(dir, "plugins", "write_report", "index.ts"))
    expect(JSON.parse(await readFile(join(dir, "plugins", "write_report", "package.json"), "utf8"))).toMatchObject({ main: "index.ts", type: "module" })
    // V2 hides plugin tools behind Code Mode unless told otherwise.
    expect(source).toContain("options: { codemode: false }")
    expect(source).toContain("context?.sessionID")
    expect(source).toContain("dimensions")
    expect(source).not.toContain("reportPath")
    expect(source).not.toContain("path:")
    expect(source).toContain("bridge-token")
    expect(source).not.toContain("process.env.CONVOY_REPORT")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("falls back to env-var lookup when no bridge is configured", async () => {
    const dir = await scratch()
    // No url/token: the shim reads CONVOY_REPORT_URL/TOKEN at runtime, so it
    // can be installed before the bridge exists (e.g. a cold config dir).
    const path = await installWriteReportTool({ dir })
    const source = await readFile(path, "utf8")

    expect(source).toContain("process.env.CONVOY_REPORT_URL")
    expect(source).toContain("process.env.CONVOY_REPORT_TOKEN")
    // The fallback embeds no address: a cold install must not hardcode one.
    expect(source).not.toMatch(/const url = "http/)
  })

  test("embeds the bridge address and posts the session-owned payload shape", async () => {
    const dir = await scratch()
    const path = await installWriteReportTool({ dir, url: "http://127.0.0.1:7/report", token: "shim-token" })
    const source = await readFile(path, "utf8")

    // The shim is a thin fetch wrapper; the bridge-level round-trip is covered
    // above. Here we lock the contract the bridge depends on: the agent never
    // chooses a path, and the body carries the sessionID and the raw args.
    expect(source).toContain("http://127.0.0.1:7/report")
    expect(source).toContain("shim-token")
    expect(source).toContain("authorization: \"Bearer \" + token")
    expect(source).toContain("JSON.stringify({ sessionID: context?.sessionID, payload: args })")
    // A failed persist throws a labeled error so the agent sees it in-chat and
    // can correct the arguments while the same turn is still open.
    expect(source).toContain("write_report failed:")
    // The agent must not be able to steer the destination from the tool args.
    expect(source).not.toContain("reportPath")
    expect(source).not.toMatch(/\bpath\s*:/)
  })

  test("rewrites only when the content changed, so OpenCode's watcher isn't churned", async () => {
    const dir = await scratch()
    const path = await installWriteReportTool({ dir, url: "http://127.0.0.1:1/report", token: "stable" })
    const expected = await readFile(path, "utf8")
    const first = (await stat(path)).mtimeMs

    await new Promise((resolve) => setTimeout(resolve, 20))
    await installWriteReportTool({ dir, url: "http://127.0.0.1:1/report", token: "stable" })
    expect((await stat(path)).mtimeMs).toBe(first)

    // A stale shim from an older Convoy is rewritten in place.
    await writeFile(path, "// stale shim from an older Convoy\n")
    await installWriteReportTool({ dir, url: "http://127.0.0.1:1/report", token: "stable" })
    expect(await readFile(path, "utf8")).toBe(expected)

    // A new bridge address rewrites the embedded literals.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await installWriteReportTool({ dir, url: "http://127.0.0.1:2/report", token: "stable" })
    const rotated = await readFile(path, "utf8")
    expect(rotated).not.toBe(expected)
    expect(rotated).toContain("http://127.0.0.1:2/report")
  })
})
