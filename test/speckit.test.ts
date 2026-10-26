import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { listSpecKitChanges, loadSpecKitBundle, readSpecKitActiveChanges, readSpecKitCompleted, readSpecKitConstitution, specKitStepEnv, specKitTaskCounts, titleFromSpec, whyFromSpec } from "../src/speckit"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function checkout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-speckit-"))
  dirs.push(dir)
  return dir
}

// Spec Kit v1.2 spec-template.md and tasks-template.md syntax, with the
// template placeholders filled in so the tests also pin rendered titles.
const spec = '# Feature Specification: Passwordless login\n\n**Input**: User description: "Let users sign in by email link"\n\n## User Scenarios & Testing\n\n### User Story 1 - Sign in (Priority: P1)\n\n**Acceptance Scenarios**:\n\n1. **Given** an email, **When** a link is requested, **Then** send a link.\n'
const tasks = "## Phase 1: Setup (Shared Infrastructure)\n\n- [x] T001 Create project structure\n- [ ] T002 [P] [US1] Implement email sign-in\n"

async function put(dir: string, path: string, body: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true })
  await writeFile(join(dir, path), body)
}

describe("Spec Kit checkout readers", () => {
  test("absent layout is known empty and never falls back to OpenSpec", async () => {
    const dir = await checkout()
    await put(dir, "openspec/changes/add-login/proposal.md", "# Other tool\n")
    expect(await readSpecKitActiveChanges(dir)).toEqual({ kind: "known", value: [] })
    expect(await readSpecKitCompleted(dir)).toEqual({ kind: "known", value: [] })
    expect(await listSpecKitChanges(dir)).toEqual([])
    expect(await loadSpecKitBundle({ targetDir: dir, explicitIds: ["add-login"] })).toBeUndefined()
    expect((await specKitTaskCounts(dir)).size).toBe(0)
  })

  test("copies in different checkouts have independent titles and completion", async () => {
    const first = await checkout()
    const second = await checkout()
    await put(first, "specs/001-login/spec.md", spec)
    await put(first, "specs/001-login/tasks.md", tasks)
    await put(second, "specs/001-login/spec.md", "# Feature Specification: Different title\n")
    await put(second, "specs/001-login/tasks.md", "- [x] T001 Done\n")
    expect(await listSpecKitChanges(first)).toEqual([{ id: "001-login", title: "Passwordless login" }])
    expect(await listSpecKitChanges(second)).toEqual([])
    expect((await readSpecKitCompleted(second))).toMatchObject({ kind: "known", value: [{ changeId: "001-login", sourcePath: join(second, "specs/001-login") }] })
    expect((await loadSpecKitBundle({ targetDir: second, explicitIds: ["001-login"] }))?.changeIds).toEqual([])
  })

  test("symlinked layout roots, files, and constitution ancestors are never followed", async () => {
    const dir = await checkout()
    const outside = await checkout()
    await put(outside, "001-login/spec.md", spec)
    await put(outside, "001-login/tasks.md", "- [x] T001 Done\n")
    await put(outside, "memory/constitution.md", "# Outside constitution\n")
    await symlink(outside, join(dir, "specs"))
    expect(await readSpecKitActiveChanges(dir)).toEqual({ kind: "known", value: [] })
    expect(await loadSpecKitBundle({ targetDir: dir, explicitIds: ["001-login"] })).toBeUndefined()
    await rm(join(dir, "specs"))
    await put(dir, "specs/001-login/spec.md", spec)
    await symlink(join(outside, "001-login/tasks.md"), join(dir, "specs/001-login/tasks.md"))
    await symlink(outside, join(dir, "specs/001-login/contracts"))
    await symlink(join(outside, "memory/constitution.md"), join(dir, "specs/001-login/leak.md"))
    await symlink(outside, join(dir, ".specify"))
    expect(await readSpecKitConstitution(dir)).toEqual({ kind: "known", value: [] })
    await rm(join(dir, ".specify"))
    await mkdir(join(dir, ".specify"))
    await symlink(join(outside, "memory"), join(dir, ".specify/memory"))
    expect(await readSpecKitConstitution(dir)).toEqual({ kind: "known", value: [] })
    await rm(join(dir, ".specify/memory"))
    await mkdir(join(dir, ".specify/memory"))
    await symlink(join(outside, "memory/constitution.md"), join(dir, ".specify/memory/constitution.md"))
    expect(await readSpecKitConstitution(dir)).toEqual({ kind: "known", value: [] })
    expect(await readSpecKitActiveChanges(dir)).toMatchObject({ kind: "known", value: [{ changeId: "001-login", tasks: "unknown" }] })
    expect((await loadSpecKitBundle({ targetDir: dir, explicitIds: ["001-login"] }))?.specFiles).toEqual(["specs/001-login/spec.md"])
  })

  test.skipIf(process.getuid?.() === 0)("unreadable feature directory is unknown evidence, not an empty change list", async () => {
    const dir = await checkout()
    await put(dir, "specs/001-login/spec.md", spec)
    await chmod(join(dir, "specs"), 0o000)
    try {
      expect((await readSpecKitActiveChanges(dir)).kind).toBe("unknown")
      expect((await readSpecKitCompleted(dir)).kind).toBe("unknown")
      await expect(listSpecKitChanges(dir)).rejects.toThrow()
    } finally {
      await chmod(join(dir, "specs"), 0o700)
    }
  })

  test("failed count observations preserve active features with unknown tasks", async () => {
    const dir = await checkout()
    await put(dir, "specs/001-login/spec.md", spec)
    await put(dir, "specs/001-login/tasks.md", "- [x] T001 Done\n")
    const read = await readSpecKitActiveChanges(dir, { taskCounts: async () => { throw new Error("unreadable count") } })
    expect(read).toMatchObject({ kind: "known", value: [{ changeId: "001-login", tasks: "unknown" }] })
  })

  test("bundle and step environment reads never persist a feature selection", async () => {
    const dir = await checkout()
    await put(dir, "specs/001-login/spec.md", "## No title\n")
    const selection = '{"feature":"other-feature"}\n'
    await put(dir, ".specify/feature.json", selection)
    expect(await listSpecKitChanges(dir)).toEqual([{ id: "001-login", title: "001-login" }])
    await loadSpecKitBundle({ targetDir: dir, explicitIds: ["001-login"] })
    expect(specKitStepEnv(dir, ["001-login"])).toEqual({ SPECIFY_FEATURE_DIRECTORY: join(dir, "specs/001-login"), SPECIFY_FEATURE_NO_PERSIST: "1" })
    expect(await readFile(join(dir, ".specify/feature.json"), "utf8")).toBe(selection)
  })

  test("titles and Why use the v1.2 template labels without inventing fallback prose", () => {
    expect(titleFromSpec(spec, "001-login")).toBe("Passwordless login")
    expect(whyFromSpec(spec)).toBe("Let users sign in by email link")
    expect(titleFromSpec("---\ntitle: not a title\n---\n# Feature Specification: Search\r\n", "id")).toBe("Search")
    expect(titleFromSpec("## User Scenarios\nNo top-level heading.", "001-login")).toBe("001-login")
    expect(titleFromSpec("# Feature Specification: \n", "001-login")).toBe("001-login")
    expect(titleFromSpec("# \n## User Stories\n", "001-login")).toBe("001-login")
    expect(whyFromSpec("**Input**: User description: 'A quoted intent'\n")).toBe("A quoted intent")
    expect(whyFromSpec("**Input**: User description: Plain intent\n")).toBe("Plain intent")
    expect(whyFromSpec("# Spec\n")).toBeUndefined()
    expect(whyFromSpec('**Input**: User description: ""\n')).toBeUndefined()
    expect(whyFromSpec("**Input**: User description:\n\n## User Scenarios\n")).toBeUndefined()
    expect(whyFromSpec("**Input**:\nUnrelated paragraph\n")).toBeUndefined()
  })

  test("materializes only selected active features in review order, constitution first", async () => {
    const dir = await checkout()
    expect(await loadSpecKitBundle({ targetDir: dir })).toBeUndefined()
    expect(await readSpecKitConstitution(dir)).toEqual({ kind: "known", value: [] })
    await put(dir, ".specify/memory/constitution.md", "# Constitution\n")
    await put(dir, "specs/001-login/spec.md", spec)
    await put(dir, "specs/001-login/plan.md", "# Plan\n")
    await put(dir, "specs/001-login/tasks.md", tasks)
    await put(dir, "specs/001-login/research.md", "# Research\n")
    await put(dir, "specs/001-login/contracts/api.md", "# API\n")
    await put(dir, "specs/001-login/checklists/requirements.md", "# Checklist\n")
    await put(dir, "specs/001-login/.private/secret.md", "# Never attached\n")
    await put(dir, "specs/002-search/spec.md", "# Feature Specification: Search\n")
    await put(dir, "specs/000-completed/spec.md", spec)
    await put(dir, "specs/000-completed/tasks.md", "- [x] T001 Done\n")
    await put(dir, "openspec/changes/wrong-tool/proposal.md", "# Not selected\n")
    const bundle = await loadSpecKitBundle({ targetDir: dir, explicitIds: ["002-search", "001-login", "002-search", "000-completed", "../wrong-tool", "wrong-tool"] })
    expect(bundle).toEqual({ tool: "speckit", changeIds: ["002-search", "001-login"], rootDir: dir, specFiles: [
      ".specify/memory/constitution.md", "specs/002-search/spec.md", "specs/001-login/checklists/requirements.md", "specs/001-login/contracts/api.md", "specs/001-login/plan.md", "specs/001-login/research.md", "specs/001-login/spec.md", "specs/001-login/tasks.md",
    ] })
    expect((await loadSpecKitBundle({ targetDir: dir }))?.changeIds).toEqual([])
    expect(await readSpecKitConstitution(dir)).toEqual({ kind: "known", value: [{ checkout: dir, capability: "constitution", sourcePath: join(dir, ".specify/memory/constitution.md") }] })
  })

  test("contract schemas in any text format join the bundle, the inventory, and the reader", async () => {
    const dir = await checkout()
    await put(dir, "specs/001-login/spec.md", spec)
    await put(dir, "specs/001-login/plan.md", "# Plan\n")
    await put(dir, "specs/001-login/contracts/openapi.yaml", "openapi: 3.1.0\n")
    await put(dir, "specs/001-login/contracts/events/login.schema.json", "{}\n")
    await put(dir, "specs/001-login/contracts/schema.graphql", "type Query { me: User }\n")
    await put(dir, "specs/001-login/contracts/auth.proto", 'syntax = "proto3";\n')
    await put(dir, "specs/001-login/contracts/diagram.png", "\x89PNG\r\n")
    await put(dir, "specs/001-login/contracts/.draft.yaml", "draft: true\n")
    await put(dir, "specs/001-login/notes.yaml", "outside: contracts\n")
    const contracts = ["contracts/auth.proto", "contracts/events/login.schema.json", "contracts/openapi.yaml", "contracts/schema.graphql"]
    expect((await loadSpecKitBundle({ targetDir: dir, explicitIds: ["001-login"] }))?.specFiles).toEqual([
      ...contracts.map((file) => `specs/001-login/${file}`), "specs/001-login/plan.md", "specs/001-login/spec.md",
    ])
    expect(await readSpecKitActiveChanges(dir)).toMatchObject({ kind: "known", value: [{ changeId: "001-login", artifacts: { other: contracts } }] })
  })

  test("unreadable tasks stay active and unknown, never completed", async () => {
    const dir = await checkout()
    await put(dir, "specs/001-login/spec.md", spec)
    await mkdir(join(dir, "specs/001-login/tasks.md"))
    const read = await readSpecKitActiveChanges(dir)
    expect(read).toMatchObject({ kind: "known", value: [{ changeId: "001-login", tasks: "unknown" }] })
    expect(await readSpecKitCompleted(dir)).toEqual({ kind: "known", value: [] })
    expect((await specKitTaskCounts(dir)).has("001-login")).toBe(false)
  })

  test("lists real feature directories sorted, splitting completed tasks without a CLI", async () => {
    const dir = await checkout()
    await put(dir, "specs/003-planning/spec.md", spec)
    await put(dir, "specs/002-login/spec.md", spec)
    await put(dir, "specs/002-login/plan.md", "# Implementation Plan\n")
    await put(dir, "specs/002-login/tasks.md", tasks)
    await put(dir, "specs/001-complete/spec.md", spec)
    await put(dir, "specs/001-complete/tasks.md", "- [x] T001 Setup\n* [X] T002 [P] Model\n+ [x] T003 Finish\n")
    await put(dir, "specs/004-empty-tasks/spec.md", spec)
    await put(dir, "specs/004-empty-tasks/tasks.md", "## Phase 1\nNo tasks yet.\n")
    await put(dir, "specs/.hidden/spec.md", spec)
    await put(dir, "specs/notes.md", "# not a feature\n")
    await mkdir(join(dir, "specs", "drafts"))
    await symlink(join(dir, "specs", "002-login"), join(dir, "specs", "005-link"))
    await mkdir(join(dir, "specs", "006-linked-spec"))
    await symlink(join(dir, "specs", "002-login", "spec.md"), join(dir, "specs", "006-linked-spec", "spec.md"))

    const active = await readSpecKitActiveChanges(dir)
    expect(active.kind).toBe("known")
    if (active.kind !== "known") throw new Error(active.reason)
    expect(active.value.map((entry) => entry.changeId)).toEqual(["002-login", "003-planning", "004-empty-tasks"])
    expect(active.value[0]).toMatchObject({ checkout: dir, sourcePath: join(dir, "specs", "002-login"), title: "Passwordless login", tasks: { done: 1, total: 2 }, artifacts: { proposal: true, design: true, tasks: true, deltaSpecs: [], other: [] } })
    expect(active.value[1]!.tasks).toBeUndefined()
    expect(active.value[2]!.tasks).toEqual({ done: 0, total: 0 })
    expect(await readSpecKitCompleted(dir)).toEqual({ kind: "known", value: [{ checkout: dir, changeId: "001-complete", sourcePath: join(dir, "specs", "001-complete"), hasMarkdown: true }] })
    expect([...(await specKitTaskCounts(dir))]).toEqual([
      ["001-complete", { done: 3, total: 3 }], ["002-login", { done: 1, total: 2 }], ["004-empty-tasks", { done: 0, total: 0 }],
    ])
  })
})
