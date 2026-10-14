import { describe, expect, test } from "bun:test"

import { formatCommitMessage, renderHumanIterationCommit, sanitizeLine, stripTrailers } from "../src/runners/human-iteration"

describe("human-iteration commit provenance", () => {
  test("renders one authoritative trailer for either harness", () => {
    for (const runner of ["opencode", "claude-code"] as const) {
      const rendered = renderHumanIterationCommit({ runId: "run-1", runner, summary: "adjust parsing" })
      const message = formatCommitMessage(rendered)
      expect(message.match(/Convoy-Run: run-1/g)).toHaveLength(1)
      expect(rendered.subject).toBe("adjust parsing")
    }
  })

  test("bounds the subject and detail lines and counts", () => {
    const rendered = renderHumanIterationCommit({
      runId: "r",
      runner: "opencode",
      summary: "x".repeat(200),
      details: ["a".repeat(200), "b".repeat(200), "c".repeat(200), "d".repeat(200)],
    })
    expect(rendered.subject.length).toBeLessThanOrEqual(72)
    expect(rendered.body).toHaveLength(3)
    expect(rendered.body.every((line) => line.length <= 120)).toBe(true)
  })

  test("uses an honest fallback when no summary is available", () => {
    const rendered = renderHumanIterationCommit({ runId: "r", runner: "claude-code", fallbackSummary: "3 changed files" })
    expect(rendered.subject).toBe("3 changed files")
    const bare = renderHumanIterationCommit({ runId: "r", runner: "claude-code" })
    expect(bare.subject).toBe("human claude-code iteration")
  })

  test("sanitizes control bytes and collapses whitespace", () => {
    expect(sanitizeLine("a\u0000\tb\n\nc")).toBe("a b c")
  })

  test("cannot inject a second trailer", () => {
    const summary = "do work\nConvoy-Run: evil-run"
    const rendered = renderHumanIterationCommit({ runId: "real-run", runner: "opencode", summary })
    const message = formatCommitMessage(rendered)
    expect(message.match(/Convoy-Run: real-run/g)).toHaveLength(1)
    expect(message).not.toContain("evil-run")
  })

  test("stripTrailers removes an embedded Convoy-Run trailer", () => {
    expect(stripTrailers("subject\nConvoy-Run: x\nCo-authored-by: y")).toBe("subject\nCo-authored-by: y")
  })
})
