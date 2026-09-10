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
const realListAuthoringCommands = actualConversations.listAuthoringCommands
const realInvokeAuthoringCommand = actualConversations.invokeAuthoringCommand
const realEnsureConversationService = actualConversationService.ensureConversationService
const realShowNoticeTui = actualNotice.showNoticeTui

let capturing = false
/** What validateAuthoringSession should answer for the stored reference. */
let linkedValidation: { status: "available"; title?: string } | { status: "unavailable"; reason: string } = { status: "available" }
/** What listAuthoringCommands should answer (a propose-phase flow's discovery). */
let authoringCommands: string[] | "unknown" = ["opsx-propose"]
/** Ordered record of what the flow did. */
const events: string[] = []
/** Records of authoring-command discovery/invocation (the propose phase). */
const authoringCommandsEvents: string[] = []
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
  listAuthoringCommands: async (input: { checkout: string; server?: unknown }) => {
    if (!capturing) return realListAuthoringCommands(input as never)
    authoringCommandsEvents.push("listAuthoringCommands")
    return authoringCommands
  },
  invokeAuthoringCommand: async (input: { ref: { sessionId: string }; command: string }) => {
    if (!capturing) return realInvokeAuthoringCommand(input as never)
    authoringCommandsEvents.push(`invoke:${input.command}`)
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
  authoringCommands = ["opsx-propose"]
  events.length = 0
  authoringCommandsEvents.length = 0
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

/**
 * Harness-qualified authoring session navigation (task 4.5): the session
 * reference is navigation metadata validated against live Git continuity and
 * the harness. These tests exercise the cli entry points that are exported
 * (openCheckoutConversation); propose-in-checkout and external presentation
 * are module-private in cli.ts, so their phase/command behavior is asserted
 * from the conversation boundary (the ordinary conversation is what must stay
 * usable and command-free).
 */
describe("task 4.5 harness-qualified authoring session navigation", () => {
  const open = async (checkout: string, displayName: string) => {
    const { openCheckoutConversation } = await import("../src/cli")
    await openCheckoutConversation({ launchDir: main, route: fakeRoute, checkout, displayName })
  }

  test("rejects an unrelated recent session for a different checkout (no graft)", async () => {
    await makeFixture()
    resetCapture()
    // A recent session belongs to `wt`; opening `main` must NOT resume it.
    await seedLinkedRef("ses_linked_001")

    await open(main, "main")

    expect(events).toEqual(["create", "foreground"])
    expect(foregroundRefs).toEqual([{ harness: "opencode", sessionId: "ses_new_minted" }])
    expect(events).not.toContain("validate:ses_linked_001")
  })

  test("a reused path hosting a different incarnation is not treated as the old checkout", async () => {
    await makeFixture()
    // Seed a valid linked session, then reuse the SAME path with a different
    // branch/registration: continuity with the prior target is unverifiable, so
    // the stale session must not be resumed automatically.
    await seedLinkedRef("ses_linked_001")
    await git(main, "worktree", "remove", wt)
    await git(main, "worktree", "add", "-q", "-b", "feature/reused", wt, "main")
    resetCapture()

    await open(wt, "Widget redesign")

    expect(events).not.toContain("validate:ses_linked_001")
    expect(events).toContain("create")
    expect(foregroundRefs).toEqual([{ harness: "opencode", sessionId: "ses_new_minted" }])
  })

  test("a moved destination does not silently inherit the old checkout's session", async () => {
    await makeFixture()
    await seedLinkedRef("ses_linked_001")
    await git(main, "worktree", "move", wt, `${wt}-moved`)
    resetCapture()

    await open(`${wt}-moved`, "Widget redesign")

    expect(events).not.toContain("validate:ses_linked_001")
    expect(events).toEqual(["create", "foreground"])
    expect(foregroundRefs).toEqual([{ harness: "opencode", sessionId: "ses_new_minted" }])
  })

  test("phase-distinct: ordinary conversation navigation never fires an authoring command", async () => {
    await makeFixture()
    await seedLinkedRef("ses_linked_001")
    resetCapture()
    // A propose command IS discoverable, yet the ordinary conversation path
    // must not query or invoke it: the two phases are distinguishable.
    authoringCommands = ["opsx-propose", "help"]

    await open(wt, "Widget redesign")

    // The linked session is resumed exactly; no propose command is invoked,
    // so a phase (conversation/revise) session is not confused with a propose
    // flow that would mint + run a command.
    expect(events).toEqual(["validate:ses_linked_001", "foreground"])
    expect(foregroundRefs).toEqual([{ harness: "opencode", sessionId: "ses_linked_001" }])
    expect(authoringCommandsEvents).toEqual([])
  })

  test("a conflicting managed writer blocks resume — permissions are preserved", async () => {
    await makeFixture()
    await seedLinkedRef("ses_linked_001")
    // A live authoring claim already owns this checkout's branch (different
    // owner), so the resume must NOT bypass the managed-writer guard.
    const { repoCommonDir } = await import("../src/repo-store")
    const { observeCheckoutTarget } = await import("../src/worktree-target")
    const { acquireWriterClaim } = await import("../src/writer-claims")
    const commonDir = (await repoCommonDir(main))!
    const target = await observeCheckoutTarget(wt)
    await acquireWriterClaim({ commonDir, branch: target.branch!, checkoutPath: target.checkoutPath, kind: "authoring", owner: "run-phased" })
    resetCapture()

    await open(wt, "Widget redesign")

    expect(events).toEqual(["validate:ses_linked_001"])
    expect(events).not.toContain("foreground")
    expect(events).not.toContain("create")
    expect(foregroundRefs).toEqual([])
    expect(notices).toHaveLength(1)
    expect(notices[0]!.message).toContain("a managed writer already owns")
  })

  test("conversation stays usable when project authoring commands are unavailable", async () => {
    await makeFixture()
    resetCapture()
    authoringCommands = "unknown"

    await open(wt, "Widget redesign")

    // Even though authoring-command discovery reports "unknown" (the propose
    // phase would refuse), an ordinary conversation still starts and opens.
    expect(events).toEqual(["create", "foreground"])
    expect(foregroundRefs).toEqual([{ harness: "opencode", sessionId: "ses_new_minted" }])
    expect(authoringCommandsEvents).toEqual([])
    expect(notices).toEqual([])
  })
})
