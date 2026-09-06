import { join } from "node:path"

import { isUuid, lifecycleSchemaVersion, readJsonFile, writeJsonFile, type StoreRead } from "./store"

/**
 * Repository-local navigation preferences (capability work-context /
 * home-launcher, task 6.4): the last valid work selection, restored when
 * Convoy reopens in any checkout of the repository. Plain navigation state —
 * never lifecycle status, never an ownership record.
 *
 * Layout: <common-dir>/convoy/preferences.json
 */

export type NavigationPreferences = {
  schemaVersion: number
  /** The last work selection, when it was valid at write time. */
  lastFeatureId?: string
  updatedAt: number
}

function preferencesPath(commonDir: string): string {
  return join(commonDir, "convoy", "preferences.json")
}

export function validatePreferences(value: unknown): NavigationPreferences | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== lifecycleSchemaVersion) return undefined
  if (typeof record.updatedAt !== "number") return undefined
  return {
    schemaVersion: lifecycleSchemaVersion,
    ...(typeof record.lastFeatureId === "string" && isUuid(record.lastFeatureId) ? { lastFeatureId: record.lastFeatureId } : {}),
    updatedAt: record.updatedAt,
  }
}

/** Reads the navigation preferences; a missing record is simply "no memory". */
export async function readPreferences(commonDir: string): Promise<StoreRead<NavigationPreferences>> {
  return readJsonFile(preferencesPath(commonDir), validatePreferences, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > lifecycleSchemaVersion,
  })
}

/** Persists the last valid work selection (a navigation write, never an association edit). */
export async function writeLastFeatureSelection(commonDir: string, featureId: string | undefined): Promise<void> {
  const read = await readPreferences(commonDir)
  const previous = read.status === "found" ? read.value : undefined
  await writeJsonFile(preferencesPath(commonDir), {
    schemaVersion: lifecycleSchemaVersion,
    ...(featureId ? { lastFeatureId: featureId } : {}),
    updatedAt: Date.now(),
    // Preserve unknown future fields is not attempted: the validator drops
    // them on read, and preferences carry no recovery evidence.
    ...(previous?.lastFeatureId && featureId === undefined ? { lastFeatureId: previous.lastFeatureId } : {}),
  })
}
