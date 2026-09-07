import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { archiveChangeOnMain, closePreflight, probeOpenPullRequest, resolveCloseTarget, runClose, type CloseEvent, type CloseInput } from "../src/feature-close"
import { templateCommitMessage, type CommitMessageProposal } from "../src/commit-message"
import { addAllAndCommit } from "../src/git"
import { renderStepCommitMessage } from "../src/step-commit"

const dirs: string[] = []

/** A writer double that always fails, so close degrades to its deterministic
 * fallback exactly as it would during a model outage — fast and hermetically. */
const writerFails: CloseInput["writer"] = async () =>
  ({ message: templateCommitMessage({ targetDir: "", branch: "", commits: [] }), source: "template", error: "writer unavailable (test double)" }) satisfies CommitMessageProposal

/** Runs the close sequence with the failing writer double unless a test brings its own. */
const runTestClose = (fixture: Fixture, extra: Partial<CloseInput> = {}) => runClose({ ...closeInput(fixture), writer: writerFails, ...extra })

/** Collects the event stream of a close run. */
const collectEvents = async (fixture: Fixture, extra: Partial<CloseInput> = {}): Promise<CloseEvent[]> => {
  const events: CloseEvent[] = []
  await runTestClose(fixture, { ...extra, onEvent: (event) => events.push(event) })
  return events
}

/** git reports worktree paths through the kernel's canonical form
 * (`/private/var/...` on macOS); tests compare against the same form. */
async function realPath(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises")
  return realpath(path)
}

async function git(cwd: string, env: Record<string, string> | undefined, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return stdout.trim()
}

/**
 * A minimal OpenSpec CLI double: `list --json` counts task checkboxes like the
 * real tool; `archive <id> --yes` moves the change into the archive layout.
 * Everything else fails loudly so a surprise invocation surfaces in tests.
 */
async function writeOpenspecDouble(binDir: string): Promise<void> {
  const script = [
    "#!/usr/bin/env bun",
    "import { readdirSync, readFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "const [cmd, ...rest] = process.argv.slice(2)",
    "const root = process.cwd()",
    "if (cmd === 'list' && rest.includes('--json')) {",
    "  const dir = join(root, 'openspec', 'changes')",
    "  const changes = []",
    "  try {",
    "    for (const id of readdirSync(dir)) {",
    "      if (id === 'archive' || id.startsWith('.')) continue",
    "      const body = readFileSync(join(dir, id, 'tasks.md'), 'utf8')",
    "      const total = (body.match(/^\\s*[-*+]\\s+\\[[ xX]\\]/gm) ?? []).length",
    "      const done = (body.match(/^\\s*[-*+]\\s+\\[[xX]\\]/gm) ?? []).length",
    "      changes.push({ name: id, completedTasks: done, totalTasks: total })",
    "    }",
    "  } catch {}",
    "  console.log(JSON.stringify({ changes }))",
    "  process.exit(0)",
    "}",
    "if (cmd === 'archive') {",
    "  if (process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL === '1') {",
    "    console.error('openspec archive failed (injected)')",
    "    process.exit(4)",
    "  }",
  "  const id = rest.find((a) => !a.startsWith('-'))",
  "  const from = join(root, 'openspec', 'changes', id)",
  "  const to = join(root, 'openspec', 'changes', 'archive', id)",
  "  statSync(from)",
  "  mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true })",
  "  renameSync(from, to)",
  "  // A real archive merges the deltas into the canonical specs; the double",
  "  // writes the fixture's expected canonical requirement so close's",
  "  // positive archive verification (task 7.2) sees a provable result.",
  "  mkdirSync(join(root, 'openspec', 'specs', 'cli'), { recursive: true })",
  "  writeFileSync(join(root, 'openspec', 'specs', 'cli', 'spec.md'), '## Requirements\\n\\n### Requirement: Widget\\n')",
  "  process.exit(0)",
    "}",
    "console.error('unexpected openspec invocation: ' + cmd)",
    "process.exit(3)",
  ].join("\n")
  const path = join(binDir, "openspec")
  await writeFile(path, script)
  await chmod(path, 0o755)
  // An `opencode` double that dies instantly: any code path that reaches for
  // the real commit-writer server fails fast instead of hanging a test on a
  // live model (the tests below bring their own writer doubles instead).
  await writeFile(join(binDir, "opencode"), "#!/bin/sh\nexit 1\n")
  await chmod(join(binDir, "opencode"), 0o755)
}

type Fixture = {
  root: string
  mainDir: string
  worktreeDir: string
}

/**
 * A repo with a completed feature worktree: `main` is the base, the feature
 * branch `feat/add-widget` carries one operator commit (the change proposal)
 * and one convoy-authored commit, and all tasks are complete.
 */
async function makeFixture(input: { tasksDone: boolean } = { tasksDone: true }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "convoy-close-"))
  dirs.push(root)
  const mainDir = join(root, "main")
  const worktreeDir = join(root, "wt")
  await mkdir(mainDir, { recursive: true })

  const user = { GIT_AUTHOR_NAME: "Operator", GIT_AUTHOR_EMAIL: "operator@example.com", GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: "operator@example.com" }
  const convoy = { GIT_AUTHOR_NAME: "convoy", GIT_AUTHOR_EMAIL: "convoy@local", GIT_COMMITTER_NAME: "convoy", GIT_COMMITTER_EMAIL: "convoy@local" }

  await git(mainDir, undefined, "init", "-b", "main")
  await git(mainDir, user, "config", "user.email", "operator@example.com")
  await git(mainDir, user, "config", "user.name", "Operator")
  await writeFile(join(mainDir, "README.md"), "# repo\n")
  await git(mainDir, user, "add", ".")
  await git(mainDir, user, "commit", "-m", "chore: init")

  await git(mainDir, undefined, "worktree", "add", "-b", "feat/add-widget", worktreeDir, "main")

  const changeDir = join(worktreeDir, "openspec", "changes", "add-widget")
  await mkdir(join(changeDir, "specs", "cli"), { recursive: true })
  await writeFile(join(changeDir, "proposal.md"), "# Add widget\n")
  await writeFile(join(changeDir, "tasks.md"), input.tasksDone ? "- [x] one\n- [x] two\n" : "- [x] one\n- [ ] two\n- [ ] three\n")
  await writeFile(join(changeDir, "specs", "cli", "spec.md"), "## ADDED Requirements\n### Requirement: Widget\n")
  await git(worktreeDir, user, "add", ".")
  await git(worktreeDir, user, "commit", "-m", "feat(openspec): propose add-widget")
  await writeFile(join(worktreeDir, "src.ts"), "export const widget = 1\n")
  await git(worktreeDir, convoy, "add", ".")
  await git(worktreeDir, convoy, "commit", "-m", "convoy(implement): implement add-widget")

  // Register the feature as spin would have: the adoption gate (task 7.1)
  // refuses closes on unassociated work, so every close fixture starts from
  // an explicitly associated context.
  const { registerSpinFeature } = await import("../src/feature-lifecycle/commands")
  await registerSpinFeature({ cwd: mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: await realPath(worktreeDir), baseRef: "main", phase: "intent" })

  return { root, mainDir: await realPath(mainDir), worktreeDir: await realPath(worktreeDir) }
}

const closeInput = (fixture: Fixture) => ({
  targetDir: fixture.mainDir,
  worktreeDir: fixture.worktreeDir,
  branch: "feat/add-widget",
  changeID: "add-widget",
})

const originalPath = process.env.PATH
const originalConvoyHome = process.env.CONVOY_HOME

beforeAll(async () => {
  // The OpenSpec CLI double leads PATH so `runClose` never shells out to the
  // real tool (whose validation needs full OpenSpec-authoring rigor).
  const binDir = join(tmpdir(), `convoy-close-bin-${Math.random().toString(36).slice(2)}`)
  dirs.push(binDir)
  await mkdir(binDir, { recursive: true })
  await writeOpenspecDouble(binDir)
  process.env.PATH = `${binDir}:${process.env.PATH}`
  // listRuns reads ~/.convoy/runs; point it at scratch so live-run state
  // never leaks between the operator's machine and these tests.
  const home = await mkdtemp(join(tmpdir(), "convoy-close-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home
})

afterAll(async () => {
  // Restore rather than delete: the preload sets CONVOY_HOME for the whole
  // process, and dropping it would expose the operator's real home to
  // later test files.
  if (originalConvoyHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = originalConvoyHome
  // The fake bin dir must not leak into other test files sharing this process.
  if (originalPath !== undefined) process.env.PATH = originalPath
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("resolveCloseTarget", () => {
  test("explicit worktree and branch win; change id falls back to the branch's id", async () => {
    const fixture = await makeFixture()
    const target = await resolveCloseTarget(closeInput(fixture))
    expect(target).toEqual({ worktreeDir: fixture.worktreeDir, branch: "feat/add-widget", changeID: "add-widget" })
  })

  test("a bare --branch resolves its worktree from the repo's worktree list", async () => {
    const fixture = await makeFixture()
    const target = await resolveCloseTarget({ targetDir: fixture.mainDir, branch: "feat/add-widget" })
    expect(target.worktreeDir).toBe(fixture.worktreeDir)
    expect(target.changeID).toBe("add-widget")
  })
})

describe("closePreflight", () => {
  test("incomplete tasks stop the sequence with the missing count", async () => {
    const fixture = await makeFixture({ tasksDone: false })
    const target = await resolveCloseTarget(closeInput(fixture))
    const blockers = await closePreflight(closeInput(fixture), target)
    const tasks = blockers.find((blocker) => blocker.check === "tasks")
    expect(tasks?.message).toContain("2 of 3 tasks are incomplete")
  })

  test("a clean, complete feature passes preflight", async () => {
    const fixture = await makeFixture()
    const target = await resolveCloseTarget(closeInput(fixture))
    expect(await closePreflight(closeInput(fixture), target)).toEqual([])
  })

  test("an unverifiable worktree status fails the preflight closed, not open (SC-6)", async () => {
    const fixture = await makeFixture()
    const target = await resolveCloseTarget(closeInput(fixture))
    const gitModule = await import("../src/git")
    const spy = spyOn(gitModule, "statusPorcelain")
    spy.mockRejectedValue(new Error("boom"))
    try {
      const blockers = await closePreflight(closeInput(fixture), target)
      const clean = blockers.find((blocker) => blocker.check === "clean-tree")
      expect(clean?.message).toContain("couldn't verify")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("runClose", () => {
  // The deterministic fallback for this fixture: branch prefix `feat`, the
  // sole touched capability `cli` as scope, the proposal title behind the
  // type-appropriate verb, and the change id first in the body.
  const fallbackSubject = "feat(cli): improve add widget"

  test("the full sequence: archive via the CLI, exactly one landing commit on the base, feature history intact", async () => {
    const fixture = await makeFixture()
    const featureCommitsBefore = await git(fixture.worktreeDir, undefined, "rev-list", "--count", "feat/add-widget")
    const result = await runTestClose(fixture)

    expect(result.disposition).toBe("landed")
    expect(result.landing).toBeDefined()
    // The base gains exactly one regular commit: the landing. The proposal
    // commit is included as content, not as base history.
    expect(await git(fixture.mainDir, undefined, "rev-list", "--count", "main")).toBe("2")
    // The feature branch's history is only ever added to (the archive
    // commit) — never rewritten by the landing.
    expect(await git(fixture.worktreeDir, undefined, "rev-list", "--count", "feat/add-widget")).toBe(String(Number(featureCommitsBefore) + 1))
    // The change dir moved into the archive layout inside the worktree.
    await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).rejects.toThrow()
    expect((await stat(join(fixture.worktreeDir, "openspec", "changes", "archive", "add-widget"))).isDirectory()).toBe(true)
    // The base's only new commit is the landing; the operator's proposal
    // commit is not duplicated into base history.
    const subjects = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(subjects).toContain(fallbackSubject)
    expect(subjects).not.toContain("feat(openspec): propose add-widget")
    const body = await git(fixture.mainDir, undefined, "log", "--format=%B", "-n", "1", "main")
    expect(body).toContain("change add-widget")
    // The landing commit carries the proposal's content.
    expect((await stat(join(fixture.mainDir, "src.ts"))).isFile()).toBe(true)
    // The worktree still exists until the operator accepts its removal.
    expect((await stat(fixture.worktreeDir)).isDirectory()).toBe(true)
  })

  test("run-linked multiline step commits squash exactly like legacy one-line commits", async () => {
    const fixture = await makeFixture()
    // An additional intermediate commit shaped like the runner's: semantic
    // subject, detail bullets, and a `Convoy-Run` trailer authored by
    // convoy@local. The authorship-anchored walk must fold it in unchanged.
    await writeFile(join(fixture.worktreeDir, "extra.ts"), "export const extra = 2\n")
    await addAllAndCommit(
      renderStepCommitMessage({
        runID: "20260101-000000-test",
        step: "implementer",
        description: { subject: "preserve report sessions across human gates", details: ["Keep handles alive during manual iteration"] },
      }),
      fixture.worktreeDir,
    )

    const result = await runTestClose(fixture)
    expect(result.disposition).toBe("landed")
    // The base still gains exactly one commit, whatever the intermediate
    // commit shapes were.
    expect(await git(fixture.mainDir, undefined, "rev-list", "--count", "main")).toBe("2")

    const log = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(log).toContain(fallbackSubject)
    expect(log).not.toContain("feat(openspec): propose add-widget")
    expect(log).not.toContain("convoy(implementer): preserve report sessions across human gates")
    // The intermediate trailer is not copied into the user-authored commit.
    const bodies = await git(fixture.mainDir, undefined, "log", "--format=%B", "main")
    expect(bodies).not.toContain("Convoy-Run:")
  })

  test("a resume after a completed close resolves the receipt instead of landing again", async () => {
    const fixture = await makeFixture()
    const first = await runTestClose(fixture)
    expect(first.disposition).toBe("landed")
    const count = await git(fixture.mainDir, undefined, "rev-list", "--count", "main")
    // A resume finds the verified receipt: nothing is redone, no duplicate
    // landing is created (design D7, task 5.7).
    const result = await runTestClose(fixture, { resume: true })
    expect(result.disposition).toBe("already-landed")
    expect(result.landing?.sha).toBe(first.landing?.sha)
    expect(await git(fixture.mainDir, undefined, "rev-list", "--count", "main")).toBe(count)
  })

  test("a resume resolves the receipt before requiring a worktree", async () => {
    const fixture = await makeFixture()
    const first = await runTestClose(fixture)
    // Cleanup got as far as removing the worktree; the branch remains.
    await git(fixture.mainDir, undefined, "worktree", "remove", "--force", fixture.worktreeDir)
    const result = await runClose({
      targetDir: fixture.mainDir,
      branch: "feat/add-widget",
      changeID: "add-widget",
      resume: true,
      writer: writerFails,
    })
    expect(result.disposition).toBe("already-landed")
    expect(result.landing?.sha).toBe(first.landing?.sha)
  })

  test("a clean sync folds the sync merge and convoy commits into one conventional commit (SC-2)", async () => {
    const fixture = await makeFixture()
    // Advance main so the sync step creates an operator-identity merge commit
    // that the squash must fold — with the raw convoy/archive commits — instead
    // of letting them reach the base branch unsquashed.
    await writeFile(join(fixture.mainDir, "main-advance.txt"), "advance\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "chore: advance main in parallel")

    const result = await runTestClose(fixture)
    expect(result.disposition).toBe("landed")
    // The base gains exactly ONE regular commit on top of its advance — the
    // landing commit with a single parent, never a merge commit (task 5.8).
    expect(await git(fixture.mainDir, undefined, "rev-list", "--count", "main")).toBe("3")
    const parents = await git(fixture.mainDir, undefined, "log", "--format=%P", "-n", "1", "main")
    expect(parents.split(/\s+/)).toHaveLength(1)

    const log = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    // The feature lands as the one conventional commit — the base's own
    // advance is present, and the proposal commit is not duplicated there.
    expect(log).not.toContain("feat(openspec): propose add-widget")
    expect(log).toContain(fallbackSubject)
    expect(log).toContain("chore: advance main in parallel")
    // ...and none of the raw convoy step commits or the archive commit leak
    // through the squash.
    expect(log).not.toContain("convoy(implement): implement add-widget")
    expect(log).not.toContain("chore(openspec): archive add-widget")
  })

  test("a conflicting sync stops with the conflict listed and nothing merged", async () => {
    const fixture = await makeFixture()
    // Advance main in a way the feature branch also touches.
    await writeFile(join(fixture.mainDir, "shared.txt"), "from main\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "chore: main moves shared.txt")
    await writeFile(join(fixture.worktreeDir, "shared.txt"), "from feature\n")
    await git(fixture.worktreeDir, undefined, "add", ".")
    await git(fixture.worktreeDir, undefined, "commit", "-m", "feat: feature moves shared.txt")

    await expect(runTestClose(fixture)).rejects.toThrow(/sync.*conflicted[\s\S]*--resume/)
    // Nothing was archived or merged.
    expect((await stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).isDirectory()).toBe(true)
    const mainLog = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(mainLog).not.toContain("add-widget")
  })

  test("preflight failure changes nothing on any branch", async () => {
    const fixture = await makeFixture({ tasksDone: false })
    const before = await git(fixture.mainDir, undefined, "rev-parse", "HEAD")
    await expect(runTestClose(fixture)).rejects.toThrow(/preflight failed/)
    expect(await git(fixture.mainDir, undefined, "rev-parse", "HEAD")).toBe(before)
  })

  test("an archive failure hard-stops before any squash or merge", async () => {
    const fixture = await makeFixture()
    process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL = "1"
    try {
      await expect(runTestClose(fixture)).rejects.toThrow(/archive.*failed[\s\S]*before any squash-merge/)
      // The change was not archived (the CLI failed before moving it)...
      expect((await stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).isDirectory()).toBe(true)
      await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "archive", "add-widget"))).rejects.toThrow()
      // ...and nothing landed on the base branch (no squash, no merge).
      const mainLog = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
      expect(mainLog).not.toContain("add-widget")
    } finally {
      delete process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL
    }
  })

  // -- task 2.2: the one-way event stream -----------------------------------

  test("a clean close narrates preflight, skipped sync, and each step as it happens", async () => {
    const fixture = await makeFixture()
    const events = await collectEvents(fixture)

    // The checklist's preflight line names the registered feature it acts on (task 7.8).
    expect(events[0]).toEqual({ type: "preflight", summary: "feature add-widget · clean tree · 2/2 tasks · no live runs" })
    // The base hasn't moved, so the sync is a detected skip, not a merge.
    expect(events[1]).toMatchObject({ type: "step-skipped", step: "sync" })
    const steps = events.map((event) =>
      event.type === "step-started" || event.type === "step-completed" || event.type === "step-skipped" || event.type === "step-failed"
        ? `${event.type}:${event.step}`
        : event.type,
    )
    expect(steps).toEqual([
      "preflight",
      "step-skipped:sync",
      "step-started:archive",
      "step-completed:archive",
      "step-started:squash-merge",
      "squash-phase",
      "squash-phase",
      "step-completed:squash-merge",
      "result",
    ])
    // One landing result names the base and the commit — no merge shape exists
    // anywhere in the narration (task 5.8, design D8).
    expect(events.filter((event) => event.type === "step-skipped" || event.type === "step-started" || event.type === "step-completed" || event.type === "step-failed").map((event) => event.step)).toEqual(expect.arrayContaining(["sync", "archive", "squash-merge"]))
    const result = events.find((event) => event.type === "result")
    expect(result && result.type === "result" ? result.result.disposition : undefined).toBe("landed")
  })

  test("a mid-sequence archive stop emits the failed step and its remediation", async () => {
    const fixture = await makeFixture()
    process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL = "1"
    try {
      const events: CloseEvent[] = []
      await expect(runTestClose(fixture, { onEvent: (event) => events.push(event) })).rejects.toThrow(/before any squash-merge/)
      expect(events[events.length - 1]).toMatchObject({ type: "step-failed", step: "archive" })
      expect(events.some((event) => event.type === "result")).toBe(false)
    } finally {
      delete process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL
    }
  })

  test("a resume after a completed close narrates the receipt as detected skips", async () => {
    const fixture = await makeFixture()
    await runTestClose(fixture)
    const events = await collectEvents(fixture, { resume: true })
    const skips = events.filter((event) => event.type === "step-skipped")
    expect(skips).toHaveLength(3)
    for (const skip of skips) {
      if (skip.type !== "step-skipped") continue
      expect(["sync", "archive", "squash-merge"]).toContain(skip.step)
      expect(skip.reason).toContain("receipt")
    }
    const result = events.find((event) => event.type === "result")
    expect(result && result.type === "result" ? result.result.disposition : undefined).toBe("already-landed")
  })

  // -- task 2.1: the message snapshot survives the archive's move ------------

  test("the writer receives the pre-archive snapshot even though archive moved the live change", async () => {
    const fixture = await makeFixture()
    const seen: Parameters<NonNullable<CloseInput["writer"]>>[0][] = []
    await runTestClose(fixture, {
      writer: async (input) => {
        seen.push(input)
        return writerFails(input)
      },
    })
    expect(seen).toHaveLength(1)
    // The change dir is long gone by composition time...
    await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget", "proposal.md"))).rejects.toThrow()
    // ...yet the writer was seeded with the captured proposal, capabilities, and commits.
    expect(seen[0]!.proposalExcerpt).toContain("Add widget")
    expect(seen[0]!.scopeCandidates).toEqual(["cli"])
    expect(seen[0]!.commits).toContain("convoy(implement): implement add-widget")
  })

  // -- task 2.3: the resolver gate -------------------------------------------

  test("a model proposal is normalized (scope enforced, change id in body) and lands after the resolver accepts", async () => {
    const fixture = await makeFixture()
    const seenProposals: Array<{ message: string; source: string; error?: string }> = []
    const result = await runTestClose(fixture, {
      writer: async () => ({
        message: { type: "feat", scope: "everything", subject: "improve the close flow", body: ["one change"] },
        source: "model",
      }),
      resolveMessage: async (proposal) => {
        seenProposals.push(proposal)
        return proposal.message
      },
    })
    expect(result.landing).toBeDefined()
    // The writer's broad scope was corrected to the sole touched capability,
    // and the change id was injected into the body.
    expect(seenProposals).toHaveLength(1)
    expect(seenProposals[0]!.source).toBe("model")
    expect(seenProposals[0]!.message).toBe("feat(cli): improve the close flow\n\n- change add-widget\n- one change")
    const subject = await git(fixture.mainDir, undefined, "log", "--format=%s", "-n", "1", "main")
    expect(subject).toBe("feat(cli): improve the close flow")
  })

  test("the fallback proposal names its writer failure and still closes", async () => {
    const fixture = await makeFixture()
    const seenProposals: Array<{ source: string; error?: string }> = []
    const result = await runTestClose(fixture, {
      resolveMessage: async (proposal) => {
        seenProposals.push(proposal)
        return proposal.message
      },
    })
    expect(result.landing).toBeDefined()
    expect(seenProposals[0]!.source).toBe("fallback")
    expect(seenProposals[0]!.error).toContain("test double")
  })

  test("an edited message lands verbatim", async () => {
    const fixture = await makeFixture()
    await runTestClose(fixture, {
      resolveMessage: async () => "feat(cli): hand polished subject\n\n- change add-widget",
    })
    const body = await git(fixture.mainDir, undefined, "log", "--format=%B", "-n", "1", "main")
    expect(body).toContain("hand polished subject")
    expect(body).toContain("change add-widget")
  })

  test("close never consults $EDITOR: only the resolver's accepted value reaches applySquash (design D4)", async () => {
    const fixture = await makeFixture()
    // Point every external-editor resolution at a writer that would poison
    // the commit; close must never run it.
    const binDir = join(tmpdir(), `convoy-close-editor-${Math.random().toString(36).slice(2)}`)
    dirs.push(binDir)
    await mkdir(binDir, { recursive: true })
    const editor = join(binDir, "poison-editor")
    await writeFile(editor, "#!/bin/sh\nprintf 'EDITOR WROTE THIS' > \"$1\"\n")
    await chmod(editor, 0o755)
    const saved = process.env.GIT_EDITOR
    process.env.GIT_EDITOR = editor
    try {
      await runTestClose(fixture, {
        resolveMessage: async (proposal) => proposal.message.replace("improve", "hand edited"),
      })
      const subject = await git(fixture.mainDir, undefined, "log", "--format=%s", "-n", "1", "main")
      expect(subject).not.toContain("EDITOR WROTE THIS")
      expect(subject).toContain("hand edited")
    } finally {
      if (saved === undefined) delete process.env.GIT_EDITOR
      else process.env.GIT_EDITOR = saved
    }
  })

  test("an explicit --message wins verbatim and bypasses writer and resolver entirely", async () => {
    const fixture = await makeFixture()
    await runTestClose(fixture, {
      message: "feat(cli): exact override",
      resolveMessage: async () => {
        throw new Error("the resolver must never be reached with an explicit --message")
      },
      writer: async () => {
        throw new Error("the writer must never run under an explicit --message")
      },
    })
    const subject = await git(fixture.mainDir, undefined, "log", "--format=%s", "-n", "1", "main")
    expect(subject).toBe("feat(cli): exact override")
  })

  test("an empty --message still bypasses composition (SC-8)", async () => {
    const fixture = await makeFixture()
    // Presence, not truthiness: `--message ""` must not fall through to the
    // writer. (git rejects an empty message, which is the failure here — but
    // neither the writer nor the resolver may even be reached.)
    let writerRan = false
    let resolverRan = false
    await expect(
      runTestClose(fixture, {
        message: "",
        writer: async () => {
          writerRan = true
          return { message: templateCommitMessage({ targetDir: "", branch: "", commits: [] }), source: "template", error: "n/a" }
        },
        resolveMessage: async () => {
          resolverRan = true
          return ""
        },
      }),
    ).rejects.toThrow()
    expect(writerRan).toBe(false)
    expect(resolverRan).toBe(false)
  })

  test("control bytes from a model message are stripped before the commit lands (SC-4)", async () => {
    const fixture = await makeFixture()
    await runTestClose(fixture, {
      writer: async () => ({
        message: { type: "feat", scope: "hack", subject: "improve \u001b[31mred\u001b[0m", body: ["a line\u001b[K"] },
        source: "model",
      }),
    })
    const subject = await git(fixture.mainDir, undefined, "log", "--format=%s", "-n", "1", "main")
    // The sole capability still wins the scope; the escape sequences are gone.
    expect(subject).toBe("feat(cli): improve red")
    const body = await git(fixture.mainDir, undefined, "log", "--format=%B", "-n", "1", "main")
    expect(body).not.toContain("\u001b")
  })

  test("a declined candidate signature emits a step-failed squash-merge event and lands nothing (SC-5)", async () => {
    const fixture = await makeFixture()
    const gitModule = await import("../src/git")
    const real = gitModule.commitAsUser
    let call = 0
    // Call 1 is the archive commit (must succeed); call 2 is the candidate
    // commit in the integration worktree (declined signature).
    const spy = spyOn(gitModule, "commitAsUser").mockImplementation(async (...args) => {
      call += 1
      if (call === 2) throw new Error("signature declined")
      return real(args[0] as string, args[1] as string)
    })
    try {
      const events: CloseEvent[] = []
      await expect(runTestClose(fixture, { onEvent: (event) => events.push(event) })).rejects.toThrow(/signature declined/)
      expect(events[events.length - 1]).toMatchObject({ type: "step-failed", step: "squash-merge" })
      expect(events.some((event) => event.type === "result")).toBe(false)
      // The base is unadvanced: the landing never happened.
      expect(await git(fixture.mainDir, undefined, "rev-list", "--count", "main")).toBe("1")
    } finally {
      spy.mockRestore()
    }
  })

  test("squash phases arrive in order for a model proposal accepted by the resolver", async () => {
    const fixture = await makeFixture()
    const events: CloseEvent[] = []
    await runTestClose(fixture, {
      writer: async () => ({
        message: { type: "feat", scope: "cli", subject: "improve the close flow", body: [] },
        source: "model",
      }),
      resolveMessage: async (proposal) => proposal.message,
      onEvent: (event) => events.push(event),
    })
    // The typed sub-phases bracket the real awaits: composition, then the
    // review gate, then the commit mutation (design D1).
    expect(events.map((event) => (event.type === "squash-phase" ? `squash:${event.phase}` : event.type))).toEqual(
      expect.arrayContaining(["step-started", "squash:composing-message", "squash:awaiting-message-review", "squash:creating-commit", "step-completed"]),
    )
    const squashStart = events.findIndex((event) => event.type === "step-started" && "step" in event && event.step === "squash-merge")
    const squashEnd = events.findIndex((event) => event.type === "step-completed" && "step" in event && event.step === "squash-merge")
    const squashSlice = events.slice(squashStart + 1, squashEnd + 1)
    expect(squashSlice.map((event) => (event.type === "squash-phase" ? event.phase : event.type))).toEqual([
      "composing-message",
      "awaiting-message-review",
      "creating-commit",
      "step-completed",
    ])
  })

  test("squash phases arrive in order for the deterministic fallback too", async () => {
    const fixture = await makeFixture()
    const events: CloseEvent[] = []
    await runTestClose(fixture, { resolveMessage: async (proposal) => proposal.message, onEvent: (event) => events.push(event) })
    const phases = events.filter((event) => event.type === "squash-phase")
    expect(phases.map((event) => (event.type === "squash-phase" ? event.phase : null))).toEqual([
      "composing-message",
      "awaiting-message-review",
      "creating-commit",
    ])
  })

  test("a declined message emits no creating-commit phase and marks the squash failed", async () => {
    const fixture = await makeFixture()
    const events: CloseEvent[] = []
    await expect(runTestClose(fixture, { resolveMessage: async () => undefined, onEvent: (event) => events.push(event) })).rejects.toThrow(
      /wasn't confirmed/,
    )
    expect(events.some((event) => event.type === "squash-phase" && event.phase === "creating-commit")).toBe(false)
    expect(events[events.length - 1]).toMatchObject({ type: "step-failed", step: "squash-merge" })
  })

  test("an explicit --message skips composition and review but still names commit creation", async () => {
    const fixture = await makeFixture()
    const events: CloseEvent[] = []
    await runTestClose(fixture, {
      message: "feat(cli): exact override",
      onEvent: (event) => events.push(event),
    })
    const phases = events.filter((event) => event.type === "squash-phase")
    expect(phases.map((event) => (event.type === "squash-phase" ? event.phase : null))).toEqual(["creating-commit"])
  })

  test("a declined message stops before the squash and nothing lands", async () => {
    const fixture = await makeFixture()
    const branchBefore = await git(fixture.worktreeDir, undefined, "rev-parse", "HEAD")
    await expect(runTestClose(fixture, { resolveMessage: async () => undefined })).rejects.toThrow(/wasn't confirmed[\s\S]*--resume/)
    // The archive happened, but the squash didn't: the branch tip moved to the
    // archive commit, not to a squashed rewrite, and nothing reached the base.
    const branchAfter = await git(fixture.worktreeDir, undefined, "rev-parse", "HEAD")
    expect(branchAfter).not.toBe(branchBefore)
    const mainLog = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(mainLog).not.toContain("improve add widget")
  })

  test("a resumed close after a declined message on a synced branch leaks no raw convoy commit onto the base (SC-1)", async () => {
    const fixture = await makeFixture()
    // Advance main so the first attempt's sync step creates an
    // operator-identity merge commit the resumed squash must fold.
    await writeFile(join(fixture.mainDir, "main-advance.txt"), "advance\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "chore: advance main in parallel")

    // First attempt: sync runs, archive runs, the message is declined at the
    // squash gate — the sequence stops with the sync merge and archive commit
    // already on the feature branch.
    await expect(runTestClose(fixture, { resolveMessage: async () => undefined })).rejects.toThrow(/wasn't confirmed[\s\S]*--resume/)

    // Resume accepts. The resumed squash must re-discover the sync merge and
    // fold it (plus the archive and convoy commits) instead of leaking them.
    const result = await runTestClose(fixture, {
      resume: true,
      resolveMessage: async (proposal) => proposal.message,
    })
    expect(result.disposition).toBe("landed")
    // One regular commit on the (advanced) base — no merge commit.
    expect(await git(fixture.mainDir, undefined, "rev-list", "--count", "main")).toBe("3")
    const parents = await git(fixture.mainDir, undefined, "log", "--format=%P", "-n", "1", "main")
    expect(parents.split(/\s+/)).toHaveLength(1)

    const log = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(log).not.toContain("convoy(implement): implement add-widget")
    expect(log).not.toContain("chore(openspec): archive add-widget")
    // The operator's proposal commit is included as content, not duplicated
    // into base history, and the landing is a single-parent commit.
    expect(log).not.toContain("feat(openspec): propose add-widget")
  })

  // -- task 2.4: merge shapes --------------------------------------------------

  test("a moved base still receives exactly one landing commit, not a merge", async () => {
    const fixture = await makeFixture()
    await writeFile(join(fixture.mainDir, "main-advance.txt"), "advance\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "chore: advance main in parallel")
    const result = await runTestClose(fixture)
    expect(result.disposition).toBe("landed")
    const parents = await git(fixture.mainDir, undefined, "log", "--format=%P", "-n", "1", "main")
    expect(parents.split(/\s+/)).toHaveLength(1)
    // The landing's parent is exactly the captured base tip.
    const baseTip = await git(fixture.mainDir, undefined, "rev-parse", "main^")
    expect(result.landing).toBeDefined()
  })
})

describe("PR-aware close", () => {
  /** A writer double with a predictable normalized subject for reference assertions. */
  const widgetWriter: CloseInput["writer"] = async () => ({
    message: { type: "feat", subject: "improve the close flow", body: ["one change"] },
    source: "model",
  })

  test("a detected open PR rides the composed subject, the result, and the disclosure", async () => {
    const fixture = await makeFixture()
    const seenProposals: Array<{ message: string }> = []
    const events: CloseEvent[] = []
    const result = await runTestClose(fixture, {
      writer: widgetWriter,
      resolveMessage: async (proposal) => {
        seenProposals.push(proposal)
        return proposal.message
      },
      probePullRequest: async (branch) => {
        expect(branch).toBe("feat/add-widget")
        return { number: 7, title: "Add widget", url: "https://github.com/acme/repo/pull/7" }
      },
      onEvent: (event) => events.push(event),
    })
    expect(result.landing).toBeDefined()
    // The composed proposal the operator reviews carries the reference...
    expect(seenProposals).toHaveLength(1)
    expect(seenProposals[0]!.message).toBe("feat(cli): improve the close flow (#7)\n\n- change add-widget\n- one change")
    // ...and the landing commit uses that exact subject.
    const subject = await git(fixture.mainDir, undefined, "log", "--format=%s", "-n", "1", "main")
    expect(subject).toBe("feat(cli): improve the close flow (#7)")
    // The result event carries the PR for the follow-up surface...
    const resultEvent = events.find((event) => event.type === "result")
    expect(resultEvent).toBeDefined()
    expect(resultEvent && resultEvent.type === "result" ? resultEvent.result.pullRequest : undefined).toEqual({
      number: 7,
      title: "Add widget",
      url: "https://github.com/acme/repo/pull/7",
    })
    // ...and the squash-merge row discloses it without asserting merge.
    const disclosure = events.find((event) => event.type === "step-completed" && event.step === "squash-merge")
    expect(disclosure).toBeDefined()
    expect(disclosure && disclosure.type === "step-completed" ? disclosure.detail : "").toContain("pull request #7 is open for feat/add-widget (https://github.com/acme/repo/pull/7)")
    expect(disclosure && disclosure.type === "step-completed" ? disclosure.detail : "").not.toContain("merged")
  })

  test("no detected PR degrades silently: no reference, no result field", async () => {
    const fixture = await makeFixture()
    const events: CloseEvent[] = []
    const result = await runTestClose(fixture, {
      writer: widgetWriter,
      resolveMessage: async (proposal) => proposal.message,
      probePullRequest: async () => undefined,
      onEvent: (event) => events.push(event),
    })
    expect(result.landing).toBeDefined()
    const subject = await git(fixture.mainDir, undefined, "log", "--format=%s", "-n", "1", "main")
    expect(subject).toBe("feat(cli): improve the close flow")
    const resultEvent = events.find((event) => event.type === "result")
    expect(resultEvent && resultEvent.type === "result" ? resultEvent.result.pullRequest : undefined).toBeUndefined()
    const disclosure = events.find((event) => event.type === "step-completed" && event.step === "squash-merge")
    expect(disclosure && disclosure.type === "step-completed" ? disclosure.detail : "").toBe(`landed ${result.landing!.sha.slice(0, 8)} on main`)
  })

  test("the deterministic fallback proposal carries the reference too", async () => {
    const fixture = await makeFixture()
    const seenProposals: Array<{ message: string; source: string }> = []
    await runTestClose(fixture, {
      resolveMessage: async (proposal) => {
        seenProposals.push(proposal)
        return proposal.message
      },
      probePullRequest: async () => ({ number: 12, url: "https://github.com/acme/repo/pull/12" }),
    })
    expect(seenProposals).toHaveLength(1)
    expect(seenProposals[0]!.source).toBe("fallback")
    expect(seenProposals[0]!.message.split("\n")[0]).toMatch(/\(#12\)$/)
  })

  test("an operator edit removing the reference is respected, never re-appended", async () => {
    const fixture = await makeFixture()
    await runTestClose(fixture, {
      writer: widgetWriter,
      resolveMessage: async (proposal) => proposal.message.replace(" (#7)", ""),
      probePullRequest: async () => ({ number: 7, url: "https://github.com/acme/repo/pull/7" }),
    })
    const subject = await git(fixture.mainDir, undefined, "log", "--format=%s", "-n", "1", "main")
    expect(subject).toBe("feat(cli): improve the close flow")
  })

  test("an explicit --message stays verbatim even with a detected PR", async () => {
    const fixture = await makeFixture()
    await runTestClose(fixture, {
      message: "feat(cli): exact override",
      resolveMessage: async () => {
        throw new Error("the resolver must never be reached with an explicit --message")
      },
      probePullRequest: async () => ({ number: 7, url: "https://github.com/acme/repo/pull/7" }),
    })
    const subject = await git(fixture.mainDir, undefined, "log", "--format=%s", "-n", "1", "main")
    expect(subject).toBe("feat(cli): exact override")
  })

  test("an already-landed resume never probes for a pull request", async () => {
    const fixture = await makeFixture()
    await runTestClose(fixture, { writer: widgetWriter, resolveMessage: async (proposal) => proposal.message })
    let probed = 0
    const result = await runTestClose(fixture, {
      probePullRequest: async () => {
        probed += 1
        return undefined
      },
    })
    expect(result.disposition).toBe("already-landed")
    expect(probed).toBe(0)
  })

  test("probeOpenPullRequest parses gh's JSON and tolerates every failure", async () => {
    const writeGhDouble = async (body: string, exitCode: number) => {
      const binDir = join(tmpdir(), `convoy-close-gh-${Math.random().toString(36).slice(2)}`)
      dirs.push(binDir)
      await mkdir(binDir, { recursive: true })
      const path = join(binDir, "gh")
      await writeFile(path, `#!/bin/sh\nprintf '%s' '${body}'\nexit ${exitCode}\n`)
      await chmod(path, 0o755)
      return binDir
    }
    const savedPath = process.env.PATH
    try {
      process.env.PATH = `${await writeGhDouble('[{"number":7,"title":"Add widget","url":"https://github.com/acme/repo/pull/7"}]', 0)}:${savedPath}`
      const fixture = await makeFixture()
      expect(await probeOpenPullRequest("feat/add-widget", fixture.mainDir)).toEqual({
        number: 7,
        title: "Add widget",
        url: "https://github.com/acme/repo/pull/7",
      })

      // A failing gh (missing auth, network, whatever) is "none detected".
      process.env.PATH = `${await writeGhDouble("error: not authenticated", 1)}:${savedPath}`
      expect(await probeOpenPullRequest("feat/add-widget", fixture.mainDir)).toBeUndefined()

      // Unparseable output degrades the same way.
      process.env.PATH = `${await writeGhDouble("not json at all", 0)}:${savedPath}`
      expect(await probeOpenPullRequest("feat/add-widget", fixture.mainDir)).toBeUndefined()
    } finally {
      process.env.PATH = savedPath
    }
  })
})

describe("archiveChangeOnMain", () => {
  test("archives in the main checkout and commits on the base branch", async () => {
    const fixture = await makeFixture()
    // Simulate the probably-merged situation: the change sits on the base
    // checkout, unarchived, with nothing left to merge.
    const changeDir = join(fixture.mainDir, "openspec", "changes", "squashed-elsewhere")
    await mkdir(join(changeDir, "specs"), { recursive: true })
    await writeFile(join(changeDir, "proposal.md"), "# Squashed elsewhere\n")
    await writeFile(join(changeDir, "tasks.md"), "- [x] done\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "feat(openspec): propose squashed-elsewhere")

    const result = await archiveChangeOnMain({ targetDir: fixture.mainDir, changeID: "squashed-elsewhere" })
    expect(result.committed).toBe(true)
    await expect(stat(changeDir)).rejects.toThrow()
    expect((await stat(join(fixture.mainDir, "openspec", "changes", "archive", "squashed-elsewhere"))).isDirectory()).toBe(true)
    const log = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(log).toContain("chore(openspec): archive squashed-elsewhere")
  })

  test("an absent change refuses", async () => {
    const fixture = await makeFixture()
    await expect(archiveChangeOnMain({ targetDir: fixture.mainDir, changeID: "ghost" })).rejects.toThrow(/ghost/)
  })

  test("archive-on-main lands on the main checkout even when invoked from a worktree (SC-4)", async () => {
    const fixture = await makeFixture()
    // An unarchived change sits on the base checkout.
    const changeDir = join(fixture.mainDir, "openspec", "changes", "squashed-elsewhere")
    await mkdir(join(changeDir, "specs"), { recursive: true })
    await writeFile(join(changeDir, "proposal.md"), "# Squashed elsewhere\n")
    await writeFile(join(changeDir, "tasks.md"), "- [x] done\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "feat(openspec): propose squashed-elsewhere")

    // Invoke as the board would when opened *inside* a feature worktree
    // (targetDir is the worktree, not main).
    const result = await archiveChangeOnMain({ targetDir: fixture.worktreeDir, changeID: "squashed-elsewhere" })
    expect(result.committed).toBe(true)
    // Archived on the main checkout, committed on the base branch...
    await expect(stat(changeDir)).rejects.toThrow()
    expect((await stat(join(fixture.mainDir, "openspec", "changes", "archive", "squashed-elsewhere"))).isDirectory()).toBe(true)
    const log = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(log).toContain("chore(openspec): archive squashed-elsewhere")
    // ...and the feature worktree gained nothing.
    await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "archive", "squashed-elsewhere"))).rejects.toThrow()
  })
})
