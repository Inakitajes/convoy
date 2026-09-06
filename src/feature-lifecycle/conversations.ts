import { join } from "node:path"

import {
  isUuid,
  lifecycleSchemaVersion,
  readJsonFile,
  withFeatureLock,
  writeJsonFile,
  type StoreRead,
} from "./store"
import { featureDir } from "./records"

/**
 * Feature-owned authoring conversation associations (capability
 * `work-conversations`, design D2): versioned records under the existing
 * feature directory, keyed by the feature's stable identity — never a second
 * ownership registry.
 *
 * Layout:
 *
 *   <git-common-dir>/convoy/features/<feature-id>/conversations/conversations.json
 *
 * Deliberate separation from `feature.json` (design D2): conversation and
 * navigation writes must not advance the *execution* association revision,
 * because accepted run plans freeze that revision — a navigation write that
 * bumped it would invalidate every reviewed plan. This record carries its own
 * monotonic revision for optimistic concurrency between two Convoy instances
 * (capability work-context: both associations are preserved, or a visible
 * retryable conflict is returned — no silent lost update).
 *
 * Old feature records load without eager migration: a feature directory
 * without a conversations record simply has none yet.
 */

/** The harness a conversation was authored with. OpenCode is the only adapter. */
export type ConversationHarness = "opencode"

/** One linked authoring conversation: a harness-qualified session reference. */
export type ConversationRef = {
  /** The harness's public session id (opaque; never an identity for Convoy records). */
  sessionId: string
  harness: ConversationHarness
  /** Operator-facing label, when one was given. */
  label?: string
  createdAt: number
  /** Last time this conversation was selected for resume (navigation only). */
  lastSelectedAt?: number
}

/** The versioned conversation record for one feature. */
export type ConversationRecord = {
  schemaVersion: number
  /** Embedded identity: must agree with the record's feature directory. */
  featureId: string
  /** Monotonically increasing; optimistic-concurrency token for edits. */
  revision: number
  conversations: ConversationRef[]
  /** The default resume target: the most recently selected conversation. */
  lastSelectedId?: string
  createdAt: number
  updatedAt: number
}

function conversationsPath(commonDir: string, featureId: string): string {
  return join(featureDir(commonDir, featureId), "conversations", "conversations.json")
}

export function validateConversationRecord(value: unknown): ConversationRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== lifecycleSchemaVersion) return undefined
  if (typeof record.featureId !== "string" || !isUuid(record.featureId)) return undefined
  if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 1) return undefined
  if (typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") return undefined
  if (!Array.isArray(record.conversations)) return undefined
  const conversations: ConversationRef[] = []
  for (const entry of record.conversations) {
    if (typeof entry !== "object" || entry === null) return undefined
    const raw = entry as Record<string, unknown>
    if (typeof raw.sessionId !== "string" || raw.sessionId === "") return undefined
    if (raw.harness !== "opencode") return undefined
    if (typeof raw.createdAt !== "number") return undefined
    conversations.push({
      sessionId: raw.sessionId,
      harness: "opencode",
      ...(typeof raw.label === "string" ? { label: raw.label } : {}),
      createdAt: raw.createdAt,
      ...(typeof raw.lastSelectedAt === "number" ? { lastSelectedAt: raw.lastSelectedAt } : {}),
    })
  }
  return {
    schemaVersion: lifecycleSchemaVersion,
    featureId: record.featureId,
    revision: record.revision,
    conversations,
    ...(typeof record.lastSelectedId === "string" ? { lastSelectedId: record.lastSelectedId } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** Reads one feature's conversation record. A foreign record is corrupt (same rule as feature records). */
export async function readConversationRecord(commonDir: string, featureId: string): Promise<StoreRead<ConversationRecord>> {
  if (!isUuid(featureId)) return { status: "corrupt", reason: "feature id is not a uuid" }
  const read = await readJsonFile(conversationsPath(commonDir, featureId), validateConversationRecord, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > lifecycleSchemaVersion,
  })
  if (read.status === "found" && read.value.featureId !== featureId) {
    return { status: "corrupt", reason: "embedded identity disagrees with the record's location" }
  }
  return read
}

/**
 * Adds a conversation reference, preserving concurrent additions: the whole
 * read-append-write cycle runs under the feature's lock (the same
 * serialization association edits use), and an id that is already linked is
 * returned unchanged instead of duplicated (design D3: retrying or adopting
 * a partial result must not create a duplicate).
 */
export async function addConversation(input: {
  commonDir: string
  featureId: string
  sessionId: string
  harness?: ConversationHarness
  label?: string
}): Promise<{ record: ConversationRecord } | { status: "corrupt" | "unsupported" | "unreadable"; reason?: string; schemaVersion?: unknown }> {
  let outcome: { record: ConversationRecord } | { status: "corrupt" | "unsupported" | "unreadable"; reason?: string; schemaVersion?: unknown } = {
    status: "unreadable",
    reason: "unreached",
  }
  await withFeatureLock(join(featureDir(input.commonDir, input.featureId)), async () => {
    const read = await readConversationRecord(input.commonDir, input.featureId)
    if (read.status === "missing") {
      const record: ConversationRecord = {
        schemaVersion: lifecycleSchemaVersion,
        featureId: input.featureId,
        revision: 1,
        conversations: [
          {
            sessionId: input.sessionId,
            harness: input.harness ?? "opencode",
            ...(input.label ? { label: input.label } : {}),
            createdAt: Date.now(),
          },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await writeJsonFile(conversationsPath(input.commonDir, input.featureId), record)
      outcome = { record }
      return
    }
    if (read.status !== "found") {
      outcome =
        read.status === "unsupported"
          ? { status: "unsupported", schemaVersion: read.schemaVersion }
          : { status: read.status, reason: read.reason }
      return
    }
    const existing = read.value.conversations.find((entry) => entry.sessionId === input.sessionId)
    if (existing) {
      outcome = { record: read.value }
      return
    }
    const record: ConversationRecord = {
      ...read.value,
      revision: read.value.revision + 1,
      conversations: [
        ...read.value.conversations,
        {
          sessionId: input.sessionId,
          harness: input.harness ?? "opencode",
          ...(input.label ? { label: input.label } : {}),
          createdAt: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    }
    await writeJsonFile(conversationsPath(input.commonDir, input.featureId), record)
    outcome = { record }
  })
  return outcome
}

/**
 * Records a resume/selection (navigation): marks the conversation selected
 * and makes it the default resume target. Navigation writes never touch
 * `feature.json` — the execution association revision stays frozen (design
 * D2) — and never fail a selection when the record is missing (a selection
 * without a linked conversation is a no-op, not an error).
 */
export async function touchConversationSelection(input: { commonDir: string; featureId: string; sessionId: string }): Promise<void> {
  await withFeatureLock(join(featureDir(input.commonDir, input.featureId)), async () => {
    const read = await readConversationRecord(input.commonDir, input.featureId)
    if (read.status !== "found") return
    const target = read.value.conversations.find((entry) => entry.sessionId === input.sessionId)
    if (!target) return
    const record: ConversationRecord = {
      ...read.value,
      revision: read.value.revision + 1,
      conversations: read.value.conversations.map((entry) =>
        entry.sessionId === input.sessionId ? { ...entry, lastSelectedAt: Date.now() } : entry,
      ),
      lastSelectedId: input.sessionId,
      updatedAt: Date.now(),
    }
    await writeJsonFile(conversationsPath(input.commonDir, input.featureId), record)
  })
}
