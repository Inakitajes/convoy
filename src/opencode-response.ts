/**
 * OpenCode v2 list endpoints added a location envelope in 1.18. Keep accepting
 * the former bare-array response because the SDK client and the installed
 * OpenCode executable can be on different versions.
 */
export type OpenCodeList<T> = readonly T[] | { readonly data: readonly T[] } | null | undefined

export function unwrapOpenCodeList<T>(value: OpenCodeList<T>): readonly T[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object" && "data" in value) return value.data
  return []
}
