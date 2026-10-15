import { describe, expect, test } from "bun:test"

import { attemptCompositionFor, releaseAttemptCompositions } from "../src/runners/attempt-composition"

describe("run-lifetime attempt composition", () => {
  test("the same run directory reuses one composition", async () => {
    try {
      const first = attemptCompositionFor({ cwd: "/tmp/convoy-composition-a" })
      const second = attemptCompositionFor({ cwd: "/tmp/convoy-composition-a" })
      expect(second).toBe(first)
    } finally {
      await releaseAttemptCompositions()
    }
  })

  test("a different directory gets its own composition", async () => {
    try {
      const a = attemptCompositionFor({ cwd: "/tmp/convoy-composition-a" })
      const b = attemptCompositionFor({ cwd: "/tmp/convoy-composition-b" })
      expect(b).not.toBe(a)
    } finally {
      await releaseAttemptCompositions()
    }
  })

  test("releasing drops the cache so the next run builds a fresh composition", async () => {
    const first = attemptCompositionFor({ cwd: "/tmp/convoy-composition-c" })
    await releaseAttemptCompositions()
    const second = attemptCompositionFor({ cwd: "/tmp/convoy-composition-c" })
    expect(second).not.toBe(first)
    await releaseAttemptCompositions()
  })
})
