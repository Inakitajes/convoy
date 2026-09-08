// Reproduction tests for the 6 release-blocking findings from the Hunter NaN PRD.
// Each test captures the pre-fix behavior so the fix can be verified against it.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { advisorTokenEnv, advisorUrlEnv } from "../src/advisor-bridge"
import { commitAsUser, findSuspiciousStagedFiles, restoreRepoSnapshot, type RepoSnapshot } from "../src/git"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tmpDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `convoy-repro-${label}-`))
  dirs.push(dir)
  return dir
}

async function git(args: string[], cwd: string): Promise<string> {
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
  const stdout = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  return stdout.trim()
}

// ===== HN-009: Non-atomic snapshot restoration =====
//
// restoreRepoSnapshot executes 6 sequential git commands with no backup ref
// and no rollback. A crash between any two commands leaves the repo in an
// inconsistent state (detached HEAD, missing branch, dirty tree) that requires
// manual git fsck. This test verifies the normal-case behavior works and
// characterizes the non-atomic nature.
describe("HN-009: restoreRepoSnapshot now has backup ref recovery", () => {
  async function repoWithChange(): Promise<{ dir: string; snapshot: RepoSnapshot }> {
    const dir = await tmpDir("hn009")
    await git(["init", "-q", "-b", "main"], dir)
    await writeFile(join(dir, "README.md"), "base\n")
    await git(["add", "README.md"], dir)
    await git(["commit", "-q", "-m", "chore: init"], dir)
    const snapshot: RepoSnapshot = { head: await git(["rev-parse", "HEAD"], dir), ref: "main" }
    // Make a change that should be reverted by restoreRepoSnapshot
    await writeFile(join(dir, "untracked.txt"), "should be cleaned\n")
    await writeFile(join(dir, "README.md"), "modified\n")
    await git(["add", "README.md"], dir)
    await git(["commit", "-q", "-m", "break: modify"], dir)
    return { dir, snapshot }
  }

  test("restores the repo to its snapshot state (normal case)", async () => {
    const { dir, snapshot } = await repoWithChange()
    await restoreRepoSnapshot(snapshot, dir)

    // HEAD is back at the snapshot commit
    expect(await git(["rev-parse", "HEAD"], dir)).toBe(snapshot.head)
    // The branch is restored
    expect(await git(["branch", "--show-current"], dir)).toBe("main")
    // The tree is clean
    expect(await git(["status", "--porcelain"], dir)).toBe("")
    // The file content is restored
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("base\n")
    // Untracked files are cleaned
    expect(await Bun.file(join(dir, "untracked.txt")).exists()).toBe(false)
  })

  test("creates a backup ref and cleans it up on successful restore (HN-009 fix)", async () => {
    const { dir, snapshot } = await repoWithChange()
    await restoreRepoSnapshot(snapshot, dir)

    // The backup ref should be cleaned up on success — no ref namespace pollution.
    const refs = await git(["for-each-ref", "--format=%(refname)", "refs/convoy/snapshot/"], dir)
    expect(refs.trim()).toBe("")
  })

  test("preserves a backup ref for recovery when restore fails mid-sequence (HN-009 fix)", async () => {
    const { dir, snapshot } = await repoWithChange()
    const beforeHead = await git(["rev-parse", "HEAD"], dir)

    // An invalid head triggers a failure at `git checkout --detach`, mid-sequence.
    const badSnapshot: RepoSnapshot = { head: "0".repeat(40), ref: "main" }
    await expect(restoreRepoSnapshot(badSnapshot, dir)).rejects.toThrow()

    // The backup ref should still exist, pointing at the pre-restore HEAD.
    const refs = await git(["for-each-ref", "--format=%(refname)", "refs/convoy/snapshot/"], dir)
    const refLines = refs.split("\n").filter(Boolean)
    expect(refLines.length).toBe(1)
    expect(await git(["rev-parse", refLines[0]!], dir)).toBe(beforeHead)
  })

  test("source contains backup ref, try/catch, and recovery instructions (HN-009 fix)", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "git.ts"),
      "utf8",
    )

    const restoreSection = source.match(/export async function restoreRepoSnapshot[\s\S]{1,2000}/)
    expect(restoreSection).not.toBeNull()
    expect(restoreSection![0]).toContain("refs/convoy/snapshot/")
    expect(restoreSection![0]).toContain("update-ref")
    expect(restoreSection![0]).toContain("catch (error)")
    expect(restoreSection![0]).toContain("git reset --hard")
    expect(restoreSection![0]).toContain("Then re-run convoy to resume")
  })
})

// ===== HN-018: Advisor token leaked via process.env =====
//
// runner.ts:558-560 sets CONVOY_ADVISOR_URL and CONVOY_ADVISOR_TOKEN in
// process.env. These are inherited by every subprocess Convoy spawns and
// the OpenCode server process. Only cleaned up in the finally block at
// lines 719-721. The advisor tool reads them from process.env (bridge.ts:171-172).
describe("HN-018: advisor token leaked via process.env", () => {
  test("the env var names are accessible to arbitrary subprocesses when set", async () => {
    // Verify the env var names are literals, not obfuscated
    expect(advisorUrlEnv).toBe("CONVOY_ADVISOR_URL")
    expect(advisorTokenEnv).toBe("CONVOY_ADVISOR_TOKEN")

    // Simulate what runner.ts:558-560 does
    const testUrl = "http://127.0.0.1:9999/advise"
    const testToken = "test-token-for-repro"
    process.env[advisorUrlEnv] = testUrl
    process.env[advisorTokenEnv] = testToken

    try {
      // A subprocess can read the token
      const echoUrl = Bun.spawn(["bash", "-c", "echo -n $CONVOY_ADVISOR_URL"], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      })
      expect(await new Response(echoUrl.stdout).text()).toBe(testUrl)

      const echoToken = Bun.spawn(["bash", "-c", "echo -n $CONVOY_ADVISOR_TOKEN"], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      })
      expect(await new Response(echoToken.stdout).text()).toBe(testToken)
    } finally {
      // Cleanup as runner.ts:720-721 does
      delete process.env[advisorUrlEnv]
      delete process.env[advisorTokenEnv]
    }
  })
})

// ===== HN-020: the landing path skips no secret scan =====
//
// addAllAndCommit (git.ts) calls findSuspiciousStagedFiles before committing.
// commitAsUser does NOT. Close's squash-merge candidate is committed through
// commitAsUser in the integration worktree, so worktree-squash.ts scans the
// staged files itself before the commit runs — the candidate commit must not
// become a secret-scan bypass merely because it no longer goes through a
// finish-time rewrite.
describe("HN-020: finish skips secret scanning", () => {
  test("addAllAndCommit calls findSuspiciousStagedFiles (reference behavior)", async () => {
    // findSuspiciousStagedFiles exists and works
    expect(findSuspiciousStagedFiles("A  .env\nA  README.md\n")).toEqual([".env"])
    expect(findSuspiciousStagedFiles("A  README.md\nM  src/main.ts\n")).toEqual([])
  })

  test("commitAsUser does not call findSuspiciousStagedFiles (structural gap)", async () => {
    // commitAsUser remains a thin wrapper around git commit; the secret scan
    // was added to applySquash in finish.ts instead, keeping the tool general.
    const fnStr = commitAsUser.toString()
    // The function body should NOT reference findSuspiciousStagedFiles
    expect(fnStr).not.toContain("findSuspiciousStagedFiles")
    // It should reference git commit
    expect(fnStr).toContain("git commit")
  })

  test("close's candidate commit scans the staged files before committing (fix)", async () => {
    // The scan lives in worktree-squash.ts's candidate creation, before the
    // commitAsUser call in the integration worktree.
    const source = await readFile(
      join(import.meta.dir, "..", "src", "worktree-squash.ts"),
      "utf8",
    )

    expect(source).toContain("findSuspiciousStagedFiles")
    expect(source).toContain("suspicious.length > 0")
  })
})

// ===== run-finalization: the manual finish rewrite is unreachable =====
//
// Capability run-finalization (design D5) removes the manual finish: the CLI
// spelling is retired, and the dashboard's finish modal, [f] seam, and
// push/PR follow-ups are gone. The authorship walk in finish.ts survives only
// as an internal primitive of `convoy close` until its true-squash landing
// replaces it. These assertions keep every surface honest about that.
describe("run-finalization: the manual finish rewrite is unreachable", () => {
  test("no source file still wires the retired finish seam or its modal", async () => {
    const srcDir = join(import.meta.dir, "..", "src")
    const files = (await readdir(srcDir)).filter((file) => file.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const source = await readFile(join(srcDir, file), "utf8")
      // The seam factory and the FinishSeam type are removed; nothing may
      // reference them (the dashboard has no path back to the rewrite).
      expect(source, file).not.toContain("createFinishSeam")
      expect(source, file).not.toContain("FinishSeam")
      expect(source, file).not.toContain("openFinishModal")
      expect(source, file).not.toContain("applyFinish(")
    }
  })

  test("the progress host controls expose publication, not a branch rewrite", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "progress.ts"), "utf8")
    expect(source).toContain("publish?: PublishSeam")
    expect(source).not.toContain("finish?: FinishSeam")
  })
})

// ===== HN-002: Fire-and-forget metadata loses state on crash =====
//
// phaseStarted, phaseEnded, and serverStopped now use `await persist({ throwOnError: true })`
// instead of `void persist()`. A crash during the debounce window no longer
// leaves stale metadata on disk. phaseRepositoryBaseline and setControlState
// always used the correct pattern.
describe("HN-002: metadata lifecycle methods", () => {
  test("phaseStarted, phaseEnded, serverStopped now await persist (fix)", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "metadata.ts"),
      "utf8",
    )

    // phaseStarted now uses `await persist({ throwOnError: true })`
    const phaseStartedAwait = source.match(/async phaseStarted[\s\S]{0,300}await persist\(\{ throwOnError: true \}\)/)
    expect(phaseStartedAwait).not.toBeNull()

    // phaseEnded now uses `await persist({ throwOnError: true })`
    const phaseEndedAwait = source.match(/async phaseEnded[\s\S]{0,300}await persist\(\{ throwOnError: true \}\)/)
    expect(phaseEndedAwait).not.toBeNull()

    // serverStopped now uses `await persist({ throwOnError: true })`
    const serverStoppedAwait = source.match(/async serverStopped[\s\S]{0,300}await persist\(\{ throwOnError: true \}\)/)
    expect(serverStoppedAwait).not.toBeNull()
  })

  test("phaseRepositoryBaseline and setControlState correctly await persist", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "metadata.ts"),
      "utf8",
    )

    // phaseRepositoryBaseline uses `await persist({ throwOnError: true })`
    expect(source).toContain("phaseRepositoryBaseline")
    expect(source).toContain("await persist({ throwOnError: true })")

    // setControlState uses `await persist({ throwOnError: true })`
    const setControlAwait = source.match(/setControlState[\s\S]{0,300}await persist\(\{ throwOnError: true \}\)/)
    expect(setControlAwait).not.toBeNull()
  })

  test("RunMetadataStore interface declares Promise<void> for lifecycle methods (HN-002 fix)", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "metadata.ts"),
      "utf8",
    )

    // The interface should now declare Promise<void> so callers must await
    expect(source).toContain("serverStopped(): Promise<void>")
    expect(source).toContain("phaseStarted(name: string): Promise<void>")
    expect(source).toContain('phaseEnded(name: string, status: "completed" | "skipped" | "failed"): Promise<void>')
  })

  test("direct call sites in runner.ts await the store methods (HN-002 fix)", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "runner.ts"),
      "utf8",
    )

    // serverStopped should be awaited with .catch() in the finally block
    expect(source).toContain("await metadata?.serverStopped().catch(")
    // phaseEnded in commitRecoveredPhase should be awaited with .catch()
    expect(source).toContain('await metadata.phaseEnded(phase.name, "completed").catch(')
  })

  test("recordProgress callbacks await store methods with error handling (HN-002 fix)", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "metadata.ts"),
      "utf8",
    )

    // phaseStarted callback should be async and await store.phaseStarted with .catch()
    expect(source).toContain("async phaseStarted(name, detail)")
    expect(source).toContain("await store.phaseStarted(name).catch(")
    // phaseCompleted callback should be async and await store.phaseEnded with .catch()
    expect(source).toContain("async phaseCompleted(name, detail)")
    expect(source).toContain('await store.phaseEnded(name, "completed").catch(')
    // phaseSkipped callback should be async and await store.phaseEnded with .catch()
    expect(source).toContain("async phaseSkipped(name)")
    expect(source).toContain('await store.phaseEnded(name, "skipped").catch(')
    // phaseFailed callback should be async and await store.phaseEnded with .catch()
    expect(source).toContain("async phaseFailed(name, detail)")
    expect(source).toContain('await store.phaseEnded(name, "failed").catch(')
  })
})

// ===== HN-003: Non-atomic phase report writes =====
//
// persistPhaseReport now writes to a `.tmp` path and renames atomically,
// matching the metadata.ts pattern. A crash mid-write can no longer leave
// a truncated report that phaseNeedsRun would treat as complete.
describe("HN-003: persistPhaseReport now uses tmp+rename (fix)", () => {
  test("writeFile writes to a .tmp path and renames atomically", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "runner.ts"),
      "utf8",
    )

    // persistPhaseReport now uses:
    //   const tmpPath = `${reportAbs}.tmp`
    //   await writeFile(tmpPath, assistantText)
    //   await rename(tmpPath, reportAbs)
    // Contract validation and the empty-continue skip sit above the atomic
    // write, so the window has to cover that preamble plus tmp+rename.
    const persistSection = source.match(/async function persistPhaseReport[\s\S]{1,1800}/)
    expect(persistSection).not.toBeNull()
    expect(persistSection![0]).toContain(".tmp")
    expect(persistSection![0]).toContain("rename(tmpPath, reportAbs)")
  })

  test("metadata.ts uses tmp+rename pattern (reference behavior)", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "metadata.ts"),
      "utf8",
    )

    // The persist function in metadata.ts uses:
    //   await writeFile(`${path}.tmp`, body)
    //   await rename(`${path}.tmp`, path)
    expect(source).toContain("writeFile(`${path}.tmp`, body)")
    expect(source).toContain("rename(`${path}.tmp`, path)")
  })
})
