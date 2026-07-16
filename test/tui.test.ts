import { describe, expect, test } from "bun:test"

import { autoFollowGroup, comparisonColumnCount, initialContentTab, iteratePrompt, phaseCapabilityLabel, pipelineSelectionTargets } from "../src/tui"
import { limitsRow } from "../src/tui-theme"

import type { LimitsSnapshot } from "../src/limits"
import type { ProgressPhase } from "../src/progress"

describe("run dashboard defaults", () => {
  test("starts live runs on session and historical runs on reports, never logs", () => {
    const live = initialContentTab("live")
    const historical = initialContentTab("historical")

    expect(live).toBe("session")
    expect(historical).toBe("reports")
    expect([live, historical]).not.toContain("logs")
  })

  test("labels audit-only phases without tagging writable work", () => {
    expect(phaseCapabilityLabel({ readOnly: true })).toBe("audit · read-only")
    expect(phaseCapabilityLabel({})).toBeUndefined()
  })
})

describe("iterate prompt", () => {
  test("names the run, lists every context file, and stays on one line", () => {
    const files = ["/runs/x/prd.md", "/runs/x/reports/plan.md", "/runs/x/reports/implement.md"]
    const prompt = iteratePrompt("20260713-101010-abcd", files)

    expect(prompt).toContain("20260713-101010-abcd")
    for (const file of files) expect(prompt).toContain(file)
    // The command travels through `zsh -lc`; a newline would break quoting assumptions.
    expect(prompt).not.toContain("\n")
    // The agent must know to wait instead of acting on the reports alone.
    expect(prompt.toLowerCase()).toContain("wait")
  })
})

describe("header limits row", () => {
  const now = Date.now()
  const full: LimitsSnapshot = {
    gpt: { sessionPct: 42, sessionResetsAt: now + 130 * 60_000, weeklyPct: 18 },
    openrouter: { kind: "remaining", amount: 12.34 },
    fetchedAt: now,
  }
  const text = (snapshot: LimitsSnapshot | undefined, width: number) =>
    limitsRow(snapshot, now, width)
      .chunks.map((chunk) => chunk.text)
      .join("")

  test("wide row shows the bar, reset countdown, weekly percent, and credits", () => {
    const row = text(full, 100)

    expect(row).toContain("GPT ")
    expect(row).toContain("█")
    expect(row).toContain("42%")
    expect(row).toContain("resets 2h 10m")
    expect(row).toContain("wk 18%")
    expect(row).toContain("OpenRouter $12.34 left")
    expect(row.length).toBeGreaterThanOrEqual(100)
  })

  test("narrow widths drop weekly first, then the countdown", () => {
    // Bar segment (18) + countdown (16) + weekly (9) + credits (22+1 gap):
    // at 60 the weekly text no longer fits, at 40 the countdown goes too.
    const at60 = text(full, 60)
    expect(at60).toContain("resets")
    expect(at60).not.toContain("wk 18%")

    const at40 = text(full, 40)
    expect(at40).toContain("42%")
    expect(at40).not.toContain("resets")
    expect(at40).toContain("OpenRouter $12.34 left")
  })

  test("monthly fallback labels the amount as spend, not balance", () => {
    const row = text({ ...full, openrouter: { kind: "monthly", amount: 4.2 } }, 100)

    expect(row).toContain("OpenRouter $4.20/mo")
  })

  test("auth problems surface a dim hint instead of a meter", () => {
    const row = text({ gptHint: "codex login", fetchedAt: now }, 80)

    expect(row).toContain("GPT — codex login")
    expect(row).not.toContain("█")
  })

  test("no data renders a quiet placeholder, never a crash", () => {
    expect(text(undefined, 80)).toBe("…")
    expect(text({ fetchedAt: now }, 80)).toBe("…")
  })
})

describe("pipeline group selection", () => {
  test("includes model and parallel headers in the same order as their child rows", () => {
    const phases: ProgressPhase[] = [
      { name: "prepare", description: "" },
      { name: "review__opus", description: "", groupId: "models", stepName: "review", plannedModel: "anthropic/claude-opus" },
      { name: "review__gpt", description: "", groupId: "models", stepName: "review", plannedModel: "openai/gpt" },
      { name: "lint", description: "", groupId: "parallel", stepName: "lint" },
      { name: "test__fast", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/fast" },
      { name: "test__deep", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/deep" },
      { name: "finish", description: "" },
    ]

    expect(pipelineSelectionTargets(phases)).toEqual([
      { kind: "phase", name: "prepare" },
      { kind: "group", groupId: "models", stepName: "review" },
      { kind: "phase", name: "review__opus" },
      { kind: "phase", name: "review__gpt" },
      { kind: "group", groupId: "parallel" },
      { kind: "phase", name: "lint" },
      { kind: "group", groupId: "parallel", stepName: "test" },
      { kind: "phase", name: "test__fast" },
      { kind: "phase", name: "test__deep" },
      { kind: "phase", name: "finish" },
    ])
  })

  test("auto-follow rests on the group header while any member of a concurrent group is active", () => {
    const phases: ProgressPhase[] = [
      { name: "prepare", description: "", groupId: "g1" },
      { name: "review__opus", description: "", groupId: "models", stepName: "review", plannedModel: "anthropic/claude-opus" },
      { name: "review__gpt", description: "", groupId: "models", stepName: "review", plannedModel: "openai/gpt" },
      { name: "lint", description: "", groupId: "parallel", stepName: "lint" },
      { name: "test__fast", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/fast" },
      { name: "test__deep", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/deep" },
      { name: "finish", description: "" },
    ]

    // Sequential steps (unique or missing groupId) follow the leaf itself.
    expect(autoFollowGroup(phases, phases[0]!)).toBeUndefined()
    expect(autoFollowGroup(phases, phases[6]!)).toBeUndefined()

    // A pure models: fan-out follows its step header, whichever member emits.
    expect(autoFollowGroup(phases, phases[1]!)).toEqual({ kind: "group", groupId: "models", stepName: "review" })
    expect(autoFollowGroup(phases, phases[2]!)).toEqual({ kind: "group", groupId: "models", stepName: "review" })

    // A parallel block of distinct steps follows its top header — the same
    // stable node no matter which child (plain or fanned-out) was active last.
    expect(autoFollowGroup(phases, phases[3]!)).toEqual({ kind: "group", groupId: "parallel" })
    expect(autoFollowGroup(phases, phases[4]!)).toEqual({ kind: "group", groupId: "parallel" })
    expect(autoFollowGroup(phases, phases[5]!)).toEqual({ kind: "group", groupId: "parallel" })
  })

  test("uses readable adaptive comparison columns", () => {
    expect(comparisonColumnCount(40, 3)).toBe(1)
    expect(comparisonColumnCount(70, 3)).toBe(2)
    expect(comparisonColumnCount(100, 3)).toBe(3)
    expect(comparisonColumnCount(200, 5)).toBe(3)
  })
})
