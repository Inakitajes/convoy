import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { currentHead, execFile, resolveCommit } from "../src/git"
import { finalizeNetZeroInterval, isNetZeroInterval, runFinalization, type FinalizationJournal } from "../src/finalization/compact"
import { boundedCommitAsOperator, BoundedCommitError } from "../src/finalization/executor"
import { verifyRunInterval } from "../src/finalization/interval"
import { acquireMutationLease, LeaseUnavailableError, mutationLeaseHeld } from "../src/finalization/lease"
import { createRefIfAbsent, gitCommonDir, ledgerTipRef, preCompactionRef, refExists, resolveRef } from "../src/finalization/refs"
import { verifyNotPublished } from "../src/finalization/remote"
import type { CommitLedgerEntry, RunBoundary } from "../src/finalization/types"

const dirs: string[] = []
const runID = "20260905-120000-compact"
const legacyRunID = "20260905-130000-l1xy"
const convoyEnv = { GIT_AUTHOR_NAME: "convoy", GIT_AUTHOR_EMAIL: "convoy@local", GIT_COMMITTER_NAME: "convoy", GIT_COMMITTER_EMAIL: "convoy@local" }
let savedHome: string | undefined

// runFinalization writes the cleanup-surviving index under
// <convoy-home>/run-records, so isolate the home or a real record leaks into
// other tests that read the index.
beforeAll(async () => {
  savedHome = process.env.CONVOY_HOME
  const home = await mkdtemp(join(tmpdir(), "convoy-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home
})

afterAll(async () => {
  if (savedHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = savedHome
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function git(args: string[], cwd: string, env: Record<string, string> = {}) {
  return await execFile("git", args, { cwd, env })
}

/** A repo with one operator base commit on main and a repo-local operator identity. */
async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-compact-"))
  dirs.push(dir)
  await git(["init", "-q", "-b", "main"], dir)
  await git(["config", "user.name", "Test Operator"], dir)
  await git(["config", "user.email", "op@example.com"], dir)
  await writeFile(join(dir, "base.txt"), "base\n")
  await git(["add", "-A"], dir)
  await git(["commit", "-qm", "base"], dir, convoyEnv)
  return dir
}

/** One run-linked convoy commit, exactly the shape step-commit writes. */
async function runCommit(dir: string, file: string, content: string, step: string, id = runID) {
  await writeFile(join(dir, file), content)
  await git(["add", "-A"], dir)
  await git(["commit", "-qm", `convoy(${step}): ${file}\n\nConvoy-Run: ${id}`], dir, convoyEnv)
}

function boundaryFor(dir: string, startHead: string, branch = "main"): RunBoundary {
  return { schemaVersion: 1, worktreeDir: dir, branch, startHead, commonDir: "", includeDirty: false, recordedAt: 1 }
}

/** Builds truthful ledger entries for every run-linked commit above startHead (parents supply the before endpoints). */
async function ledgerFor(dir: string, startHead: string, id = runID): Promise<CommitLedgerEntry[]> {
  const entries: CommitLedgerEntry[] = []
  const log = await git(["log", "--reverse", "--format=%H%x1f%s%x1f%P", `${startHead}..HEAD`], dir)
  for (const line of log.stdout.split("\n").filter(Boolean)) {
    const [sha = "", subject = "", parents = ""] = line.split("\x1f")
    const body = (await git(["log", "--format=%B", "-1", sha], dir)).stdout
    if (!body.includes(`Convoy-Run: ${id}`)) continue // not this run's commit: unledgered
    const step = /convoy\(([^)]*)\)/.exec(subject)?.[1] ?? "step"
    const tree = await git(["rev-parse", `${sha}^{tree}`], dir)
    entries.push({ schemaVersion: 1, mode: "phase", step, beforeSha: parents.trim() || startHead, afterSha: sha, afterTree: tree.stdout.trim(), recordedAt: 1 })
  }
  return entries
}

describe("create-only protected refs", () => {
  test("creation succeeds once and refuses to overwrite existing evidence", async () => {
    const dir = await repo()
    const sha = (await currentHead(dir))!
    await createRefIfAbsent(preCompactionRef(runID), sha, dir)
    expect(await resolveRef(preCompactionRef(runID), dir)).toBe(sha)
    expect(createRefIfAbsent(preCompactionRef(runID), sha, dir)).rejects.toThrow()
    // The original value survives the refused write.
    expect(await resolveRef(preCompactionRef(runID), dir)).toBe(sha)
  })

  test("separate runs never overwrite each other's namespaces", async () => {
    const dir = await repo()
    const sha = (await currentHead(dir))!
    await createRefIfAbsent(preCompactionRef("run-a"), sha, dir)
    await createRefIfAbsent(preCompactionRef("run-b"), sha, dir)
    expect(await refExists(preCompactionRef("run-a"), dir)).toBe(true)
    expect(await refExists(preCompactionRef("run-b"), dir)).toBe(true)
  })

  test("the git common dir resolves across the repository", async () => {
    const dir = await repo()
    expect((await gitCommonDir(dir))?.endsWith(".git")).toBe(true)
  })
})

describe("repository mutation lease", () => {
  test("serializes holders and frees on release", async () => {
    const dir = await repo()
    const common = (await gitCommonDir(dir))!
    const first = await acquireMutationLease(common)
    await expect(acquireMutationLease(common, { timeoutMs: 200 })).rejects.toBeInstanceOf(LeaseUnavailableError)
    await first.release()
    const second = await acquireMutationLease(common)
    await second.release()
  })

  test("a stale diagnostic sidecar from a dead holder never blocks acquisition", async () => {
    const dir = await repo()
    const common = (await gitCommonDir(dir))!
    await mkdir(join(common, "convoy"), { recursive: true })
    // A crashed holder leaves its sidecar behind; the kernel lock itself was
    // released on death, so acquisition must succeed without any userspace
    // steal logic touching a live holder's lease.
    await writeFile(join(common, "convoy", "mutation-lease.json"), JSON.stringify({ holder: "dead", pid: 999_999_999, acquiredAt: Date.now() }))
    const lease = await acquireMutationLease(common, { timeoutMs: 500 })
    expect(await mutationLeaseHeld(common)).toBe(true)
    await lease.release()
    expect(await mutationLeaseHeld(common)).toBe(false)
  })

  test("a holder killed without releasing (crashed coordinator) does not wedge the lease", async () => {
    const dir = await repo()
    const common = (await gitCommonDir(dir))!
    const child = Bun.spawn([
      process.execPath,
      "-e",
      `const { acquireMutationLease } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "finalization", "lease.ts"))});
       const lease = await acquireMutationLease(${JSON.stringify(common)});
       console.log("held");
       setInterval(() => {}, 1000);`,
    ])
    // Wait until the child actually holds the lease, then kill it mid-hold.
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    let sawHeld = false
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      output += decoder.decode(value)
      if (output.includes("held")) {
        sawHeld = true
        break
      }
    }
    expect(sawHeld).toBe(true)
    child.kill("SIGKILL")
    await child.exited

    // The kernel released the lock on death; acquisition proceeds immediately
    // without any userspace reclamation that could disturb a live holder.
    const lease = await acquireMutationLease(common, { timeoutMs: 500 })
    expect(await mutationLeaseHeld(common)).toBe(true)
    await lease.release()
  }, 15_000)

  test("a contender refused while another holds cannot disturb that holder's lease", async () => {
    // Deterministic regression for the takeover race: there is no userspace
    // steal step left, so a refused contender (B, delayed or not) can never
    // move or delete the lease A holds — C after B still sees A holding.
    const dir = await repo()
    const common = (await gitCommonDir(dir))!
    const a = await acquireMutationLease(common)
    await expect(acquireMutationLease(common, { timeoutMs: 1 })).rejects.toBeInstanceOf(LeaseUnavailableError)
    await expect(acquireMutationLease(common, { timeoutMs: 1 })).rejects.toBeInstanceOf(LeaseUnavailableError)
    // A still holds after B's and C's refused attempts.
    expect(await mutationLeaseHeld(common)).toBe(true)
    await a.release()
    const next = await acquireMutationLease(common, { timeoutMs: 500 })
    await next.release()
  })

  test("concurrent contenders cannot steal each other's lease while breaking a dead one", async () => {
    const dir = await repo()
    const common = (await gitCommonDir(dir))!
    await mkdir(join(common, "convoy"), { recursive: true })
    await writeFile(join(common, "convoy", "mutation-lease.json"), JSON.stringify({ holder: "dead", pid: 999_999_999, acquiredAt: Date.now() }))

    // Eight contenders race to break the same dead lease; exactly one may hold
    // the lease afterwards, and the losers' takeover attempts must not have
    // deleted the winner's lease.
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireMutationLease(common, { timeoutMs: 400 })),
    )
    const winners = attempts.filter((attempt) => attempt.status === "fulfilled")
    const losers = attempts.filter((attempt) => attempt.status === "rejected")
    expect(winners).toHaveLength(1)
    expect(losers.length).toBe(7)
    expect(losers.every((attempt) => (attempt as PromiseRejectedResult).reason instanceof LeaseUnavailableError)).toBe(true)

    // The surviving lease belongs to this process and still guards the repo.
    expect(await mutationLeaseHeld(common)).toBe(true)
    await expect(acquireMutationLease(common, { timeoutMs: 200 })).rejects.toBeInstanceOf(LeaseUnavailableError)

    // After the winner releases, the next contender acquires normally.
    await (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireMutationLease>>>).value.release()
    const next = await acquireMutationLease(common, { timeoutMs: 500 })
    await next.release()
    expect(await mutationLeaseHeld(common)).toBe(false)
  })
})

describe("bounded commit executor", () => {
  test("commits staged changes as the operator with no unsigned fallback", async () => {
    const dir = await repo()
    await writeFile(join(dir, "work.txt"), "work\n")
    await git(["add", "-A"], dir)
    const { sha } = await boundedCommitAsOperator("feat: do the work", dir)
    const show = await git(["show", "--format=%an%n%ae%n%s", "--name-only", sha], dir)
    expect(show.stdout).toContain("feat: do the work")
    // The operator identity is inherited from git config, not convoy's.
    expect(show.stdout).not.toContain("convoy@local")
    expect(show.stdout).toContain("work.txt")
  })

  test("refuses to commit files that look like secrets", async () => {
    const dir = await repo()
    await writeFile(join(dir, ".env"), "TOKEN=1\n")
    await git(["add", "-A"], dir)
    await expect(boundedCommitAsOperator("feat: leak", dir)).rejects.toThrow("look like they contain secrets")
  })

  test("a hanging commit hook is terminated at the deadline without advancing HEAD", async () => {
    // A detached coordinator must never hang on interactive signing or a hook:
    // the bounded executor closes stdin and kills the git process at the
    // deadline, preserving the staged work for a later attempt.
    const dir = await repo()
    const hook = join(dir, ".git", "hooks", "pre-commit")
    await writeFile(hook, "#!/bin/sh\nsleep 30\n")
    await chmod(hook, 0o755)
    await writeFile(join(dir, "work.txt"), "work\n")
    await git(["add", "-A"], dir)
    const before = (await currentHead(dir))!
    const started = Date.now()
    await expect(boundedCommitAsOperator("feat: hang", dir, { timeoutMs: 700 })).rejects.toThrow(/terminated after/)
    // The kill fires at the deadline, not after the hook's own sleep.
    expect(Date.now() - started).toBeLessThan(10_000)
    // The deadline is not interpreted as a successful no-op commit.
    expect(await currentHead(dir)).toBe(before)
    // The staged work is untouched, so a retry stays possible.
    expect((await git(["status", "--porcelain"], dir)).stdout.trim()).toContain("work.txt")
  }, 15_000)

  test("captures hook diagnostics when the commit is rejected", async () => {
    // A hook that rejects the commit must fail visibly with its diagnostics in
    // the outcome — no silent unsigned/unverified fallback.
    const dir = await repo()
    const hook = join(dir, ".git", "hooks", "pre-commit")
    await writeFile(hook, "#!/bin/sh\necho 'denied by local policy' >&2\nexit 1\n")
    await chmod(hook, 0o755)
    await writeFile(join(dir, "work.txt"), "work\n")
    await git(["add", "-A"], dir)
    const before = (await currentHead(dir))!
    const error = await boundedCommitAsOperator("feat: denied", dir).catch((caught) => caught)
    expect(error).toBeInstanceOf(BoundedCommitError)
    expect((error as BoundedCommitError).diagnostics).toContain("denied by local policy")
    expect(await currentHead(dir)).toBe(before)
  })
})

describe("verified run interval", () => {
  test("accepts a fully ledgered run interval with matching trailers", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design")
    await runCommit(dir, "b.txt", "b\n", "implement")
    const boundary = boundaryFor(dir, startHead)
    const ledger = await ledgerFor(dir, startHead)
    const interval = await verifyRunInterval(boundary, ledger, runID, dir)
    expect(interval.ok).toBe(true)
    if (interval.ok) expect(interval.commits.map((c) => c.step)).toEqual(["design", "implement"])
  })

  test("an independent operator commit refuses the whole interval", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design")
    // The operator commits between the two run commits; the truthful ledger
    // chains design(start→c1) and implement(c2→c3), so the chain check breaks.
    await writeFile(join(dir, "mine.txt"), "mine\n")
    await git(["add", "-A"], dir)
    await git(["commit", "-qm", "my own work"], dir)
    await runCommit(dir, "b.txt", "b\n", "implement")
    const interval = await verifyRunInterval(boundaryFor(dir, startHead), await ledgerFor(dir, startHead), runID, dir)
    expect(interval).toMatchObject({ ok: false, kind: "ledger-gap" })
  })

  test("a foreign run's commits above the boundary are not absorbed by authorship", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    // An earlier run's commit (convoy-authored, different trailer) is the only
    // commit in range; a chain-consistent ledger covering it still refuses on
    // the trailer, because authorship alone never proves run ownership.
    await runCommit(dir, "old.txt", "old\n", "earlier", "20260101-000000-older")
    const head = (await currentHead(dir))!
    const ledger: CommitLedgerEntry[] = [{ schemaVersion: 1, mode: "phase", step: "earlier", beforeSha: startHead, afterSha: head, recordedAt: 1 }]
    const interval = await verifyRunInterval(boundaryFor(dir, startHead), ledger, runID, dir)
    expect(interval).toMatchObject({ ok: false, kind: "trailer-mismatch" })
  })

  test("a commit in range without any ledger entry refuses as unaccounted", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "old.txt", "old\n", "earlier", "20260101-000000-older")
    await runCommit(dir, "new.txt", "new\n", "design")
    const head = (await currentHead(dir))!
    // A ledger entry that skips the foreign commit (defence in depth against
    // a buggy or tampered ledger): the git range walk catches it.
    const ledger: CommitLedgerEntry[] = [{ schemaVersion: 1, mode: "phase", step: "design", beforeSha: startHead, afterSha: head, recordedAt: 1 }]
    const interval = await verifyRunInterval(boundaryFor(dir, startHead), ledger, runID, dir)
    expect(interval).toMatchObject({ ok: false, kind: "unaccounted-commit" })
  })

  test("a merge inside the run interval refuses", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design")
    await git(["checkout", "-qb", "side"], dir)
    await runCommit(dir, "side.txt", "side\n", "design")
    await git(["checkout", "-q", "main"], dir)
    await git(["merge", "--no-ff", "-m", `convoy(design): merge\n\nConvoy-Run: ${runID}`, "side"], dir, convoyEnv)
    // A ledger chain that claims every range commit including the merge (a
    // buggy or tampered ledger): the merge-parent check must refuse regardless.
    const head = (await currentHead(dir))!
    const first = await resolveCommit(`${head}^`, dir)
    const second = await resolveCommit(`${head}^2`, dir)
    const ledger: CommitLedgerEntry[] = [
      { schemaVersion: 1, mode: "phase", step: "design", beforeSha: startHead, afterSha: first!, recordedAt: 1 },
      { schemaVersion: 1, mode: "phase", step: "design", beforeSha: first!, afterSha: second!, recordedAt: 2 },
      { schemaVersion: 1, mode: "phase", step: "design", beforeSha: second!, afterSha: head, recordedAt: 3 },
    ]
    const interval = await verifyRunInterval(boundaryFor(dir, startHead), ledger, runID, dir)
    expect(interval).toMatchObject({ ok: false, kind: "merge-commit" })
  })

  test("a missing ledger entry (unrecorded commit) refuses via the gap check", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design")
    const full = await ledgerFor(dir, startHead)
    // Second commit never got ledgered (crash before persist).
    await runCommit(dir, "b.txt", "b\n", "implement")
    const interval = await verifyRunInterval(boundaryFor(dir, startHead), full, runID, dir)
    expect(interval).toMatchObject({ ok: false, kind: "ledger-gap" })
  })

  test("a missing boundary skips instead of guessing a range", async () => {
    const dir = await repo()
    await runCommit(dir, "a.txt", "a\n", "design")
    const interval = await verifyRunInterval(undefined, [], runID, dir)
    expect(interval).toMatchObject({ ok: false, kind: "no-boundary" })
  })
})

describe("automatic compaction", () => {
  const compose = async () => "feat: add the thing"

  test("compacts two run commits into one operator-authored commit with the same tree", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design")
    await runCommit(dir, "b.txt", "b\n", "implement")
    const headTree = (await git(["rev-parse", "HEAD^{tree}"], dir)).stdout.trim()

    const record = await runFinalization({ runID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: await ledgerFor(dir, startHead), branch: "main", composeMessage: compose })
    expect(record.state).toBe("completed")
    expect(record.producedSha).toBeTruthy()

    // The produced commit: one parent (the run-start), the original tree, operator identity.
    const show = await git(["show", "--format=%P%n%T%n%an%n%ae%n%s", "--name-only", record.producedSha!], dir)
    const [parents = "", tree = "", author = "", email = "", subject = ""] = show.stdout.split("\n")
    expect(parents).toBe(startHead)
    expect(tree).toBe(headTree)
    expect(author).toBe("Test Operator")
    expect(email).toBe("op@example.com")
    expect(subject).toBe("feat: add the thing")
    expect(show.stdout).toContain("a.txt")
    expect(show.stdout).toContain("b.txt")
  })

  test("recovery refs and manifest survive compaction and stay inspectable", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design")
    await runCommit(dir, "b.txt", "b\n", "implement")
    const preHead = (await currentHead(dir))!

    await runFinalization({ runID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: await ledgerFor(dir, startHead), branch: "main", composeMessage: compose })

    expect(await resolveRef(preCompactionRef(runID), dir)).toBe(preHead)
    expect(await resolveRef(ledgerTipRef(runID, 0), dir)).toBeTruthy()
    expect(await resolveRef(ledgerTipRef(runID, 1), dir)).toBeTruthy()
    // The manifest names the endpoints and the protected refs.
    const common = (await gitCommonDir(dir))!
    const manifest = JSON.parse(await Bun.file(join(common, "convoy", "finalization", `${runID}.manifest.json`)).text())
    expect(manifest.preCompactionHead).toBe(preHead)
    expect(manifest.startHead).toBe(startHead)
    expect(manifest.replacedCommits).toHaveLength(2)
    // The original commits remain inspectable through the protected ref.
    const subjects = await git(["log", "--format=%s", `${preCompactionRef(runID)}`, "-2"], dir)
    expect(subjects.stdout).toContain("convoy(implement): b.txt")
  })

  test("a run with no commits skips without touching refs or the writer", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    const before = (await currentHead(dir))!
    const record = await runFinalization({ runID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: [], branch: "main", composeMessage: compose })
    expect(record.state).toBe("skipped")
    expect(await currentHead(dir)).toBe(before)
  })

  test("the index retains a run's exact persisted title — longer than any display cap, immune to prd rewrites (capability run-titles)", async () => {
    // A valid run id, so run discovery lists the index-only record after cleanup.
    const titledRunID = "20260905-125000-x1ab"
    const { readRunIndexEntry, listRuns } = await import("../src/runs")
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design", titledRunID)

    const runDir = await mkdtemp(join(tmpdir(), "convoy-compact-rundir-"))
    dirs.push(runDir)
    const exactTitle = "a persisted run title deliberately longer than one hundred and twenty characters so no persistence-side cap can quietly clip the durable evidence"
    await writeFile(join(runDir, "metadata.json"), JSON.stringify({ schemaVersion: 5, runID: titledRunID, title: exactTitle, control: { state: "running" }, phases: {} }))
    // The prompt document is rewritten (goal-loop reset) and then the workspace
    // is cleaned: the index title comes from the stored field, never the prd.
    await writeFile(join(runDir, "prd.md"), "# A completely different prompt now\n")

    const record = await runFinalization({ runID: titledRunID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: await ledgerFor(dir, startHead, titledRunID), branch: "main", runDir, composeMessage: compose })
    expect(record.state).toBe("completed")

    const entry = await readRunIndexEntry(titledRunID)
    expect(entry).toBeDefined()
    expect(entry!.title).toBe(exactTitle)

    // After the workspace is deleted, discovery still names the run; the runs
    // list applies its own display truncation to the exact stored value.
    await rm(runDir, { recursive: true, force: true })
    const runs = await listRuns()
    const listed = runs.find((run) => run.runID === titledRunID)
    expect(listed).toBeDefined()
    expect(listed!.title.length).toBeLessThanOrEqual(63)
    expect(listed!.title.endsWith("...")).toBe(true)
  })

  test("a legacy run named by its index is not renamed by a later prd rewrite (capability run-titles)", async () => {
    const { readRunIndexEntry } = await import("../src/runs")
    const { convoyHome } = await import("../src/workspace")
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design", legacyRunID)

    const runDir = await mkdtemp(join(tmpdir(), "convoy-compact-rundir-"))
    dirs.push(runDir)
    // A legacy run: metadata carries no persisted title, the cleanup-surviving
    // index already names the run, and the prompt document was since rewritten.
    await writeFile(join(runDir, "metadata.json"), JSON.stringify({ schemaVersion: 5, runID: legacyRunID, control: { state: "running" }, phases: {} }))
    await writeFile(join(runDir, "prd.md"), "# A rewritten prompt line\n")
    const indexDir = join(convoyHome(), "run-records")
    await mkdir(indexDir, { recursive: true })
    await writeFile(
      join(indexDir, `${legacyRunID}.json`),
      JSON.stringify({ schemaVersion: 1, runID: legacyRunID, title: "The original naming", state: "completed", manifestPath: "/x", recordedAt: 1, updatedAt: 2 }),
    )

    const record = await runFinalization({ runID: legacyRunID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: await ledgerFor(dir, startHead, legacyRunID), branch: "main", runDir, composeMessage: compose })
    expect(record.state).toBe("completed")

    // The earlier durable index title wins over the rewritten prd fallback.
    const entry = await readRunIndexEntry(legacyRunID)
    expect(entry).toBeDefined()
    expect(entry!.title).toBe("The original naming")
  })

  test("a legacy run without a durable boundary skips", async () => {
    const dir = await repo()
    await runCommit(dir, "a.txt", "a\n", "design")
    const before = (await currentHead(dir))!
    const record = await runFinalization({ runID, targetDir: dir, boundary: undefined, ledger: [], composeMessage: compose })
    expect(record.state).toBe("skipped")
    expect(await currentHead(dir)).toBe(before)
  })

  test("an interrupted operator commit blocks compaction and preserves every commit", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design")
    await writeFile(join(dir, "mine.txt"), "mine\n")
    await git(["add", "-A"], dir)
    await git(["commit", "-qm", "my own work"], dir)
    const before = (await currentHead(dir))!
    const record = await runFinalization({ runID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: await ledgerFor(dir, startHead), branch: "main", composeMessage: compose })
    expect(record.state).toBe("blocked")
    expect(record.reason).toMatch(/does not chain|not owned by this run|commit ledger ends at/)
    expect(await currentHead(dir)).toBe(before)
  })

  test("a net-zero run interval is removed without manufacturing an empty commit", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    // The run adds a file and then removes it again: zero net change.
    await runCommit(dir, "temp.txt", "temp\n", "design")
    await rm(join(dir, "temp.txt"))
    await git(["add", "-A"], dir)
    await git(["commit", "-qm", `convoy(design): clear\n\nConvoy-Run: ${runID}`], dir, convoyEnv)
    const before = (await currentHead(dir))!

    const interval = await verifyRunInterval(boundaryFor(dir, startHead), await ledgerFor(dir, startHead), runID, dir)
    if (!interval.ok) throw new Error("expected a verified interval")
    expect(isNetZeroInterval(interval)).toBe(true)

    const record = await runFinalization({ runID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: await ledgerFor(dir, startHead), branch: "main", composeMessage: compose })
    expect(record.state).toBe("completed")
    expect(record.producedSha).toBeUndefined()
    expect(record.reason).toContain("no content change")
    // The branch is back at the run start; the removed history stays protected.
    expect(await currentHead(dir)).toBe(startHead)
    expect(await resolveRef(preCompactionRef(runID), dir)).toBe(before)
  })

  test("a published replacement commit blocks compaction without touching history", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design")
    const before = (await currentHead(dir))!

    // Publish the run commit to a local bare remote.
    const remote = join(await mkdtemp(join(tmpdir(), "convoy-remote-")), "remote.git")
    dirs.push(remote)
    await git(["init", "-q", "--bare", "-b", "main", remote], dir)
    await git(["remote", "add", "origin", remote], dir)
    await git(["push", "-q", "origin", "main:main"], dir)

    const record = await runFinalization({ runID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: await ledgerFor(dir, startHead), branch: "main", composeMessage: compose })
    expect(record.state).toBe("blocked")
    expect(record.reason).toMatch(/force-push/)
    expect(await currentHead(dir)).toBe(before)
  })

  test("unpublished new commits above a published ancestor may compact", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    // Publish the boundary (older history), then make fresh run commits.
    const remote = join(await mkdtemp(join(tmpdir(), "convoy-remote-")), "remote.git")
    dirs.push(remote)
    await git(["init", "-q", "--bare", "-b", "main", remote], dir)
    await git(["remote", "add", "origin", remote], dir)
    await git(["push", "-q", "origin", "main:main"], dir)
    await runCommit(dir, "a.txt", "a\n", "design")

    const record = await runFinalization({ runID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: await ledgerFor(dir, startHead), branch: "main", composeMessage: compose })
    expect(record.state).toBe("completed")
  })

  test("an unresolvable remote blocks with fetch guidance instead of assuming unpublished", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design")
    await git(["remote", "add", "origin", join(tmpdir(), "convoy-does-not-exist-remote")], dir)
    const before = (await currentHead(dir))!

    const record = await runFinalization({ runID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: await ledgerFor(dir, startHead), branch: "main", composeMessage: compose })
    expect(record.state).toBe("blocked")
    expect(record.reason).toContain('remote "origin"')
    expect(await currentHead(dir)).toBe(before)
  })

  test("a compaction crash after the commit is recognized, not squashed again", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design")
    const preHead = (await currentHead(dir))!
    const common = (await gitCommonDir(dir))!
    const journalPath = join(common, "convoy", "finalization", `${runID}.json`)

    // Simulate a stopped attempt whose commit landed but the journal never
    // advanced past "prepared" and the produced SHA was journaled as committed.
    const record = await runFinalization({ runID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: await ledgerFor(dir, startHead), branch: "main", composeMessage: compose })
    expect(record.state).toBe("completed")
    const produced = record.producedSha!

    // Rewind the ledger so a naive rerun would try to compact again; the
    // journal must recognize the produced commit instead.
    const journal: FinalizationJournal = {
      schemaVersion: 1,
      runID,
      branch: "main",
      originalHead: preHead,
      startHead,
      headTree: (await git(["rev-parse", `${preHead}^{tree}`], dir)).stdout.trim(),
      phase: "committed",
      producedSha: produced,
      updatedAt: 1,
    }
    await writeFile(journalPath, JSON.stringify(journal))

    const rerun = await runFinalization({ runID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: [], branch: "main", composeMessage: compose })
    expect(rerun.state).toBe("completed")
    expect(rerun.reason).toContain("already created this compaction commit")
    expect(await currentHead(dir)).toBe(produced)
  })

  test("finalizeNetZeroInterval refuses a branch that moved concurrently", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await runCommit(dir, "temp.txt", "temp\n", "design")
    const interval = await verifyRunInterval(boundaryFor(dir, startHead), await ledgerFor(dir, startHead), runID, dir)
    if (!interval.ok) throw new Error("expected a verified interval")
    // The expected tip no longer matches the branch: the guarded ref update
    // must refuse instead of clobbering whatever is checked out now.
    const moved = { ...interval, headSha: "f".repeat(40) }
    const record = await finalizeNetZeroInterval({ runID, targetDir: dir, boundary: boundaryFor(dir, startHead), ledger: [], branch: "main" }, moved)
    expect(record.state).toBe("blocked")
  })

  test("verifyNotPublished passes for local-only repos with no remotes", async () => {
    const dir = await repo()
    const verdict = await verifyNotPublished([(await currentHead(dir))!], dir)
    expect(verdict).toEqual({ ok: true, checkedRemotes: [] })
  })

  test("two compacted runs keep independently inspectable evidence after garbage collection", async () => {
    // run-finalization spec scenario "Two runs followed by cleanup and
    // garbage collection": protective refs and manifests must keep each run's
    // phase changes and pre-compaction history inspectable even after GC, and
    // a later run must never overwrite an earlier run's evidence.
    const dir = await repo()
    const firstID = "20260905-120000-aa01"
    const secondID = "20260905-120000-aa02"

    // First run: two phase commits, compacted into one operator commit.
    const firstStart = (await currentHead(dir))!
    await runCommit(dir, "a.txt", "a\n", "design", firstID)
    await runCommit(dir, "b.txt", "b\n", "implement", firstID)
    const firstPre = (await currentHead(dir))!
    const first = await runFinalization({ runID: firstID, targetDir: dir, boundary: boundaryFor(dir, firstStart), ledger: await ledgerFor(dir, firstStart, firstID), branch: "main", composeMessage: compose })
    expect(first.state).toBe("completed")

    // Second run on the same branch: its boundary is the first run's product,
    // so a naive author-walk would have swallowed both runs together.
    const secondStart = (await currentHead(dir))!
    expect(secondStart).toBe(first.producedSha!)
    await runCommit(dir, "c.txt", "c\n", "design", secondID)
    await runCommit(dir, "d.txt", "d\n", "implement", secondID)
    const secondPre = (await currentHead(dir))!
    const second = await runFinalization({ runID: secondID, targetDir: dir, boundary: boundaryFor(dir, secondStart), ledger: await ledgerFor(dir, secondStart, secondID), branch: "main", composeMessage: compose })
    expect(second.state).toBe("completed")

    // Expire reflogs and run aggressive GC with immediate pruning: only the
    // protected create-only refs keep the pre-compaction commits alive.
    await git(["reflog", "expire", "--expire=now", "--all"], dir)
    await git(["gc", "--prune=now", "--aggressive", "--quiet"], dir)

    // Both runs' pre-compaction tips and per-commit refs survive GC.
    for (const [id, pre] of [
      [firstID, firstPre],
      [secondID, secondPre],
    ] as const) {
      expect(await resolveRef(preCompactionRef(id), dir)).toBe(pre)
      expect(await resolveRef(ledgerTipRef(id, 0), dir)).toBeTruthy()
      expect(await resolveRef(ledgerTipRef(id, 1), dir)).toBeTruthy()
    }

    // Each run's interval endpoints stay diffable, so its individual phase
    // changes remain independently inspectable after GC.
    const firstDiff = await git(["diff", "--name-only", firstStart, firstPre], dir)
    expect(firstDiff.stdout).toContain("a.txt")
    expect(firstDiff.stdout).toContain("b.txt")
    const secondDiff = await git(["diff", "--name-only", secondStart, secondPre], dir)
    expect(secondDiff.stdout).toContain("c.txt")
    expect(secondDiff.stdout).toContain("d.txt")

    // The manifests also survive in the git common dir.
    const common = (await gitCommonDir(dir))!
    expect(await Bun.file(join(common, "convoy", "finalization", `${firstID}.manifest.json`)).exists()).toBe(true)
    expect(await Bun.file(join(common, "convoy", "finalization", `${secondID}.manifest.json`)).exists()).toBe(true)

    // The branch itself carries exactly one produced commit per run: running
    // twice on one branch never replaces the preceding run's product.
    const subjects = await git(["log", "--format=%s", `${firstStart}..HEAD`], dir)
    expect(subjects.stdout.split("\n").filter(Boolean)).toEqual(["feat: add the thing", "feat: add the thing"])
  })
})
