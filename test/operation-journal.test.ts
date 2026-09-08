import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import {
  acknowledgeStep,
  addProtectiveRef,
  cancelStep,
  createOperation,
  listPendingOperations,
  operationsRoot,
  readOperation,
  recordStepIntent,
  resolveOperation,
} from "../src/operation-journal"

/**
 * Task 2.3: bounded versioned atomic unresolved-operation journals under
 * `<git-common-dir>/convoy/operations/<operation-id>/`. Storage faults
 * (interrupted writes, unreadable/version-invalid records), checkout removal
 * survival, and separation from durable run records and compaction refs.
 */

const fixtures: FixtureRepo[] = []
const scratch: string[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => {})
})

describe("createOperation", () => {
  test("writes intent and pending steps before any effect", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "push", intent: { remote: "origin", refspec: "feat/x:feat/x" }, steps: ["push", "confirm"] })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const operation = created.operation
    expect(operation.status).toBe("pending")
    expect(operation.steps.map((step) => step.id)).toEqual(["push", "confirm"])
    expect(operation.protectiveRefs).toEqual([])
    // The id is opaque: never the branch, never a path.
    expect(operation.operationId).not.toContain("feat")
    const read = await readOperation(commonDir, operation.operationId)
    expect(read.status).toBe("found")
  })

  test("refuses to create without steps — an operation must record what it will do", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    expect(await createOperation(commonDir, { kind: "close", steps: [] })).toMatchObject({ ok: false })
    expect(await createOperation(commonDir, { kind: "close", steps: ["a", "a"] })).toMatchObject({ ok: false })
  })
})

describe("acknowledgeStep / recordStepIntent / cancelStep", () => {
  test("an acknowledgement is written only after the caller verified the effect", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "archive", steps: ["archive", "commit"] })
    if (!created.ok) throw new Error("setup failed")
    const id = created.operation.operationId

    const intent = await recordStepIntent(commonDir, id, "archive", { changeId: "add-widget" })
    expect(intent.ok).toBe(true)
    // Acknowledging an unstarted step is refused — recovery must not mistake
    // journal bookkeeping for a verified effect.
    const premature = await acknowledgeStep(commonDir, id, "commit")
    expect(premature.ok).toBe(false)
    const ack = await acknowledgeStep(commonDir, id, "archive", { archiveDir: "2026-09-08-add-widget" })
    expect(ack.ok).toBe(true)
    const double = await acknowledgeStep(commonDir, id, "archive")
    expect(double.ok).toBe(false)
    const read = await readOperation(commonDir, id)
    if (read.status !== "found") throw new Error("read failed")
    expect(read.value.steps[0]).toMatchObject({ id: "archive", acknowledgement: { evidence: { archiveDir: "2026-09-08-add-widget" } } })
    expect(read.value.steps[1]!.acknowledgement).toBeUndefined()
  })

  test("an explicit cancellation is recorded, never inferred", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "push", steps: ["push"] })
    if (!created.ok) throw new Error("setup failed")
    expect((await cancelStep(commonDir, created.operation.operationId, "push")).ok).toBe(true)
  })

  test("mutations on an unknown or hostile id are refused", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    expect((await acknowledgeStep(commonDir, "no-such-operation", "step")).ok).toBe(false)
    expect((await acknowledgeStep(commonDir, "../escape", "step")).ok).toBe(false)
  })
})

describe("resolveOperation", () => {
  test("refuses resolution while steps are undecided", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "close", steps: ["sync", "archive"] })
    if (!created.ok) throw new Error("setup failed")
    await acknowledgeStep(commonDir, created.operation.operationId, "sync")
    const result = await resolveOperation({ commonDir, operationId: created.operation.operationId, gitCwd: fixture.root, outcome: "resolved" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("archive")
  })

  test("resolution deletes the journal and its own protective refs — and nothing else", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "squash", intent: { base: "main" }, steps: ["candidate", "land"] })
    if (!created.ok) throw new Error("setup failed")
    const id = created.operation.operationId
    const protective = `refs/convoy/operations/${id}/candidate`
    await fixture.git(["update-ref", protective, "HEAD"])
    await addProtectiveRef(commonDir, id, protective)
    // A durable run-compaction-style ref that must survive resolution.
    const runRef = "refs/convoy/runs/some-run/backup"
    await fixture.git(["update-ref", runRef, "HEAD"])

    for (const step of ["candidate", "land"]) await acknowledgeStep(commonDir, id, step)
    const result = await resolveOperation({ commonDir, operationId: id, gitCwd: fixture.root, outcome: "resolved" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.released.refs).toEqual([protective])
    expect(await readOperation(commonDir, id).then((read) => read.status)).toBe("missing")
    const stillThere = await fixture.git(["rev-parse", "--verify", runRef])
    expect(stillThere.trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(await listPendingOperations(commonDir)).toEqual([])
  })
})

describe("storage faults", () => {
  test("a torn or hand-corrupted record reads as corrupt, never as a valid operation", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const corruptId = "corruptop0000000000000000000000000000000000"
    await mkdir(join(operationsRoot(commonDir), corruptId), { recursive: true })
    await writeFile(join(operationsRoot(commonDir), corruptId, "operation.json"), "{ not json")
    const corrupt = await readOperation(commonDir, corruptId)
    expect(corrupt.status).toBe("corrupt")

    const newerId = "newerop0000000000000000000000000000000000000"
    await mkdir(join(operationsRoot(commonDir), newerId), { recursive: true })
    await writeFile(join(operationsRoot(commonDir), newerId, "operation.json"), JSON.stringify({ schemaVersion: 99, operationId: newerId, kind: "close", createdAt: 1, updatedAt: 1, status: "pending", steps: [], protectiveRefs: [] }))
    const newer = await readOperation(commonDir, newerId)
    expect(newer.status).toBe("unsupported")
    expect(await listPendingOperations(commonDir)).toEqual([])
  })

  test("a leftover temp file from an interrupted write is ignored by readers", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "push", steps: ["push"] })
    if (!created.ok) throw new Error("setup failed")
    await writeFile(join(operationsRoot(commonDir), created.operation.operationId, "operation.json.abc.tmp"), "torn write")
    const read = await readOperation(commonDir, created.operation.operationId)
    expect(read.status).toBe("found")
  })

  test("the journal survives removal of the checkout the operation may mutate", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "doomed", branch: "feat/doomed" }] })
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "close", intent: { checkout: fixture.worktrees["doomed"] }, steps: ["remove"] })
    if (!created.ok) throw new Error("setup failed")
    await rm(fixture.worktrees["doomed"]!, { recursive: true, force: true })
    const read = await readOperation(commonDir, created.operation.operationId)
    expect(read.status).toBe("found")
    if (read.status === "found") expect((read.value.intent as { checkout: string }).checkout).toContain("doomed")
  })

  test("a persist failure at creation blocks the operation instead of half-registering it", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const root = operationsRoot(commonDir)
    await mkdir(join(commonDir, "convoy"), { recursive: true })
    // Cross-platform fault injection: a regular file occupies the operations
    // root, so creating the record directory fails with a filesystem error on
    // every platform (no POSIX-only permission bits involved).
    await writeFile(root, "not a directory")
    const created = await createOperation(commonDir, { kind: "push", steps: ["push"] })
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.reason).toBeTruthy()
    // Nothing half-registered: no pending operation is listable.
    expect(await listPendingOperations(commonDir)).toEqual([])
  })

  test("journals live outside every checkout, under the common dir", async () => {
    const fixture = await createFixtureRepo({ worktrees: [{ name: "wt", branch: "feat/wt" }] })
    fixtures.push(fixture)
    const commonDir = (await fixture.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    const created = await createOperation(commonDir, { kind: "close", steps: ["step"] })
    if (!created.ok) throw new Error("setup failed")
    const stored = await readFile(join(operationsRoot(commonDir), created.operation.operationId, "operation.json"), "utf8")
    expect(JSON.parse(stored)).toMatchObject({ kind: "close" })
    expect(operationsRoot(commonDir)).toContain(join(".git", "convoy", "operations"))
    // Not inside the removable worktree.
    expect(operationsRoot(commonDir).startsWith(fixture.worktrees["wt"]!)).toBe(false)
  })
})
