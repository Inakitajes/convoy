import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { createReportRuntime } from "../src/report-runtime"
import { isScoringAgent, maxReportMarkdownChars, validateWriteReportPayload, writeReportScope } from "../src/report"
import { loadCommitSidecar, sidecarPathFor } from "../src/step-commit"
import { qualityDimensionWeights } from "../src/quality-score"
import type { AgentStep, DeliverableContract } from "../src/types"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-report-runtime-"))
  dirs.push(dir)
  return dir
}

function phase(extra: Partial<AgentStep> = {}): AgentStep {
  return {
    type: "agent",
    name: "review",
    stepName: "review",
    groupId: "g1",
    agentName: "bug-auditor",
    description: "Review",
    model: "openai/gpt-5.6-terra",
    inputFiles: ["prd.md"],
    inputDiff: false,
    reportPath: "reports/review.md",
    ...extra,
  }
}

const markdown: DeliverableContract = { kind: "markdown-report" }
const dimensions = { prd: 92, tests: 70, security: 95, maintainability: 88, operational: 90, scope: 85 }

describe("report runtime", () => {
  test("writes the owning phase report atomically and retains its candidate", async () => {
    const dir = await workspace()
    const reports = createReportRuntime(dir)
    const handle = reports.begin("ses_1", phase(), markdown, qualityDimensionWeights)

    const result = await handle.write({ markdown: "# Findings\n\nNo blockers." })
    expect("markdown" in result && result.markdown).toContain("# Findings")
    expect(await readFile(join(dir, "reports/review.md"), "utf8")).toBe("# Findings\n\nNo blockers.")
    expect(handle.candidate).toBe("# Findings\n\nNo blockers.")
    expect((await readdir(join(dir, "reports"))).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("serializes repeated writes so the last report wins", async () => {
    const dir = await workspace()
    const handle = createReportRuntime(dir).begin("ses_1", phase(), markdown, qualityDimensionWeights)

    await Promise.all([handle.write({ markdown: "first" }), handle.write({ markdown: "second" })])
    expect(handle.candidate).toBe("second")
    expect(await readFile(join(dir, "reports/review.md"), "utf8")).toBe("second")
  })

  test("forgets sessions once their phase ends", async () => {
    const reports = createReportRuntime(await workspace())
    const handle = reports.begin("ses_1", phase(), markdown, qualityDimensionWeights)
    await handle.write({ markdown: "completed" })
    expect(reports.handleFor("ses_1")).toBeDefined()
    handle.end()
    expect(reports.handleFor("ses_1")).toBeUndefined()
    expect(reports.candidateFor("ses_1")).toBe("completed")
  })

  test("a phase handle remains resolvable until end() is called", async () => {
    const reports = createReportRuntime(await workspace())
    const handle = reports.begin("ses_1", phase(), markdown, qualityDimensionWeights)

    // The session must stay owned while its phase attempt is still open — the
    // human gate reopens that window with [o] and writes through write_report,
    // so idle/complete is not the end of the session's life.
    expect(reports.handleFor("ses_1")).toBeDefined()
    await handle.write({ markdown: "# Draft" })
    expect(reports.handleFor("ses_1")).toBeDefined()
    expect(await reports.handleFor("ses_1")!.write({ markdown: "# Rescued" })).toEqual({
      markdown: "# Rescued",
    })

    // Only the explicit release makes the session unknown to the bridge.
    reports.handleFor("ses_1")!.end()
    expect(reports.handleFor("ses_1")).toBeUndefined()
    expect(reports.candidateFor("ses_1")).toBe("# Rescued")
  })

  test("rejects empty markdown and score arguments from ordinary agents", async () => {
    const dir = await workspace()
    const handle = createReportRuntime(dir).begin("ses_1", phase(), markdown, qualityDimensionWeights)

    expect(await handle.write({ markdown: "" })).toEqual({ error: "markdown must be a non-empty string" })
    expect(await handle.write({ markdown: "report", dimensions })).toEqual({ error: "only quality-scorer and quality-score-report may supply scoring fields" })
    expect(await handle.write({ markdown: "x".repeat(maxReportMarkdownChars + 1) })).toEqual({
      error: `markdown must be at most ${maxReportMarkdownChars} characters`,
    })
  })

  test("renders scorer inputs into the canonical score report and rejects malformed dimensions", async () => {
    const dir = await workspace()
    const handle = createReportRuntime(dir).begin(
      "ses_1",
      phase({ agentName: "quality-score-report", reportPath: "reports/score.md" }),
      { kind: "quality-score-report", schemaVersion: 1, retryOnMissingOrInvalid: 1 },
      qualityDimensionWeights,
    )

    expect(await handle.write({ markdown: "score", dimensions: { ...dimensions, tests: 101 } })).toEqual({ error: "dimensions.tests must be a number from 0–100 (received: 101)" })
    const result = await handle.write({ markdown: "# Score", dimensions, mustFix: ["SC-1: nit (minor)"], confidence: "high" })
    expect("markdown" in result && result.markdown).toContain("\"score\": 87")
    expect("markdown" in result && result.markdown).toContain("\"verdict\": \"ready-with-caveats\"")
    expect("markdown" in result && result.markdown).toContain("```quality-score")
  })

  test("never accepts agent-supplied score or verdict", async () => {
    const handle = createReportRuntime(await workspace()).begin(
      "ses_1",
      phase({ agentName: "quality-scorer" }),
      { kind: "quality-score-report", schemaVersion: 1, retryOnMissingOrInvalid: 1 },
      qualityDimensionWeights,
    )
    expect(await handle.write({ markdown: "score", dimensions, score: 100, verdict: "ready" })).toEqual({
      error: "write_report does not accept score or verdict; Convoy derives both from dimensions",
    })
  })
})

describe("report runtime commit metadata", () => {
  test("a writable phase's valid commit description persists into a report-bound sidecar", async () => {
    const dir = await workspace()
    const reports = createReportRuntime(dir)
    const handle = reports.begin("ses_1", phase(), markdown, qualityDimensionWeights)

    const result = await handle.write({
      markdown: "# Findings\n\nDone.",
      commit: { subject: "preserve report sessions across human gates", details: ["Keep handles alive", "Cover reopened sessions"] },
    })
    expect("error" in result).toBe(false)
    expect(await loadCommitSidecar(join(dir, phase().reportPath))).toEqual({
      subject: "preserve report sessions across human gates",
      details: ["Keep handles alive", "Cover reopened sessions"],
    })
  })

  test("a corrected write without commit metadata clears the previous description", async () => {
    const dir = await workspace()
    const reports = createReportRuntime(dir)
    const handle = reports.begin("ses_1", phase(), markdown, qualityDimensionWeights)
    const reportPath = join(dir, phase().reportPath)

    await handle.write({ markdown: "# First", commit: { subject: "first subject" } })
    expect(await loadCommitSidecar(reportPath)).toBeDefined()

    await handle.write({ markdown: "# Second" })
    expect(await loadCommitSidecar(reportPath)).toBeUndefined()
    expect(await readFile(reportPath, "utf8")).toBe("# Second")
  })

  test("malformed commit data is rejected without replacing the last valid report candidate", async () => {
    const dir = await workspace()
    const handle = createReportRuntime(dir).begin("ses_1", phase(), markdown, qualityDimensionWeights)
    const reportPath = join(dir, phase().reportPath)

    await handle.write({ markdown: "# Good", commit: { subject: "good subject" } })
    expect(await handle.write({ markdown: "# Bad", commit: { subject: "two\nlines" } })).toEqual({
      error: "commit.subject must be a single line",
    })
    expect(await handle.write({ markdown: "# Bad", commit: { subject: "s", details: ["1", "2", "3", "4"] } })).toEqual({
      error: "commit.details must contain at most 3 entries",
    })
    // The report and sidecar from the last valid write are untouched.
    expect(await readFile(reportPath, "utf8")).toBe("# Good")
    expect((await loadCommitSidecar(reportPath))?.subject).toBe("good subject")
  })

  test("read-only phases cannot supply commit metadata", async () => {
    const dir = await workspace()
    const handle = createReportRuntime(dir).begin("ses_1", phase({ readOnly: true }), markdown, qualityDimensionWeights)
    expect(await handle.write({ markdown: "# Findings", commit: { subject: "nope" } })).toEqual({
      error: "read-only phases cannot supply commit metadata: they never create a step commit",
    })
    expect(await loadCommitSidecar(join(dir, phase().reportPath))).toBeUndefined()
  })

  test("the sidecar sits beside the report inside the run directory only", async () => {
    const dir = await workspace()
    const handle = createReportRuntime(dir).begin("ses_1", phase(), markdown, qualityDimensionWeights)
    await handle.write({ markdown: "# Findings", commit: { subject: "s" } })
    const entries = await readdir(join(dir, "reports"))
    expect(entries.sort()).toEqual(["review.md", "review.md.commit.json"])
  })
})

describe("write_report dimensions errors", () => {
  const error = (value: unknown) => validateWriteReportPayload({ markdown: "score", dimensions: value }, true, false)

  test("names the missing dimensions and what was received", () => {
    expect(error({ maintainability: 86.0166 })).toEqual({ error: "dimensions is missing prd, tests, security, operational, scope (received: maintainability)" })
    expect(error({})).toEqual({ error: "dimensions is missing prd, tests, security, maintainability, operational, scope (received: no keys)" })
  })

  test("names a wrong-typed or out-of-range score with its value", () => {
    expect(error({ ...dimensions, prd: "85" })).toEqual({ error: 'dimensions.prd must be a number from 0–100 (received: "85")' })
    expect(error({ ...dimensions, security: -1 })).toEqual({ error: "dimensions.security must be a number from 0–100 (received: -1)" })
  })

  test("reports missing and invalid dimensions together", () => {
    expect(error({ prd: 90, tests: 101, security: null, maintainability: 80 })).toEqual({
      error: "dimensions is missing operational, scope (received: prd, tests, security, maintainability); dimensions.tests must be a number from 0–100 (received: 101); dimensions.security must be a number from 0–100 (received: null)",
    })
  })

  test("explains a missing or non-object dimensions", () => {
    const expected = "an object scoring every quality dimension (prd, tests, security, maintainability, operational, scope) from 0–100"
    expect(validateWriteReportPayload({ markdown: "score" }, true, false)).toEqual({ error: `dimensions is required: ${expected}` })
    expect(error("85")).toEqual({ error: `dimensions must be ${expected} (received: "85")` })
    expect(error([90, 80])).toEqual({ error: `dimensions must be ${expected} (received: [90,80])` })
    expect(error(null)).toEqual({ error: `dimensions must be ${expected} (received: null)` })
  })
})

describe("writeReportScope", () => {
  test("follows the phase: writable unless read-only, scoring for the scorer agents", () => {
    expect(writeReportScope("implementer", undefined)).toEqual({ writable: true, scoring: false })
    expect(writeReportScope("bug-auditor", true)).toEqual({ writable: false, scoring: false })
    expect(writeReportScope("quality-scorer__ro", true)).toEqual({ writable: false, scoring: true })
  })
})

describe("isScoringAgent", () => {
  test("recognizes the scorer agents and their read-only/verify variants", () => {
    expect(isScoringAgent("quality-scorer")).toBe(true)
    expect(isScoringAgent("quality-score-report")).toBe(true)
    // The runner appends __ro (read-only) and __verify (verify-only) suffixes to
    // the agent name; a scorer variant must still be allowed to score.
    expect(isScoringAgent("quality-scorer__ro")).toBe(true)
    expect(isScoringAgent("quality-score-report__verify")).toBe(true)
  })

  test("rejects ordinary agents, including their read-only/verify variants", () => {
    expect(isScoringAgent("bug-auditor")).toBe(false)
    expect(isScoringAgent("bug-auditor__ro")).toBe(false)
    expect(isScoringAgent("implementer__verify")).toBe(false)
    // A name that merely contains the scorer prefix is not a scorer.
    expect(isScoringAgent("quality-scorer-clone")).toBe(false)
  })

  test("a read-only scorer variant can still supply scoring fields through the runtime", async () => {
    const handle = createReportRuntime(await workspace()).begin(
      "ses_1",
      phase({ agentName: "quality-scorer__ro" }),
      { kind: "quality-score-report", schemaVersion: 1, retryOnMissingOrInvalid: 1 },
      qualityDimensionWeights,
    )
    const result = await handle.write({ markdown: "# Score", dimensions, mustFix: [], confidence: "medium" })
    expect("error" in result).toBe(false)
    expect("markdown" in result && result.markdown).toContain("```quality-score")
  })
})

describe("report runtime workspace boundary", () => {
  test("rejects a report path that escapes the workspace", () => {
    const reports = createReportRuntime("/tmp/convoy-boundary-root")
    expect(() =>
      reports.begin(
        "ses_1",
        phase({ reportPath: "../escape.md" }),
        markdown,
        qualityDimensionWeights,
      ),
    ).toThrow(/outside workspace/)
    // An absolute path outside the root is rejected the same way.
    expect(() =>
      reports.begin(
        "ses_2",
        phase({ reportPath: "/etc/convoy-report.md" }),
        markdown,
        qualityDimensionWeights,
      ),
    ).toThrow(/outside workspace/)
  })
})
