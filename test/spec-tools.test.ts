import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isSpecToolId, specPromptFor, specToolById, specToolFor, specToolIds, specToolOf, specTools } from "../src/spec-tools"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("spec tool descriptors", () => {
  test("title fallback and rationale policies belong to the tool", () => {
    expect(specTools.openspec.promptWhyFallback).toBe(true)
    expect(specTools.speckit.promptWhyFallback).toBe(false)
    expect(specTools.openspec.fallbackTitleIsUsable).toBe(false)
    expect(specTools.speckit.fallbackTitleIsUsable).toBe(true)
    for (const id of ["archive", "feature.md"]) {
      expect(specTools.openspec.isChangeId(id)).toBe(false)
      expect(specTools.speckit.isChangeId(id)).toBe(true)
    }
    for (const tool of Object.values(specTools)) {
      for (const id of ["", ".hidden", "../outside", "nested/feature", "nested\\feature", "bad\u0000id"]) expect(tool.isChangeId(id)).toBe(false)
    }
  })

  test("shared descriptor arrays and reader groups cannot be mutated by consumers", () => {
    expect(Object.isFrozen(specToolIds)).toBe(true)
    expect(Object.isFrozen(specTools)).toBe(true)
    for (const tool of Object.values(specTools)) {
      expect(Object.isFrozen(tool)).toBe(true)
      expect(Object.isFrozen(tool.proposalCommands)).toBe(true)
      expect(Object.isFrozen(tool.fingerprintRoots)).toBe(true)
      expect(Object.isFrozen(tool.groups)).toBe(true)
      for (const group of tool.groups) {
        expect(Object.isFrozen(group)).toBe(true)
        expect(Object.isFrozen(group.files)).toBe(true)
        if (group.prefixes) expect(Object.isFrozen(group.prefixes)).toBe(true)
      }
    }
  })

  test("OpenSpec descriptor wraps its existing bundle and delta prefix without changing the layout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-spec-tools-"))
    dirs.push(dir)
    const changeRoot = join(dir, "openspec/changes/add-login")
    await mkdir(join(changeRoot, "specs/auth"), { recursive: true })
    await mkdir(join(dir, "openspec/specs/auth"), { recursive: true })
    await writeFile(join(changeRoot, "proposal.md"), "# Add login\n\n## Why\n\nAvoid passwords.\n\n## What Changes\n\nEmail links.\n")
    await writeFile(join(changeRoot, "specs/auth/spec.md"), "## MODIFIED Requirements\n")
    await writeFile(join(dir, "openspec/specs/auth/spec.md"), "# Current auth\n")
    const tool = specTools.openspec
    expect(await tool.listChanges(dir)).toEqual([{ id: "add-login", title: "Add login" }])
    expect(await tool.loadBundle({ targetDir: dir, explicitIds: ["add-login"] })).toEqual({ tool: "openspec", changeIds: ["add-login"], rootDir: dir, specFiles: ["openspec/specs/auth/spec.md", "openspec/changes/add-login/proposal.md", "openspec/changes/add-login/specs/auth/spec.md"] })
    await writeFile(join(dir, "openspec/specs/core.md"), "# Loose canonical Markdown\n")
    expect(await tool.readCanonicalFiles(dir)).toEqual({ kind: "known", value: ["openspec/specs/auth/spec.md", "openspec/specs/core.md"] })
    // The board's capability inventory keeps its existing spec.md-only rule;
    // the reader and contract walker also include loose canonical Markdown.
    expect(await tool.readCanonical(dir)).toEqual({ kind: "known", value: [{ checkout: dir, capability: "auth", sourcePath: join(dir, "openspec/specs/auth/spec.md") }] })
    expect((await tool.loadBundle({ targetDir: dir, explicitIds: ["add-login"] }))?.specFiles).toContain("openspec/specs/core.md")
    expect(tool.whyOf("## Why\n\nAvoid passwords.\n\n## What Changes\n\nEmail links.\n")).toBe("Avoid passwords.")
    expect(tool.whyOf("# No rationale")).toBeUndefined()
    expect(await tool.branchPrefix(changeRoot)).toBe("change")
    await writeFile(join(changeRoot, "specs/auth/spec.md"), "## ADDED Requirements\n")
    expect(await tool.branchPrefix(changeRoot)).toBe("feat")
    await writeFile(join(changeRoot, "specs/auth/spec.md"), "## REMOVED Requirements\n")
    expect(await tool.branchPrefix(changeRoot)).toBe("fix")
    expect(await specTools.speckit.branchPrefix(changeRoot)).toBe("feat")
  })

  test("contract prompts retain pipeline verbs while naming the selected tool", () => {
    for (const [pipeline, verb] of [["review", "Review"], ["review-lite", "Review"], ["review-cc", "Review"], ["ship", "Ship"], ["fixer", "Apply"], ["hunter", "Audit"], ["hunter-max", "Audit"], ["implement", "Implement"], ["custom", "Implement"]]) {
      for (const tool of Object.values(specTools)) expect(specPromptFor(pipeline!, tool)).toBe(`${verb} the attached ${tool.changeNoun}.`)
    }
  })

  test("reader groups describe each layout with an explicit catch-all", () => {
    expect(specTools.openspec.groups).toEqual([
      { kind: "proposal", label: "Proposal", files: ["proposal.md"] },
      { kind: "design", label: "Design", files: ["design.md"] },
      { kind: "tasks", label: "Tasks", files: ["tasks.md"] },
      { kind: "delta", label: "Delta Specs", files: [], prefixes: ["specs/"], headings: true },
      { kind: "other", label: "Other", files: [] },
    ])
    expect(specTools.speckit.groups).toEqual([
      { kind: "spec", label: "Spec", files: ["spec.md"] },
      { kind: "plan", label: "Plan", files: ["plan.md"] },
      { kind: "tasks", label: "Tasks", files: ["tasks.md"] },
      { kind: "design-docs", label: "Design Docs", files: ["research.md", "data-model.md", "quickstart.md"], prefixes: ["contracts/"], headings: true },
      { kind: "other", label: "Other", files: [] },
    ])
  })

  test("chooses exactly the configured tool, defaults to OpenSpec, and disables specs explicitly", () => {
    expect(specToolIds).toEqual(["openspec", "speckit"])
    expect(specToolFor()).toBe(specTools.openspec)
    expect(specToolFor({ features: {} })).toBe(specTools.openspec)
    expect(specToolFor({ features: { specs: "speckit" } })).toBe(specTools.speckit)
    expect(specToolFor({ features: { specs: false } })).toBeUndefined()
    for (const id of specToolIds) expect(specToolById(id)).toBe(specTools[id])
    expect(specTools.openspec).toMatchObject({ label: "OpenSpec", changeNoun: "OpenSpec change", changeRoot: "openspec/changes", dirtyRoot: "openspec/", proposalFile: "proposal.md", archives: true, settledLabel: "archives", canonicalLabel: "Canonical Specs", proposalCommands: ["opsx-propose", "*propose"], fingerprintRoots: ["openspec/"] })
    expect(specTools.speckit).toMatchObject({ label: "Spec Kit", changeNoun: "Spec Kit feature", changeRoot: "specs", dirtyRoot: "specs/", proposalFile: "spec.md", archives: false, archiveDisabledReason: "Spec Kit has no archive", settledLabel: "completed", canonicalLabel: "Constitution", proposalCommands: ["speckit.specify", "speckit-specify"], fingerprintRoots: ["specs/", ".specify/"] })
    expect(specTools.speckit.stepEnv("/w/app", ["001-login"])).toEqual({ SPECIFY_FEATURE_DIRECTORY: "/w/app/specs/001-login", SPECIFY_FEATURE_NO_PERSIST: "1" })
    expect(specTools.speckit.stepEnv("/w/app", [])).toEqual({})
    expect(specTools.speckit.stepEnv("/w/app", ["001-login", "002-search"])).toEqual({})
    expect(specTools.openspec.stepEnv("/w/app", ["add-login"])).toEqual({})
  })

  test("recognizes registered tool ids and resolves a features.specs value", () => {
    for (const id of specToolIds) expect(isSpecToolId(id)).toBe(true)
    for (const value of [true, false, "", "OpenSpec", "spec-kit", undefined]) expect(isSpecToolId(value)).toBe(false)
    expect(specToolOf(undefined)).toBe(specTools.openspec)
    expect(specToolOf("speckit")).toBe(specTools.speckit)
    expect(specToolOf(false)).toBeUndefined()
  })
})
