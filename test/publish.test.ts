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

/** A happy-path fake: clean feature branch on origin, gh installed and authenticated. */
function fakeRunner(overrides: Record<string, RunResult> = {}, calls: Array<{ command: string; args: string[] }> = []): PublishRunner {
  const defaults: Record<string, RunResult> = {
    "git symbolic-ref --quiet --short HEAD": ok("feat/widget\n"),
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

  test("a missing or unauthenticated gh disables publishing with remediation", async () => {
    const missing = seamWith({ "gh --version": fail("command not found") })
    const missingPrepared = await missing.seam.prepare()
    expect(missingPrepared.ok).toBe(false)
    if (!missingPrepared.ok) expect(missingPrepared.message).toContain("https://cli.github.com")

    const unauthed = seamWith({ "gh auth status": fail("not logged in") })
    const unauthedPrepared = await unauthed.seam.prepare()
    expect(unauthedPrepared.ok).toBe(false)
    if (!unauthedPrepared.ok) expect(unauthedPrepared.message).toContain("gh auth login")
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

  async function withRunDir(feature: unknown): Promise<string> {
    const { mkdtemp: mkd, writeFile: wf } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkd(join(tmpdir(), "convoy-publish-rundir-"))
    dirs.push(dir)
    if (feature !== undefined) {
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
          feature,
        }),
      )
    }
    return dir
  }

  test("a feature-backed run refuses publication when its link no longer verifies", async () => {
    const main = await makeFeatureRepo("11111111-2222-4333-8444-555555555555")
    const runDir = await withRunDir({
      featureId: "99999999-2222-4333-8444-555555555555",
      repositoryId: "88888888-2222-4333-8444-555555555555",
      associationRevision: 1,
      contracts: ["add-widget"],
      baseRef: "main",
      branch: "feat/widget",
    })
    const { seam } = seamWith({}, runDir)
    void seam
    // Re-create the seam with the real cwd so the gate reaches the store.
    const real = createPublishSeam({ cwd: main, runDir, run: fakeRunner({}, []) })
    const prepared = await real.prepare()
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.message).toMatch(/never pushes the branch now occupying the historical path/)
  })

  test("a verified feature link revalidates and publication proceeds", async () => {
    const main = await makeFeatureRepo("11111111-2222-4333-8444-555555555556")
    const runDir = await withRunDir({
      featureId: "11111111-2222-4333-8444-555555555556",
      repositoryId: "88888888-2222-4333-8444-555555555555",
      associationRevision: 2,
      contracts: ["add-widget"],
      baseRef: "main",
      branch: "feat/widget",
    })
    const calls: Array<{ command: string; args: string[] }> = []
    const real = createPublishSeam({ cwd: main, runDir, run: fakeRunner({}, calls) })
    const prepared = await real.prepare()
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.plan.branch).toBe("feat/widget")
  })

  test("a run without a feature link keeps the no-spec publication flow", async () => {
    const runDir = await withRunDir(undefined)
    const real = createPublishSeam({ cwd: "/repo", runDir, run: fakeRunner({}, []) })
    const prepared = await real.prepare()
    expect(prepared.ok).toBe(true)
  })

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
  })
})
