const minimumOpenCodeVersion = "1.18.4"

/** Extracts entries from OpenCode's location-scoped v2 discovery response. */
export function discoveryData<T>(payload: { data: T[] } | undefined, resource: string): readonly T[] {
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error(`Cannot read OpenCode ${resource}: OpenCode ${minimumOpenCodeVersion} or newer is required`)
  }
  return payload.data
}
