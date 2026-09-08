import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createPublishSeam, type PublishRunner, type RunResult } from "../src/publish"
import type { FeatureRecord } from "../src/feature-lifecycle/records"

/**
 * The deliberate `Create pull request` action (capability run-finalization,
 * design D5), exercised through an injected runner so no real Git or `gh`
 * subprocess ever runs. The contract under test: disclose before publishing,
 * push normally (never forced), locate before creating, and keep push and PR
 * outcomes separately recoverable.
 */

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", exitCode: 0 })
const fail = (stderr: string): RunResult => ({ stdout: "", stderr, exitCode: 1 })

/** The run-start HEAD the fake world's boundary records; the fake runner answers its ancestry query. */
const TEST_START_HEAD = "a".repeat(40)

/** The fake world's boundary: the /repo checkout on feat/widget, started at TEST_START_HEAD. */
function fakeBoundary(): Record<string, unknown> {
  return { worktreeDir: "/repo", branch: "feat/widget", startHead: TEST_START_HEAD, commonDir: "/repo/.git", includeDirty: false, recordedAt: 1, schemaVersion: 1 }
}

/** A happy-path fake: clean feature branch on origin, gh installed and authenticated. */
function fakeRunner(overrides: Record<string, RunResult> = {}, calls: Array<{ command: string; args: string[] }> = []): PublishRunner {
  const defaults: Record<string, RunResult> = {
    "git symbolic-ref --quiet --short HEAD": ok("feat/widget\n"),
    "git rev-parse --path-format=absolute --git-common-dir": ok("/repo/.git\n"),
    "git rev-parse --show-toplevel": ok("/repo\n"),
    [`git merge-base --is-ancestor ${TEST_START_HEAD} HEAD`]: ok(""),
    "git status --porcelain": ok(""),
    "git remote": ok("origin\n"),
    "git rev-parse --quiet --abbrev-ref --symbolic-full-name feat/widget@{upstream}": fail("no upstream"),
    "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": ok("origin/main\n"),
    "gh --version": ok("gh version 2.0.0\n"),
    "gh auth status": ok(""),
    "git push origin feat/widget:feat/widget": ok(""),
    "gh pr list": ok("[]"),
    "gh pr create": ok("https://github.com/acme/repo/pull/12\n"),
    ...overrides,
  }
  return async (command, args) => {
    calls.push({ command, args })
    const key = `${command} ${args.join(" ")}`
    if (defaults[key] !== undefined) return defaults[key]!
    // The composed --title/--body vary, so the gh subcommands match by prefix.
    if (command === "gh" && args[0] === "pr" && args[1] === "create") return defaults["gh pr create"]!
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return defaults["gh pr list"]!
    return fail(`unexpected call: ${key}`)
  }
}

function seamWith(overrides: Record<string, RunResult> = {}, runDir?: string) {
  const calls: Array<{ command: string; args: string[] }> = []
  const seam = createPublishSeam({ cwd: "/repo", ...(runDir ? { runDir } : {}), run: fakeRunner(overrides, calls) })
  return { seam, calls }
}

/** A run workspace whose metadata optionally carries a (retired) feature link and a run-start boundary. */
async function withRunDir(feature: unknown, boundary?: Record<string, unknown>): Promise<string> {
  const { mkdtemp: mkd, writeFile: wf } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkd(join(tmpdir(), "convoy-publish-rundir-"))
  runDirs.push(dir)
  await wf(
    join(dir, "metadata.json"),
    JSON.stringify({
      schemaVersion: 5,
      runID: "20260101-000000-x",
      targetDir: ".",
      createdAt: 1,
      updatedAt: 1,
      control: { state: "completed" },
      phases: {},
      ...(feature !== undefined ? { feature } : {}),
      ...(boundary ? { boundary } : {}),
    }),
  )
  return dir
}

const runDirs: string[] = []

afterAll(async () => {
  await Promise.all(runDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

describe("publish preparation discloses, never guesses", () => {
  test("resolves the upstream-less unique remote and the destination default base", async () => {
    const { seam } = seamWith()
    const prepared = await seam.prepare()
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.plan).toEqual({ branch: "feat/widget", remote: "origin", base: "main" })
  })

  test("refuses a base branch, a detached HEAD, and a dirty tree", async () => {
    for (const [head, expected] of [
      ["main\n", "base branch"],
      ["", "detached"],
    ] as const) {
      const { seam } = seamWith({ "git symbolic-ref --quiet --short HEAD": ok(head) })
      const prepared = await seam.prepare()
      expect(prepared.ok).toBe(false)
      if (!prepared.ok) expect(prepared.message).toContain(expected)
    }
    const { seam } = seamWith({ "git status --porcelain": ok(" M src/x.ts\n") })
    const prepared = await seam.prepare()
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.message).toContain("uncommitted changes")
  })

  test("refuses no remotes and ambiguous remotes without an upstream", async () => {
    const none = seamWith({ "git remote": ok("") })
    const nonePrepared = await none.seam.prepare()
    expect(nonePrepared.ok).toBe(false)

    const ambiguous = seamWith({
      "git remote": ok("origin\nupstream\n"),
      "git rev-parse --quiet --abbrev-ref --symbolic-full-name feat/widget@{upstream}": fail("no upstream"),
    })
    const ambiguousPrepared = await ambiguous.seam.prepare()
    expect(ambiguousPrepared.ok).toBe(false)
    if (!ambiguousPrepared.ok) expect(ambiguousPrepared.message).toContain("several remotes")
  })

  test("a missing or unauthenticated gh blocks only the PR action, never the push", async () => {
    const missing = seamWith({ "gh --version": fail("command not found") })
    const missingPrepared = await missing.seam.prepare()
    // Push is independent of gh (delta run-finalization): preparation and the
    // push succeed; only the PR step is skipped.
    expect(missingPrepared.ok).toBe(true)
    const missingApplied = await missing.seam.apply({ branch: "feat/widget", remote: "origin", base: "main" })
    expect(missingApplied.ok).toBe(true)
    if (missingApplied.ok) expect(missingApplied.outcome.pushed).toBe(true)
    expect(missing.calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(true)
    expect(missing.calls.some((call) => call.command === "gh" && call.args[1] === "create")).toBe(false)

    const unauthed = seamWith({ "gh auth status": fail("not logged in") })
    const unauthedPrepared = await unauthed.seam.prepare()
    expect(unauthedPrepared.ok).toBe(true)
    const unauthedApplied = await unauthed.seam.apply({ branch: "feat/widget", remote: "origin", base: "main" })
    expect(unauthedApplied.ok).toBe(true)
    if (unauthedApplied.ok) expect(unauthedApplied.outcome.pushed).toBe(true)
  })
})

describe("publish apply pushes normally and locates before creating", () => {
  test("creates the PR after a normal push with an explicit refspec and no force", async () => {
    const { seam, calls } = seamWith()
    const result = await seam.apply({ branch: "feat/widget", remote: "origin", base: "main" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.outcome).toEqual({ pushed: true, url: "https://github.com/acme/repo/pull/12" })
    const push = calls.find((call) => call.command === "git" && call.args[0] === "push")
    expect(push?.args).toEqual(["push", "origin", "feat/widget:feat/widget"])
    const create = calls.find((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create")
    expect(create?.args).toContain("--head")
    expect(create?.args).toContain("feat/widget")
    expect(create?.args).toContain("--base")
    expect(create?.args).toContain("main")
    expect(JSON.stringify(calls)).not.toContain("--force")
  })

  test("a rejected push stops before any gh call and never force-pushes", async () => {
    const { seam, calls } = seamWith({ "git push origin feat/widget:feat/widget": fail("non-fast-forward") })
    const result = await seam.apply({ branch: "feat/widget", remote: "origin", base: "main" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("nothing was published")
    expect(calls.some((call) => call.command === "gh")).toBe(false)
  })

  test("an existing open PR is returned instead of created twice", async () => {
    const { seam, calls } = seamWith({
      "gh pr list": ok('[{"url":"https://github.com/acme/repo/pull/3"}]'),
    })
    const result = await seam.apply({ branch: "feat/widget", remote: "origin", base: "main" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.outcome.url).toBe("https://github.com/acme/repo/pull/3")
    expect(calls.some((call) => call.args.includes("pr") && call.args.includes("create"))).toBe(false)
  })

  test("a PR failure after a landed push preserves the push and invites a retry", async () => {
    const { seam, calls } = seamWith({ "gh pr create": fail("no permission") })
    const result = await seam.apply({ branch: "feat/widget", remote: "origin", base: "main" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("the branch was pushed to origin/feat/widget")
    expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(true)
  })
})

/** Extracts the composed --title/--body a `gh pr create` call received. */
function composedArgs(calls: Array<{ command: string; args: string[] }>): { title: string; body: string } {
  const create = calls.find((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create")
  expect(create).toBeDefined()
  const title = create!.args[create!.args.indexOf("--title") + 1]
  const body = create!.args[create!.args.indexOf("--body") + 1]
  expect(typeof title).toBe("string")
  expect(typeof body).toBe("string")
  return { title: title as string, body: body as string }
}

/** Like the happy-path fake, but any normal push succeeds so tests can apply arbitrary branches. */
function seedingRunner(calls: Array<{ command: string; args: string[] }>): PublishRunner {
  const base = fakeRunner({}, calls)
  return async (command, args, options) => {
    if (command === "git" && args[0] === "push") return ok("")
    return base(command, args, options)
  }
}

describe("PR text is composed deterministically from persisted context (capability run-titles)", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  /** A target checkout with the attached change's proposal and a run workspace with reports. */
  async function seedFixtures(options: { proposal?: string | null; recap?: boolean; finalizationMessage?: string } = {}): Promise<{ cwd: string; runDir: string }> {
    const cwd = join(await mkdtemp(join(tmpdir(), "convoy-publish-cwd-")), "repo")
    const runDir = await mkdtemp(join(tmpdir(), "convoy-publish-rundir-"))
    dirs.push(cwd, runDir)
    if (options.proposal !== null) {
      await mkdir(join(cwd, "openspec", "changes", "add-attach-flow"), { recursive: true })
      await writeFile(
        join(cwd, "openspec", "changes", "add-attach-flow", "proposal.md"),
        options.proposal ??
          "# Attachment flow for run reports\n\n## Why\n\nRun reports need a first page a human actually reads.\n\n## What Changes\n\n- Attach it.\n",
      )
    }
    await writeFile(join(runDir, "prd.md"), "Implement the attach flow for run reports\n\nMore detail below.\n")
    await writeFile(join(runDir, "SUMMARY.md"), "# convoy run - summary\n\n## implementer\n\nMechanical dump of every phase report.\n")
    if (options.recap !== false) {
      await mkdir(join(runDir, "reports"), { recursive: true })
      await writeFile(join(runDir, "reports", "run-report.md"), "# One-page recap\n\nEverything the phases reported, distilled.\n")
      await writeFile(join(runDir, "reports", "tests.md"), "42 specs pass across the publish flow.\n")
    }
    if (options.finalizationMessage !== undefined) {
      await writeFile(
        join(runDir, "metadata.json"),
        JSON.stringify({ schemaVersion: 5, finalization: { state: "completed", producedMessage: options.finalizationMessage } }),
      )
    }
    return { cwd, runDir }
  }

  test("a change-backed branch composes `type: proposal title`", async () => {
    const { cwd, runDir } = await seedFixtures()
    const calls: Array<{ command: string; args: string[] }> = []
    const real = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await real.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const { title, body } = composedArgs(calls)
    expect(title).toBe("feat: Attachment flow for run reports")
    // The three-section shape replaces the raw dump and the Run: line.
    expect(body).toContain("## Why")
    expect(body).toContain("## What")
    expect(body).toContain("## How tested")
    expect(body).not.toContain("Run: ")
    expect(body).toContain("Run reports need a first page a human actually reads.")
    // What prefers the distilled recap; How tested names the test step's report.
    expect(body.indexOf("One-page recap")).toBeGreaterThan(body.indexOf("## What"))
    expect(body).toContain("42 specs pass across the publish flow.")
  })

  test("a spin `change/` branch resolves to its change and titles with the `change` type", async () => {
    // Spin mints `change/<change-id>` branches; the prefix supplies the commit
    // type and the same change-title lookup supplies the subject, so a
    // spin-launched run publishes `change: <proposal title>`, not `feat:`.
    const { cwd, runDir } = await seedFixtures()
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "change/add-attach-flow", remote: "origin", base: "main" })
    expect(composedArgs(calls).title).toBe("change: Attachment flow for run reports")
  })

  test("a prefixed non-change branch titles from the humanized slug; an unprefixed branch fabricates no type", async () => {
    const { cwd, runDir } = await seedFixtures({ proposal: "# Something unrelated\n" })
    const calls: Array<{ command: string; args: string[] }> = []
    const prefixed = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await prefixed.apply({ branch: "fix/quiet-notifications", remote: "origin", base: "main" })
    expect(composedArgs(calls).title).toBe("fix: quiet notifications")

    const unprefixedCalls: Array<{ command: string; args: string[] }> = []
    const unprefixed = createPublishSeam({ cwd, runDir, run: seedingRunner(unprefixedCalls) })
    await unprefixed.apply({ branch: "team/alice/release-42", remote: "origin", base: "main" })
    expect(composedArgs(unprefixedCalls).title).toBe("team alice release 42")
  })

  test("the whole title stays inside the 72-column subject budget with word-boundary shortening", async () => {
    const longTitle = "Attachment flow for run reports with a deliberately very long subject line that must be shortened at a word boundary"
    const { cwd, runDir } = await seedFixtures({ proposal: `# ${longTitle}\n` })
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const { title } = composedArgs(calls)
    expect(title.length).toBeLessThanOrEqual(72)
    expect(title.startsWith("feat: ")).toBe(true)
    // Shortened at a word boundary: a prefix of the proposal title, never a mid-word cut.
    expect(`${longTitle} `.startsWith(`${title.slice("feat: ".length)} `)).toBe(true)
  })

  test("each missing source degrades mechanically: prompt why, message-body what, disclosed how-tested", async () => {
    // No proposal at all, no recap, no test reports: the prompt paragraph feeds
    // Why, the message body feeds What, and How tested discloses the gap
    // instead of implying coverage.
    const { cwd, runDir } = await seedFixtures({
      proposal: null,
      recap: false,
      finalizationMessage: "feat: compact the run\n\n- body line one\n- body line two\n",
    })
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const { title, body } = composedArgs(calls)
    expect(title).toBe("feat: add attach flow")
    expect(body).toContain("Implement the attach flow for run reports")
    expect(body).toContain("- body line one")
    expect(body).toContain("No test or validation report was produced by this run.")
  })

  test("the SUMMARY.md excerpt remains the last fallback for What", async () => {
    const { cwd, runDir } = await seedFixtures({ proposal: "# Something unrelated\n", recap: false })
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const { body } = composedArgs(calls)
    expect(body).toContain("Mechanical dump of every phase report.")
  })

  test("embedded content nests under the section heading that quotes it; fenced code is untouched", async () => {
    // The default fixture's SUMMARY.md opens with `# convoy run - summary` and
    // carries `## implementer`; quoted verbatim under `## What` those would
    // outrank the composed section heading itself. The test report's own
    // headings would likewise escape `### tests`.
    const { cwd, runDir } = await seedFixtures({ proposal: "# Something unrelated\n", recap: false })
    await mkdir(join(runDir, "reports"), { recursive: true })
    await writeFile(join(runDir, "reports", "tests.md"), "## Results\n\n42 specs pass.\n\n```bash\n# a comment, not a heading\n```\n")
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const { body } = composedArgs(calls)
    // The summary's headings shift under `## What` (H1 → H3, H2 → H4)…
    expect(body).toContain("### convoy run - summary")
    expect(body).toContain("#### implementer")
    // …and the report's under `### tests` (H2 → H4), fences preserved.
    expect(body).toContain("### tests")
    expect(body).toContain("#### Results")
    expect(body).toContain("# a comment, not a heading")
    // Outside fenced code, no heading outranks the composed `##` sections.
    expect(body.replace(/```[\s\S]*?```/g, "").match(/^# /m)).toBeNull()
  })

  test("a fenced example inside a longer fence stays code; headings after the outer close still normalize", async () => {
    // A ``` example inside a ```` fence must not flip the fence state: every
    // line inside the outer fence survives byte-exact, and heading-shaped
    // content there is never rewritten. Only after the outer fence closes do
    // real headings shift under the `### tests` step heading.
    const { cwd, runDir } = await seedFixtures({ proposal: "# Something unrelated\n", recap: false })
    await mkdir(join(runDir, "reports"), { recursive: true })
    await writeFile(
      join(runDir, "reports", "tests.md"),
      "````markdown\n```bash\n# not a heading: inner fence\n```\n# not a heading: inside the outer fence\n````\n## Results\n\n42 specs pass.\n",
    )
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const lines = composedArgs(calls).body.split("\n")
    // Exact lines, not substrings: a shifted `##` line would still contain the
    // single-# form, so containment on the array pins byte-exact preservation.
    expect(lines).toContain("````markdown")
    expect(lines).toContain("```bash")
    expect(lines).toContain("# not a heading: inner fence")
    expect(lines).toContain("```")
    expect(lines).toContain("# not a heading: inside the outer fence")
    expect(lines).toContain("````")
    expect(lines).not.toContain("## not a heading: inner fence")
    // After the outer fence closes, real headings still nest.
    expect(lines).toContain("#### Results")
    expect(lines).not.toContain("## Results")
  })

  test("prepare→apply twice over identical state composes the identical title and body, and absent sources still publish", async () => {
    const { cwd, runDir } = await seedFixtures()
    const firstCalls: Array<{ command: string; args: string[] }> = []
    const first = createPublishSeam({ cwd, runDir, run: seedingRunner(firstCalls) })
    const firstResult = await first.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    expect(firstResult.ok).toBe(true)

    const secondCalls: Array<{ command: string; args: string[] }> = []
    const second = createPublishSeam({ cwd, runDir, run: seedingRunner(secondCalls) })
    const secondResult = await second.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    expect(secondResult.ok).toBe(true)

    const firstText = composedArgs(firstCalls)
    const secondText = composedArgs(secondCalls)
    expect(secondText.title).toBe(firstText.title)
    expect(secondText.body).toBe(firstText.body)
  })

  test("a run without any source documents still publishes with disclosed fallback sections", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd: "/repo", run: seedingRunner(calls) })
    const result = await seam.apply({ branch: "feat/widget", remote: "origin", base: "main" })
    expect(result.ok).toBe(true)
    const { title, body } = composedArgs(calls)
    expect(title).toBe("feat: widget")
    expect(body).toContain("## Why")
    expect(body).toContain("## What")
    expect(body).toContain("No test or validation report was produced by this run.")
  })
})

describe("publication revalidates the reviewed feature link (task 5.2)", () => {
  const dirs: string[] = []

  /** A real repo with a registered feature whose branch is checked out in a worktree. */
  async function makeFeatureRepo(featureId: string): Promise<string> {
    const { execFile } = await import("../src/git")
    const { mkdir, mkdtemp: mkd, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const main = join(await mkd(join(tmpdir(), "convoy-publish-feature-")), "main")
    dirs.push(main)
    await mkdir(main, { recursive: true })
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: main })
    await writeFile(join(main, "README.md"), "x\n")
    await execFile("git", ["add", "."], { cwd: main })
    await execFile("git", ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init"], { cwd: main })
    // The feature's branch is checked out in a worktree so the association verifies.
    const { realpath } = await import("node:fs/promises")
    const wt = join(await mkd(join(tmpdir(), "convoy-publish-feature-wt-")), "wt")
    dirs.push(wt)
    await execFile("git", ["worktree", "add", "-b", "feat/widget", wt], { cwd: main, allowFailure: true })
    const { ensureRepositoryRecord, isFound, lifecycleCommonDir, withFeatureLock } = await import("../src/feature-lifecycle/store")
    const { writeFeatureRecord } = await import("../src/feature-lifecycle/records")
    const commonDir = (await lifecycleCommonDir(main))!
    const repoRecord = await ensureRepositoryRecord(commonDir)
    if (!isFound(repoRecord)) throw new Error("no repo record")
    const record: FeatureRecord = {
      schemaVersion: 1,
      featureId,
      repositoryId: repoRecord.value.repositoryId,
      displayName: "add-widget",
      associationRevision: 2,
      contracts: [{ changeId: "add-widget", kind: "active", sourcePath: "openspec/changes/add-widget", provenance: "adopt", selectedAtRevision: 2 }],
      intendedBaseRef: "main",
      context: { branch: "feat/widget", checkoutPath: await realpath(wt) },
      runIds: [],
      closeAttemptIds: [],
      history: [],
      createdAt: 1,
      updatedAt: 1,
    }
    await withFeatureLock(join(commonDir, "convoy", "features", featureId), () => writeFeatureRecord(commonDir, record, 0))
    return main
  }

  test("publication refuses a checkout that is no longer a valid Git target", async () => {
    // The injected runner answers for the target gate: a checkout whose Git
    // administrative directory cannot be resolved is refused, never published
    // through a reused historical path.
    const { seam } = seamWith({
      "git rev-parse --path-format=absolute --git-common-dir": fail("not a git repository"),
    })
    const prepared = await seam.prepare()
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.message).toMatch(/never pushes through a reused historical path/)
  })

  test("a run whose boundary verifies keeps the publication flow without feature metadata", async () => {
    const runDir = await withRunDir(undefined, fakeBoundary())
    const real = createPublishSeam({ cwd: "/repo", runDir, run: fakeRunner({}, []) })
    const prepared = await real.prepare()
    expect(prepared.ok).toBe(true)
  })

  test("a readable run record without run-start provenance requires fresh target review", async () => {
    const runDir = await withRunDir(undefined)
    const real = createPublishSeam({ cwd: "/repo", runDir, run: fakeRunner({}, []) })
    const prepared = await real.prepare()
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.message).toContain("no run-start provenance")
  })

  test("a boundary whose start commit is not reachable from HEAD is refused", async () => {
    const runDir = await withRunDir(undefined, { ...fakeBoundary(), startHead: "b".repeat(40) })
    const real = createPublishSeam({ cwd: "/repo", runDir, run: fakeRunner({}, []) })
    const prepared = await real.prepare()
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.message).toMatch(/not reachable from the current HEAD/)
  })

  test("a boundary whose recorded branch no longer matches the checkout is refused", async () => {
    const runDir = await withRunDir(undefined, { ...fakeBoundary(), branch: "feat/other" })
    const real = createPublishSeam({ cwd: "/repo", runDir, run: fakeRunner({}, []) })
    const prepared = await real.prepare()
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.message).toMatch(/not the recorded branch/)
  })

  test("a boundary recorded in another repository is refused", async () => {
    const runDir = await withRunDir(undefined, { ...fakeBoundary(), commonDir: "/elsewhere/.git" })
    const real = createPublishSeam({ cwd: "/repo", runDir, run: fakeRunner({}, []) })
    const prepared = await real.prepare()
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.message).toMatch(/different repository/)
  })

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  /** A target checkout with the attached change's proposal and a run workspace with reports. */
  async function seedFixtures(options: { proposal?: string | null; recap?: boolean; finalizationMessage?: string } = {}): Promise<{ cwd: string; runDir: string }> {
    const cwd = join(await mkdtemp(join(tmpdir(), "convoy-publish-cwd-")), "repo")
    const runDir = await mkdtemp(join(tmpdir(), "convoy-publish-rundir-"))
    dirs.push(cwd, runDir)
    if (options.proposal !== null) {
      await mkdir(join(cwd, "openspec", "changes", "add-attach-flow"), { recursive: true })
      await writeFile(
        join(cwd, "openspec", "changes", "add-attach-flow", "proposal.md"),
        options.proposal ??
          "# Attachment flow for run reports\n\n## Why\n\nRun reports need a first page a human actually reads.\n\n## What Changes\n\n- Attach it.\n",
      )
    }
    await writeFile(join(runDir, "prd.md"), "Implement the attach flow for run reports\n\nMore detail below.\n")
    await writeFile(join(runDir, "SUMMARY.md"), "# convoy run - summary\n\n## implementer\n\nMechanical dump of every phase report.\n")
    if (options.recap !== false) {
      await mkdir(join(runDir, "reports"), { recursive: true })
      await writeFile(join(runDir, "reports", "run-report.md"), "# One-page recap\n\nEverything the phases reported, distilled.\n")
      await writeFile(join(runDir, "reports", "tests.md"), "42 specs pass across the publish flow.\n")
    }
    if (options.finalizationMessage !== undefined) {
      await writeFile(
        join(runDir, "metadata.json"),
        JSON.stringify({ schemaVersion: 5, finalization: { state: "completed", producedMessage: options.finalizationMessage } }),
      )
    }
    return { cwd, runDir }
  }

  test("a change-backed branch composes `type: proposal title`", async () => {
    const { cwd, runDir } = await seedFixtures()
    const calls: Array<{ command: string; args: string[] }> = []
    const real = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await real.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const { title, body } = composedArgs(calls)
    expect(title).toBe("feat: Attachment flow for run reports")
    // The three-section shape replaces the raw dump and the Run: line.
    expect(body).toContain("## Why")
    expect(body).toContain("## What")
    expect(body).toContain("## How tested")
    expect(body).not.toContain("Run: ")
    expect(body).toContain("Run reports need a first page a human actually reads.")
    // What prefers the distilled recap; How tested names the test step's report.
    expect(body.indexOf("One-page recap")).toBeGreaterThan(body.indexOf("## What"))
    expect(body).toContain("42 specs pass across the publish flow.")
  })

  test("a spin `change/` branch resolves to its change and titles with the `change` type", async () => {
    // Spin mints `change/<change-id>` branches; the prefix supplies the commit
    // type and the same change-title lookup supplies the subject, so a
    // spin-launched run publishes `change: <proposal title>`, not `feat:`.
    const { cwd, runDir } = await seedFixtures()
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "change/add-attach-flow", remote: "origin", base: "main" })
    expect(composedArgs(calls).title).toBe("change: Attachment flow for run reports")
  })

  test("a prefixed non-change branch titles from the humanized slug; an unprefixed branch fabricates no type", async () => {
    const { cwd, runDir } = await seedFixtures({ proposal: "# Something unrelated\n" })
    const calls: Array<{ command: string; args: string[] }> = []
    const prefixed = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await prefixed.apply({ branch: "fix/quiet-notifications", remote: "origin", base: "main" })
    expect(composedArgs(calls).title).toBe("fix: quiet notifications")

    const unprefixedCalls: Array<{ command: string; args: string[] }> = []
    const unprefixed = createPublishSeam({ cwd, runDir, run: seedingRunner(unprefixedCalls) })
    await unprefixed.apply({ branch: "team/alice/release-42", remote: "origin", base: "main" })
    expect(composedArgs(unprefixedCalls).title).toBe("team alice release 42")
  })

  test("the whole title stays inside the 72-column subject budget with word-boundary shortening", async () => {
    const longTitle = "Attachment flow for run reports with a deliberately very long subject line that must be shortened at a word boundary"
    const { cwd, runDir } = await seedFixtures({ proposal: `# ${longTitle}\n` })
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const { title } = composedArgs(calls)
    expect(title.length).toBeLessThanOrEqual(72)
    expect(title.startsWith("feat: ")).toBe(true)
    // Shortened at a word boundary: a prefix of the proposal title, never a mid-word cut.
    expect(`${longTitle} `.startsWith(`${title.slice("feat: ".length)} `)).toBe(true)
  })

  test("each missing source degrades mechanically: prompt why, message-body what, disclosed how-tested", async () => {
    // No proposal at all, no recap, no test reports: the prompt paragraph feeds
    // Why, the message body feeds What, and How tested discloses the gap
    // instead of implying coverage.
    const { cwd, runDir } = await seedFixtures({
      proposal: null,
      recap: false,
      finalizationMessage: "feat: compact the run\n\n- body line one\n- body line two\n",
    })
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const { title, body } = composedArgs(calls)
    expect(title).toBe("feat: add attach flow")
    expect(body).toContain("Implement the attach flow for run reports")
    expect(body).toContain("- body line one")
    expect(body).toContain("No test or validation report was produced by this run.")
  })

  test("the SUMMARY.md excerpt remains the last fallback for What", async () => {
    const { cwd, runDir } = await seedFixtures({ proposal: "# Something unrelated\n", recap: false })
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const { body } = composedArgs(calls)
    expect(body).toContain("Mechanical dump of every phase report.")
  })

  test("embedded content nests under the section heading that quotes it; fenced code is untouched", async () => {
    // The default fixture's SUMMARY.md opens with `# convoy run - summary` and
    // carries `## implementer`; quoted verbatim under `## What` those would
    // outrank the composed section heading itself. The test report's own
    // headings would likewise escape `### tests`.
    const { cwd, runDir } = await seedFixtures({ proposal: "# Something unrelated\n", recap: false })
    await mkdir(join(runDir, "reports"), { recursive: true })
    await writeFile(join(runDir, "reports", "tests.md"), "## Results\n\n42 specs pass.\n\n```bash\n# a comment, not a heading\n```\n")
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const { body } = composedArgs(calls)
    // The summary's headings shift under `## What` (H1 → H3, H2 → H4)…
    expect(body).toContain("### convoy run - summary")
    expect(body).toContain("#### implementer")
    // …and the report's under `### tests` (H2 → H4), fences preserved.
    expect(body).toContain("### tests")
    expect(body).toContain("#### Results")
    expect(body).toContain("# a comment, not a heading")
    // Outside fenced code, no heading outranks the composed `##` sections.
    expect(body.replace(/```[\s\S]*?```/g, "").match(/^# /m)).toBeNull()
  })

  test("a fenced example inside a longer fence stays code; headings after the outer close still normalize", async () => {
    // A ``` example inside a ```` fence must not flip the fence state: every
    // line inside the outer fence survives byte-exact, and heading-shaped
    // content there is never rewritten. Only after the outer fence closes do
    // real headings shift under the `### tests` step heading.
    const { cwd, runDir } = await seedFixtures({ proposal: "# Something unrelated\n", recap: false })
    await mkdir(join(runDir, "reports"), { recursive: true })
    await writeFile(
      join(runDir, "reports", "tests.md"),
      "````markdown\n```bash\n# not a heading: inner fence\n```\n# not a heading: inside the outer fence\n````\n## Results\n\n42 specs pass.\n",
    )
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd, runDir, run: seedingRunner(calls) })
    await seam.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    const lines = composedArgs(calls).body.split("\n")
    // Exact lines, not substrings: a shifted `##` line would still contain the
    // single-# form, so containment on the array pins byte-exact preservation.
    expect(lines).toContain("````markdown")
    expect(lines).toContain("```bash")
    expect(lines).toContain("# not a heading: inner fence")
    expect(lines).toContain("```")
    expect(lines).toContain("# not a heading: inside the outer fence")
    expect(lines).toContain("````")
    expect(lines).not.toContain("## not a heading: inner fence")
    // After the outer fence closes, real headings still nest.
    expect(lines).toContain("#### Results")
    expect(lines).not.toContain("## Results")
  })

  test("prepare→apply twice over identical state composes the identical title and body, and absent sources still publish", async () => {
    const { cwd, runDir } = await seedFixtures()
    const firstCalls: Array<{ command: string; args: string[] }> = []
    const first = createPublishSeam({ cwd, runDir, run: seedingRunner(firstCalls) })
    const firstResult = await first.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    expect(firstResult.ok).toBe(true)

    const secondCalls: Array<{ command: string; args: string[] }> = []
    const second = createPublishSeam({ cwd, runDir, run: seedingRunner(secondCalls) })
    const secondResult = await second.apply({ branch: "feat/add-attach-flow", remote: "origin", base: "main" })
    expect(secondResult.ok).toBe(true)

    const firstText = composedArgs(firstCalls)
    const secondText = composedArgs(secondCalls)
    expect(secondText.title).toBe(firstText.title)
    expect(secondText.body).toBe(firstText.body)
  })

  test("a run without any source documents still publishes with disclosed fallback sections", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd: "/repo", run: seedingRunner(calls) })
    const result = await seam.apply({ branch: "feat/widget", remote: "origin", base: "main" })
    expect(result.ok).toBe(true)
    const { title, body } = composedArgs(calls)
    expect(title).toBe("feat: widget")
    expect(body).toContain("## Why")
    expect(body).toContain("## What")
    expect(body).toContain("No test or validation report was produced by this run.")
  })
})

describe("publication validates the current target (delta run-finalization)", () => {
  const dirs: string[] = []

  test("a stale feature link in run metadata grants no publication authority", async () => {
    const runDir = await withRunDir(
      {
        featureId: "99999999-2222-4333-8444-555555555555",
        repositoryId: "88888888-2222-4333-8444-555555555555",
        associationRevision: 1,
        contracts: ["add-widget"],
        baseRef: "main",
        branch: "feat/widget",
      },
      fakeBoundary(),
    )
    // The retired feature link neither blocks nor authorizes publication:
    // the gate is the current Git target, not the registry (delta
    // run-finalization). The happy-path fake answers for that target.
    const real = createPublishSeam({ cwd: "/repo", runDir, run: fakeRunner({}, []) })
    const prepared = await real.prepare()
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.plan.branch).toBe("feat/widget")
  })

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
  })
})

describe("publication proves frozen provenance against the live checkout (real repo)", () => {
  const dirs: string[] = []

  async function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
    const { execFile } = await import("../src/git")
    // Only override the environment when the caller names variables: a
    // partially-spread env can drop PATH and break git lookup.
    const result = await execFile("git", args, Object.keys(env).length > 0 ? { cwd, allowFailure: true, env: { ...process.env, ...env } as Record<string, string> } : { cwd, allowFailure: true })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${(result.stderr || result.stdout).trim()}`)
    return result.stdout.trim()
  }

  /** A real repository with a feature worktree, a remote, and one commit on the feature branch. */
  async function makeRepo(): Promise<{ main: string; wt: string; startHead: string; commonDir: string }> {
    const { realpath } = await import("node:fs/promises")
    const root = await mkdtemp(join(tmpdir(), "convoy-publish-provenance-"))
    dirs.push(root)
    const main = join(root, "main")
    const wt = join(root, "wt")
    await mkdir(main, { recursive: true })
    await git(["init", "-q", "-b", "main"], main)
    await writeFile(join(main, "README.md"), "# repo\n")
    await git(["add", "."], main)
    await git(["commit", "-q", "-m", "init"], main, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" })
    await git(["remote", "add", "origin", "https://example.invalid/acme/repo"], main)
    await git(["worktree", "add", "-q", "-b", "feat/widget", wt], main)
    await writeFile(join(wt, "feature.txt"), "run work\n")
    await git(["add", "."], wt)
    await git(["commit", "-q", "-m", "feat: run work"], wt, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" })
    const startHead = await git(["rev-parse", "HEAD"], wt)
    const commonDir = await realpath((await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], wt)))
    return { main, wt: await realpath(wt), startHead, commonDir }
  }

  /** The seam's runner: real Git, every call recorded so "no push" is provable. */
  function recordingRunner(cwd: string, calls: Array<{ command: string; args: string[] }>): PublishRunner {
    return async (command, args, options) => {
      calls.push({ command, args })
      const { execFile } = await import("../src/git")
      try {
        return await execFile(command, args, { cwd, allowFailure: options?.allowFailure ?? false })
      } catch (error) {
        return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 }
      }
    }
  }

  test("the run's own branch advancing after the boundary is continuity, not a replacement", async () => {
    const { wt, startHead, commonDir } = await makeRepo()
    const runDir = await withRunDir(undefined, { worktreeDir: wt, branch: "feat/widget", startHead, commonDir, includeDirty: false, recordedAt: 1, schemaVersion: 1 })
    // The run (or the operator) advanced the branch after the boundary.
    await writeFile(join(wt, "more.txt"), "later work\n")
    await git(["add", "."], wt)
    await git(["commit", "-q", "-m", "feat: later work"], wt, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" })

    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd: wt, runDir, run: recordingRunner(wt, calls) })
    const prepared = await seam.prepare()
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.plan.branch).toBe("feat/widget")
    expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false)
  })

  test("a checkout removed and recreated at the same path on the same branch spelling is refused; no push occurs", async () => {
    const { main, wt, startHead, commonDir } = await makeRepo()
    const runDir = await withRunDir(undefined, { worktreeDir: wt, branch: "feat/widget", startHead, commonDir, includeDirty: false, recordedAt: 1, schemaVersion: 1 })

    // Remove the run's checkout entirely…
    await git(["worktree", "remove", "--force", wt], main)
    // …and recreate a DIFFERENT checkout at the same path, on the same branch
    // spelling, whose history never contained the run's start commit: an
    // unrelated root commit moved onto the reused branch name.
    const tree = await git(["write-tree"], main)
    const replacement = await git(["commit-tree", tree, "-m", "replacement work"], main, {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    })
    await git(["update-ref", "refs/heads/feat/widget", replacement], main)
    await git(["worktree", "add", "-q", wt, "feat/widget"], main)
    expect(await git(["rev-parse", "HEAD"], wt)).toBe(replacement)

    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd: wt, runDir, run: recordingRunner(wt, calls) })
    const prepared = await seam.prepare()
    // The frozen provenance does not verify: the replacement checkout shares
    // only the path and the branch spelling, not the run's history.
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.message).toMatch(/not reachable from the current HEAD/)
    // Nothing was pushed: the guarded flow (prepare → apply) refused during
    // preparation, before any effect, and the call log proves no push ran.
    expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false)
  })

  test("a checkout replaced by another repository at the same path is refused", async () => {
    const { wt, startHead, commonDir } = await makeRepo()
    const runDir = await withRunDir(undefined, { worktreeDir: wt, branch: "feat/widget", startHead, commonDir, includeDirty: false, recordedAt: 1, schemaVersion: 1 })

    // A different repository takes over the path.
    const { rm, realpath } = await import("node:fs/promises")
    await rm(await realpath(wt), { recursive: true, force: true })
    const otherParent = await mkdtemp(join(tmpdir(), "convoy-publish-imposter-"))
    dirs.push(otherParent)
    const other = join(otherParent, "wt")
    await mkdir(other, { recursive: true })
    // Same branch spelling as the recorded boundary — only the provenance
    // checks (repository, path, start-commit reachability) can tell it apart.
    await git(["init", "-q", "-b", "feat/widget"], other)
    await writeFile(join(other, "README.md"), "# an entirely different repository\n")
    await git(["add", "."], other)
    await git(["commit", "-q", "-m", "init"], other, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" })

    const calls: Array<{ command: string; args: string[] }> = []
    const seam = createPublishSeam({ cwd: other, runDir, run: recordingRunner(other, calls) })
    const prepared = await seam.prepare()
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.message).toMatch(/different repository|does not match the current checkout/)
    expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false)
  })

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
  })
})
