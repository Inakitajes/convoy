import { afterEach, describe, expect, test } from "bun:test"

import { createFixtureRepo, type FixtureRepo } from "./helpers/multi-worktree"
import { acknowledgeStep, createOperation, readOperation, recordStepIntent } from "../src/operation-journal"
import { recoverOperation, type ReconcileFinding } from "../src/operation-recovery"
import { repoCommonDir } from "../src/repo-store"

/**
 * Task 2.4: recovery dispatch inspects actual effects before ordinary
 * preflight, preserves uncertain candidates, and releases only resolved
 * journals. No blind replay, no retained success ledger, no destruction of
 * recoverable work, no deletion of independent run evidence.
 */

const fixtures: FixtureRepo[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

async function commonDirOf(fixture: FixtureRepo): Promise<string> {
  const dir = await repoCommonDir(fixture.root)
  if (!dir) throw new Error("fixture has no common dir")
  return dir
}

async function setupPending(fixture: FixtureRepo, steps: string[], intent?: unknown): Promise<string> {
  const commonDir = await commonDirOf(fixture)
  const created = await createOperation(commonDir, { kind: "close", intent, steps })
  if (!created.ok) throw new Error(`setup failed: ${"reason" in created ? created.reason : ""}`)
  for (const step of steps) await recordStepIntent(commonDir, created.operation.operationId, step, { step })
  return created.operation.operationId
}

describe("recoverOperation", () => {
  test("inspect-only consent never mutates beyond recording verified effects", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const id = await setupPending(fixture, ["land", "cleanup"])
    // "land" already happened in reality; "cleanup" did not.
    const probe = async (_step: { id: string }): Promise<ReconcileFinding> =>
      _step.id === "land" ? { finding: "verified", evidence: { landing: "abc" } } : { finding: "pending", reason: "worktree still exists" }

    const outcome = await recoverOperation({ commonDir, operationId: id, gitCwd: fixture.root, probe })
    expect(outcome.status).toBe("awaiting-consent")
    if (outcome.status === "awaiting-consent") {
      expect(outcome.reconciliation).toEqual([
        { stepId: "land", state: "verified", evidence: { landing: "abc" } },
        { stepId: "cleanup", state: "pending", reason: "worktree still exists" },
      ])
    }
    // The verified effect is durable; the pending step is untouched.
    const read = await readOperation(commonDir, id)
    if (read.status !== "found") throw new Error("journal vanished")
    expect(read.value.steps[0]!.acknowledgement).toBeDefined()
    expect(read.value.steps[1]!.acknowledgement).toBeUndefined()
  })

  test("a fully reconciled journal resolves without further consent", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const id = await setupPending(fixture, ["land"])
    const outcome = await recoverOperation({
      commonDir,
      operationId: id,
      gitCwd: fixture.root,
      probe: async () => ({ finding: "verified", evidence: { ok: true } }),
    })
    expect(outcome.status).toBe("reconciled")
    expect(await readOperation(commonDir, id).then((read) => read.status)).toBe("missing")
  })

  test("unexplained evidence blocks every mode and refuses to guess", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const id = await setupPending(fixture, ["land"])
    const probe = async (): Promise<ReconcileFinding> => ({ finding: "unexplained", reason: "base moved without containing the candidate" })
    expect((await recoverOperation({ commonDir, operationId: id, gitCwd: fixture.root, probe })).status).toBe("blocked")
    expect(
      (await recoverOperation({ commonDir, operationId: id, gitCwd: fixture.root, probe, consent: "continue" })).status,
    ).toBe("blocked")
    expect(
      (await recoverOperation({ commonDir, operationId: id, gitCwd: fixture.root, probe, consent: "cancel" })).status,
    ).toBe("blocked")
    // Nothing was cancelled or deleted by the blocked attempts.
    expect((await readOperation(commonDir, id)).status).toBe("found")
  })

  test("continue leaves pending work for fresh preflight; verified effects are never replayed", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const id = await setupPending(fixture, ["land", "cleanup"])
    const probe = async (step: { id: string }): Promise<ReconcileFinding> => (step.id === "land" ? { finding: "verified" } : { finding: "pending" })
    const outcome = await recoverOperation({ commonDir, operationId: id, gitCwd: fixture.root, probe, consent: "continue" })
    expect(outcome.status).toBe("needs-work")
    if (outcome.status === "needs-work") expect(outcome.remaining).toEqual(["cleanup"])
    // The verified landing is now acknowledged in the journal.
    const read = await readOperation(commonDir, id)
    if (read.status !== "found") throw new Error("journal vanished")
    expect(read.value.steps.map((step) => step.acknowledgement !== undefined)).toEqual([true, false])
  })

  test("cancel explicitly cancels remaining steps and resolves the operation", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const id = await setupPending(fixture, ["land", "cleanup"])
    const probe = async (): Promise<ReconcileFinding> => ({ finding: "pending" })
    const outcome = await recoverOperation({ commonDir, operationId: id, gitCwd: fixture.root, probe, consent: "cancel" })
    expect(outcome.status).toBe("cancelled")
    expect(await readOperation(commonDir, id).then((read) => read.status)).toBe("missing")
  })

  test("an unknown id, another repository's journal, or an unsupported version never replays", async () => {
    const fixture = await createFixtureRepo({})
    const other = await createFixtureRepo({})
    fixtures.push(fixture, other)
    const probe = async (): Promise<ReconcileFinding> => ({ finding: "verified" })
    const outcome = await recoverOperation({ commonDir: await commonDirOf(fixture), operationId: "no-such-id", gitCwd: fixture.root, probe, consent: "continue" })
    expect(outcome.status).toBe("unknown-operation")

    // A journal written by another repository is not found here.
    const otherId = await setupPending(other, ["land"])
    const foreign = await recoverOperation({ commonDir: await commonDirOf(fixture), operationId: otherId, gitCwd: fixture.root, probe, consent: "continue" })
    expect(foreign.status).toBe("unknown-operation")
  })

  test("already-acknowledged steps are reported without being re-probed or re-executed", async () => {
    const fixture = await createFixtureRepo({})
    fixtures.push(fixture)
    const commonDir = await commonDirOf(fixture)
    const id = await setupPending(fixture, ["sync", "archive"])
    // Pre-acknowledge sync with a recorded verified outcome.
    await acknowledgeStep(commonDir, id, "sync", { synced: true })
    let probed: string[] = []
    const probe = async (step: { id: string }): Promise<ReconcileFinding> => {
      probed.push(step.id)
      return { finding: "pending" }
    }
    const outcome = await recoverOperation({ commonDir, operationId: id, gitCwd: fixture.root, probe })
    expect(outcome.status).toBe("awaiting-consent")
    expect(probed).toEqual(["archive"])
    if (outcome.status === "awaiting-consent") {
      expect(outcome.reconciliation).toEqual([
        { stepId: "sync", state: "already-done" },
        { stepId: "archive", state: "pending" },
      ])
    }
  })
})
