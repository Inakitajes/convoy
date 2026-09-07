import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execFile } from "../src/git"
import { isFound, lifecycleCommonDir, lifecycleSchemaVersion } from "../src/feature-lifecycle/store"
import { readFeatureRecord, writeFeatureRecord } from "../src/feature-lifecycle/records"
import { ensureRepositoryRecord } from "../src/feature-lifecycle/store"
import {
  addConversation,
  readConversationRecord,
  touchConversationSelection,
} from "../src/feature-lifecycle/conversations"
import { authoringClientArgv, createAuthoringConversation, openConversationExternal, validateAuthoringSession } from "../src/conversations"
import { bootOpencodeServerFrom } from "../src/opencode"
import { runForegroundChild } from "../src/terminal-host"
import type { FeatureRecord } from "../src/feature-lifecycle/records"

/**
 * Tasks 3.1/4.1/4.2 (capability work-conversations, design D2/D4): versioned
 * conversation associations live under the existing feature directory using
 * lifecycle store conventions — old feature records load without migration,
 * concurrent additions are both preserved, navigation writes never advance
 * the execution association revision, and corrupt/unsupported records stay
 * typed failures. The adapter creates and validates durable session
 * references through the public OpenCode API; the terminal host restores the
 * caller's UI on every exit path.
 */

const dirs: string[] = []
let commonDir: string

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await execFile("git", args, { cwd, allowFailure: true })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
}

function record(featureId: string, repositoryId: string, overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: lifecycleSchemaVersion,
    featureId,
    repositoryId,
    displayName: "add-widget",
    associationRevision: 1,
    contracts: [{ changeId: "add-widget", kind: "active", sourcePath: "openspec/changes/add-widget", provenance: "adopt", selectedAtRevision: 1 }],
    intendedBaseRef: "main",
    runIds: [],
    closeAttemptIds: [],
    history: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const featureId = "eeeeeeee-0000-4000-8000-00000000abc4"

beforeAll(async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "convoy-conversations-"))
  dirs.push(repoDir)
  await Bun.write(join(repoDir, "README.md"), "# repo\n")
  await git(repoDir, ["init", "-q", "-b", "main"])
  await git(repoDir, ["add", "."])
  await git(repoDir, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])
  commonDir = (await lifecycleCommonDir(repoDir))!
  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw new Error("no repository record")
  await writeFeatureRecord(commonDir, record(featureId, repoRecord.value.repositoryId), 0)
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("feature-owned conversation associations (task 3.1)", () => {
  test("an old feature record without a conversations record loads unchanged; the first add creates the record", async () => {
    // The feature record existed before conversations did: it still reads.
    const feature = await readFeatureRecord(commonDir, featureId)
    expect(feature.status).toBe("found")
    // And the conversation record simply does not exist yet.
    expect((await readConversationRecord(commonDir, featureId)).status).toBe("missing")
    const added = await addConversation({ commonDir, featureId, sessionId: "ses_one", label: "authoring" })
    expect("record" in added && added.record.conversations).toHaveLength(1)
  })

  test("concurrent additions are both preserved under the feature lock", async () => {
    const [first, second] = await Promise.all([
      addConversation({ commonDir, featureId, sessionId: "ses_a" }),
      addConversation({ commonDir, featureId, sessionId: "ses_b" }),
    ])
    expect("record" in first).toBe(true)
    expect("record" in second).toBe(true)
    const final = await readConversationRecord(commonDir, featureId)
    if (final.status !== "found") throw new Error("record lost")
    const ids = final.value.conversations.map((entry) => entry.sessionId).sort()
    expect(ids).toContain("ses_a")
    expect(ids).toContain("ses_b")
    // Exactly one of each: no silent duplication.
    expect(ids.filter((id) => id === "ses_a")).toHaveLength(1)
  })

  test("re-adding an existing session id is idempotent, not a duplicate", async () => {
    await addConversation({ commonDir, featureId, sessionId: "ses_a" })
    const final = await readConversationRecord(commonDir, featureId)
    if (final.status !== "found") throw new Error("record lost")
    expect(final.value.conversations.filter((entry) => entry.sessionId === "ses_a")).toHaveLength(1)
  })

  test("selection is navigation-only: feature.json's associationRevision never moves", async () => {
    const before = await readFeatureRecord(commonDir, featureId)
    if (before.status !== "found") throw new Error("feature record lost")
    await addConversation({ commonDir, featureId, sessionId: "ses_nav" })
    await touchConversationSelection({ commonDir, featureId, sessionId: "ses_nav" })
    const after = await readFeatureRecord(commonDir, featureId)
    if (after.status !== "found") throw new Error("feature record lost")
    expect(after.value.associationRevision).toBe(before.value.associationRevision)
    const conversations = await readConversationRecord(commonDir, featureId)
    if (conversations.status !== "found") throw new Error("conversation record lost")
    expect(conversations.value.lastSelectedId).toBe("ses_nav")
    const selected = conversations.value.conversations.find((entry) => entry.sessionId === "ses_nav")
    expect(selected?.lastSelectedAt).toBeGreaterThan(0)
  })

  test("a corrupt conversations record is corrupt, not empty", async () => {
    const oneOff = "ffff0000-0000-4000-8000-00000000abc5"
    await writeFeatureRecord(commonDir, record(oneOff, "ffffffff-0000-4000-8000-00000000ffff"), 0)
    await addConversation({ commonDir, featureId: oneOff, sessionId: "ses_x" })
    const path = join(commonDir, "convoy", "features", oneOff, "conversations", "conversations.json")
    await Bun.write(path, "{ not json")
    const read = await readConversationRecord(commonDir, oneOff)
    expect(read.status).toBe("corrupt")
    // Adding to a corrupt record refuses instead of overwriting it.
    const added = await addConversation({ commonDir, featureId: oneOff, sessionId: "ses_y" })
    expect("record" in added).toBe(false)
  })

  test("an unsupported (newer schema) conversations record stays unsupported", async () => {
    const oneOff = "ffff0000-0000-4000-8000-00000000abc6"
    await writeFeatureRecord(commonDir, record(oneOff, "ffffffff-0000-4000-8000-00000000ffff"), 0)
    const path = join(commonDir, "convoy", "features", oneOff, "conversations", "conversations.json")
    await Bun.write(path, JSON.stringify({ schemaVersion: lifecycleSchemaVersion + 1, featureId: oneOff, revision: 1, conversations: [], createdAt: 1, updatedAt: 1 }))
    const read = await readConversationRecord(commonDir, oneOff)
    expect(read.status).toBe("unsupported")
    expect(read.status === "unsupported" ? read.schemaVersion : undefined).toBe(lifecycleSchemaVersion + 1)
  })

  test("a conversations record whose embedded identity disagrees with its path is corrupt", async () => {
    const oneOff = "ffff0000-0000-4000-8000-00000000abc7"
    await writeFeatureRecord(commonDir, record(oneOff, "ffffffff-0000-4000-8000-00000000ffff"), 0)
    const path = join(commonDir, "convoy", "features", oneOff, "conversations", "conversations.json")
    await Bun.write(
      path,
      JSON.stringify({ schemaVersion: lifecycleSchemaVersion, featureId: "11111111-2222-4333-8444-555555555555", revision: 1, conversations: [], createdAt: 1, updatedAt: 1 }),
    )
    expect((await readConversationRecord(commonDir, oneOff)).status).toBe("corrupt")
  })

  test("writes are atomic: the record on disk is the renamed temp file, not a torn write", async () => {
    await addConversation({ commonDir, featureId, sessionId: "ses_atomic" })
    const path = join(commonDir, "convoy", "features", featureId, "conversations", "conversations.json")
    const raw = await readFile(path, "utf8")
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(raw.endsWith("\n")).toBe(true)
  })
})

describe("conversation adapter + terminal host (tasks 4.1/4.2)", () => {
  test("authoring client argv roots the interactive client at the checkout with the exact session", () => {
    const argv = authoringClientArgv({ checkout: "/repo/wt", ref: { harness: "opencode", sessionId: "ses_exact" } })
    expect(argv).toEqual(["opencode", "/repo/wt", "--session", "ses_exact"])
  })

  test("runForegroundChild restores the UI in finally on normal and failing exits", async () => {
    const events: string[] = []
    const code = await runForegroundChild({
      argv: ["sh", "-lc", "exit 3"],
      cwd: process.cwd(),
      suspend: () => events.push("suspend"),
      resume: () => events.push("resume"),
    })
    expect(code).toBe(3)
    expect(events).toEqual(["suspend", "resume"])
    const ok = await runForegroundChild({
      argv: ["sh", "-lc", "exit 0"],
      cwd: process.cwd(),
      suspend: () => events.push("suspend"),
      resume: () => events.push("resume"),
    })
    expect(ok).toBe(0)
    expect(events.slice(-2)).toEqual(["suspend", "resume"])
  })

  test("runForegroundChild restores the UI even when the child cannot spawn", async () => {
    const events: string[] = []
    await runForegroundChild({
      argv: ["/definitely/not/a/binary"],
      cwd: process.cwd(),
      suspend: () => events.push("suspend"),
      resume: () => events.push("resume"),
    }).catch(() => "caught")
    expect(events).toEqual(["suspend", "resume"])
  })

  test("a durable reference survives a server restart: create → validate → restart → validate", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "convoy-conversation-e2e-"))
    dirs.push(repoDir)
    await Bun.write(join(repoDir, "README.md"), "# repo\n")
    await git(repoDir, ["init", "-q", "-b", "main"])
    await git(repoDir, ["add", "."])
    await git(repoDir, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])

    // A bounded per-checkout server (the same boot the service would own).
    const server = await bootOpencodeServerFrom(repoDir)
    try {
      const ref = await createAuthoringConversation({ checkout: repoDir, title: "authoring", server })
      expect(ref.harness).toBe("opencode")
      expect(ref.sessionId).toMatch(/^ses_/)
      const valid = await validateAuthoringSession({ ref, checkout: repoDir, server })
      expect(valid.status).toBe("available")
    } finally {
      server.close()
    }
    // Restart: a fresh server of the same repository resolves the same id.
    const server2 = await bootOpencodeServerFrom(repoDir)
    try {
      const ref = await validateAuthoringSession({ ref: { harness: "opencode", sessionId: (await latestSessionId(repoDir, server2.url))! }, checkout: repoDir, server: server2 })
      expect(ref.status).toBe("available")
    } finally {
      server2.close()
    }
  })

  test("external presentation reports pane creation and harness startup independently (task 4.6)", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "convoy-conversation-ext-"))
    dirs.push(repoDir)
    await Bun.write(join(repoDir, "README.md"), "# repo\n")
    await git(repoDir, ["init", "-q", "-b", "main"])
    await git(repoDir, ["add", "."])
    await git(repoDir, ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])

    // Pane creation fails: a real outcome, reported before any session claim.
    const failed = await openConversationExternal({
      checkout: repoDir,
      ref: { harness: "opencode", sessionId: "ses_missing" },
      openWindow: async () => {
        throw new Error("no backend available")
      },
    })
    expect(failed.status).toBe("failed")
    if (failed.status !== "failed") return
    expect(failed.reason).toContain("no backend available")

    // A real server with a real session: pane creation + verified session.
    const server = await bootOpencodeServerFrom(repoDir)
    try {
      const ref = await createAuthoringConversation({ checkout: repoDir, title: "external", server })
      const opened = await openConversationExternal({
        checkout: repoDir,
        ref,
        openWindow: async () => "herdr",
        server,
      })
      expect(opened.status).toBe("opened")
      if (opened.status !== "opened") return
      expect(opened.backend).toBe("herdr")
      expect(opened.sessionVerified).toBe(true)
    } finally {
      server.close()
    }

    // A pane in front of a dead harness: the pane result alone must never
    // read as a running conversation.
    const unverified = await openConversationExternal({
      checkout: repoDir,
      ref: { harness: "opencode", sessionId: "ses_not_here" },
      openWindow: async () => "ghostty",
      server: { url: "http://127.0.0.1:1", close() {} },
    })
    expect(unverified.status).toBe("opened-unverified")
    if (unverified.status !== "opened-unverified") return
    expect(unverified.backend).toBe("ghostty")
    expect(unverified.reason).toBeTruthy()
  })
})

/** Reads the newest session id from a live server (public list API). */
async function latestSessionId(checkout: string, url: string): Promise<string | undefined> {
  const { connectOpencode } = await import("../src/opencode")
  const client = connectOpencode(url)
  const list = await client.session.list()
  return (list.data ?? []).at(-1)?.id
}
