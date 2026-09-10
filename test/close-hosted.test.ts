import { afterEach, describe, expect, mock, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { driveClose, runWorktreesCommand } from "../src/worktree-commands"
import { landViaGitHub, hostedOperationInputs, isHostedCloseOperation } from "../src/close-hosted"
import { acknowledgeStep, createOperation, listPendingOperations, recordStepIntent } from "../src/operation-journal"
import { reconcileStepReality } from "../src/operation-reconcile"
import { reviewOperation } from "../src/operation-handlers"
import { execFile } from "../src/git"
import { repoCommonDir } from "../src/repo-store"
import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import type { CloseEvent, CloseLandingDecision } from "../src/close-events"

/**
 * The hosted close landing (change `close-lands-via-github-pr`): when close
 * detects exactly one open PR for the branch, the landing leaves the local
 * squash behind and becomes a journaled remote transaction — non-force branch
 * push, `gh pr merge --squash` with the reviewed message, local base
 * fast-forward — reconciled by receipt on recovery. Every test drives a fake
 * `gh` that performs the hosted squash against a real bare remote, so the
 * assertions check Git and hosting facts, not mocks.
 */

type FakePrState = {
  number: number
  title: string
  url: string
  state: "OPEN" | "MERGED" | "CLOSED"
  mergeCommit?: string
  ambiguous?: boolean
  mergeFails?: boolean
  /** Make `gh pr list` fail so PR evidence is unavailable, not absent. */
  listFails?: boolean
  mergeCalls?: number
}

type HostedFixture = {
  fixture: FixtureRepo
  origin: string
  wt: string
  commonDir: string
  statePath: string
  readState(): Promise<FakePrState | null>
  writeState(state: FakePrState | null): Promise<void>
}

const cleanupFns: Array<() => Promise<void>> = []
const scratchDirs: string[] = []

afterEach(async () => {
  for (const fn of cleanupFns.splice(0)) await fn()
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {})
  process.exitCode = 0
})

/** Creates a fixture repository with a bare `origin` remote and `main` pushed to it. */
async function createHostedFixture(): Promise<HostedFixture> {
  const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
  cleanupFns.push(() => fixture.cleanup())
  const wt = fixture.worktrees["wt"]!
  const origin = join(fixture.root, "..", "origin.git")
  await execFile("git", ["init", "--bare", "-b", "main", origin], { cwd: fixture.root })
  await fixture.git(["remote", "add", "origin", origin])
  await fixture.git(["push", "-u", "origin", "main"])
  const commonDir = (await repoCommonDir(fixture.root))!
  const stateDir = await mkdtemp(join(tmpdir(), "convoy-fake-gh-"))
  scratchDirs.push(stateDir)
  const statePath = join(stateDir, "pr-state.json")
  return {
    fixture,
    origin,
    wt,
    commonDir,
    statePath,
    async readState() {
      const file = Bun.file(statePath)
      if (!(await file.exists())) return null
      return (await file.json()) as FakePrState
    },
    async writeState(state) {
      if (state === null) await rm(statePath, { force: true }).catch(() => {})
      else await writeFile(statePath, JSON.stringify(state))
    },
  }
}

/**
 * Writes a fake `gh` whose PR state lives in CONVOY_FAKE_GH_STATE: `pr list`
 * and `pr view` answer from that file; `pr merge --squash` performs the real
 * hosted squash against the bare origin (commit-tree onto origin/main, push)
 * and records the receipt. Runs `fn` with the fake first on PATH and the
 * state path in the environment.
 */
async function withFakeGh(fx: HostedFixture, fn: () => Promise<void>): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), "convoy-fake-gh-bin-"))
  scratchDirs.push(binDir)
  const script = [
    `#!/usr/bin/env bun`,
    `import { readFileSync, writeFileSync, existsSync } from "node:fs"`,
    `import { execFileSync } from "node:child_process"`,
    `const statePath = process.env.CONVOY_FAKE_GH_STATE ?? ""`,
    `const readState = () => (statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null)`,
    `const writeState = (value) => { if (statePath) writeFileSync(statePath, JSON.stringify(value)) }`,
    `const argv = process.argv.slice(2)`,
    `if (argv[0] === "--version") { console.log("gh version fake-1.0"); process.exit(0) }`,
    `if (argv[0] === "pr") {`,
    `  const state = readState()`,
    `  const sub = argv[1]`,
    `  if (sub === "list") {`,
    `    if (state && state.listFails === true) { console.error("gh: network unreachable"); process.exit(1) }`,
    `    const prs = []`,
    `    if (state && state.state === "OPEN") {`,
    `      const count = state.ambiguous === true ? 2 : 1`,
    `      for (let i = 1; i <= count; i++) prs.push({ number: state.number + i - 1, title: state.title, url: state.url + (i > 1 ? "-" + i : "") })`,
    `    }`,
    `    console.log(JSON.stringify(prs))`,
    `    process.exit(0)`,
    `  }`,
    `  if (sub === "view") {`,
    `    if (!state) { console.error("no such PR"); process.exit(1) }`,
    `    console.log(JSON.stringify({ state: state.state, mergeCommit: state.mergeCommit ?? "" }))`,
    `    process.exit(0)`,
    `  }`,
    `  if (sub === "merge") {`,
    `    if (!state) { console.error("no such PR"); process.exit(1) }`,
    `    if (state.mergeFails === true) { console.error("GraphQL: Pull request is not mergeable: the base branch has conflicts"); process.exit(1) }`,
    `    const si = argv.indexOf("--subject")`,
    `    const bi = argv.indexOf("--body")`,
    `    const subject = si >= 0 && argv[si + 1] !== undefined ? argv[si + 1] : ""`,
    `    const body = bi >= 0 && argv[bi + 1] !== undefined ? argv[bi + 1] : ""`,
    `    const message = subject + (body ? "\\n\\n" + body : "")`,
    `    execFileSync("git", ["fetch", "origin", "main"], { stdio: "ignore" })`,
    `    const base = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim()`,
    `    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim()`,
    `    const sha = execFileSync("git", ["commit-tree", tree, "-p", base], { input: message, encoding: "utf8" }).trim()`,
    `    execFileSync("git", ["push", "origin", sha + ":refs/heads/main"], { stdio: "ignore" })`,
    `    state.state = "MERGED"`,
    `    state.mergeCommit = sha`,
    `    state.mergeCalls = (state.mergeCalls ?? 0) + 1`,
    `    writeState(state)`,
    `    console.log("squashed " + sha.slice(0, 7))`,
    `    process.exit(0)`,
    `  }`,
    `}`,
    `process.exit(1)`,
  ].join("\n")
  await writeFile(join(binDir, "gh"), script)
  await chmod(join(binDir, "gh"), 0o755)
  const previousPath = process.env.PATH
  const previousState = process.env.CONVOY_FAKE_GH_STATE
  process.env.PATH = `${binDir}:${previousPath ?? ""}`
  process.env.CONVOY_FAKE_GH_STATE = fx.statePath
  try {
    await fn()
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousState === undefined) delete process.env.CONVOY_FAKE_GH_STATE
    else process.env.CONVOY_FAKE_GH_STATE = previousState
  }
}

const openPr = (extra: Partial<FakePrState> = {}): FakePrState => ({
  number: 7,
  title: "Add widget",
  url: "https://github.com/acme/repo/pull/7",
  state: "OPEN",
  ...extra,
})

function stdoutCapture(): { lines: string[]; start(): void; stop(): void } {
  const lines: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  const spy = mock((chunk: string) => {
    lines.push(chunk)
    return true
  })
  return {
    lines,
    start() {
      process.stdout.write = spy as typeof process.stdout.write
    },
    stop() {
      process.stdout.write = originalWrite
    },
  }
}

const originMain = (fx: HostedFixture): Promise<string> =>
  execFile("git", ["--git-dir", fx.origin, "rev-parse", "main"], { cwd: fx.fixture.root }).then((r) => r.stdout.trim())

const localMain = (fx: HostedFixture): Promise<string> => fx.fixture.git(["rev-parse", "main"]).then((out) => out.trim())

// ── the hosted landing e2e (task 5.1) ────────────────────────────────────

describe("hosted close landing", () => {
  test("headless close with a linked PR pushes, squash-merges via GitHub, and fast-forwards the local base", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "hosted work\n")
    await fx.fixture.commitAll("feat: hosted work", fx.wt)
    const sourceTip = (await fx.fixture.git(["rev-parse", "feat/x"])).trim()
    const originMainBefore = await originMain(fx)
    await fx.writeState(openPr())

    const capture = stdoutCapture()
    let exit: Promise<void>
    capture.start()
    try {
      exit = withFakeGh(fx, () => runWorktreesCommand({ kind: "close", worktree: fx.wt, base: "main", changes: [], message: "feat: hosted work\n\n- adds the widget" }, fx.fixture.root))
      await exit
    } finally {
      capture.stop()
    }

    // GitHub's squash commit exists on the remote base, carrying the reviewed
    // message verbatim as subject and body.
    const state = await fx.readState()
    expect(state?.state).toBe("MERGED")
    expect(state?.mergeCalls).toBe(1)
    const mergeSha = state?.mergeCommit
    if (mergeSha === undefined) throw new Error("the fake gh recorded no merge commit")
    expect(mergeSha).toMatch(/^[0-9a-f]{40}$/)
    expect(await originMain(fx)).toBe(mergeSha)
    expect((await fx.fixture.git(["log", "-1", "--format=%s", "main"])).trim()).toBe("feat: hosted work")
    expect((await fx.fixture.git(["log", "-1", "--format=%b", "main"]))).toContain("adds the widget")
    // The local base was fast-forwarded to GitHub's commit: no twin squash commits.
    expect(await localMain(fx)).toBe(mergeSha)
    // The hosted commit's tree is the source tree; the source branch was not rewritten.
    expect((await fx.fixture.git(["rev-parse", "feat/x"])).trim()).toBe(sourceTip)
    expect((await fx.fixture.git(["rev-parse", `${mergeSha}^{tree}`])).trim()).toBe((await fx.fixture.git(["rev-parse", "feat/x^{tree}"])).trim())
    // The push happened as part of the transaction: the remote branch holds the reviewed tip.
    expect((await execFile("git", ["--git-dir", fx.origin, "rev-parse", "refs/heads/feat/x"], { cwd: fx.fixture.root })).stdout.trim()).toBe(sourceTip)
    // The journal was released.
    expect(await listPendingOperations(fx.commonDir)).toEqual([])
    // The headless plan disclosed the remote steps before any effect.
    const output = capture.lines.join("")
    expect(output).toContain("close plan:")
    expect(output).toContain("hosted landing via PR #7")
    // The summary narrates the observed merge as a fact, replacing the
    // reference-only disclaimer.
    expect(output).toContain(`PR #7 was merged by GitHub as ${(mergeSha ?? "").slice(0, 8)}`)
    expect(output).toContain("the local main was fast-forwarded to GitHub's squash commit")
    expect(output).not.toContain("not a claim that GitHub merged it")
    void originMainBefore
  })

  test("--local-landing keeps the whole landing local and leaves the PR untouched", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "local work\n")
    await fx.fixture.commitAll("feat: local work", fx.wt)
    const originMainBefore = await originMain(fx)
    await fx.writeState(openPr())

    await withFakeGh(fx, () =>
      runWorktreesCommand({ kind: "close", worktree: fx.wt, base: "main", changes: [], message: "feat: local work", localLanding: true }, fx.fixture.root),
    )

    // The local squash landed on the local base; GitHub never learned of it.
    expect(await localMain(fx)).not.toBe(originMainBefore)
    expect((await fx.fixture.git(["log", "-1", "--format=%s", "main"])).trim()).toBe("feat: local work")
    expect(await originMain(fx)).toBe(originMainBefore)
    expect((await execFile("git", ["--git-dir", fx.origin, "rev-parse", "refs/heads/feat/x"], { cwd: fx.fixture.root, allowFailure: true })).exitCode).not.toBe(0)
    const state = await fx.readState()
    expect(state?.state).toBe("OPEN")
    expect(state?.mergeCalls ?? 0).toBe(0)
    expect(await listPendingOperations(fx.commonDir)).toEqual([])
  })

  test("no linked PR keeps the local landing even when gh is usable", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "local work\n")
    await fx.fixture.commitAll("feat: local work", fx.wt)
    const originMainBefore = await originMain(fx)
    // No PR state at all: the probe reports none.
    await fx.writeState(null)

    await withFakeGh(fx, () => runWorktreesCommand({ kind: "close", worktree: fx.wt, base: "main", changes: [], message: "feat: local work" }, fx.fixture.root))

    expect(await localMain(fx)).not.toBe(originMainBefore)
    expect(await originMain(fx)).toBe(originMainBefore)
    expect((await fx.readState())?.mergeCalls ?? 0).toBe(0)
  })

  test("an ambiguous PR match selects the local path without asserting hosted coverage", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "local work\n")
    await fx.fixture.commitAll("feat: local work", fx.wt)
    const originMainBefore = await originMain(fx)
    await fx.writeState(openPr({ ambiguous: true }))

    await withFakeGh(fx, () => runWorktreesCommand({ kind: "close", worktree: fx.wt, base: "main", changes: [], message: "feat: local work" }, fx.fixture.root))

    expect(await localMain(fx)).not.toBe(originMainBefore)
    expect(await originMain(fx)).toBe(originMainBefore)
    expect((await fx.readState())?.mergeCalls ?? 0).toBe(0)
  })

  test("unavailable PR evidence lands locally and never claims hosted state", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "local work\n")
    await fx.fixture.commitAll("feat: local work", fx.wt)
    const originMainBefore = await originMain(fx)
    // gh is usable but the lookup itself fails: unavailable evidence, not an
    // absent PR, so the landing must stay local and claim no hosted state.
    await fx.writeState(openPr({ listFails: true }))

    const capture = stdoutCapture()
    capture.start()
    try {
      await withFakeGh(fx, () => runWorktreesCommand({ kind: "close", worktree: fx.wt, base: "main", changes: [], message: "feat: local work" }, fx.fixture.root))
    } finally {
      capture.stop()
    }

    const output = capture.lines.join("")
    // No hosted plan, no observed-merge claim, and no reference-only PR claim.
    expect(output).not.toContain("hosted landing via PR")
    expect(output).not.toContain("was merged by GitHub")
    expect(output).not.toContain("not a claim")
    // The local squash landed; the PR and the remote base are untouched.
    expect(await localMain(fx)).not.toBe(originMainBefore)
    expect(await originMain(fx)).toBe(originMainBefore)
    expect((await fx.readState())?.mergeCalls ?? 0).toBe(0)
    expect(await listPendingOperations(fx.commonDir)).toEqual([])
  })

  test("a GitHub merge rejection stops close with the blocker; the branch and PR stay unchanged", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "blocked work\n")
    await fx.fixture.commitAll("feat: blocked work", fx.wt)
    const sourceTip = (await fx.fixture.git(["rev-parse", "feat/x"])).trim()
    const originMainBefore = await originMain(fx)
    // A PR GitHub cannot merge: the merge request fails and the PR stays open.
    await fx.writeState(openPr({ mergeFails: true }))

    const previousExit = process.exitCode
    try {
      await withFakeGh(fx, () =>
        runWorktreesCommand({ kind: "close", worktree: fx.wt, base: "main", changes: [], message: "feat: blocked work" }, fx.fixture.root),
      )
      throw new Error("the close should have failed")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/did not merge PR #7|unmergeable/)
    }
    process.exitCode = previousExit

    // The PR and the local branch are unchanged; retry reconciles by receipt
    // instead of duplicating effects.
    const state = await fx.readState()
    expect(state?.state).toBe("OPEN")
    expect(state?.mergeCalls ?? 0).toBe(0)
    expect(await originMain(fx)).toBe(originMainBefore)
    expect((await fx.fixture.git(["rev-parse", "feat/x"])).trim()).toBe(sourceTip)
    // The journal stays pending for recovery.
    expect(await listPendingOperations(fx.commonDir)).toHaveLength(1)
  })

  test("a pending hosted journal refuses close before sync or archive mutate anything", async () => {
    // The recovery contract (feature-close): pending effects that changed
    // checkout/index state are reconciled before ordinary fresh-operation
    // preflight. A close with a selected archive input must therefore refuse
    // at the top of its effect — no sync merge, no archive commit — while the
    // journal and its evidence stay intact for explicit recovery.
    const fx = await createHostedFixture()
    const wt = fx.wt
    // A selected archive input with complete tasks (it would archive cleanly
    // if the refusal failed to fire) and source work the sync would carry.
    await fx.fixture.write(wt, "openspec/changes/add-widget/proposal.md", "# Proposal: Add widget\n")
    await fx.fixture.write(wt, "openspec/changes/add-widget/tasks.md", "# Tasks\n\n- [x] one\n- [x] two\n")
    await fx.fixture.write(wt, "feature.txt", "branch work\n")
    await fx.fixture.commitAll("feat: branch work", wt)
    const sourceBefore = (await fx.fixture.git(["rev-parse", "feat/x"])).trim()
    // The base advances after the fork, so an unguarded sync WOULD merge here.
    await fx.fixture.write(fx.fixture.root, "base-file.txt", "base work\n")
    await fx.fixture.commitAll("chore: base advance")
    const baseAfterAdvance = (await fx.fixture.git(["rev-parse", "main"])).trim()

    // The interrupted hosted close: nothing acknowledged, the remote branch
    // never pushed, and a hosted merge commit recorded that main does not
    // contain — every step undecided.
    await fx.writeState(openPr({ state: "MERGED", mergeCommit: sourceBefore }))
    const created = await createOperation(fx.commonDir, {
      kind: "close",
      intent: { hosted: true, checkout: wt, branch: "feat/x", base: "main", prNumber: 7, remote: "origin", subject: "feat: branch work (#7)", body: "", sourceTip: sourceBefore },
      steps: ["branch-push", "hosted-merge", "base-advancement"],
    })
    if (!created.ok) throw new Error("setup failed")
    const operationId = created.operation.operationId
    await recordStepIntent(fx.commonDir, operationId, "branch-push", { remote: "origin", remoteRef: "feat/x", oid: sourceBefore })
    await recordStepIntent(fx.commonDir, operationId, "hosted-merge", { prNumber: 7, subject: "feat: branch work (#7)", body: "" })
    await recordStepIntent(fx.commonDir, operationId, "base-advancement", { base: "main", mergeCommit: sourceBefore })

    const previousExit = process.exitCode
    await expect(
      withFakeGh(fx, () =>
        runWorktreesCommand({ kind: "close", worktree: wt, base: "main", changes: ["add-widget"], message: "feat: second try" }, fx.fixture.root),
      ),
    ).rejects.toThrow(/undecided steps/)
    process.exitCode = previousExit

    // The source HEAD is untouched: no sync merge and no archive commit.
    expect((await fx.fixture.git(["rev-parse", "feat/x"])).trim()).toBe(sourceBefore)
    // The selected archive input was not archived: still active, files intact.
    expect(await Bun.file(join(wt, "openspec/changes/add-widget/proposal.md")).text()).toContain("Add widget")
    const active = await import("../src/checkout-openspec").then((m) => m.readCheckoutActiveChanges(wt))
    expect(active.kind).toBe("known")
    if (active.kind === "known") expect(active.value.some((change) => change.changeId === "add-widget")).toBe(true)
    expect((await execFile("git", ["status", "--porcelain"], { cwd: wt })).stdout).toBe("")
    // The base stayed where the external advance left it.
    expect((await fx.fixture.git(["rev-parse", "main"])).trim()).toBe(baseAfterAdvance)
    // The recovery evidence survives untouched.
    expect(await listPendingOperations(fx.commonDir)).toEqual([operationId])
  })

  test("an interrupted hosted close blocks a later local close instead of duplicating the merge", async () => {
    // The dangerous interruption: GitHub merged the PR but the base
    // advancement never completed. A following local close must reconcile the
    // pending journal first — never land a second squash commit on the base.
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "hosted work\n")
    await fx.fixture.commitAll("feat: hosted work", fx.wt)
    await fx.writeState(openPr())
    await withFakeGh(fx, () =>
      runWorktreesCommand({ kind: "close", worktree: fx.wt, base: "main", changes: [], message: "feat: hosted work (#7)" }, fx.fixture.root),
    )
    const state = await fx.readState()
    expect(state?.state).toBe("MERGED")
    const mergeSha = state?.mergeCommit
    if (mergeSha === undefined) throw new Error("setup failed")
    const preMergeMain = (await fx.fixture.git(["rev-parse", `${mergeSha}~1`])).trim()

    // Simulate the interrupted retry: every step journaled but unacknowledged,
    // with the local base left behind the hosted commit.
    const tip = (await fx.fixture.git(["rev-parse", "feat/x"])).trim()
    const created = await createOperation(fx.commonDir, {
      kind: "close",
      intent: { hosted: true, checkout: fx.wt, branch: "feat/x", base: "main", prNumber: 7, remote: "origin", subject: "feat: hosted work (#7)", body: "", sourceTip: tip },
      steps: ["branch-push", "hosted-merge", "base-advancement"],
    })
    if (!created.ok) throw new Error("setup failed")
    const operationId = created.operation.operationId
    await recordStepIntent(fx.commonDir, operationId, "branch-push", { remote: "origin", remoteRef: "feat/x", oid: tip })
    await recordStepIntent(fx.commonDir, operationId, "hosted-merge", { prNumber: 7, subject: "feat: hosted work (#7)", body: "" })
    await recordStepIntent(fx.commonDir, operationId, "base-advancement", { base: "main", mergeCommit: mergeSha })
    await execFile("git", ["update-ref", "refs/heads/main", preMergeMain], { cwd: fx.fixture.root })

    // A plain local close (--local-landing) must refuse: the hosted landing's
    // base advancement is still undecided, and landing locally would diverge
    // local and remote main.
    const previousExit = process.exitCode
    await expect(
      withFakeGh(fx, () =>
        runWorktreesCommand({ kind: "close", worktree: fx.wt, base: "main", changes: [], message: "feat: second try", localLanding: true }, fx.fixture.root),
      ),
    ).rejects.toThrow(/undecided steps/)
    process.exitCode = previousExit

    // No second squash commit: the local base stayed where recovery left it.
    expect(await localMain(fx)).toBe(preMergeMain)
    expect(await originMain(fx)).toBe(mergeSha)
    // The journal survives for explicit recovery.
    expect(await listPendingOperations(fx.commonDir)).toEqual([operationId])
  })

  test("the operator's local-landing decision keeps every step local (design D5)", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "operator work\n")
    await fx.fixture.commitAll("feat: operator work", fx.wt)
    const originMainBefore = await originMain(fx)
    await fx.writeState(openPr())

    const review = (await reviewOperation({ action: "close", checkout: fx.wt, base: "main", commonDir: fx.commonDir })).review
    if (!review.available) throw new Error("setup failed")
    const events: CloseEvent[] = []
    const result = await withFakeGhReturning(
      fx,
      () =>
        driveClose({ kind: "close", worktree: fx.wt, base: "main", changes: [] }, fx.commonDir, review, {
          onEvent: (event) => events.push(event),
          resolveLanding: (proposal): Promise<CloseLandingDecision> => Promise.resolve({ kind: "local", message: proposal.message }),
        }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.hostedMerge).toBeUndefined()
    expect(result.value.pullRequest?.number).toBe(7)
    expect(result.value.steps.join(" ")).toContain("landed")
    expect(await localMain(fx)).not.toBe(originMainBefore)
    expect(await originMain(fx)).toBe(originMainBefore)
    expect((await fx.readState())?.mergeCalls ?? 0).toBe(0)
  })

  test("the operator's hosted acceptance lands through GitHub (design D5)", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "operator work\n")
    await fx.fixture.commitAll("feat: operator work", fx.wt)
    await fx.writeState(openPr())

    const review = (await reviewOperation({ action: "close", checkout: fx.wt, base: "main", commonDir: fx.commonDir })).review
    if (!review.available) throw new Error("setup failed")
    const events: CloseEvent[] = []
    const result = await withFakeGhReturning(
      fx,
      () =>
        driveClose({ kind: "close", worktree: fx.wt, base: "main", changes: [] }, fx.commonDir, review, {
          onEvent: (event) => events.push(event),
          resolveLanding: (proposal): Promise<CloseLandingDecision> => Promise.resolve({ kind: "hosted", message: proposal.message }),
        }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.hostedMerge?.prNumber).toBe(7)
    expect(result.value.hostedMerge?.baseAdvanced).toBe(true)
    const mergeSha = (await fx.readState())?.mergeCommit
    if (mergeSha === undefined) throw new Error("the fake gh recorded no merge commit")
    expect(await localMain(fx)).toBe(mergeSha)
    expect(await originMain(fx)).toBe(mergeSha)
    // The hosted sub-phases narrate each remote step.
    const phases = events.filter((event) => event.type === "squash-phase").map((event) => (event as { phase: string }).phase)
    expect(phases).toContain("pushing-branch")
    expect(phases).toContain("requesting-merge")
    expect(phases).toContain("catching-up-base")
  })
})

/** Runs `fn` with the fake gh active and returns its value. */
async function withFakeGhReturning<T>(fx: HostedFixture, fn: () => Promise<T>): Promise<T> {
  let value: T | undefined
  await withFakeGh(fx, async () => {
    value = await fn()
  })
  return value as T
}

// ── recovery reconciles the remote steps by receipt (task 4.1) ───────────

describe("hosted close recovery", () => {
  test("crash after the push: --continue resumes with the merge without re-pushing", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "recovered work\n")
    await fx.fixture.commitAll("feat: recovered work", fx.wt)
    const tip = (await fx.fixture.git(["rev-parse", "feat/x"])).trim()
    // The crash state: the branch push completed, the merge request was never
    // issued, and the journal holds the frozen inputs with no acknowledgements.
    await execFile("git", ["push", "origin", "feat/x:feat/x"], { cwd: fx.wt })
    const remoteTip = (await execFile("git", ["--git-dir", fx.origin, "rev-parse", "refs/heads/feat/x"], { cwd: fx.fixture.root })).stdout.trim()
    expect(remoteTip).toBe(tip)
    await fx.writeState(openPr())
    const created = await createOperation(fx.commonDir, {
      kind: "close",
      intent: { hosted: true, checkout: fx.wt, branch: "feat/x", base: "main", prNumber: 7, remote: "origin", subject: "feat: recovered work (#7)", body: "- detail", sourceTip: tip },
      steps: ["branch-push", "hosted-merge", "base-advancement"],
    })
    if (!created.ok) throw new Error("setup failed")
    const operationId = created.operation.operationId
    await recordStepIntent(fx.commonDir, operationId, "branch-push", { remote: "origin", remoteRef: "feat/x", oid: tip })
    await acknowledgeStep(fx.commonDir, operationId, "branch-push", { remote: "origin", remoteRef: "feat/x", oid: tip })
    await recordStepIntent(fx.commonDir, operationId, "hosted-merge", { prNumber: 7, subject: "feat: recovered work (#7)", body: "- detail" })

    const capture = stdoutCapture()
    capture.start()
    try {
      await withFakeGh(fx, () => runWorktreesCommand({ kind: "recover", operationId, consent: "continue" }, fx.fixture.root))
    } finally {
      capture.stop()
    }

    // The merge was requested exactly once, with the frozen message; the base
    // caught up; the journal was released.
    const state = await fx.readState()
    expect(state?.state).toBe("MERGED")
    expect(state?.mergeCalls).toBe(1)
    const mergeSha = state?.mergeCommit
    if (mergeSha === undefined) throw new Error("the fake gh recorded no merge commit")
    expect(await localMain(fx)).toBe(mergeSha)
    expect(await originMain(fx)).toBe(mergeSha)
    expect((await fx.fixture.git(["log", "-1", "--format=%s", "main"])).trim()).toBe("feat: recovered work (#7)")
    // The already-pushed branch was recognized, never re-pushed: the remote
    // branch tip still equals the pinned OID.
    expect((await execFile("git", ["--git-dir", fx.origin, "rev-parse", "refs/heads/feat/x"], { cwd: fx.fixture.root })).stdout.trim()).toBe(tip)
    expect(await listPendingOperations(fx.commonDir)).toEqual([])
    expect(capture.lines.join("")).toContain("hosted landing resumed and completed")
  })

  test("an uncertain merge whose PR already shows MERGED is reconciled without a second merge request", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "uncertain work\n")
    await fx.fixture.commitAll("feat: uncertain work", fx.wt)
    // First the merge really happened; then a retried operation finds the
    // receipt: the recorded mergeCommit is the completed step.
    await fx.writeState(openPr())
    await withFakeGh(fx, () =>
      runWorktreesCommand({ kind: "close", worktree: fx.wt, base: "main", changes: [], message: "feat: uncertain work (#7)" }, fx.fixture.root),
    )
    const state = await fx.readState()
    expect(state?.mergeCalls).toBe(1)
    const mergeSha = state?.mergeCommit
    if (mergeSha === undefined) throw new Error("the fake gh recorded no merge commit")
    const tip = (await fx.fixture.git(["rev-parse", "feat/x"])).trim()
    // A fresh journal whose every step is unacknowledged, mirroring a retry
    // after an uncertain merge outcome.
    const created = await createOperation(fx.commonDir, {
      kind: "close",
      intent: { hosted: true, checkout: fx.wt, branch: "feat/x", base: "main", prNumber: 7, remote: "origin", subject: "feat: uncertain work (#7)", body: "", sourceTip: tip },
      steps: ["branch-push", "hosted-merge", "base-advancement"],
    })
    if (!created.ok) throw new Error("setup failed")
    const operationId = created.operation.operationId
    await recordStepIntent(fx.commonDir, operationId, "branch-push", { remote: "origin", remoteRef: "feat/x", oid: tip })
    await recordStepIntent(fx.commonDir, operationId, "hosted-merge", { prNumber: 7, subject: "feat: uncertain work (#7)", body: "" })
    await recordStepIntent(fx.commonDir, operationId, "base-advancement", { base: "main", mergeCommit: mergeSha })

    await withFakeGh(fx, () => runWorktreesCommand({ kind: "recover", operationId, consent: "continue" }, fx.fixture.root))

    // Every step was verified by receipt; GitHub was not asked to merge again.
    expect((await fx.readState())?.mergeCalls).toBe(1)
    expect(await listPendingOperations(fx.commonDir)).toEqual([])
    expect(await localMain(fx)).toBe(mergeSha)
  })

  test("a merged PR whose squash commit is absent from the base lineage stops with guidance (task 4.2)", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "work\n")
    await fx.fixture.commitAll("feat: work", fx.wt)
    const tip = (await fx.fixture.git(["rev-parse", "feat/x"])).trim()
    const baseTip = (await fx.fixture.git(["rev-parse", "main"])).trim()
    // Hosting says MERGED with a merge commit that no Git evidence supports.
    await fx.writeState(openPr({ state: "MERGED", mergeCommit: tip }))
    const created = await createOperation(fx.commonDir, {
      kind: "close",
      intent: { hosted: true, checkout: fx.wt, branch: "feat/x", base: "main", prNumber: 7, remote: "origin", subject: "feat: work (#7)", body: "", sourceTip: tip },
      steps: ["branch-push", "hosted-merge", "base-advancement"],
    })
    if (!created.ok) throw new Error("setup failed")
    const operationId = created.operation.operationId
    await recordStepIntent(fx.commonDir, operationId, "branch-push", { remote: "origin", remoteRef: "feat/x", oid: tip })
    await recordStepIntent(fx.commonDir, operationId, "hosted-merge", { prNumber: 7, subject: "feat: work (#7)", body: "" })
    await recordStepIntent(fx.commonDir, operationId, "base-advancement", { base: "main", mergeCommit: tip })

    const previousExit = process.exitCode
    const capture = stdoutCapture()
    capture.start()
    try {
      await withFakeGh(fx, () => runWorktreesCommand({ kind: "recover", operationId, consent: "continue" }, fx.fixture.root))
    } finally {
      capture.stop()
    }
    // The contradictory evidence stopped the replay with guidance; the local
    // base was not touched and the journal survives for inspection.
    expect(process.exitCode).toBe(1)
    process.exitCode = previousExit
    expect(capture.lines.join("")).toContain("contradictory hosting/Git evidence")
    expect(await localMain(fx)).toBe(baseTip)
    expect(await listPendingOperations(fx.commonDir)).toEqual([operationId])
  })
})

// ── the kind-specific reality probes (task 1.1) ─────────────────────────

describe("hosted close reconciliation probes", () => {
  function hostedOperation(fx: HostedFixture, tip: string, steps: string[]) {
    return createOperation(fx.commonDir, {
      kind: "close",
      intent: { hosted: true, checkout: fx.wt, branch: "feat/x", base: "main", prNumber: 7, remote: "origin", sourceTip: tip },
      steps,
    }).then((created) => {
      if (!created.ok) throw new Error("setup failed")
      return created.operation.operationId
    })
  }

  test("branch-push is verified when the remote holds the pinned OID and pending otherwise", async () => {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "work\n")
    await fx.fixture.commitAll("feat: work", fx.wt)
    const tip = (await fx.fixture.git(["rev-parse", "feat/x"])).trim()
    const operationId = await hostedOperation(fx, tip, ["branch-push"])
    await recordStepIntent(fx.commonDir, operationId, "branch-push", { remote: "origin", remoteRef: "feat/x", oid: tip })
    const read = await import("../src/operation-journal").then((m) => m.readOperation(fx.commonDir, operationId))
    if (read.status !== "found") throw new Error("setup failed")
    const step = read.value.steps[0]!
    const record = read.value

    // Not pushed yet: pending.
    const before = await reconcileStepReality(step, record, fx.fixture.root)
    expect(before.finding).toBe("pending")

    // Pushed: the receipt verifies without any effect.
    await execFile("git", ["push", "origin", "feat/x:feat/x"], { cwd: fx.wt })
    await withFakeGh(fx, async () => {
      const after = await reconcileStepReality(step, record, fx.fixture.root)
      expect(after.finding).toBe("verified")
    })
  })

  test("hosted-merge reconciles by the PR's own state: MERGED verified, OPEN pending, CLOSED unexplained", async () => {
    const fx = await createHostedFixture()
    const tip = (await fx.fixture.git(["rev-parse", "main"])).trim()
    const operationId = await hostedOperation(fx, tip, ["hosted-merge"])
    await recordStepIntent(fx.commonDir, operationId, "hosted-merge", { prNumber: 7, subject: "s", body: "" })
    const read = await import("../src/operation-journal").then((m) => m.readOperation(fx.commonDir, operationId))
    if (read.status !== "found") throw new Error("setup failed")
    const step = read.value.steps[0]!
    const record = read.value

    await fx.writeState(openPr())
    await withFakeGh(fx, async () => {
      expect((await reconcileStepReality(step, record, fx.fixture.root)).finding).toBe("pending")
    })

    await fx.writeState(openPr({ state: "MERGED", mergeCommit: tip }))
    await withFakeGh(fx, async () => {
      const merged = await reconcileStepReality(step, record, fx.fixture.root)
      expect(merged.finding).toBe("verified")
      if (merged.finding === "verified") {
        expect((merged.evidence as { mergeCommit?: string }).mergeCommit).toBe(tip)
      }
    })

    await fx.writeState(openPr({ state: "CLOSED" }))
    await withFakeGh(fx, async () => {
      const closed = await reconcileStepReality(step, record, fx.fixture.root)
      expect(closed.finding).toBe("unexplained")
    })
  })

  test("base-advancement is verified when the base contains the hosted squash commit", async () => {
    const fx = await createHostedFixture()
    const tip = (await fx.fixture.git(["rev-parse", "main"])).trim()
    const operationId = await hostedOperation(fx, tip, ["base-advancement"])
    await recordStepIntent(fx.commonDir, operationId, "base-advancement", { base: "main", mergeCommit: tip })
    const read = await import("../src/operation-journal").then((m) => m.readOperation(fx.commonDir, operationId))
    if (read.status !== "found") throw new Error("setup failed")
    const step = read.value.steps[0]!
    const record = read.value

    const verified = await reconcileStepReality(step, record, fx.fixture.root)
    expect(verified.finding).toBe("verified")

    // A different recorded commit the base does not contain: pending, never
    // guessed done.
    const pendingStep = { id: "base-advancement", intent: { base: "main", mergeCommit: "0".repeat(40) } }
    const missing = await reconcileStepReality(pendingStep as typeof step, record, fx.fixture.root)
    expect(missing.finding).toBe("pending")
  })
})

// ── hosted landing step outcomes via injected effects (task 4.2) ─────────

describe("hosted landing step outcomes (injected effects)", () => {
  /** A fixture with a committed branch, ready for a hosted landing attempt. */
  async function readyFixture(): Promise<{ fx: HostedFixture; sourceTip: string; baseTip: string }> {
    const fx = await createHostedFixture()
    await fx.fixture.write(fx.wt, "feature.txt", "hosted work\n")
    await fx.fixture.commitAll("feat: hosted work", fx.wt)
    const sourceTip = (await fx.fixture.git(["rev-parse", "feat/x"])).trim()
    const baseTip = (await fx.fixture.git(["rev-parse", "main"])).trim()
    return { fx, sourceTip, baseTip }
  }

  test("a closed PR stops at the merge step without touching the base or re-pushing", async () => {
    const { fx, sourceTip, baseTip } = await readyFixture()
    // The receipt reports the branch already published, so no push is issued.
    const result = await landViaGitHub({
      checkout: fx.wt,
      branch: "feat/x",
      base: "main",
      commonDir: fx.commonDir,
      prNumber: 7,
      message: "feat: hosted work",
      effects: { remoteTip: async () => sourceTip, readMergeState: async () => ({ state: "CLOSED" }) },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/CLOSED/)
    // The branch was never actually pushed, because the receipt said it was.
    const remoteBranch = await execFile("git", ["--git-dir", fx.origin, "rev-parse", "refs/heads/feat/x"], { cwd: fx.fixture.root, allowFailure: true })
    expect(remoteBranch.exitCode).not.toBe(0)
    expect(await localMain(fx)).toBe(baseTip)
    expect(await originMain(fx)).toBe(baseTip)
    expect(await listPendingOperations(fx.commonDir)).toHaveLength(1)
  })

  test("an unreadable PR state stops before any merge request is issued", async () => {
    const { fx, sourceTip, baseTip } = await readyFixture()
    const result = await landViaGitHub({
      checkout: fx.wt,
      branch: "feat/x",
      base: "main",
      commonDir: fx.commonDir,
      prNumber: 7,
      message: "feat: hosted work",
      effects: { remoteTip: async () => sourceTip, readMergeState: async () => ({ reason: "network unreachable" }) },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("network unreachable")
    expect(await localMain(fx)).toBe(baseTip)
    expect(await listPendingOperations(fx.commonDir)).toHaveLength(1)
  })

  test("a base already containing the hosted commit is acknowledged without a second advancement", async () => {
    const { fx, sourceTip, baseTip } = await readyFixture()
    const result = await landViaGitHub({
      checkout: fx.wt,
      branch: "feat/x",
      base: "main",
      commonDir: fx.commonDir,
      prNumber: 7,
      message: "feat: hosted work",
      effects: { remoteTip: async () => sourceTip, readMergeState: async () => ({ state: "MERGED", mergeCommit: baseTip }) },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.facts.baseAdvanced).toBe(false)
    expect(result.facts.mergeSha).toBe(baseTip)
    expect(result.narration.join("\n")).toContain("already contained the hosted squash commit")
    expect(await localMain(fx)).toBe(baseTip)
    expect(await listPendingOperations(fx.commonDir)).toEqual([])
  })

  test("a local base with local-only commits cannot fast-forward and stops with remediation", async () => {
    const { fx, sourceTip, baseTip } = await readyFixture()
    const sourceTree = (await fx.fixture.git(["rev-parse", "feat/x^{tree}"])).trim()
    // GitHub's squash commit: the source tree on top of the published base.
    const hosted = (await execFile("git", ["commit-tree", sourceTree, "-p", baseTip, "-m", "feat: hosted work (#7)"], { cwd: fx.fixture.root })).stdout.trim()
    await execFile("git", ["push", "origin", `${hosted}:refs/heads/main`], { cwd: fx.fixture.root })
    // The local base gains a commit of its own, so it can no longer fast-forward.
    await fx.fixture.write(fx.fixture.root, "local-only.txt", "local\n")
    await fx.fixture.commitAll("chore: local only")
    const localOnly = (await fx.fixture.git(["rev-parse", "main"])).trim()
    expect(localOnly).not.toBe(baseTip)

    const result = await landViaGitHub({
      checkout: fx.wt,
      branch: "feat/x",
      base: "main",
      commonDir: fx.commonDir,
      prNumber: 7,
      message: "feat: hosted work",
      effects: { remoteTip: async () => sourceTip, readMergeState: async () => ({ state: "MERGED", mergeCommit: hosted }) },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/local-only commits|fast-forward/)
    // Neither base moved: the divergent local history is preserved for review.
    expect(await localMain(fx)).toBe(localOnly)
    expect(await originMain(fx)).toBe(hosted)
    expect(await listPendingOperations(fx.commonDir)).toHaveLength(1)
  })
})

// ── hosted operation inputs (recovery reconstruction) ────────────────────

describe("hosted operation inputs", () => {
  test("isHostedCloseOperation matches only hosted close records", async () => {
    const fx = await createHostedFixture()
    const hosted = await createOperation(fx.commonDir, { kind: "close", intent: { hosted: true }, steps: ["branch-push"] })
    const plain = await createOperation(fx.commonDir, { kind: "close", intent: {}, steps: ["candidate"] })
    const push = await createOperation(fx.commonDir, { kind: "push", intent: { hosted: true }, steps: ["push"] })
    if (!hosted.ok || !plain.ok || !push.ok) throw new Error("setup failed")
    expect(isHostedCloseOperation(hosted.operation)).toBe(true)
    expect(isHostedCloseOperation(plain.operation)).toBe(false)
    expect(isHostedCloseOperation(push.operation)).toBe(false)
  })

  test("hostedOperationInputs replays the frozen reviewed message, not regenerated text", async () => {
    const fx = await createHostedFixture()
    const created = await createOperation(fx.commonDir, {
      kind: "close",
      intent: { hosted: true, checkout: fx.wt, branch: "feat/x", base: "main", prNumber: 7, remote: "origin", subject: "stale subject", body: "stale body" },
      steps: ["branch-push", "hosted-merge", "base-advancement"],
    })
    if (!created.ok) throw new Error("setup failed")
    const operationId = created.operation.operationId
    await recordStepIntent(fx.commonDir, operationId, "hosted-merge", { prNumber: 7, subject: "feat: frozen (#7)", body: "- frozen detail" })

    const inputs = await hostedOperationInputs(fx.commonDir, operationId)
    expect(inputs?.message).toBe("feat: frozen (#7)\n- frozen detail")
    expect(inputs?.prNumber).toBe(7)
    expect(inputs?.branch).toBe("feat/x")
    expect(inputs?.base).toBe("main")
    expect(inputs?.remote).toBe("origin")
    expect(inputs?.checkout).toBe(fx.wt)
    expect(inputs?.existingOperationId).toBe(operationId)
  })

  test("hostedOperationInputs refuses a record without the frozen landing facts", async () => {
    const fx = await createHostedFixture()
    const created = await createOperation(fx.commonDir, { kind: "close", intent: { hosted: true }, steps: ["branch-push"] })
    if (!created.ok) throw new Error("setup failed")
    expect(await hostedOperationInputs(fx.commonDir, created.operation.operationId)).toBeUndefined()
    expect(await hostedOperationInputs(fx.commonDir, "not-a-real-operation")).toBeUndefined()
  })
})
