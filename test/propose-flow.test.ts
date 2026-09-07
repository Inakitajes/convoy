import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"

import type { TuiRoute } from "../src/tui-session"

/**
 * The Propose path (task 5.3, capability work-context): command discovery
 * through the supported API, the writer claim taken BEFORE any writer work
 * (creating the conversation and invoking the command both start one), and
 * the on-return association review that never renames the work's branch.
 *
 * bun runs every test file's top-level code before any tests execute, so
 * mock.module here is visible process-wide; each mock therefore DELEGATES to
 * the real module unless this file's tests have raised `capturing`, keeping
 * sibling files (opencode.test.ts, conversation-service.test.ts, …) on real
 * behavior — the same pattern specs-routing.test.ts established.
 */

const actualConversations = await import("../src/conversations")
const actualOpencode = await import("../src/opencode")
const actualConversationService = await import("../src/conversation-service")
const actualNotice = await import("../src/notice-tui")

// Snapshot the real functions BEFORE mock.module: bun patches the module
// record in place, so the namespace objects above reflect the mock once
// registered and would recurse if consulted through them.
const realCreateAuthoringConversation = actualConversations.createAuthoringConversation
const realListAuthoringCommands = actualConversations.listAuthoringCommands
const realInvokeAuthoringCommand = actualConversations.invokeAuthoringCommand
const realOpenConversationForeground = actualConversations.openConversationForeground
const realSessionActivity = actualConversations.sessionActivity
const realBootOpencodeServerFrom = actualOpencode.bootOpencodeServerFrom
const realEnsureConversationService = actualConversationService.ensureConversationService
const realShowNoticeTui = actualNotice.showNoticeTui

let capturing = false
/** What the propose flow should discover as the project's authoring commands. */
let discoveredCommands: string[] | "unknown" = ["opsx-propose"]
/** The foreground client's exit code. */
let foregroundExitCode = 0
/** Ordered record of what the flow did, for the claim-before-invoke assertion. */
const events: string[] = []
/** Whether the writer claim existed on disk at conversation-creation time. */
const claimStateAtCreate: Array<boolean> = []
const notices: Array<{ title: string; message: string }> = []

const fakeRoute = {
  session: { renderer: { suspend: () => {}, resume: () => {} } },
} as unknown as TuiRoute

mock.module("../src/conversations", () => ({
  ...actualConversations,
  listAuthoringCommands: async (input: { checkout: string; server?: unknown }) => {
    if (!capturing) return realListAuthoringCommands(input as never)
    return discoveredCommands
  },
  createAuthoringConversation: async (input: { checkout: string; title?: string; server?: unknown }) => {
    if (!capturing) return realCreateAuthoringConversation(input as never)
    const { readWriterClaim } = await import("../src/feature-lifecycle/writer-claims")
    const { lifecycleCommonDir } = await import("../src/feature-lifecycle/store")
    const commonDir = (await lifecycleCommonDir(input.checkout))!
    const claim = await readWriterClaim(commonDir, "feat/add-widget")
    claimStateAtCreate.push(claim.status === "found")
    events.push("create")
    return { harness: "opencode" as const, sessionId: "ses_propose001" }
  },
  invokeAuthoringCommand: async (input: { ref: unknown; server: unknown; command: string }) => {
    if (!capturing) return realInvokeAuthoringCommand(input as never)
    events.push(`invoke:${input.command}`)
  },
  openConversationForeground: async (input: { checkout: string; ref: unknown }) => {
    if (!capturing) return realOpenConversationForeground(input as never)
    events.push("foreground")
    return foregroundExitCode
  },
  sessionActivity: async (input: { checkout: string; ref: unknown }) => {
    if (!capturing) return realSessionActivity(input as never)
    return "idle" as const
  },
}))

mock.module("../src/opencode", () => ({
  ...actualOpencode,
  bootOpencodeServerFrom: async (checkout: string) => {
    if (!capturing) return realBootOpencodeServerFrom(checkout as never)
    throw new Error("the propose flow must use the conversation service, not a bounded boot, in these tests")
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
  // The mocks are process-wide: drop the capture flag so sibling test files
  // (loading-transition, opencode, …) stay on real behavior.
  capturing = false
})

const dirs: string[] = []
let main: string
let wt: string
let featureId: string

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "convoy-propose-home-"))
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

/** A repo with a registered pre-proposal feature on worktree branch feat/add-widget. */
async function makeFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "convoy-propose-"))
  dirs.push(root)
  main = join(root, "main")
  wt = join(root, "wt")
  await mkdir(main, { recursive: true })
  await git(main, "init", "-b", "main")
  await writeFile(join(main, "README.md"), "# repo\n")
  await git(main, "add", ".")
  await git(main, "-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init")
  await git(main, "worktree", "add", "-b", "feat/add-widget", wt)
  const { featureNewWork } = await import("../src/feature-lifecycle/commands")
  const feature = await featureNewWork({
    cwd: main,
    branch: "feat/add-widget",
    worktree: wt,
    changeIds: [],
    base: "main",
    displayName: "Widget redesign",
  })
  featureId = feature.featureId
}

function resetCapture(): void {
  capturing = true
  discoveredCommands = ["opsx-propose"]
  foregroundExitCode = 0
  events.length = 0
  claimStateAtCreate.length = 0
  notices.length = 0
}

describe("proposeForFeature (task 5.3)", () => {
  test("an unavailable authoring workflow is reported and no conversation is created", async () => {
    await makeFixture()
    resetCapture()
    discoveredCommands = []
    const { proposeForFeature } = await import("../src/cli")
    await proposeForFeature({ launchDir: main, route: fakeRoute, featureId, checkout: wt, branch: "feat/add-widget", displayName: "Widget redesign" })
    expect(notices).toHaveLength(1)
    expect(notices[0]!.message).toContain("no supported proposal workflow command")
    expect(events).toEqual([])
    // No writer claim was taken for a flow that never started a writer.
    const { readWriterClaim } = await import("../src/feature-lifecycle/writer-claims")
    const { lifecycleCommonDir } = await import("../src/feature-lifecycle/store")
    const commonDir = (await lifecycleCommonDir(main))!
    expect((await readWriterClaim(commonDir, "feat/add-widget")).status).toBe("missing")
  })

  test("a live conflicting writer claim is refused before any conversation is created or command invoked", async () => {
    await makeFixture()
    resetCapture()
    const { acquireWriterClaim } = await import("../src/feature-lifecycle/writer-claims")
    const { lifecycleCommonDir } = await import("../src/feature-lifecycle/store")
    const commonDir = (await lifecycleCommonDir(main))!
    // A live pipeline writer (this test process is alive) owns the checkout.
    const seeded = await acquireWriterClaim({ commonDir, branch: "feat/add-widget", checkoutPath: wt, kind: "pipeline", owner: "run-123", pid: process.pid })
    expect(seeded.status).toBe("acquired")
    const { proposeForFeature } = await import("../src/cli")
    await proposeForFeature({ launchDir: main, route: fakeRoute, featureId, checkout: wt, branch: "feat/add-widget", displayName: "Widget redesign" })
    expect(notices).toHaveLength(1)
    expect(notices[0]!.message).toContain("already owns")
    // The refusal happened before any writer work: nothing was created or invoked.
    expect(events).toEqual([])
  })

  test("the writer claim is held before the conversation is created and re-owned by the session", async () => {
    await makeFixture()
    resetCapture()
    const { proposeForFeature } = await import("../src/cli")
    await proposeForFeature({ launchDir: main, route: fakeRoute, featureId, checkout: wt, branch: "feat/add-widget", displayName: "Widget redesign" })
    // Ordering: the claim existed on disk when the conversation was created,
    // and the command was invoked inside it before the foreground client.
    expect(claimStateAtCreate).toEqual([true])
    expect(events).toEqual(["create", "invoke:opsx-propose", "foreground"])
    // After the flow the claim is re-owned by the session id and released
    // when the session is provably idle — no stale claim is left behind.
    const { readWriterClaim } = await import("../src/feature-lifecycle/writer-claims")
    const { lifecycleCommonDir } = await import("../src/feature-lifecycle/store")
    const commonDir = (await lifecycleCommonDir(main))!
    expect((await readWriterClaim(commonDir, "feat/add-widget")).status).toBe("missing")
    // The conversation was linked to the feature.
    const { readConversationRecord } = await import("../src/feature-lifecycle/conversations")
    const record = await readConversationRecord(commonDir, featureId)
    expect(record.status).toBe("found")
    expect(record.status === "found" && record.value.conversations.some((entry) => entry.sessionId === "ses_propose001")).toBe(true)
  })

  test("a differing authored change id is surfaced for association review without renaming the branch", async () => {
    await makeFixture()
    resetCapture()
    // The workflow authored a change whose id differs from the work's name.
    const changeDir = join(wt, "openspec", "changes", "add-widget")
    await mkdir(changeDir, { recursive: true })
    await writeFile(join(changeDir, "proposal.md"), "# Add widget\n")
    const { proposeForFeature } = await import("../src/cli")
    await proposeForFeature({ launchDir: main, route: fakeRoute, featureId, checkout: wt, branch: "feat/add-widget", displayName: "Widget redesign" })
    expect(notices.some((notice) => notice.message.includes("newly authored change: add-widget") && notice.message.includes("convoy feature revise"))).toBe(true)
    // The branch was never renamed: the feature's recorded context is intact.
    const { readFeatureRecord } = await import("../src/feature-lifecycle/records")
    const { lifecycleCommonDir } = await import("../src/feature-lifecycle/store")
    const commonDir = (await lifecycleCommonDir(main))!
    const record = await readFeatureRecord(commonDir, featureId)
    expect(record.status === "found" && record.value.context?.branch).toBe("feat/add-widget")
  })
})
