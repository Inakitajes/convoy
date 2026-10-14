import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { advisorFeedbackToolName, advisorToolName } from "../src/advisor"
import { writeReportToolName } from "../src/report"
import {
  planPluginRegistration,
  pluginHealth,
  renderAdvisorPlugin,
  renderWriteReportPlugin,
  type PluginToolSpec,
} from "../src/runners/opencode/plugin-tools"

const reportSpec: PluginToolSpec = {
  name: writeReportToolName,
  description: "Persist this phase's complete Markdown report through Convoy.",
  bridgeUrl: "http://127.0.0.1:49152/report",
  token: "tok-report-abc123",
}

const advisorSpec: PluginToolSpec = {
  name: advisorToolName,
  description: "Consult the reviewing advisor before substantive work.",
  bridgeUrl: "http://127.0.0.1:49153/advise",
  token: "tok-advisor-xyz789",
}

/** Every line that mentions `text`, so we can assert a secret only appears in an assignment. */
function linesContaining(source: string, text: string): string[] {
  return source.split("\n").filter((line) => line.includes(text))
}

describe("opencode v2 plugin tool rendering (task 4.5)", () => {
  test("renders a valid v2 plugin registering write_report and posting to the bridge", () => {
    const source = renderWriteReportPlugin(reportSpec)

    // The v2 registration surface, not the V1 bare default export.
    expect(source).toContain('import { Plugin } from "@opencode/plugin"')
    expect(source).toContain("Plugin.define(")
    expect(source).toContain("ctx.tool.transform((editor) => {")
    expect(source).toContain("editor.add({")
    expect(source).toContain(`name: ${JSON.stringify(writeReportToolName)}`)
    expect(source).toContain(`description: ${JSON.stringify(reportSpec.description)}`)

    // It posts to the exact bridge URL with bearer authorization.
    expect(source).toContain(JSON.stringify(reportSpec.bridgeUrl))
    expect(source).toContain('authorization: "Bearer " + token')
    expect(source).toContain("method: \"POST\"")
  })

  test("embeds the token only in the bridge-call assignment, never in a comment or the id", () => {
    const source = renderWriteReportPlugin(reportSpec)
    const tokenLines = linesContaining(source, reportSpec.token)

    // Exactly one code path: the `const token = "..."` assignment inside execute.
    expect(tokenLines).toHaveLength(1)
    expect(tokenLines[0]?.trim()).toBe(`const token = ${JSON.stringify(reportSpec.token)}`)
    // The generated header/comment must not leak the credential.
    expect(source.split("\n")[0]).not.toContain(reportSpec.token)
    expect(source).not.toContain(`id: ${JSON.stringify(reportSpec.token)}`)
  })

  test("renders the advisor plugin with both advisor tools sharing the bridge token", () => {
    const source = renderAdvisorPlugin(advisorSpec)

    expect(source).toContain("Plugin.define(")
    expect(source).toContain(`name: ${JSON.stringify(advisorToolName)}`)
    expect(source).toContain(`name: ${JSON.stringify(advisorFeedbackToolName)}`)
    expect(source).toContain(JSON.stringify(advisorSpec.bridgeUrl))
    expect(source).toContain('authorization: "Bearer " + token')

    // Two bridge-call paths, both plain token assignments; nothing in a comment.
    const tokenLines = linesContaining(source, advisorSpec.token)
    expect(tokenLines.length).toBeGreaterThanOrEqual(2)
    for (const line of tokenLines) expect(line.trim()).toBe(`const token = ${JSON.stringify(advisorSpec.token)}`)
    expect(source.split("\n")[0]).not.toContain(advisorSpec.token)
  })

  test("plans deterministic, run-isolated plugin directories", () => {
    const runA = "/runs/20260101-120000-aaaa"
    const runB = "/runs/20260101-120001-bbbb"
    const specs = [reportSpec, advisorSpec]

    const first = planPluginRegistration(runA, specs)
    const again = planPluginRegistration(runA, specs)
    const other = planPluginRegistration(runB, specs)

    // Deterministic: identical inputs render identical plans.
    expect(first).toEqual(again)
    expect(first.dir).toBe(join(runA, "plugins"))
    expect(Object.keys(first.files).sort()).toEqual(["advisor.ts", "write_report.ts"])
    expect(first.files["write_report.ts"]).toBe(renderWriteReportPlugin(reportSpec))
    expect(first.files["advisor.ts"]).toBe(renderAdvisorPlugin(advisorSpec))

    // Per-run: a different run root yields a different (non-shared) directory.
    expect(other.dir).not.toBe(first.dir)
    expect(other.dir).toBe(join(runB, "plugins"))
    expect(other.files).toEqual(first.files)
  })

  test("rejects duplicate tool file names instead of overwriting", () => {
    const duplicate: PluginToolSpec = { ...reportSpec, name: "write_report", description: "again" }
    expect(() => planPluginRegistration("/runs/x", [reportSpec, duplicate])).toThrow(/duplicate plugin tool file name/)
  })

  test("pluginHealth reports missing tools so registration is checked before prompting", () => {
    expect(pluginHealth([
      { name: writeReportToolName, registered: true },
      { name: advisorToolName, registered: true },
      { name: advisorFeedbackToolName, registered: true },
    ])).toEqual({ ok: true, missing: [] })

    expect(pluginHealth([
      { name: writeReportToolName, registered: false },
      { name: advisorToolName, registered: true },
      { name: advisorFeedbackToolName, registered: false },
    ])).toEqual({ ok: false, missing: [writeReportToolName, advisorFeedbackToolName] })

    expect(pluginHealth([])).toEqual({ ok: true, missing: [] })
  })
})
