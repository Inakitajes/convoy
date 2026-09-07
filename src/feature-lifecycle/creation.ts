import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { isUuid, lifecycleSchemaVersion, readJsonFile, writeJsonFile, type StoreRead } from "./store"

/**
 * Creation-intent records (capability work-context, design D3): recovery
 * evidence for the create-work flow, written BEFORE the worktree exists and
 * finalized only when the feature association is registered. The intent is
 * never lifecycle status — a pending intent means "creation may have
 * partially happened", and recovery reconciles it against Git evidence
 * instead of trusting the record.
 *
 * Layout:
 *
 *   <git-common-dir>/convoy/creations/<operation-id>.json
 */

export type CreationIntentStatus = "pending" | "completed"

/** One create-work operation's durable intent. */
export type CreationIntent = {
  schemaVersion: number
  /** Opaque operation id; also the filename. */
  operationId: string
  repositoryId: string
  /** The operator's name for the work (independent of any change id). */
  displayName: string
  branch: string
  base: string
  /** The planned worktree destination (the path creation was asked for). */
  worktree: string
  /** The registered feature, set only when association persistence succeeded. */
  featureId?: string
  status: CreationIntentStatus
  createdAt: number
  updatedAt: number
}

function creationPath(commonDir: string, operationId: string): string {
  return join(commonDir, "convoy", "creations", `${operationId}.json`)
}

export function validateCreationIntent(value: unknown): CreationIntent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== lifecycleSchemaVersion) return undefined
  if (typeof record.operationId !== "string" || !isUuid(record.operationId)) return undefined
  if (typeof record.repositoryId !== "string" || !isUuid(record.repositoryId)) return undefined
  if (typeof record.displayName !== "string" || record.displayName === "") return undefined
  if (typeof record.branch !== "string" || record.branch === "") return undefined
  if (typeof record.base !== "string" || record.base === "") return undefined
  if (typeof record.worktree !== "string" || record.worktree === "") return undefined
  if (record.status !== "pending" && record.status !== "completed") return undefined
  if (typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") return undefined
  return {
    schemaVersion: lifecycleSchemaVersion,
    operationId: record.operationId,
    repositoryId: record.repositoryId,
    displayName: record.displayName,
    branch: record.branch,
    base: record.base,
    worktree: record.worktree,
    ...(typeof record.featureId === "string" && isUuid(record.featureId) ? { featureId: record.featureId } : {}),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Persists the intent before any filesystem effect. A persistence failure
 * here means creation MUST NOT proceed (design D3: an inability to persist
 * required intent blocks the mutation) — the caller gets the error, not a
 * half-created worktree with no recovery evidence.
 */
export async function beginCreationIntent(
  commonDir: string,
  input: { repositoryId: string; displayName: string; branch: string; base: string; worktree: string },
): Promise<CreationIntent> {
  const now = Date.now()
  const intent: CreationIntent = {
    schemaVersion: lifecycleSchemaVersion,
    operationId: crypto.randomUUID(),
    repositoryId: input.repositoryId,
    displayName: input.displayName,
    branch: input.branch,
    base: input.base,
    worktree: input.worktree,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  }
  await writeJsonFile(creationPath(commonDir, intent.operationId), intent)
  return intent
}

/** Marks the intent completed once the feature association is durably registered. */
export async function completeCreationIntent(commonDir: string, operationId: string, featureId: string): Promise<void> {
  const read = await readJsonFile(creationPath(commonDir, operationId), validateCreationIntent, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > lifecycleSchemaVersion,
  })
  if (read.status !== "found") return
  await writeJsonFile(creationPath(commonDir, operationId), {
    ...read.value,
    featureId,
    status: "completed",
    updatedAt: Date.now(),
  })
}

/** Reads one intent (typed); recovery consumers surface unreadable records rather than skipping them silently. */
export async function readCreationIntent(commonDir: string, operationId: string): Promise<StoreRead<CreationIntent>> {
  if (!isUuid(operationId)) return { status: "corrupt", reason: "operation id is not a uuid" }
  return readJsonFile(creationPath(commonDir, operationId), validateCreationIntent, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > lifecycleSchemaVersion,
  })
}

/**
 * Lists every intent whose outcome is not yet reconciled (design D3:
 * "discover orphaned results even if final registration failed"). Completed
 * intents are history; pending ones are the recovery surface. Unreadable or
 * corrupt records are returned as typed failures so recovery can name them
 * instead of silently ignoring possible authored content.
 */
export async function listPendingCreationIntents(
  commonDir: string,
): Promise<Array<{ operationId: string; read: StoreRead<CreationIntent> }>> {
  let entries
  try {
    entries = await readdir(join(commonDir, "convoy", "creations"), { withFileTypes: true })
  } catch {
    return []
  }
  const ids = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && isUuid(entry.name.replace(/\.json$/, "")))
    .map((entry) => entry.name.replace(/\.json$/, ""))
  const reads = await Promise.all(ids.map(async (operationId) => ({ operationId, read: await readCreationIntent(commonDir, operationId) })))
  return reads.filter((entry) => entry.read.status !== "found" || entry.read.value.status === "pending")
}
