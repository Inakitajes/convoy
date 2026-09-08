import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"

import type { TuiRoute } from "../src/tui-session"

/**
 * The Home conversation action's resume path (capability work-conversations,
 * SC-2): a verifiable linked session is resumed exactly — Home must NOT mint
 * a new session while a valid prior harness reference exists. The stored
 * reference is navigation metadata validated against live Git continuity and
 * the harness; an unavailable linked session is reported, never silently
 * replaced.
 *
 * bun runs every test file's top-level code before any tests execute, so
 * mock.module here is visible process-wide; each mock therefore DELEGATES to
 * the real module unless this file's tests have raised `capturing` — the same
 * pattern propose-flow.test.ts established.
 */

const actualConversations = await import("../src/conversations")
const actualConversationService = await import("../src/conversation-service")
const actualNotice = await import("../src/notice-tui")

const realValidateAuthoringSession = actualConversations.validateAuthoringSession
const realCreateAuthoringConversation = actualConversations.createAuthoringConversation
const realOpenConversationForeground = actualConversations.openConversationForeground
const realSessionActivity = actualConversations.sessionActivity
const realEnsureConversationService = actualConversationService.ensureConversationService
const realShowNoticeTui = actualNotice.showNoticeTui

let capturing = false
/** What validateAuthoringSession should answer for the stored reference. */
let linkedValidation: { status: "available"; title?: string } | { status: "unavailable"; reason: string } = { status: "available" }
/** Ordered record of what the flow did. */
const events: string[] = []
/** The reference the foreground client was handed. */
const foregroundRefs: Array<{ harness: string; sessionId: string }> = []
const notices: Array<{ title: string; message: string }> = []

const fakeRoute = {
  session: { renderer: { suspend: () => {}, resume: () => {} } },
} as unknown as TuiRoute

mock.module("../src/conversations", () => ({
  ...actualConversations,
  validateAuthoringSession: async (input: { ref: { sessionId: string }; checkout: string; server?: unknown }) => {
    if (!capturing) return realValidateAuthoringSession(input as never)
    events.push(`validate:${input.ref.sessionId}`)
    return linkedValidation
  },
  createAuthoringConversation: async (input: { checkout: string; title?: string; server?: unknown }) => {
    if (!capturing) return realCreateAuthoringConversation(input as never)
    events.push("create")
    return { harness: "opencode" as const, sessionId: "ses_new_minted" }
  },
  openConversationForeground: async (input: { checkout: string; ref: { harness: string; sessionId: string } }) => {
    if (!capturing) return realOpenConversationForeground(input as never)
    events.push("foreground")
    foregroundRefs.push(input.ref)
    return 0
  },
  sessionActivity: async (input: { checkout: string; ref: { sessionId: string } }) => {
    if (!capturing) return realSessionActivity(input as never)
    return "idle" as const
  },
}))

mock.module("../src/conversation-service", () => ({
  ...actualConversationService,
  ensureConversationService: async (input: { commonDir: string; checkout: string }) => {
    if (!capturing) return realEnsureConversationService(input as never)
    return { status: "live" as const, url: "http://127.0.0.1:9", record: {} as never, reused: true }
  },
}))

mock.module("../src/notice-tui", () => ({
  ...actualNotice,
  showNoticeTui: (route: unknown, options: { title: string; message: string }) => {
    if (!capturing) return realShowNoticeTui(route as never, options)
    notices.push(options)
    return Promise.resolve()
  },
}))

afterEach(async () => {
  capturing = false
})

const dirs: string[] = []
let main: string
let wt: string

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "convoy-resume-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const { execFile: nodeExecFile } = await import("node:child_process")
const { promisify } = await import("node:util")
const exec = promisify(nodeExecFile)
async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd })
}

async function makeFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "convoy-resume-"))
  dirs.push(root)
  main = join(root, "main")
  wt = join(root, "wt")
  await mkdir(main, { recursive: true })
  await git(main, "init", "-q", "-b", "main")
  await writeFile(join(main, "README.md"), "# repo\n")
  await git(main, "add", ".")
  await git(main, "-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init")
  await git(main, "worktree", "add", "-q", "-b", "feat/add-widget", wt)
}

function resetCapture(): void {
  capturing = true
  linkedValidation = { status: "available" }
  events.length = 0
  foregroundRefs.length = 0
  notices.length = 0
}

/** Seeds the session-hints store with a linked reference for the worktree. */
async function seedLinkedRef(sessionId: string): Promise<void> {
  const { repoCommonDir } = await import("../src/repo-store")
  const { observeCheckoutTarget } = await import("../src/worktree-target")
  const { saveConversationRef } = await import("../src/session-hints")
  const commonDir = (await repoCommonDir(main))!
  const target = await observeCheckoutTarget(wt)
  await saveConversationRef(commonDir, target, { harness: "opencode", sessionId })
}

describe("openCheckoutConversation resume (work-conversations SC-2)", () => {
  test("a valid prior harness reference is resumed exactly — no new session is minted", async () => {
    await makeFixture()
    resetCapture()
    await seedLinkedRef("ses_linked_001")

    const { openCheckoutConversation } = await import("../src/cli")
    await openCheckoutConversation({ launchDir: main, route: fakeRoute, checkout: wt, displayName: "Widget redesign" })

    expect(events).toContain("validate:ses_linked_001")
    expect(events).not.toContain("create")
    expect(events).toEqual(["validate:ses_linked_001", "foreground"])
    expect(foregroundRefs).toEqual([{ harness: "opencode", sessionId: "ses_linked_001" }])
    expect(notices).toEqual([])
  })

  test("an unavailable linked session is reported, not silently replaced", async () => {
    resetCapture()
    linkedValidation = { status: "unavailable", reason: "the harness cannot return that session" }

    const { openCheckoutConversation } = await import("../src/cli")
    await openCheckoutConversation({ launchDir: main, route: fakeRoute, checkout: wt, displayName: "Widget redesign" })

    expect(events).toEqual(["validate:ses_linked_001"])
    expect(events).not.toContain("create")
    expect(events).not.toContain("foreground")
    expect(notices).toHaveLength(1)
    expect(notices[0]!.message).toContain("the linked session could not be opened")
    expect(notices[0]!.message).toContain("new conversation")
  })

  test("with no stored reference, a new conversation is created and its reference stored", async () => {
    resetCapture()
    // A different checkout path: no hint exists for it.
    const { openCheckoutConversation } = await import("../src/cli")
    await openCheckoutConversation({ launchDir: main, route: fakeRoute, checkout: main, displayName: "main" })

    expect(events).toEqual(["create", "foreground"])
    expect(foregroundRefs).toEqual([{ harness: "opencode", sessionId: "ses_new_minted" }])

    // The created reference is stored, so the next open resumes it.
    events.length = 0
    foregroundRefs.length = 0
    await openCheckoutConversation({ launchDir: main, route: fakeRoute, checkout: main, displayName: "main" })
    expect(events).toEqual(["validate:ses_new_minted", "foreground"])
    expect(foregroundRefs).toEqual([{ harness: "opencode", sessionId: "ses_new_minted" }])
  })
})
