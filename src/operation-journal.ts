import { mkdir, readdir, rm } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { execFile } from "./git"
import { isSafePathSegment, readJsonFile, withExclusiveLock, writeJsonFile, type StoreRead } from "./repo-store"

/**
 * Unresolved-operation journals (change `worktree-control-center`, task 2.3,
 * design D9): temporary, operation-scoped recovery records that survive
 * removal of the checkout an operation may mutate. They live under
 * `<git-common-dir>/convoy/operations/<operation-id>/` — never inside a
 * checkout, and never in the removable `.git` administrative directory of a
 * worktree. Records are written owner-readable only (0600): they carry
 * reviewed targets and operation intent, not public state.
 *
 * Contract:
 * - **Intent before effect.** The record (with its pending steps and frozen
 *   inputs) is written before the first irreversible or externally visible
 *   mutation; a persistence failure blocks the mutation.
 * - **Acknowledgement after verified effect.** A step's acknowledgement is
 *   recorded only after the effect was verified. A missing acknowledgement
 *   is not evidence that the effect failed; recovery inspects reality.
 * - **Bounded lifetime.** Resolved or safely cancelled operations delete
 *   their journal and their protective temporary refs. They never become a
 *   landing ledger, history registry, or cleanup authority, and they never
 *   touch durable run records or compaction refs.
 */

export const operationSchemaVersion = 1

/** One recorded step of an operation, from frozen intent to verified outcome. */
export type OperationStep = {
  id: string
  /** What was decided before the effect (frozen reviewed inputs). Optional until recorded. */
  intent?: unknown
  /** Recorded only after the effect was verified. Absent ≠ failed. */
  acknowledgement?: { at: number; evidence?: unknown }
  /** True when the step was explicitly cancelled without effect. */
  cancelled?: boolean
}

export type OperationRecord = {
  schemaVersion: number
  /** Opaque operation id; identifies unresolved attempts only. */
  operationId: string
  /** The operation family (e.g. `close`, `push`, `pr`, `archive`, `worktree-create`). */
  kind: string
  createdAt: number
  updatedAt: number
  status: "pending" | "resolved" | "cancelled"
  /** The reviewed inputs frozen before any effect. */
  intent: unknown
  steps: OperationStep[]
  /** Protective temporary refs recorded while unresolved; released on resolution. */
  protectiveRefs: string[]
}

export function validateOperationRecord(value: unknown): OperationRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== operationSchemaVersion) return undefined
  if (typeof record.operationId !== "string" || !isSafePathSegment(record.operationId)) return undefined
  if (typeof record.kind !== "string" || record.kind === "") return undefined
  if (typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") return undefined
  if (record.status !== "pending" && record.status !== "resolved" && record.status !== "cancelled") return undefined
  if (!Array.isArray(record.steps)) return undefined
  if (!Array.isArray(record.protectiveRefs)) return undefined
  const steps: OperationStep[] = []
  for (const raw of record.steps) {
    if (typeof raw !== "object" || raw === null) return undefined
    const step = raw as Record<string, unknown>
    if (typeof step.id !== "string" || step.id === "") return undefined
    steps.push({
      id: step.id,
      ...(step.intent !== undefined ? { intent: step.intent } : {}),
      ...(step.acknowledgement !== undefined && typeof step.acknowledgement === "object" && step.acknowledgement !== null
        ? {
            acknowledgement: {
              at: typeof (step.acknowledgement as Record<string, unknown>).at === "number" ? (step.acknowledgement as { at: number }).at : Date.now(),
              ...((step.acknowledgement as Record<string, unknown>).evidence !== undefined
                ? { evidence: (step.acknowledgement as Record<string, unknown>).evidence }
                : {}),
            },
          }
        : {}),
      ...(step.cancelled === true ? { cancelled: true } : {}),
    })
  }
  const refs: string[] = []
  for (const ref of record.protectiveRefs) {
    if (typeof ref !== "string" || !ref.startsWith("refs/")) return undefined
    refs.push(ref)
  }
  return {
    schemaVersion: operationSchemaVersion,
    operationId: record.operationId,
    kind: record.kind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    intent: record.intent,
    steps,
    protectiveRefs: refs,
  }
}

/** `<commonDir>/convoy/operations` — the unresolved-operation root. */
export function operationsRoot(commonDir: string): string {
  return join(commonDir, "convoy", "operations")
}

function operationDir(commonDir: string, operationId: string): string {
  return join(operationsRoot(commonDir), operationId)
}

function operationPath(commonDir: string, operationId: string): string {
  return join(operationDir(commonDir, operationId), "operation.json")
}

/** Reads one operation; unknown, hostile, or relative ids read as missing, never guessed. */
export async function readOperation(commonDir: string, operationId: string): Promise<StoreRead<OperationRecord>> {
  if (!isSafePathSegment(operationId) || !isAbsolute(commonDir)) return { status: "missing" }
  return readJsonFile(operationPath(commonDir, operationId), validateOperationRecord, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > operationSchemaVersion,
  })
}

/** Lists pending operation ids in this repository (opaque ids only). */
export async function listPendingOperations(commonDir: string): Promise<string[]> {
  if (!isAbsolute(commonDir)) return []
  let ids: string[]
  try {
    ids = await readdir(operationsRoot(commonDir))
  } catch {
    return []
  }
  const pending: string[] = []
  for (const id of ids) {
    if (!isSafePathSegment(id)) continue
    const read = await readOperation(commonDir, id)
    if (read.status === "found" && read.value.status === "pending") pending.push(id)
  }
  return pending.sort()
}

export type OperationCreation =
  | { ok: true; operation: OperationRecord }
  | { ok: false; reason: string }

/**
 * Creates an unresolved operation with its frozen intent and pending steps,
 * before any effect. Every step starts pending; intents may be recorded
 * per step or supplied here. The operation id is opaque — callers must not
 * encode branch names, change ids, or paths into it.
 */
export async function createOperation(
  commonDir: string,
  input: { kind: string; intent?: unknown; steps: readonly string[] },
): Promise<OperationCreation> {
  // Journals must live under an absolute common dir: a relative one would
  // silently resolve against the process cwd instead of the repository.
  if (!isAbsolute(commonDir)) return { ok: false, reason: "common dir must be an absolute path" }
  if (input.steps.length === 0) return { ok: false, reason: "an operation needs at least one recorded step" }
  if (!input.steps.every((step) => step !== "")) return { ok: false, reason: "step ids must be non-empty" }
  if (new Set(input.steps).size !== input.steps.length) return { ok: false, reason: "step ids must be distinct" }
  const now = Date.now()
  const record: OperationRecord = {
    schemaVersion: operationSchemaVersion,
    operationId: crypto.randomUUID(),
    kind: input.kind,
    createdAt: now,
    updatedAt: now,
    status: "pending",
    intent: input.intent,
    steps: input.steps.map((id) => ({ id })),
    protectiveRefs: [],
  }
  try {
    await writeJsonFile(operationPath(commonDir, record.operationId), record, { mode: 0o600 })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, operation: record }
}

export type OperationMutation =
  | { ok: true; operation: OperationRecord }
  | { ok: false; reason: string }

async function mutateOperation(
  commonDir: string,
  operationId: string,
  mutate: (record: OperationRecord) => OperationRecord | undefined,
): Promise<OperationMutation> {
  // A hostile id or a relative root must never reach the filesystem as a path.
  if (!isSafePathSegment(operationId) || !isAbsolute(commonDir)) return { ok: false, reason: "operation id is not a safe record id" }
  let outcome: OperationMutation = { ok: false, reason: "operation could not be read" }
  await withExclusiveLock(operationDir(commonDir, operationId), async () => {
    const read = await readOperation(commonDir, operationId)
    if (read.status !== "found") {
      outcome = { ok: false, reason: read.status === "unsupported" ? `operation ${operationId} uses an unsupported schema version` : `operation ${operationId} is not a readable pending record` }
      return
    }
    const updated = mutate(read.value)
    if (!updated) {
      outcome = { ok: false, reason: `operation ${operationId} does not accept that mutation in its current state` }
      return
    }
    updated.updatedAt = Date.now()
    try {
      await writeJsonFile(operationPath(commonDir, operationId), updated, { mode: 0o600 })
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) }
      return
    }
    outcome = { ok: true, operation: updated }
  })
  return outcome
}

/** Records a step's frozen intent before its effect. */
export async function recordStepIntent(
  commonDir: string,
  operationId: string,
  stepId: string,
  intent: unknown,
): Promise<OperationMutation> {
  return mutateOperation(commonDir, operationId, (record) => {
    const step = record.steps.find((entry) => entry.id === stepId)
    if (!step || step.acknowledgement || step.cancelled) return undefined
    return { ...record, steps: record.steps.map((entry) => (entry.id === stepId ? { ...entry, intent } : entry)) }
  })
}

/**
 * Acknowledges a verified effect. Callers must verify the effect in reality
 * first — an acknowledgement is a claim about observed output, not a
 * substitute for it.
 */
export async function acknowledgeStep(
  commonDir: string,
  operationId: string,
  stepId: string,
  evidence?: unknown,
): Promise<OperationMutation> {
  return mutateOperation(commonDir, operationId, (record) => {
    const step = record.steps.find((entry) => entry.id === stepId)
    // Intent must exist before an effect can be acknowledged: an effect
    // nobody recorded the inputs for is not one recovery can verify later.
    if (!step || (step.intent === undefined && record.intent === undefined)) return undefined
    if (step.acknowledgement || step.cancelled) return undefined
    return {
      ...record,
      steps: record.steps.map((entry) => (entry.id === stepId ? { ...entry, acknowledgement: { at: Date.now(), ...(evidence !== undefined ? { evidence } : {}) } } : entry)),
    }
  })
}

/** Records a protective temporary ref while the operation is unresolved. */
export async function addProtectiveRef(commonDir: string, operationId: string, ref: string): Promise<OperationMutation> {
  if (!ref.startsWith("refs/")) return { ok: false, reason: `protective refs must live under refs/ (got ${ref})` }
  return mutateOperation(commonDir, operationId, (record) => {
    if (record.protectiveRefs.includes(ref)) return undefined
    return { ...record, protectiveRefs: [...record.protectiveRefs, ref] }
  })
}

/**
 * Marks a step explicitly cancelled without effect (a deliberate decision,
 * not an inferred one).
 */
export async function cancelStep(commonDir: string, operationId: string, stepId: string): Promise<OperationMutation> {
  return mutateOperation(commonDir, operationId, (record) => {
    const step = record.steps.find((entry) => entry.id === stepId)
    if (!step || step.acknowledgement || step.cancelled) return undefined
    return { ...record, steps: record.steps.map((entry) => (entry.id === stepId ? { ...entry, cancelled: true } : entry)) }
  })
}

export type OperationResolution =
  | { ok: true; released: { journal: boolean; refs: string[] } }
  | { ok: false; reason: string }

/**
 * Resolves a fully handled operation and deletes its journal plus its
 * protective refs. Steps must each be acknowledged or explicitly cancelled —
 * resolution is refused while a step is still undecided, so unresolved
 * effects can never be silently dropped. Only this operation's own
 * directory and listed refs are released: durable run records, compaction
 * backups, and anything not recorded here stay untouched.
 */
export async function resolveOperation(input: {
  commonDir: string
  operationId: string
  /** Any worktree of the repository, for `git update-ref -d` on protective refs. */
  gitCwd: string
  outcome: "resolved" | "cancelled"
}): Promise<OperationResolution> {
  if (!isAbsolute(input.commonDir)) return { ok: false, reason: "common dir must be an absolute path" }
  const read = await readOperation(input.commonDir, input.operationId)
  if (read.status !== "found") {
    return { ok: false, reason: read.status === "unsupported" ? "operation uses an unsupported schema version" : "operation is not a readable pending record" }
  }
  const record = read.value
  const undecided = record.steps.filter((step) => !step.acknowledgement && !step.cancelled)
  if (undecided.length > 0) {
    return { ok: false, reason: `operation ${record.operationId} still has undecided steps: ${undecided.map((step) => step.id).join(", ")}` }
  }

  const released: string[] = []
  for (const ref of record.protectiveRefs) {
    const result = await execFile("git", ["update-ref", "-d", ref], { cwd: input.gitCwd, allowFailure: true })
    if (result.exitCode === 0) released.push(ref)
    // A ref that was already gone counts as released; a failure to delete
    // (locked, packed-refs edge) leaves the journal decision below careful.
  }

  const journalRemoved = await rm(operationDir(input.commonDir, input.operationId), { recursive: true, force: true }).then(
    () => true,
    () => false,
  )
  return { ok: true, released: { journal: journalRemoved, refs: released } }
}

/** Ensures the operations root exists (creation-time only, never on read). */
export async function ensureOperationsRoot(commonDir: string): Promise<void> {
  await mkdir(operationsRoot(commonDir), { recursive: true })
}
