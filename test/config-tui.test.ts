import { describe, expect, test } from "bun:test"

import {
  addParallelMember,
  agentStepCount,
  applyModelsSelection,
  asStepObject,
  collapseStep,
  claudeModelPickerState,
  defaultFields,
  deleteAt,
  describeDefault,
  dissolveParallel,
  ejectMember,
  isGoalStep,
  isHumanStep,
  moveMember,
  priorStepNames,
  setSpecAt,
  specAt,
  stepValueSummary,
  toggleStepRunnerSpec,
  wrapInParallel,
} from "../src/config-tui"

import type { AgentStepSpec, GoalStepSpec, StepSpec } from "../src/pipeline"

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

  test("asStepObject returns a copy, not the original", () => {
    const spec: AgentStepSpec = { agent: "test", model: "a/b" }
    const obj = asStepObject(spec)
    expect(obj).toEqual(spec)
    expect(obj).not.toBe(spec)
  })

  test("collapseStep keeps object when it has more than agent", () => {
    expect(collapseStep({ agent: "x", model: "a/b" })).toEqual({ agent: "x", model: "a/b" })
    expect(collapseStep({ agent: "x", name: "test" })).toEqual({ agent: "x", name: "test" })
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

  test("wrapInParallel refuses the terminal goal node", () => {
    const goalNode: GoalStepSpec = {
      goal: {
        target: 85,
        maxIterations: 3,
        plateau: 3,
        improve: { briefStep: "fix", steps: [{ agent: "goal-fixer", name: "fix" }] },
        measure: { steps: ["quality-score-report"] },
      },
    }
    const list: StepSpec[] = ["implementer", goalNode, "security"]
    expect(wrapInParallel(list, 1)).toBeUndefined()
    expect(list).toHaveLength(3)
    expect(list[1]).toBe(goalNode)
  })

  test("wrapInParallel returns undefined for out-of-bounds index", () => {
    expect(wrapInParallel(["implementer"], 5)).toBeUndefined()
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

  test("ejectMember returns undefined for invalid index", () => {
    const list: StepSpec[] = ["implementer"]
    expect(ejectMember(list, 0, 0)).toBeUndefined()
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

  test("dissolveParallel returns undefined for non-parallel step", () => {
    const list: StepSpec[] = ["implementer"]
    expect(dissolveParallel(list, 0)).toBeUndefined()
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

  test("deleteAt with member does nothing on non-parallel", () => {
    const list: StepSpec[] = ["implementer"]
    deleteAt(list, 0, 0)
    expect(list).toEqual(["implementer"])
  })

  test("moveMember reorders within the group and stops at its edges", () => {
    const list = steps()
    expect(moveMember(list, 1, 0, 1)).toBe(1)
    expect(specAt(list, 1, 1)).toBe("bug-auditor")
    expect(moveMember(list, 1, 1, 1)).toBeUndefined()
    expect(moveMember(list, 1, 0, -1)).toBeUndefined()
  })

  test("moveMember returns undefined for non-parallel step", () => {
    expect(moveMember(["implementer"], 0, 0, 1)).toBeUndefined()
  })

  test("agentStepCount counts members individually and skips human gates", () => {
    expect(agentStepCount(steps())).toBe(4)
    expect(agentStepCount([{ type: "human" }, "human-review"])).toBe(0)
  })

  test("agentStepCount handles parallel groups with human gates inside", () => {
    const list: StepSpec[] = [{ parallel: ["implementer", "human-review"] }]
    expect(agentStepCount(list)).toBe(1)
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

  test("copies the spec rather than mutating in place", () => {
    const spec: AgentStepSpec = { agent: "x", model: "a/b" }
    const result = applyModelsSelection(spec, ["c/d"])
    expect(spec.model).toBe("a/b")
    expect(result.model).toBe("c/d")
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
      toggleStepRunnerSpec({ agent: "bug-auditor", model: "openai/gpt-5.6", name: "bugs", reports: "all", diff: false }, true),
    ).toEqual({
      ok: true,
      spec: { agent: "bug-auditor", runner: "claude-code", name: "bugs", reports: "all", diff: false },
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
    expect(state.options.findIndex((choice) => choice.value === "claude-opus-4-8")).toBeGreaterThan(0)
  })
})

describe("claudeModelPickerState", () => {
  test("returns clearOption as first entry when current is undefined", () => {
    const state = claudeModelPickerState(undefined)
    expect(state.options[0]).toEqual({ value: "", label: "inherit — clear override", providerID: "" })
    expect(state.index).toBe(0)
  })

  test("includes claude-code aliases after clearOption", () => {
    const state = claudeModelPickerState(undefined)
    expect(state.options.length).toBeGreaterThan(1)
    const aliasOptions = state.options.slice(1)
    for (const option of aliasOptions) {
      expect(option.providerID).toBe("claude-code")
    }
  })

  test("finds the current value in options and sets index", () => {
    const state = claudeModelPickerState("sonnet")
    expect(state.index).toBeGreaterThan(0)
    expect(state.options[state.index]!.value).toBe("sonnet")
  })

  test("appends current value to options when it is not one of the aliases", () => {
    const state = claudeModelPickerState("claude-opus-4-8")
    expect(state.options[state.options.length - 1]!.value).toBe("claude-opus-4-8")
    expect(state.options[state.options.length - 1]!.label).toBe("Claude claude-opus-4-8 · current")
  })

  test("does not duplicate current value when it matches an alias", () => {
    const state = claudeModelPickerState("sonnet")
    const lastOption = state.options[state.options.length - 1]!
    expect(lastOption.value).not.toBe("sonnet")
    expect(lastOption.label).not.toContain("· current")
  })

  test("sets index to 0 when current is empty string", () => {
    const state = claudeModelPickerState("")
    expect(state.index).toBe(0)
  })
})

describe("goal node classification", () => {
  test("isGoalStep recognizes the terminal goal control node and nothing else", () => {
    const node = { goal: { target: 85, improve: { briefStep: "fix", steps: [{ agent: "goal-fixer", name: "fix" }] }, measure: { steps: ["quality-score-report"] } } }
    expect(isGoalStep(node)).toBe(true)
    expect(isGoalStep({ parallel: ["patterns"] })).toBe(false)
    expect(isGoalStep({ type: "human" })).toBe(false)
    expect(isGoalStep({ agent: "patterns" })).toBe(false)
    expect(isGoalStep("patterns")).toBe(false)
  })

  test("goal rows do not masquerade as human gates or plain agent steps", () => {
    const node = { goal: { target: 85, improve: { briefStep: "fix", steps: [{ agent: "goal-fixer", name: "fix" }] }, measure: { steps: ["quality-score-report"] } } }
    expect(isHumanStep(node)).toBe(false)
  })
})

describe("defaults fields", () => {
  test("worktreeLocation is listed as a string field with its template hint", () => {
    const field = defaultFields.find((field) => field.key === "worktreeLocation")
    expect(field?.type).toBe("string")
    expect(field?.hint).toContain("{repo}/{branch}")
  })

  test("worktreeLocation renders a description naming the template and the marker override", () => {
    const description = describeDefault("worktreeLocation")
    expect(description).toContain("{repo}/{branch}")
    expect(description).toContain("AGENTS.md")
  })

  test("every listed defaults field renders a description", () => {
    for (const field of defaultFields) {
      expect(describeDefault(field.key)).not.toBe("")
    }
  })
})

describe("reports helpers", () => {
  test("priorStepNames lists base names of earlier agent steps, excluding groupmates and humans", () => {
    const list = steps()
    expect(priorStepNames(list, 0)).toEqual([])
    expect(priorStepNames(list, 1)).toEqual(["scope"])
    expect(priorStepNames(list, 3)).toEqual(["scope", "bug-auditor", "security"])
  })

  test("priorStepNames with an empty list", () => {
    expect(priorStepNames([], 0)).toEqual([])
  })

  test("stepValueSummary shows the fan-out count and explicitly set fields", () => {
    expect(stepValueSummary("patterns")).toBe("(inherits)")
    expect(stepValueSummary({ agent: "x", models: ["a/b", "c/d"] })).toBe("2 models")
    expect(stepValueSummary({ agent: "x", model: "a/b", name: "scope", reports: ["scope"], diff: false })).toBe(
      "a/b · name scope · reports scope · diff off",
    )
  })

  test("stepValueSummary distinguishes an advisor, an explicit opt-out, and inheriting", () => {
    expect(stepValueSummary({ agent: "x", model: "a/b", advisor: "c/d" })).toBe("a/b · advisor c/d")
    expect(stepValueSummary({ agent: "x", model: "a/b", advisor: false })).toBe("a/b · no advisor")
    expect(stepValueSummary({ agent: "x", model: "a/b" })).toBe("a/b")
    expect(stepValueSummary({ agent: "x", model: "a/b", advisor: "c/d", advisorMaxCalls: 2 })).toBe("a/b · advisor c/d · advisor×2")
  })

  test("stepValueSummary handles reports as a string", () => {
    expect(stepValueSummary({ agent: "x", reports: "all" })).toBe("(inherits) · reports all")
  })

  test("stepValueSummary handles diff on", () => {
    expect(stepValueSummary({ agent: "x", diff: true })).toBe("(inherits) · diff on")
  })
})
describe("config layout (columns wide, stacked narrow)", () => {
  test("a narrow terminal docks the help pane under the list as a bounded footer", async () => {
    const { createTestRenderer } = await import("@opentui/core/testing")
    const { ConfigEditor } = await import("../src/config-tui")
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "convoy-config-layout-"))
    const key = (name: string) =>
      ({ name, ctrl: false, meta: false, shift: false, option: false, sequence: name, number: false, raw: name, eventType: "keypress", source: "raw", preventDefault: () => {}, stopPropagation: () => {} } as any)
    try {
      await mkdir(join(dir, ".convoy"), { recursive: true })
      await writeFile(join(dir, ".convoy", "config.yaml"), "permissions:\n  allow: []\n  deny: []\nhooks:\n  pre: []\n  post: []\n  pipelines: {}\nattachments: []\n")

      // Narrow: the field pane docks below the list — its frame opens at the
      // left edge on its own line, under the list's closed bottom border.
      const narrow = await createTestRenderer({ width: 80, height: 24 })
      const narrowEditor = new ConfigEditor(narrow.renderer, dir, undefined, undefined)
      await narrow.renderOnce()
      await Bun.sleep(10)
      await narrow.renderOnce()
      const narrowFrame = narrow.captureCharFrame()
      const docked = narrowFrame.split("\n").some((line) => line.trimStart().startsWith("╭─ help"))
      expect(docked).toBe(true)
      narrow.renderer.keyInput.emit("keypress", key("q"))
      await narrowEditor.result.catch(() => {})

      // Wide: the field pane rides beside the list — its frame opens on the
      // same line the list closes on.
      const wide = await createTestRenderer({ width: 120, height: 30 })
      const wideEditor = new ConfigEditor(wide.renderer, dir, undefined, undefined)
      await wide.renderOnce()
      await Bun.sleep(10)
      await wide.renderOnce()
      const wideFrameText = wide.captureCharFrame()
      const sideBySide = wideFrameText.split("\n").some((line) => line.includes("╮") && line.indexOf("╭─ help") > line.indexOf("╮"))
      expect(sideBySide).toBe(true)
      wide.renderer.keyInput.emit("keypress", key("q"))
      await wideEditor.result.catch(() => {})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
