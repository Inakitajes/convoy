import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildRunPlan } from "../src/run-plan"
import { renderRunPlan } from "../src/run-review"
import { parseCommand } from "../src/cli"
import type { RunOptions } from "../src/types"
import {
  branchIdFromBranch,
  isOpenSpecChangeId,
  listOpenSpecChanges,
  loadOpenSpecBundle,
  openSpecPromptFor,
  openspecDirName,
  resolveChange,
  titleFromProposal,
  type OpenSpecChange,
} from "../src/openspec"

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function change(id: string, touchedFiles: string[], specFiles: string[]): OpenSpecChange {
  return { id, touchedFiles, specFiles }
}

describe("OpenSpec change discovery", () => {
  test("a change dir is any entry that is not the archive binder, a dotfile, or a stray markdown file", () => {
    expect(isOpenSpecChangeId("add-login")).toBe(true)
    expect(isOpenSpecChangeId("archive")).toBe(false)
    expect(isOpenSpecChangeId(".hidden")).toBe(false)
    expect(isOpenSpecChangeId("README.md")).toBe(false)
  })

  test("branch-to-id matching strips a type/ prefix: feat/add-foo → add-foo", () => {
    expect(branchIdFromBranch("feat/add-foo")).toBe("add-foo")
    expect(branchIdFromBranch("add-foo")).toBe("add-foo")
    expect(branchIdFromBranch("feat/nested/add-foo")).toBe("nested/add-foo")
    expect(branchIdFromBranch(undefined)).toBeUndefined()
  })

  test("without an explicit selection, resolves nothing — a singleton is never auto-attached", () => {
    expect(
      resolveChange({
        changesDirEntries: ["add-foo", "archive", "README.md"],
        changesById: new Map([["add-foo", change("add-foo", [], [])]]),
      }),
    ).toEqual([])
  })

  test("skips archive/ and any .md that is not a change dir", () => {
    expect(
      resolveChange({
        changesDirEntries: ["archive", "README.md", "design.md", ".gitkeep"],
        changesById: new Map(),
      }),
    ).toEqual([])
  })

  test("a matching branch name never selects its change id (no branch heuristic)", () => {
    expect(
      resolveChange({
        changesDirEntries: ["add-foo", "add-bar"],
        changesById: new Map([
          ["add-foo", change("add-foo", [], [])],
          ["add-bar", change("add-bar", [], [])],
        ]),
      }),
    ).toEqual([])
  })

  test("touched files never select a change (no diff-composition heuristic)", () => {
    expect(
      resolveChange({
        changesDirEntries: ["add-foo", "add-bar"],
        changesById: new Map([
          ["add-foo", change("add-foo", ["src/foo.ts", "lib/foo.ts"], [])],
          ["add-bar", change("add-bar", ["src/bar.ts"], [])],
        ]),
      }),
    ).toEqual([])
  })

  test("the explicit selection keeps the requested order and deduplicates", () => {
    expect(
      resolveChange({
        explicitIds: ["add-b", "add-a", "add-b"],
        changesDirEntries: ["add-a", "add-b", "add-c"],
        changesById: new Map([
          ["add-a", change("add-a", [], [])],
          ["add-b", change("add-b", [], [])],
          ["add-c", change("add-c", [], [])],
        ]),
      }),
    ).toEqual(["add-b", "add-a"])
  })

  test("an id that names no active change is dropped here; the caller refuses naming it", () => {
    expect(
      resolveChange({
        explicitIds: ["add-foo", "nope"],
        changesDirEntries: ["add-foo", "add-bar"],
        changesById: new Map([
          ["add-foo", change("add-foo", [], [])],
          ["add-bar", change("add-bar", [], [])],
        ]),
      }),
    ).toEqual(["add-foo"])
  })

  test("the explicit selection wins regardless of branch or diff evidence", () => {
    expect(
      resolveChange({
        explicitIds: ["baz-qux"],
        changesDirEntries: ["add-foo", "baz-qux", "add-bar"],
        changesById: new Map([
          ["add-foo", change("add-foo", [], [])],
          ["add-bar", change("add-bar", [], [])],
          ["baz-qux", change("baz-qux", ["src/baz.ts"], [])],
        ]),
      }),
    ).toEqual(["baz-qux"])
  })

  test("an explicit id that is archived or absent selects nothing", () => {
    expect(
      resolveChange({
        explicitIds: ["nope"],
        changesDirEntries: ["add-foo", "archive"],
        changesById: new Map([["add-foo", change("add-foo", [], [])]]),
      }),
    ).toEqual([])
  })

  test("empty openspec/changes/ resolves to no change", () => {
    expect(resolveChange({ changesDirEntries: [], changesById: new Map() })).toEqual([])
  })

  test("loadOpenSpecBundle returns undefined when openspec/ is absent, and never throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-openspec-absent-"))
    dirs.push(dir)
    expect(await loadOpenSpecBundle({ targetDir: dir })).toBeUndefined()
  })

  test("materializes the bundle: current specs plus the active change's files, never archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-openspec-bundle-"))
    dirs.push(dir)
    await mkdir(join(dir, openspecDirName, "specs", "auth"), { recursive: true })
    await mkdir(join(dir, openspecDirName, "specs", "payments"), { recursive: true })
    await mkdir(join(dir, openspecDirName, "changes", "add-login", "specs", "auth"), { recursive: true })
    await mkdir(join(dir, openspecDirName, "archive", "old-change"), { recursive: true })
    await writeFile(join(dir, openspecDirName, "specs", "auth", "spec.md"), "# Auth spec\n")
    await writeFile(join(dir, openspecDirName, "specs", "payments", "spec.md"), "# Payments spec\n")
    await writeFile(join(dir, openspecDirName, "changes", "add-login", "proposal.md"), "# Add Login\n")
    await writeFile(join(dir, openspecDirName, "changes", "add-login", "specs", "auth", "spec.md"), "## ADDED Scenarios\n")
    await writeFile(join(dir, openspecDirName, "archive", "old-change", "proposal.md"), "# Old\n")

    const bundle = await loadOpenSpecBundle({ targetDir: dir, explicitIds: ["add-login"] })
    expect(bundle).toBeDefined()
    expect(bundle!.changeIds).toEqual(["add-login"])
    expect([...bundle!.specFiles].sort()).toEqual(
      [
        "openspec/specs/auth/spec.md",
        "openspec/specs/payments/spec.md",
        "openspec/changes/add-login/proposal.md",
        "openspec/changes/add-login/specs/auth/spec.md",
      ].sort(),
    )
  })

  test("never follows symlinks: a change-dir .md link, a symlinked change dir, and a symlinked specs root attach nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-openspec-symlink-"))
    dirs.push(dir)
    const outside = await mkdtemp(join(tmpdir(), "convoy-openspec-outside-"))
    dirs.push(outside)
    await writeFile(join(outside, "leak.md"), "# outside the repository\n")

    await mkdir(join(dir, openspecDirName, "changes", "add-login"), { recursive: true })
    await writeFile(join(dir, openspecDirName, "changes", "add-login", "proposal.md"), "# Add Login\n")
    // Committed symlinks whose targets live outside the repository must never
    // reach the spec bundle the runner attaches to agent prompts.
    await symlink(join(outside, "leak.md"), join(dir, openspecDirName, "changes", "add-login", "leak.md"))
    await symlink(outside, join(dir, openspecDirName, "changes", "evil"))
    await symlink(outside, join(dir, openspecDirName, "specs"))

    const bundle = await loadOpenSpecBundle({ targetDir: dir, explicitIds: ["add-login"] })
    expect(bundle).toBeDefined()
    expect(bundle!.changeIds).toEqual(["add-login"])
    expect(bundle!.specFiles).toEqual(["openspec/changes/add-login/proposal.md"])
  })

  test("the loader resolves only the explicit selection; without one, no change attaches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-openspec-explicit-"))
    dirs.push(dir)
    await mkdir(join(dir, openspecDirName, "changes", "add-foo", "specs"), { recursive: true })
    await mkdir(join(dir, openspecDirName, "changes", "add-bar"), { recursive: true })
    await writeFile(join(dir, openspecDirName, "changes", "add-foo", "proposal.md"), "# Foo\n")
    await writeFile(join(dir, openspecDirName, "changes", "add-bar", "proposal.md"), "# Bar\n")

    expect((await loadOpenSpecBundle({ targetDir: dir }))?.changeIds).toEqual([])
    expect((await loadOpenSpecBundle({ targetDir: dir, explicitIds: ["add-bar"] }))?.changeIds).toEqual(["add-bar"])
  })

  test("loader persists an empty bundle (openspec present, nothing selected), distinct from absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-openspec-empty-"))
    dirs.push(dir)
    await mkdir(join(dir, openspecDirName, "archive", "old-change"), { recursive: true })
    await mkdir(join(dir, openspecDirName, "changes"), { recursive: true })
    await writeFile(join(dir, openspecDirName, "changes", "README.md"), "# changes\n")

    const bundle = await loadOpenSpecBundle({ targetDir: dir })
    expect(bundle).toBeDefined()
    expect(bundle!.changeIds).toEqual([])
  })

  test("a reviewed plan freezes the bundle and --plan previews the active change without an agent", () => {
    const options: RunOptions = {
      prompt: "review",
      prdHistory: true,
      changes: ["add-login"],
      files: [],
      onlySteps: [],
      skipSteps: [],
      resumeRunID: "",
      keepRunDir: true,
      modelOverride: "",
      advisorOverride: "",
      advisorDisabled: false,
      tui: false,
      notify: false,
      notifications: {},
      humanReview: false,
      baseRef: "main",
      targetDir: "/repo",
      worktree: false,
      includeDirty: false,
      yolo: false,
      smart: false,
      smartJudgeModel: "openai/gpt-5.6-sol",
      pipeline: { name: "review", steps: [] },
      agents: [],
      permissions: { allow: [], deny: [] },
      hooks: { pre: [], post: [], pipelines: {} },
    }
    const bundle = {
      changeIds: ["add-login"],
      specFiles: ["openspec/specs/auth/spec.md", "openspec/changes/add-login/proposal.md"],
    }
    const plan = buildRunPlan({ ...options, openspec: bundle })
    expect(plan.openspec).toEqual(bundle)
    expect(Object.isFrozen(plan.openspec)).toBe(true)

    const rendered = renderRunPlan(plan)
    expect(rendered).toContain("OpenSpec change: add-login")
    expect(rendered).toContain("contract attached (2 spec files)")
  })

  test("a plan without resolves previews the diff fallback instead of an OpenSpec line", () => {
    const options: RunOptions = {
      prompt: "test",
      prdHistory: true,
      files: [],
      onlySteps: [],
      skipSteps: [],
      resumeRunID: "",
      keepRunDir: true,
      modelOverride: "",
      advisorOverride: "",
      advisorDisabled: false,
      tui: false,
      notify: false,
      notifications: {},
      humanReview: false,
      baseRef: "main",
      targetDir: "/repo",
      worktree: false,
      includeDirty: false,
      yolo: false,
      smart: false,
      smartJudgeModel: "openai/gpt-5.6-sol",
      pipeline: { name: "review", steps: [] },
      agents: [],
      permissions: { allow: [], deny: [] },
      hooks: { pre: [], post: [], pipelines: {} },
    }
    const plan = buildRunPlan({ ...options, openspec: { changeIds: [], specFiles: [] } })
    expect(plan.openspec?.changeIds).toEqual([])
    expect(renderRunPlan(plan)).toContain("no active change — scope falls back to the diff")
  })
})

describe("--change wiring through the reviewed run plan", () => {
  async function git(args: string[], cwd: string): Promise<void> {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "convoy-test",
        GIT_AUTHOR_EMAIL: "convoy-test@example.invalid",
        GIT_COMMITTER_NAME: "convoy-test",
        GIT_COMMITTER_EMAIL: "convoy-test@example.invalid",
      },
    })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  async function repoOn(branch: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-openspec-cli-"))
    dirs.push(dir)
    await git(["init", "-q", "-b", branch], dir)
    await writeFile(join(dir, "README.md"), "# test\n")
    await git(["add", "README.md"], dir)
    await git(["commit", "-qm", "initial"], dir)
    return dir
  }

  /** Two active changes plus the current auth spec, as /opsx:propose would leave them. */
  async function repoWithTwoChanges(branch: string): Promise<string> {
    const repo = await repoOn(branch)
    for (const id of ["add-foo", "add-bar"]) {
      await mkdir(join(repo, openspecDirName, "changes", id), { recursive: true })
      await writeFile(join(repo, openspecDirName, "changes", id, "proposal.md"), `# ${id}\n`)
    }
    await mkdir(join(repo, openspecDirName, "specs", "auth"), { recursive: true })
    await writeFile(join(repo, openspecDirName, "specs", "auth", "spec.md"), "# Auth spec\n")
    return repo
  }

  async function runPlanFor(argv: string[]) {
    const command = await parseCommand(argv)
    if (command.type !== "run") throw new Error(`expected a run command, got ${command.type}`)
    return command.options.plan
  }

  test("--change add-foo freezes that change's bundle and the main specs into the plan", async () => {
    const repo = await repoWithTwoChanges("main")

    const plan = await runPlanFor(["--dir", repo, "--change", "add-foo", "review this"])
    expect(plan?.openspec?.changeIds).toEqual(["add-foo"])
    expect(plan?.openspec?.specFiles).toContain("openspec/specs/auth/spec.md")
    expect(plan?.openspec?.specFiles).toContain("openspec/changes/add-foo/proposal.md")
    expect(plan?.openspec?.specFiles).not.toContain("openspec/changes/add-bar/proposal.md")
  })

  test("a headless launch without --change or --manual never binds a lone active change (regression)", async () => {
    const repo = await repoOn("main")
    await mkdir(join(repo, openspecDirName, "changes", "add-login"), { recursive: true })
    await writeFile(join(repo, openspecDirName, "changes", "add-login", "proposal.md"), "# Add Login\n")

    // The singleton must not attach itself: the launch refuses naming the
    // explicit selection modes instead (run-launcher delta).
    await expect(runPlanFor(["--dir", repo, "review this"])).rejects.toThrow("no change is selected")
    // The explicit no-change mode is valid with zero selected changes.
    const manual = await runPlanFor(["--dir", repo, "--manual", "review this"])
    expect(manual?.openspec?.changeIds).toEqual([])
    // And the explicit selection still freezes the singleton's bundle.
    const explicit = await runPlanFor(["--dir", repo, "--change", "add-login", "review this"])
    expect(explicit?.openspec?.changeIds).toEqual(["add-login"])
    expect(explicit?.openspec?.specFiles).toContain("openspec/changes/add-login/proposal.md")
  })

  test("a matching branch name never picks its change; the explicit selection does", async () => {
    const repo = await repoWithTwoChanges("main")
    await mkdir(join(repo, "src"), { recursive: true })
    await writeFile(join(repo, "src", "foo.ts"), "export {}\n")
    await git(["add", "src"], repo)
    await git(["checkout", "-q", "-b", "feat/add-foo"], repo)
    await git(["commit", "-qm", "foo"], repo)

    await expect(runPlanFor(["--dir", repo, "review this"])).rejects.toThrow("no change is selected")
    const plan = await runPlanFor(["--dir", repo, "--change", "add-foo", "review this"])
    expect(plan?.openspec?.changeIds).toEqual(["add-foo"])
  })

  test("the full ordered --change list freezes into the durable plan (B then A)", async () => {
    const repo = await repoWithTwoChanges("main")

    const plan = await runPlanFor(["--dir", repo, "--change", "add-bar", "--change", "add-foo", "review this"])
    expect(plan?.openspec?.changeIds).toEqual(["add-bar", "add-foo"])
    expect(plan?.openspec?.specFiles).toContain("openspec/changes/add-bar/proposal.md")
    expect(plan?.openspec?.specFiles).toContain("openspec/changes/add-foo/proposal.md")
  })

  test("a checkout without openspec/ keeps plan.openspec undefined (today's behavior)", async () => {
    const repo = await repoOn("main")

    const plan = await runPlanFor(["--dir", repo, "review this"])
    expect(plan?.openspec).toBeUndefined()
  })

  test("--change with an unknown id refuses instead of silently reviewing without a contract", async () => {
    const repo = await repoWithTwoChanges("main")

    await expect(runPlanFor(["--dir", repo, "--change", "nope", "review this"])).rejects.toThrow("--change \"nope\"")
    // A repo without openspec/ refuses too: the pinned id cannot exist there.
    const plain = await repoOn("main")
    await expect(runPlanFor(["--dir", plain, "--change", "add-foo", "review this"])).rejects.toThrow("--change \"add-foo\"")
  })

  test("a launch with no active change refuses with the propose/manual guidance", async () => {
    const repo = await repoOn("main")
    await mkdir(join(repo, openspecDirName, "changes"), { recursive: true })
    await writeFile(join(repo, openspecDirName, "changes", "README.md"), "# changes\n")

    await expect(runPlanFor(["--dir", repo, "build it"])).rejects.toThrow("/opsx:propose")
  })

  test("review accepts the explicit no-change mode when openspec/ is present but no change is active", async () => {
    const repo = await repoOn("main")
    await mkdir(join(repo, openspecDirName, "changes"), { recursive: true })
    await writeFile(join(repo, openspecDirName, "changes", "README.md"), "# changes\n")

    await expect(runPlanFor(["--dir", repo, "-p", "review", "review this"])).rejects.toThrow("/opsx:propose")
    const plan = await runPlanFor(["--dir", repo, "-p", "review", "--manual", "review this"])
    expect(plan?.openspec?.changeIds).toEqual([])
  })

describe("the launcher's explicit selection through prepareInteractiveRun", () => {
  test("the durable plan carries the full ordered selection (B then A), never just the first", async () => {
    const repo = await repoWithTwoChanges("main")
    const { prepareInteractiveRun } = await import("../src/cli")

    const preparation = await prepareInteractiveRun(repo, {
      targetDir: repo,
      prompt: "review this",
      pipeline: "review",
      humanReview: false,
      tui: false,
      includeDirty: false,
      keepRunDir: true,
      yolo: false,
      smart: false,
      gateway: "configured",
      isolateWorktree: false,
      changes: ["add-bar", "add-foo"],
    } as never)
    expect(preparation.plan.openspec?.changeIds).toEqual(["add-bar", "add-foo"])
    expect(preparation.plan.openspec?.specFiles).toContain("openspec/changes/add-bar/proposal.md")
    expect(preparation.plan.openspec?.specFiles).toContain("openspec/changes/add-foo/proposal.md")
  })

  test("proceeding without a pick or the manual decision refuses; the manual decision is valid", async () => {
    const repo = await repoOn("main")
    await mkdir(join(repo, openspecDirName, "changes", "add-login"), { recursive: true })
    await writeFile(join(repo, openspecDirName, "changes", "add-login", "proposal.md"), "# Add Login\n")
    const { prepareInteractiveRun } = await import("../src/cli")

    const base = {
      targetDir: repo,
      prompt: "review this",
      pipeline: "review",
      humanReview: false,
      tui: false,
      includeDirty: false,
      keepRunDir: true,
      yolo: false,
      smart: false,
      gateway: "configured",
      isolateWorktree: false,
    }
    await expect(prepareInteractiveRun(repo, { ...base, changes: [] } as never)).rejects.toThrow("no change is selected")
    const manual = await prepareInteractiveRun(repo, { ...base, changes: [], manualNoChanges: true } as never)
    expect(manual.plan.openspec?.changeIds).toEqual([])
  })
})
})

describe("OpenSpec listing and canned prompt", () => {
  test("titleFromProposal prefers the first heading and skips YAML frontmatter", () => {
    expect(titleFromProposal("# Add Login\n\nDetails.", "fallback")).toBe("Add Login")
    expect(titleFromProposal("---\nstatus: draft\n---\n# Add Logout\n", "fallback")).toBe("Add Logout")
    expect(titleFromProposal("No heading at all\njust prose.", "fallback")).toBe("No heading at all")
    expect(titleFromProposal("   \n\n", "add-empty")).toBe("add-empty")
  })

  test("openSpecPromptFor is pipeline-aware and never invents a brief", () => {
    expect(openSpecPromptFor("implement")).toBe("Implement the attached OpenSpec change.")
    expect(openSpecPromptFor("implement-lite")).toBe("Implement the attached OpenSpec change.")
    expect(openSpecPromptFor("review")).toBe("Review the attached OpenSpec change.")
    expect(openSpecPromptFor("review-lite")).toBe("Review the attached OpenSpec change.")
    expect(openSpecPromptFor("ship")).toBe("Ship the attached OpenSpec change.")
    expect(openSpecPromptFor("hunter")).toBe("Audit the attached OpenSpec change.")
    expect(openSpecPromptFor("custom-thing")).toBe("Implement the attached OpenSpec change.")
  })

  test("listOpenSpecChanges returns id + title and skips archive/stray files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-openspec-list-"))
    dirs.push(dir)
    await mkdir(join(dir, openspecDirName, "changes", "add-login"), { recursive: true })
    await mkdir(join(dir, openspecDirName, "changes", "add-logout"), { recursive: true })
    await mkdir(join(dir, openspecDirName, "changes", "archive"), { recursive: true })
    await writeFile(join(dir, openspecDirName, "changes", "add-login", "proposal.md"), "# Add Login\n")
    await writeFile(join(dir, openspecDirName, "changes", "add-logout", "proposal.md"), "Logout the user\n")
    await writeFile(join(dir, openspecDirName, "changes", "README.md"), "# not a change\n")

    expect(await listOpenSpecChanges(dir)).toEqual([
      { id: "add-login", title: "Add Login" },
      { id: "add-logout", title: "Logout the user" },
    ])
  })

  test("listOpenSpecChanges returns [] when openspec/ is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-openspec-none-"))
    dirs.push(dir)
    expect(await listOpenSpecChanges(dir)).toEqual([])
  })
})
