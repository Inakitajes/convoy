import { describe, expect, test } from "bun:test"

import {
  addParallelMember,
  agentStepCount,
  applyModelsSelection,
  asStepObject,
  collapseStep,
  claudeModelPickerState,
  deleteAt,
  dissolveParallel,
  ejectMember,
  isHumanStep,
  moveMember,
  priorStepNames,
  setSpecAt,
  specAt,
  stepValueSummary,
  toggleStepRunnerSpec,
  wrapInParallel,
} from "../src/config-tui"

import type { AgentStepSpec, StepSpec } from "../src/pipeline"

const steps = (): StepSpec[] => [
  { agent: "review-scope", name: "scope", reports: "none" },
  { parallel: ["bug-auditor", { agent: "security-reviewer", name: "security" }] },
  { type: "human" },
  "review-report",
]

describe("step addressing", () => {
  test("specAt reads top-level steps and parallel members", () => {
    const list = steps()
    expect(specAt(list, 0)).toEqual({ agent: "review-scope", name: "scope", reports: "none" })
    expect(specAt(list, 1, 0)).toBe("bug-auditor")
    expect(specAt(list, 1, 1)).toEqual({ agent: "security-reviewer", name: "security" })
    expect(specAt(list, 0, 0)).toBeUndefined()
    expect(specAt(list, 9)).toBeUndefined()
  })

  test("setSpecAt writes back at the same address", () => {
    const list = steps()
    setSpecAt(list, 1, 0, { agent: "bug-auditor", model: "prov/model" })
    expect(specAt(list, 1, 0)).toEqual({ agent: "bug-auditor", model: "prov/model" })
    setSpecAt(list, 3, undefined, { agent: "review-report", reports: "all" })
    expect(list[3]).toEqual({ agent: "review-report", reports: "all" })
  })

  test("asStepObject/collapseStep round-trip the string shorthand", () => {
    expect(asStepObject("patterns")).toEqual({ agent: "patterns" })
    expect(collapseStep({ agent: "patterns" })).toBe("patterns")
    expect(collapseStep({ agent: "patterns", diff: false })).toEqual({ agent: "patterns", diff: false })
  })
})

describe("parallel group editing", () => {
  test("wrapInParallel wraps a lone sequential step into a one-member group", () => {
    const list: StepSpec[] = ["implementer", "patterns", "tests"]
    expect(wrapInParallel(list, 1)).toEqual({ index: 1, member: 0 })
    expect(list).toEqual(["implementer", { parallel: ["patterns"] }, "tests"])
  })

  test("wrapInParallel joins the group directly above", () => {
    const list: StepSpec[] = [{ parallel: ["patterns"] }, "security", "tests"]
    expect(wrapInParallel(list, 1)).toEqual({ index: 0, member: 1 })
    expect(list).toEqual([{ parallel: ["patterns", "security"] }, "tests"])
  })

  test("wrapInParallel joins the group directly below", () => {
    const list: StepSpec[] = ["security", { parallel: ["patterns"] }]
    expect(wrapInParallel(list, 0)).toEqual({ index: 0, member: 0 })
    expect(list).toEqual([{ parallel: ["security", "patterns"] }])
  })

  test("wrapInParallel refuses human steps and group headers", () => {
    const list: StepSpec[] = [{ type: "human" }, "human-review", { parallel: ["patterns"] }]
    expect(wrapInParallel(list, 0)).toBeUndefined()
    expect(wrapInParallel(list, 1)).toBeUndefined()
    expect(wrapInParallel(list, 2)).toBeUndefined()
    expect(list).toHaveLength(3)
  })

  test("ejectMember re-inserts the member right after its group", () => {
    const list = steps()
    expect(ejectMember(list, 1, 0)).toBe(2)
    expect(list[1]).toEqual({ parallel: [{ agent: "security-reviewer", name: "security" }] })
    expect(list[2]).toBe("bug-auditor")
  })

  test("ejecting the last member replaces the group in place", () => {
    const list: StepSpec[] = ["implementer", { parallel: ["patterns"] }]
    expect(ejectMember(list, 1, 0)).toBe(1)
    expect(list).toEqual(["implementer", "patterns"])
  })

  test("dissolveParallel splices members back as sequential steps", () => {
    const list = steps()
    expect(dissolveParallel(list, 1)).toBe(1)
    expect(list).toEqual([
      { agent: "review-scope", name: "scope", reports: "none" },
      "bug-auditor",
      { agent: "security-reviewer", name: "security" },
      { type: "human" },
      "review-report",
    ])
  })

  test("addParallelMember appends to the group", () => {
    const list = steps()
    expect(addParallelMember(list, 1, "clean-code-auditor")).toBe(2)
    expect(specAt(list, 1, 2)).toBe("clean-code-auditor")
    expect(addParallelMember(list, 0, "clean-code-auditor")).toBeUndefined()
  })

  test("deleteAt removes members and drops a group that empties", () => {
    const list: StepSpec[] = ["implementer", { parallel: ["patterns", "security"] }]
    deleteAt(list, 1, 0)
    expect(list[1]).toEqual({ parallel: ["security"] })
    deleteAt(list, 1, 0)
    expect(list).toEqual(["implementer"])
    deleteAt(list, 0)
    expect(list).toEqual([])
  })

  test("moveMember reorders within the group and stops at its edges", () => {
    const list = steps()
    expect(moveMember(list, 1, 0, 1)).toBe(1)
    expect(specAt(list, 1, 1)).toBe("bug-auditor")
    expect(moveMember(list, 1, 1, 1)).toBeUndefined()
    expect(moveMember(list, 1, 0, -1)).toBeUndefined()
  })

  test("agentStepCount counts members individually and skips human gates", () => {
    expect(agentStepCount(steps())).toBe(4)
    expect(agentStepCount([{ type: "human" }, "human-review"])).toBe(0)
  })

  test("isHumanStep covers object gates and the legacy human-review forms", () => {
    expect(isHumanStep({ type: "human" })).toBe(true)
    expect(isHumanStep("human-review")).toBe(true)
    expect(isHumanStep({ agent: "human-review" })).toBe(true)
    expect(isHumanStep("patterns")).toBe(false)
    expect(isHumanStep({ parallel: ["patterns"] })).toBe(false)
  })
})

describe("multi-model selection", () => {
  const base: AgentStepSpec = { agent: "bug-auditor", models: ["a/b", "c/d"], reports: "none" }

  test("no selection clears both model keys", () => {
    expect(applyModelsSelection(base, [])).toEqual({ agent: "bug-auditor", reports: "none" })
  })

  test("one selection sets the singular model", () => {
    expect(applyModelsSelection(base, ["a/b#high"])).toEqual({ agent: "bug-auditor", model: "a/b#high", reports: "none" })
  })

  test("two or more selections set the fan-out and drop the singular model", () => {
    const single: AgentStepSpec = { agent: "bug-auditor", model: "a/b" }
    expect(applyModelsSelection(single, ["a/b", "c/d"])).toEqual({ agent: "bug-auditor", models: ["a/b", "c/d"] })
  })

  test("never leaves both model and models set", () => {
    const applied = applyModelsSelection({ agent: "x", model: "a/b", models: ["a/b", "c/d"] } as AgentStepSpec, ["e/f", "g/h"])
    expect(applied.model).toBeUndefined()
    expect(applied.models).toEqual(["e/f", "g/h"])
  })
})

describe("runner selection", () => {
  test("toggles between canonical OpenCode and Claude Code forms", () => {
    expect(toggleStepRunnerSpec({ agent: "bug-auditor" }, true)).toEqual({
      ok: true,
      spec: { agent: "bug-auditor", runner: "claude-code" },
      clearedModel: false,
    })
    expect(toggleStepRunnerSpec({ agent: "bug-auditor", runner: "claude-code" }, true)).toEqual({
      ok: true,
      spec: { agent: "bug-auditor" },
      clearedModel: false,
    })
  })

  test("clears incompatible singular models but preserves unrelated step fields", () => {
    expect(
      toggleStepRunnerSpec({ agent: "bug-auditor", model: "openai/gpt-5.6", name: "bugs", reports: "all", diff: false, maxAttempts: 3 }, true),
    ).toEqual({
      ok: true,
      spec: { agent: "bug-auditor", runner: "claude-code", name: "bugs", reports: "all", diff: false, maxAttempts: 3 },
      clearedModel: true,
    })
  })

  test("refuses to switch a model fan-out to Claude Code", () => {
    const spec: AgentStepSpec = { agent: "bug-auditor", models: ["a/b", "c/d"] }
    expect(toggleStepRunnerSpec(spec, true)).toEqual({ ok: false, reason: "model-fanout" })
    expect(spec).toEqual({ agent: "bug-auditor", models: ["a/b", "c/d"] })
  })

  test("summarizes Claude Code's model and read-only contract", () => {
    expect(stepValueSummary({ agent: "bug-auditor", runner: "claude-code" })).toBe("claude-code/default · read-only")
    expect(stepValueSummary({ agent: "bug-auditor", runner: "claude-code", model: "opus" })).toBe("claude-code/opus · read-only")
  })

  test("refuses to switch a writable sequential step to Claude Code", () => {
    expect(toggleStepRunnerSpec({ agent: "implementer" }, false)).toEqual({ ok: false, reason: "writable-agent" })
  })

  test("preserves a configured full Claude model ID when the picker opens", () => {
    const state = claudeModelPickerState("claude-opus-4-8")
    expect(state.options[state.index]?.value).toBe("claude-opus-4-8")
  })
})

describe("reports helpers", () => {
  test("priorStepNames lists base names of earlier agent steps, excluding groupmates and humans", () => {
    const list = steps()
    expect(priorStepNames(list, 0)).toEqual([])
    expect(priorStepNames(list, 1)).toEqual(["scope"])
    // A member of the group at index 1 sees the same names as the group itself.
    expect(priorStepNames(list, 3)).toEqual(["scope", "bug-auditor", "security"])
  })

  test("stepValueSummary shows the fan-out count and explicitly set fields", () => {
    expect(stepValueSummary("patterns")).toBe("(inherits)")
    expect(stepValueSummary({ agent: "x", models: ["a/b", "c/d"] })).toBe("2 models")
    expect(stepValueSummary({ agent: "x", model: "a/b", name: "scope", reports: ["scope"], diff: false, maxAttempts: 3 })).toBe(
      "a/b · name scope · reports scope · diff off · attempts 3",
    )
  })
})
