import { afterEach, describe, expect, mock, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseAndRun, parseCommand, retiredFeatureDiagnostic } from "../src/cli"
import { parseWorktreesArgs, renderInventory, runWorktreesCommand, worktreesHelp, parseCloseCommandArgs, runCloseCommandFromArgs, closeCommandHelp } from "../src/worktree-commands"
import { pushCommittedRevision, assertNonForceRefspec } from "../src/operation-handlers"
import { createOperation, listPendingOperations, operationsRoot, recordStepIntent } from "../src/operation-journal"
import { acquireWriterClaim, writerClaimPath } from "../src/writer-claims"
import { execFile } from "../src/git"
import { repoCommonDir } from "../src/repo-store"
import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"

/**
 * Protecting regression tests for the worktree control center's user-facing
 * contract (change `worktree-control-center`, tasks 7.8 and 8.2): the command
 * surface exists, the retired feature commands refuse before any mutation,
 * the guarded handlers refuse force pushes, and the coordination records stay
 * owner-readable. Each test fails if the old behavior returns.
 */

const fixtures: FixtureRepo[] = []
const scratch: string[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => {})
  process.exitCode = 0
})

// ── the command surface exists ───────────────────────────────────────────

describe("convoy worktrees routing", () => {
  test("bare `convoy worktrees` parses as the inventory command", async () => {
    const command = await parseCommand(["worktrees"])
    expect(command).toEqual({ type: "worktrees", args: [] })
  })

  test("subcommands parse with their explicit targets", async () => {
    const command = await parseCommand(["worktrees", "sync", "--worktree", "/wt/x", "--base", "main"])
    expect(command).toEqual({ type: "worktrees", args: ["sync", "--worktree", "/wt/x", "--base", "main"] })
    const parsed = parseWorktreesArgs(["sync", "--worktree", "/wt/x", "--base", "main"])
    expect(parsed).toEqual({ kind: "sync", worktree: "/wt/x", base: "main" })
  })

  test("the help text names the reviewed surface", () => {
    const help = worktreesHelp()
    for (const sub of ["fetch", "sync", "push", "archive", "squash", "close", "remove", "delete-branch", "recover"]) {
      expect(help).toContain(sub)
    }
    expect(help).toContain("--worktree")
  })

  test("cleanup-legacy previews without consent and removes only retired files/refs with it (task 8.3)", async () => {
    const fixture = await createFixtureRepo()
    fixtures.push(fixture)
    const commonDir = (await repoCommonDir(fixture.root))!
    // Retired legacy state: a feature record, a resolved legacy close journal,
    // and their protective refs — plus live state that must survive.
    const featureDir = join(commonDir, "convoy", "features", "11111111-1111-4111-8111-111111111111")
    await mkdir(join(featureDir, "receipts"), { recursive: true })
    await writeFile(join(featureDir, "feature.json"), JSON.stringify({ schemaVersion: 1, featureId: "11111111-1111-4111-8111-111111111111" }))
    const closeDir = join(commonDir, "convoy", "close")
    await mkdir(closeDir, { recursive: true })
    const headSha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout.trim()
    await writeFile(
      join(closeDir, "feat-x__add-widget.json"),
      JSON.stringify({
        schemaVersion: 1,
        branch: "feat/x",
        changeID: "add-widget",
        attemptID: "22222222-2222-4222-8222-222222222222",
        phase: "landed",
        checkoutMaterialized: true,
        baseRef: "main",
        baseSha: "0".repeat(40),
        landingSha: headSha,
        featureTip: headSha,
        updatedAt: Date.now(),
      }),
    )
    await execFile("git", ["update-ref", "refs/convoy/features/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/feature-tip", headSha], { cwd: fixture.root })
    // Live state that cleanup must never touch.
    const operationsRoot = join(commonDir, "convoy", "operations")
    await mkdir(join(operationsRoot, "op-live"), { recursive: true })
    await writeFile(join(operationsRoot, "op-live", "operation.json"), "{}")
    await writeFile(join(commonDir, "convoy", "session-hints.json"), "{}")

    // Preview only: nothing is removed without --confirm.
    await runWorktreesCommand({ kind: "cleanup-legacy", confirm: false }, fixture.root)
    expect((await stat(featureDir)).isDirectory()).toBe(true)

    // With consent: the retired files and refs go; live state stays.
    await runWorktreesCommand({ kind: "cleanup-legacy", confirm: true }, fixture.root)
    await expect(stat(featureDir)).rejects.toThrow()
    await expect(stat(closeDir)).rejects.toThrow()
    const refs = await execFile("git", ["for-each-ref", "--format=%(refname)", "refs/convoy/"], { cwd: fixture.root, allowFailure: true })
    expect(refs.stdout.trim()).toBe("")
    expect((await stat(join(operationsRoot, "op-live"))).isDirectory()).toBe(true)
    expect((await stat(join(commonDir, "convoy", "session-hints.json"))).isFile()).toBe(true)
  })

  test("cleanup-legacy is blocked while an unresolved legacy journal depends on the evidence", async () => {
    const fixture = await createFixtureRepo()
    fixtures.push(fixture)
    const commonDir = (await repoCommonDir(fixture.root))!
    const closeDir = join(commonDir, "convoy", "close")
    await mkdir(closeDir, { recursive: true })
    // A half-applied legacy close: prepared but never landed.
    const headSha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout.trim()
    await writeFile(
      join(closeDir, "feat-y__add-widget.json"),
      JSON.stringify({
        schemaVersion: 1,
        branch: "feat/y",
        changeID: "add-widget",
        attemptID: "33333333-3333-4333-8333-333333333333",
        phase: "candidate",
        checkoutMaterialized: true,
        baseRef: "main",
        baseSha: "0".repeat(40),
        candidateSha: headSha,
        featureTip: headSha,
        updatedAt: Date.now(),
      }),
    )
    await expect(runWorktreesCommand({ kind: "cleanup-legacy", confirm: true }, fixture.root)).rejects.toThrow("unresolved legacy close journal")
    // The evidence stays byte-identical.
    const raw = await readFile(join(closeDir, "feat-y__add-widget.json"), "utf8")
    expect(JSON.parse(raw).phase).toBe("candidate")
  })

  test("the inventory lists every registered checkout, including spec-less ones", async () => {
    const fixture = await createFixtureRepo({
      worktrees: [{ name: "spec-less", branch: "feat/plain" }],
    })
    fixtures.push(fixture)
    await fixture.write(fixture.worktrees["spec-less"]!, "README.txt", "no openspec here\n")
    const listing = await renderInventory(fixture.root)
    expect(listing).toContain("worktrees of")
    expect(listing).toContain(fixture.root)
    expect(listing).toContain(fixture.worktrees["spec-less"]!)
    expect(listing).toContain("feat/plain")
    // A spec-less checkout is an ordinary peer, not an adoption candidate.
    expect(listing).not.toMatch(/adopt/i)
  })

  test("the inventory shows local changes with their own task counts", async () => {
    const fixture = await createFixtureRepo({
      worktrees: [{ name: "wt", branch: "feat/widget" }],
    })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "openspec/changes/add-widget/proposal.md", "# Proposal: Add widget\n")
    await fixture.write(wt, "openspec/changes/add-widget/tasks.md", "# Tasks\n\n- [x] one\n- [ ] two\n")
    const listing = await renderInventory(fixture.root)
    expect(listing).toContain("add-widget")
    expect(listing).toContain("Add widget")
    expect(listing).toContain("tasks 1/2")
  })
})

// ── the retired feature commands refuse before mutation ──────────────────

describe("retired convoy feature commands", () => {
  test("every `convoy feature` spelling routes to the retired diagnostic, never to the lifecycle commands", async () => {
    for (const argv of [
      ["feature"],
      ["feature", "bind", "f-1", "--branch", "feat/x", "--worktree", "/wt/x"],
      ["feature", "adopt", "--branch", "feat/x", "--change", "c", "--base", "main"],
      ["feature", "show"],
      ["feature", "--help"],
    ]) {
      const command = await parseCommand(argv)
      expect(command.type).toBe("retired-feature")
    }
  })

  test("the diagnostic exits non-zero with worktree guidance and performs no mutation", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const errors: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    const spy = mock((chunk: string) => {
      errors.push(chunk)
      return true
    })
    process.stderr.write = spy as typeof process.stderr.write
    const previousExitCode = process.exitCode
    try {
      await parseAndRun(["feature", "bind", "f-1", "--branch", "feat/x", "--worktree", fixture.root])
    } finally {
      process.stderr.write = originalWrite
    }
    expect(process.exitCode).toBe(1)
    process.exitCode = previousExitCode
    const output = errors.join("")
    expect(output).toContain("convoy feature was removed")
    expect(output).toContain("convoy worktrees")
    // No registry writes, no Git effects: the repository is untouched.
    const gitStatus = await fixture.git(["status", "--porcelain"])
    expect(gitStatus.trim()).toBe("")
  })

  test("the diagnostic text carries actionable replacement guidance", () => {
    const text = retiredFeatureDiagnostic(["bind", "f-1"])
    expect(text).toContain("convoy feature bind f-1")
    expect(text).toContain("convoy worktrees sync")
    expect(text).toContain("convoy worktrees close")
  })
})

// ── push never force-publishes ───────────────────────────────────────────

describe("push handler refuses force refspecs at the boundary", () => {
  test("a '+' anywhere in the refspec is refused before review or effect", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    let effectRan = false
    expect(() => assertNonForceRefspec("+feat/x:feat/x")).toThrow(/\+/)
    expect(() => assertNonForceRefspec("feat/x:+force")).toThrow(/\+/)
    await expect(
      pushCommittedRevision({
        checkout: fixture.worktrees["wt"]!,
        commonDir: (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
        remote: "origin",
        refspec: "+feat/x:feat/x",
        effect: async () => {
          effectRan = true
          return { pushedRef: "+feat/x:feat/x" }
        },
      }),
    ).rejects.toThrow(/force/)
    expect(effectRan).toBe(false)
  })

  test("a whitespace or destination-less refspec is refused", () => {
    expect(() => assertNonForceRefspec("feat/x feat/x")).toThrow(/whitespace/)
    expect(() => assertNonForceRefspec("feat/x")).toThrow(/<local>:<remote>/)
    expect(() => assertNonForceRefspec("feat/x:")).toThrow(/remote side/)
  })

  test("a valid non-force refspec executes through the guarded seam", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const outcome = await pushCommittedRevision({
      checkout: fixture.worktrees["wt"]!,
      commonDir,
      remote: "origin",
      refspec: "feat/x:feat/x",
      effect: async (target) => {
        expect(target.branch).toBe("feat/x")
        return { pushedRef: "feat/x:feat/x" }
      },
    })
    expect(outcome.ok).toBe(true)
  })
})

// ── coordination records are owner-readable ──────────────────────────────

describe("journal and claim permissions", () => {
  test.skipIf(process.platform === "win32")("operation journals are written 0600", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "push", steps: ["push"] })
    if (!created.ok) throw new Error("setup failed")
    const info = await stat(join(operationsRoot(commonDir), created.operation.operationId, "operation.json"))
    expect(info.mode & 0o777).toBe(0o600)
  })

  test.skipIf(process.platform === "win32")("writer claims are written 0600", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const acquired = await acquireWriterClaim({ commonDir, branch: "feat/x", checkoutPath: fixture.root, kind: "pipeline", owner: "run-1" })
    expect(acquired.status).toBe("acquired")
    const info = await stat(writerClaimPath(commonDir, "feat/x"))
    expect(info.mode & 0o777).toBe(0o600)
  })
})

// ── sync, squash, and close on explicit targets ──────────────────────────

describe("sync", () => {
  test("merges the reviewed base when it is not contained, and no-ops when it is", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    // The base advances after the worktree forked.
    await fixture.write(fixture.root, "base-file.txt", "base work\n")
    await fixture.commitAll("chore: base advance")
    const baseTipBefore = (await fixture.git(["rev-parse", "main"])).trim()

    await runWorktreesCommand({ kind: "sync", worktree: wt, base: "main" }, fixture.root)
    const contains = await fixture.git(["merge-base", "--is-ancestor", baseTipBefore, "feat/x"])
    expect(contains).toBe("")
    // The base checkout itself was not moved by the sync.
    expect((await fixture.git(["rev-parse", "main"])).trim()).toBe(baseTipBefore)

    // A second sync is a no-op: the base is already contained.
    const wtTipBefore = (await fixture.git(["rev-parse", "feat/x"])).trim()
    await runWorktreesCommand({ kind: "sync", worktree: wt, base: "main" }, fixture.root)
    expect((await fixture.git(["rev-parse", "feat/x"])).trim()).toBe(wtTipBefore)
  })

  test("a dirty source blocks the sync before any merge", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    await fixture.write(fixture.worktrees["wt"]!, "dirty.txt", "uncommitted\n")
    const errors: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = mock((chunk: string) => {
      errors.push(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      await runWorktreesCommand({ kind: "sync", worktree: fixture.worktrees["wt"]!, base: "main" }, fixture.root)
    } finally {
      process.stderr.write = originalWrite
    }
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
    expect(errors.join("")).toContain("uncommitted change")
  })
})

describe("squash and close", () => {
  test("close lands the whole branch as one commit on the base — without any feature record or receipt", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "feature-file.txt", "operator work\n")
    await fixture.commitAll("feat: operator work", wt)
    await fixture.write(wt, "feature-file-2.txt", "more work\n")
    await fixture.commitAll("feat: more work", wt)
    const baseTipBefore = (await fixture.git(["rev-parse", "main"])).trim()
    const sourceTipBefore = (await fixture.git(["rev-parse", "feat/x"])).trim()
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()

    await runWorktreesCommand({ kind: "close", worktree: wt, base: "main", changes: [] }, fixture.root)

    // The base advanced by exactly one commit whose only parent is the old base tip.
    const baseTipAfter = (await fixture.git(["rev-parse", "main"])).trim()
    expect(baseTipAfter).not.toBe(baseTipBefore)
    const parents = (await fixture.git(["rev-list", "--parents", "-n", "1", baseTipAfter])).trim().split(/\s+/)
    expect(parents).toHaveLength(2)
    expect(parents[1]).toBe(baseTipBefore)
    // The landed tree equals the source tree.
    const sourceTree = (await fixture.git(["rev-parse", "feat/x^{tree}"])).trim()
    const landedTree = (await fixture.git(["rev-parse", `${baseTipAfter}^{tree}`])).trim()
    expect(landedTree).toBe(sourceTree)
    // The source branch's history was not rewritten.
    expect((await fixture.git(["rev-parse", "feat/x"])).trim()).toBe(sourceTipBefore)
    // No durable lifecycle residue: the operation journal was released.
    expect(await listPendingOperations(commonDir)).toEqual([])
  })

  test("close with a selected change archives exactly that change, then squashes", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "openspec/changes/add-widget/proposal.md", "# Proposal: Add widget\n")
    await fixture.write(wt, "openspec/changes/add-widget/tasks.md", "# Tasks\n\n- [x] one\n- [x] two\n")
    await fixture.write(wt, "openspec/changes/inherited/proposal.md", "# Proposal: Inherited\n")
    await fixture.write(wt, "openspec/changes/inherited/tasks.md", "# Tasks\n\n- [ ] one\n")
    await fixture.commitAll("feat: propose add-widget", wt)
    await fixture.write(wt, "code.txt", "implementation\n")
    await fixture.commitAll("feat: implement", wt)

    // A fake openspec CLI that archives by moving the change into the archive.
    const binDir = await mkdtemp(join(tmpdir(), "convoy-wt-bin-"))
    scratch.push(binDir)
    const script = [
      "#!/usr/bin/env bun",
      "import { renameSync, mkdirSync, statSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "const [cmd, ...rest] = process.argv.slice(2)",
      "const root = process.cwd()",
      "if (cmd === 'archive') {",
      "  const id = rest.find((a) => !a.startsWith('-'))",
      "  const from = join(root, 'openspec', 'changes', id)",
      "  const to = join(root, 'openspec', 'changes', 'archive', id)",
      "  statSync(from)",
      "  mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true })",
      "  renameSync(from, to)",
      "  process.exit(0)",
      "}",
      "console.error('unexpected openspec invocation: ' + cmd)",
      "process.exit(3)",
    ].join("\n")
    await writeFile(join(binDir, "openspec"), script)
    await chmod(join(binDir, "openspec"), 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${binDir}:${previousPath ?? ""}`
    try {
      await runWorktreesCommand({ kind: "close", worktree: wt, base: "main", changes: ["add-widget"] }, fixture.root)
    } finally {
      process.env.PATH = previousPath
    }

    // Only the selected change was archived; the inherited copy stays active.
    expect(await readFile(join(wt, "openspec/changes/inherited/proposal.md"), "utf8")).toContain("Inherited")
    const archiveListing = (await fixture.git(["ls-tree", "-r", "--name-only", "feat/x", "openspec/changes/archive/"])).trim()
    expect(archiveListing).toContain("add-widget")
    // The base gained one squash commit covering the whole branch (archive + code).
    const baseTip = (await fixture.git(["rev-parse", "main"])).trim()
    const landedTree = (await fixture.git(["rev-parse", `${baseTip}^{tree}`])).trim()
    const sourceTree = (await fixture.git(["rev-parse", "feat/x^{tree}"])).trim()
    expect(landedTree).toBe(sourceTree)
  })

  test("equal trees land nothing and authorize nothing", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    const baseTipBefore = (await fixture.git(["rev-parse", "main"])).trim()
    await runWorktreesCommand({ kind: "squash", worktree: wt, base: "main" }, fixture.root)
    expect((await fixture.git(["rev-parse", "main"])).trim()).toBe(baseTipBefore)
  })

  test("an unsynced base stops the squash with sync guidance", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "feature.txt", "work\n")
    await fixture.commitAll("feat: work", wt)
    await fixture.write(fixture.root, "base.txt", "base advance\n")
    await fixture.commitAll("chore: base advance")
    const baseTipBefore = (await fixture.git(["rev-parse", "main"])).trim()
    const errors: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = mock((chunk: string) => {
      errors.push(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      await runWorktreesCommand({ kind: "squash", worktree: wt, base: "main" }, fixture.root)
    } finally {
      process.stderr.write = originalWrite
    }
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
    expect(errors.join("")).toContain("sync")
    // Nothing landed.
    expect((await fixture.git(["rev-parse", "main"])).trim()).toBe(baseTipBefore)
  })
})

describe("remove and delete-branch", () => {
  test("removal keeps the branch and reports removal, not completion", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    await runWorktreesCommand({ kind: "remove", worktree: fixture.worktrees["wt"]! }, fixture.root)
    const branches = (await fixture.git(["branch", "--list", "feat/x"])).trim()
    expect(branches).toContain("feat/x")
    const listing = await renderInventory(fixture.root)
    expect(listing).not.toContain(fixture.worktrees["wt"]!)
  })

  test("a checked-out branch cannot be deleted", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    await expect(runWorktreesCommand({ kind: "delete-branch", branch: "feat/x", force: false }, fixture.root)).rejects.toThrow(/checked out/)
  })

  test("unique history after a squash needs explicit destructive consent bound to the reviewed tip", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "feature.txt", "work\n")
    await fixture.commitAll("feat: work", wt)
    await runWorktreesCommand({ kind: "close", worktree: wt, base: "main", changes: [] }, fixture.root)
    // Remove the worktree so the branch is deletable, then try the safe form.
    await runWorktreesCommand({ kind: "remove", worktree: wt }, fixture.root)
    // `-d` refuses: the squashed branch's commits are not contained in main.
    await expect(runWorktreesCommand({ kind: "delete-branch", branch: "feat/x", force: false }, fixture.root)).rejects.toThrow(/--force/)
    expect((await fixture.git(["branch", "--list", "feat/x"])).trim()).toContain("feat/x")
    // `--force` alone is not consent: the operator must name the exact tip.
    const tip = (await fixture.git(["rev-parse", "feat/x"])).trim()
    await expect(runWorktreesCommand({ kind: "delete-branch", branch: "feat/x", force: true }, fixture.root)).rejects.toThrow(/--expect/)
    expect((await fixture.git(["branch", "--list", "feat/x"])).trim()).toContain("feat/x")
    // A --expect that does not match the current tip is refused.
    await expect(runWorktreesCommand({ kind: "delete-branch", branch: "feat/x", force: true, expect: "0123456789abcdef0123456789abcdef01234567" }, fixture.root)).rejects.toThrow(/moved after review/)
    expect((await fixture.git(["branch", "--list", "feat/x"])).trim()).toContain("feat/x")
    // --force with the reviewed tip is the explicit destructive consent.
    await runWorktreesCommand({ kind: "delete-branch", branch: "feat/x", force: true, expect: tip }, fixture.root)
    expect((await fixture.git(["branch", "--list", "feat/x"])).trim()).toBe("")
  })

  test("a branch that moves after review is refused, not deleted (fault injection)", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "feature.txt", "work\n")
    await fixture.commitAll("feat: work", wt)
    await runWorktreesCommand({ kind: "close", worktree: wt, base: "main", changes: [] }, fixture.root)
    await runWorktreesCommand({ kind: "remove", worktree: wt }, fixture.root)

    // The operator reviews the tip…
    const reviewedTip = (await fixture.git(["rev-parse", "feat/x"])).trim()
    // …and an external process advances the branch before deletion.
    await fixture.write(fixture.root, "late.txt", "unreviewed work\n")
    await fixture.commitAll("feat: unreviewed late work", fixture.root)
    await fixture.git(["update-ref", `refs/heads/feat/x`, (await fixture.git(["rev-parse", "main"])).trim()])
    const movedTip = (await fixture.git(["rev-parse", "feat/x"])).trim()
    expect(movedTip).not.toBe(reviewedTip)

    // Deletion bound to the stale reviewed tip is refused; the unreviewed
    // commit survives.
    await expect(runWorktreesCommand({ kind: "delete-branch", branch: "feat/x", force: true, expect: reviewedTip }, fixture.root)).rejects.toThrow(/moved after review/)
    expect((await fixture.git(["rev-parse", "feat/x"])).trim()).toBe(movedTip)

    // And even if the operator re-reviews, a ref that moves between the fresh
    // read and the compare-and-delete is refused by Git's expected-OID check:
    // update-ref -d with a stale old value must not delete the moved branch.
    const guard = await execFile("git", ["update-ref", "-d", "refs/heads/feat/x", reviewedTip], { cwd: fixture.root, allowFailure: true })
    expect(guard.exitCode).not.toBe(0)
    expect((await fixture.git(["rev-parse", "feat/x"])).trim()).toBe(movedTip)
  })
})

describe("convoy close routing (CC-3)", () => {
  test("the close command parses onto the shared composite surface", async () => {
    const command = await parseCommand(["close", "--branch", "feat/x", "--base", "main", "--change", "add-widget"])
    expect(command).toEqual({ type: "close", args: ["--branch", "feat/x", "--base", "main", "--change", "add-widget"] })
  })

  test("retired spellings stop with guidance before any Git effect", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const before = await fixture.git(["status", "--porcelain"])
    await expect(runCloseCommandFromArgs(parseCloseCommandArgs(["--feature", "f-1"]), fixture.root)).rejects.toThrow(/feature identity is retired/)
    await expect(runCloseCommandFromArgs(parseCloseCommandArgs(["--cleanup", "worktree"]), fixture.root)).rejects.toThrow(/convoy worktrees remove/)
    await expect(runCloseCommandFromArgs(parseCloseCommandArgs(["--resume"]), fixture.root)).rejects.toThrow(/convoy worktrees recover/)
    expect(await fixture.git(["status", "--porcelain"])).toBe(before)
  })

  test("a branch selector resolves uniquely through Git's inventory and runs the composite", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "feature.txt", "work\n")
    await fixture.commitAll("feat: work", wt)
    await runCloseCommandFromArgs(parseCloseCommandArgs(["--branch", "feat/x", "--base", "main"]), fixture.root)
    // The whole branch landed on main as one squash commit; the source
    // branch's own history is intact. The composed deterministic subject
    // keeps the branch's conventional type and names the work as words.
    const mainLog = await fixture.git(["log", "--oneline", "main"])
    expect(mainLog).toMatch(/feat: improve x/)
    const wtLog = await fixture.git(["log", "--oneline", "feat/x"])
    expect(wtLog).toContain("feat: work")
  })

  test("a branch selector that resolves to no live checkout is refused, never guessed", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    await expect(runCloseCommandFromArgs(parseCloseCommandArgs(["--branch", "feat/nowhere", "--base", "main"]), fixture.root)).rejects.toThrow(/does not resolve uniquely/)
  })

  test("dry-run prints the reviewed sequence without touching the repository", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = mock((chunk: string) => {
      chunks.push(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      await runCloseCommandFromArgs(parseCloseCommandArgs(["--worktree", fixture.worktrees["wt"]!, "--base", "main", "--change", "add-widget", "--dry-run"]), fixture.root)
    } finally {
      process.stdout.write = originalWrite
    }
    const output = chunks.join("")
    expect(output).toContain("sync (as needed)")
    expect(output).toContain("add-widget")
    expect(output).toContain("whole-branch squash")
    expect(await fixture.git(["log", "--oneline", "--all"])).not.toMatch(/archive/)
  })
})

describe("recover", () => {
  test("an unknown operation id is refused, never guessed", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    await expect(runWorktreesCommand({ kind: "recover", operationId: "no-such-op", consent: "inspect" }, fixture.root)).rejects.toThrow(/not a readable pending operation/)
  })

  test("an archive interrupted before its commit is reconciled, not replayed", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "openspec/changes/add-widget/proposal.md", "# Proposal: Add widget\n")
    await fixture.write(wt, "openspec/changes/add-widget/tasks.md", "# Tasks\n\n- [x] one\n")
    await fixture.commitAll("feat: propose", wt)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()

    // The crash state: OpenSpec archived the change (moved it into the
    // archive layout) but the process stopped before committing the output.
    // The journal holds the recorded intent with no acknowledgements.
    await mkdir(join(wt, "openspec/changes/archive"), { recursive: true })
    await rename(join(wt, "openspec/changes/add-widget"), join(wt, "openspec/changes/archive/add-widget"))
    const created = await createOperation(commonDir, {
      kind: "archive",
      intent: { checkout: wt, changes: ["add-widget"] },
      steps: ["archive:add-widget", "commit"],
    })
    if (!created.ok) throw new Error("setup failed")
    const operationId = created.operation.operationId
    await recordStepIntent(commonDir, operationId, "archive:add-widget", { changeId: "add-widget", checkout: wt })
    await recordStepIntent(commonDir, operationId, "commit", { checkout: wt, changes: ["add-widget"] })

    // Inspection reconciles in memory: the archive effect is verified against
    // reality, the commit stays pending, and nothing was mutated.
    const previousExitCode = process.exitCode
    await runWorktreesCommand({ kind: "recover", operationId, consent: "inspect" }, fixture.root)
    expect(process.exitCode).toBe(1)
    process.exitCode = previousExitCode
    expect(await listPendingOperations(commonDir)).toEqual([operationId])
    // The archive output is still uncommitted in the worktree.
    expect((await execFile("git", ["status", "--porcelain"], { cwd: wt })).stdout).not.toBe("")

    // The next archive on this checkout reconciles first: exactly the
    // interrupted output is committed, the journal is released, and the fresh
    // archive then refuses the already-archived change instead of guessing.
    await expect(runWorktreesCommand({ kind: "archive", worktree: wt, changes: ["add-widget"] }, fixture.root)).rejects.toThrow(/not an active change/)
    expect(await fixture.git(["log", "--oneline", "feat/x"])).toMatch(/chore: archive add-widget/)
    expect(await listPendingOperations(commonDir)).toEqual([])
    // Only the verified archive output was committed — nothing else.
    expect((await execFile("git", ["status", "--porcelain"], { cwd: wt })).stdout).toBe("")
  })

  test("inspection reports pending steps and exits non-zero without consent", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "push", steps: ["push"] })
    if (!created.ok) throw new Error("setup failed")
    const previousExitCode = process.exitCode
    await runWorktreesCommand({ kind: "recover", operationId: created.operation.operationId, consent: "inspect" }, fixture.root)
    expect(process.exitCode).toBe(1)
    process.exitCode = previousExitCode
    // The journal survives inspection untouched.
    expect(await listPendingOperations(commonDir)).toEqual([created.operation.operationId])
  })

  test("explicit cancellation releases the journal", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "push", steps: ["push"] })
    if (!created.ok) throw new Error("setup failed")
    await runWorktreesCommand({ kind: "recover", operationId: created.operation.operationId, consent: "cancel" }, fixture.root)
    expect(await listPendingOperations(commonDir)).toEqual([])
  })

  test("a prefix --expect is not destructive consent (CC-9)", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "feature.txt", "work\n")
    await fixture.commitAll("feat: work", wt)
    await runWorktreesCommand({ kind: "remove", worktree: wt }, fixture.root)
    const tip = (await fixture.git(["rev-parse", "feat/x"])).trim()
    // A 8-char prefix of the real tip must not authorize the deletion.
    await expect(runWorktreesCommand({ kind: "delete-branch", branch: "feat/x", force: true, expect: tip.slice(0, 8) }, fixture.root)).rejects.toThrow(/full 40-character OID/)
    expect((await fixture.git(["branch", "--list", "feat/x"])).trim()).toContain("feat/x")
  })

  test("the kind-specific probe acknowledges a squash candidate already contained in the base (CC-7)", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "feature.txt", "work\n")
    await fixture.commitAll("feat: work", wt)
    // Simulate the crash-after-landing-before-acknowledgement case: the
    // candidate was created and landed on the base, but the journal step was
    // never acknowledged.
    const candidate = (await fixture.git(["rev-parse", "feat/x"])).trim()
    await fixture.git(["update-ref", "refs/heads/main", candidate])
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "close", steps: ["land"] })
    if (!created.ok) throw new Error("setup failed")
    const { recordStepIntent } = await import("../src/operation-journal")
    await recordStepIntent(commonDir, created.operation.operationId, "land", { candidateSha: candidate, base: "main" })
    const id = created.operation.operationId

    // Inspection alone recognizes the verified effect (recording observed
    // reality is evidence-keeping, not an effect) and resolves the journal.
    await runWorktreesCommand({ kind: "recover", operationId: id, consent: "inspect" }, fixture.root)
    expect(await listPendingOperations(commonDir)).toEqual([])
    // The base was not touched again: no duplicate landing, no new commit.
    expect((await fixture.git(["rev-parse", "main"])).trim()).toBe(candidate)
  })

  test("a candidate not contained in the reviewed base blocks recovery instead of replaying", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/x" }] })
    fixtures.push(fixture)
    const wt = fixture.worktrees["wt"]!
    await fixture.write(wt, "feature.txt", "work\n")
    await fixture.commitAll("feat: work", wt)
    const candidate = (await fixture.git(["rev-parse", "feat/x"])).trim()
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "close", steps: ["land"] })
    if (!created.ok) throw new Error("setup failed")
    const { recordStepIntent } = await import("../src/operation-journal")
    await recordStepIntent(commonDir, created.operation.operationId, "land", { candidateSha: candidate, base: "main" })
    const id = created.operation.operationId

    const errors: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = mock((chunk: string) => {
      errors.push(chunk)
      return true
    }) as typeof process.stdout.write
    const previousExitCode = process.exitCode
    try {
      await runWorktreesCommand({ kind: "recover", operationId: id, consent: "continue" }, fixture.root)
    } finally {
      process.stdout.write = originalWrite
    }
    // Unexplained divergence blocks: the journal survives for inspection and
    // the candidate was not re-landed anywhere.
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
    expect(errors.join("")).toContain("not reachable from the reviewed base")
    expect(await listPendingOperations(commonDir)).toEqual([id])
  })
})
