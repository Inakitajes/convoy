import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  isFound,
  isSafePathSegment,
  isSafeRelativePath,
  isUuid,
  pathExists,
  readJsonFile,
  removePath,
  withExclusiveLock,
  writeJsonFile,
} from "../src/repo-store"

/**
 * Generic repository storage primitives (change `worktree-control-center`,
 * task 2.1). These were extracted from the feature-lifecycle store so the
 * worktree control center can persist coordination data without importing the
 * feature domain. This suite tests the generic layer directly — the
 * identity/path-safety predicates (which decide whether a corrupt or hostile
 * record can escape its root), typed reads, atomic writes, and lock
 * serialization/stale-theft — since the feature-lifecycle compat tests only
 * exercise them indirectly and leave several uncovered.
 */

const dirs: string[] = []
let root: string

async function tempDir(prefix = "repo-store-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeAll(async () => {
  root = await tempDir()
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("identity and path-safety predicates (generic storage)", () => {
  test("isUuid accepts only canonical opaque UUIDs", () => {
    expect(isUuid("5f0a3c1e-8b2d-4c6a-9e0f-1a2b3c4d5e6f")).toBe(true)
    expect(isUuid("5F0A3C1E-8B2D-4C6A-9E0F-1A2B3C4D5E6F")).toBe(true)
    expect(isUuid("feat/add-widget")).toBe(false)
    expect(isUuid("add-widget")).toBe(false)
    expect(isUuid("")).toBe(false)
    expect(isUuid("5f0a3c1e-8b2d-4c6a-9e0f")).toBe(false)
    expect(isUuid("5f0a3c1e-8b2d-4c6a-9e0f-1a2b3c4d5e6")).toBe(false)
    expect(isUuid("zzz0a3c1e-8b2d-4c6a-9e0f-1a2b3c4d5e6f")).toBe(false)
  })

  test("isSafePathSegment rejects traversal, absolutes, separators, and empty", () => {
    expect(isSafePathSegment("add-widget")).toBe(true)
    expect(isSafePathSegment("feat__x")).toBe(true)
    expect(isSafePathSegment("")).toBe(false)
    expect(isSafePathSegment(".")).toBe(false)
    expect(isSafePathSegment("..")).toBe(false)
    expect(isSafePathSegment("/etc/passwd")).toBe(false)
    expect(isSafePathSegment("\\etc\\passwd")).toBe(false)
    expect(isSafePathSegment("a/b")).toBe(false)
    expect(isSafePathSegment("a\\b")).toBe(false)
    expect(isSafePathSegment("C:evil")).toBe(false)
    expect(isSafePathSegment("C:/evil")).toBe(false)
  })

  test("isSafeRelativePath permits repo-relative paths but never escapes its root", () => {
    expect(isSafeRelativePath("openspec/changes/add-widget/proposal.md")).toBe(true)
    expect(isSafeRelativePath("openspec/specs")).toBe(true)
    expect(isSafeRelativePath("a/b/c")).toBe(true)
    expect(isSafeRelativePath("a\\b\\c")).toBe(true)
    expect(isSafeRelativePath("")).toBe(false)
    expect(isSafeRelativePath("/abs")).toBe(false)
    expect(isSafeRelativePath("\\abs")).toBe(false)
    expect(isSafeRelativePath("C:/abs")).toBe(false)
    expect(isSafeRelativePath("../x")).toBe(false)
    expect(isSafeRelativePath("a/../b")).toBe(false)
    expect(isSafeRelativePath("a\\..\\b")).toBe(false)
    expect(isSafeRelativePath("a/..")).toBe(false)
  })
})

describe("typed reads (readJsonFile)", () => {
  test("a missing file is 'missing', never a fabricated value", async () => {
    const read = await readJsonFile(join(root, "does-not-exist.json"), () => 1)
    expect(read.status).toBe("missing")
  })

  test("a valid document against the validator is found", async () => {
    const path = join(root, "valid.json")
    await writeJsonFile(path, { schemaVersion: 1, value: "ok" })
    const read = await readJsonFile<{ value: string }>(path, (v) => {
      if (typeof v !== "object" || v === null) return undefined
      if (typeof (v as { value?: unknown }).value !== "string") return undefined
      return { value: (v as { value: string }).value }
    })
    expect(isFound(read)).toBe(true)
    if (read.status === "found") expect(read.value).toEqual({ value: "ok" })
  })

  test("malformed JSON is corrupt with a reason, not absence", async () => {
    const path = join(root, "bad.json")
    await writeFile(path, "{not json")
    const read = await readJsonFile(path, () => 1)
    expect(read.status).toBe("corrupt")
    if (read.status === "corrupt") expect(read.reason).toBeTruthy()
  })

  test("a non-object value (array or null) is corrupt", async () => {
    const arrayPath = join(root, "array.json")
    await writeFile(arrayPath, JSON.stringify([1, 2, 3]))
    expect((await readJsonFile(arrayPath, () => 1)).status).toBe("corrupt")

    const nullPath = join(root, "null.json")
    await writeFile(nullPath, "null")
    expect((await readJsonFile(nullPath, () => 1)).status).toBe("corrupt")
  })

  test("a validator that rejects its document yields corrupt, not found", async () => {
    const path = join(root, "reject.json")
    await writeJsonFile(path, { schemaVersion: 1, value: 42 })
    const read = await readJsonFile(path, () => undefined)
    expect(read.status).toBe("corrupt")
    if (read.status === "corrupt") expect(read.reason).toMatch(/validation/i)
  })

  test("the unsupported gate reports a newer schema instead of interpreting it", async () => {
    const path = join(root, "newer.json")
    await writeJsonFile(path, { schemaVersion: 999, value: "future" })
    const read = await readJsonFile(path, () => ({ ok: true }), {
      unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > 1,
    })
    expect(read.status).toBe("unsupported")
    if (read.status === "unsupported") expect(read.schemaVersion).toBe(999)
  })

  test("an I/O failure (directory in place of a file) is unreadable, not missing", async () => {
    const path = join(root, "is-a-dir.json")
    await mkdir(path, { recursive: true })
    const read = await readJsonFile(path, () => 1)
    expect(read.status).toBe("unreadable")
    if (read.status === "unreadable") expect(read.reason).toBeTruthy()
  })
})

describe("atomic writes (writeJsonFile)", () => {
  test("writes the JSON document with a trailing newline", async () => {
    const path = join(root, "written.json")
    await writeJsonFile(path, { a: 1 })
    expect(await readFile(path, "utf8")).toBe(JSON.stringify({ a: 1 }, null, 2) + "\n")
  })

  test("overwrites an existing document atomically in place", async () => {
    const path = join(root, "overwrite.json")
    await writeJsonFile(path, { v: 1 })
    await writeJsonFile(path, { v: 2 })
    const read = await readJsonFile<{ v: number }>(path, (value) => {
      if (typeof value !== "object" || value === null) return undefined
      return typeof (value as { v?: unknown }).v === "number" ? { v: (value as { v: number }).v } : undefined
    })
    expect(isFound(read) && read.value.v).toBe(2)
  })

  test("leaves no temp files behind", async () => {
    const path = join(root, "no-temp.json")
    await writeJsonFile(path, { clean: true })
    const siblings = await readdir(join(root))
    expect(siblings.filter((s) => s.includes(".tmp"))).toEqual([])
  })
})

describe("pathExists and removePath", () => {
  test("pathExists distinguishes present from absent, including directories", async () => {
    const file = join(root, "exists.txt")
    await writeFile(file, "x")
    expect(await pathExists(file)).toBe(true)
    expect(await pathExists(join(root, "absent.txt"))).toBe(false)
    expect(await pathExists(root)).toBe(true)
  })

  test("removePath removes files and directories best-effort without throwing", async () => {
    const file = join(root, "remove-me.txt")
    const dir = join(root, "remove-me-dir")
    await writeFile(file, "x")
    await mkdir(dir, { recursive: true })
    await removePath(file)
    await removePath(dir)
    expect(await pathExists(file)).toBe(false)
    expect(await pathExists(dir)).toBe(false)
    // Removing something absent is a no-op, not an error.
    await expect(removePath(join(root, "never-was"))).resolves.toBeUndefined()
  })
})

describe("exclusive lock (withExclusiveLock)", () => {
  test("only one writer proceeds at a time on one record directory", async () => {
    const dir = await tempDir()
    let inLock = false
    let overlap = false
    const run = async (label: string) =>
      withExclusiveLock(dir, async () => {
        if (inLock) overlap = true
        inLock = true
        await new Promise((resolve) => setTimeout(resolve, 30))
        inLock = false
        return label
      })
    const results = await Promise.all([run("a"), run("b")])
    expect(overlap).toBe(false)
    expect([...results].sort()).toEqual(["a", "b"])
  })

  test("always releases (and removes) the lock even when the callback throws", async () => {
    const dir = await tempDir()
    await expect(withExclusiveLock(dir, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    await expect(stat(join(dir, ".lock"))).rejects.toThrow()
  })

  test("steals a stale lock left by a crashed writer after the stale window", async () => {
    const dir = await tempDir()
    const lock = join(dir, ".lock")
    await writeFile(lock, "99999\n")
    const oldSeconds = (Date.now() - 120_000) / 1000
    await utimes(lock, oldSeconds, oldSeconds)
    let ran = false
    const result = await withExclusiveLock(dir, async () => {
      ran = true
      return 7
    }, { staleMs: 30_000 })
    expect(ran).toBe(true)
    expect(result).toBe(7)
    await expect(stat(lock)).rejects.toThrow()
  })
})
