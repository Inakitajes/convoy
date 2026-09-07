/**
 * Task 7.1 verification (`unify-work-context`): the end-to-end work-first
 * scenario from main — create work, propose in its worktree, leave/reopen the
 * exact conversation, resolve the work-scoped pipeline destination, and
 * return — recording that no manual `cd`, `/move`, nested Convoy, or extra
 * worktree was required. The propose *command execution* itself (a real
 * authoring agent) stays out of scope here exactly as in the feasibility
 * probes: command discovery and session continuity go through the public
 * interfaces; a model call is never needed for any step.
 *
 * Run with `bun run scripts/verify-workflow-e2e.ts`.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

const root = await mkdtemp(join(tmpdir(), "convoy-verify-e2e-"))
const main = join(root, "main")
const wt = join(root, "wt")
const record = (step: string, outcome: unknown) => console.log(`STEP ${step}: ${JSON.stringify(outcome).slice(0, 400)}`)
const fail = (step: string, outcome: unknown): never => {
  record(step, outcome)
  console.log("SCENARIO FAILED")
  process.exit(1)
}

// ── fixture: a repo whose project authoring workflow exists ────────────────
await mkdir(main, { recursive: true })
await writeFile(join(main, "README.md"), "# e2e\n")
await mkdir(join(main, "openspec", "specs"), { recursive: true })
await mkdir(join(main, ".opencode", "commands"), { recursive: true })
await writeFile(join(main, ".opencode", "commands", "opsx-propose.md"), "---\ndescription: propose\n---\nRun openspec propose for the described change.\n")
const git = (args: string[], cwd = main) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) fail("git", { args, stderr: proc.stderr.toString().slice(0, 200) })
  return proc.stdout.toString()
}
git(["init", "-q", "-b", "main"])
git(["add", "."])
git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])
const commitsAtStart = git(["rev-list", "--count", "HEAD"]).trim()
git(["worktree", "add", "-q", "-b", "feat/widget", wt])

const convoy = (args: string[], cwd: string) => {
  const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "src", "main.ts"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONVOY_HOME: join(root, "home") },
  })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

// ── 1. Create work before proposal (headless creation path) ────────────────
const created = convoy(["feature", "new-work", "--branch", "feat/widget", "--worktree", wt, "--base", "main"], main)
if (created.code !== 0) fail("new-work", created)
record("new-work", { code: created.code, out: created.out.slice(0, 200) })
const featureIdFromOutput = created.out.match(/\(([0-9a-f-]{36})\)/)?.[1]
if (!featureIdFromOutput) fail("new-work-id", { out: created.out })
const shown = convoy(["feature", "show", featureIdFromOutput!, "--json"], main)
if (shown.code !== 0) fail("feature-show", shown)
record("feature-show-raw", shown.out.slice(0, 300))
const feature = JSON.parse(shown.out) as { featureId: string; displayName: string; context?: { branch?: string; checkoutPath?: string } }
record("feature-registered", { featureId: feature.featureId, displayName: feature.displayName, branch: feature.context?.branch, checkout: feature.context?.checkoutPath })

// ── 2. The board lists the pre-proposal work from main (no cd) ─────────────
const listed = convoy(["specs"], main)
if (listed.code !== 0) fail("specs-list", listed)
record("board-lists-pre-proposal", {
  awaitingProposal: listed.out.includes("Awaiting proposal"),
  namedWork: listed.out.includes(feature.displayName),
  noControlSequences: !/\u001b\[/.test(listed.out),
})

// ── 3. Propose in the worktree: command discovery through the worktree ─────
let nextPort = 26531
const liveServers: Array<{ proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe"> }> = []
process.on("exit", () => {
  for (const server of liveServers) server.proc.kill()
})
async function bootServer(cwd: string): Promise<{ url: string; proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe"> }> {
  const proc = Bun.spawn(["opencode", "serve", "--hostname=127.0.0.1", `--port=${nextPort++}`], { cwd, stdout: "pipe", stderr: "pipe" })
  liveServers.push({ proc })
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("boot timeout")), 30_000)
    ;(proc.stdout as ReadableStream).pipeThrough(new TextDecoderStream()).pipeTo(
      new WritableStream({
        write(chunk) {
          const match = [...chunk.matchAll(/http:\/\/[^\s]+/g)].at(-1)
          if (match) {
            clearTimeout(timer)
            resolve(match[0].replace(/[^\S].*$/, "").trim())
          }
        },
      }),
    ).catch(() => reject(new Error("boot timeout")))
  })
  return { url, proc }
}

const wtServer = await bootServer(wt)
const wtClient = createOpencodeClient({ baseUrl: wtServer.url })
const { listAuthoringCommands } = await import("../src/conversations")
const commands = await listAuthoringCommands({ checkout: wt, server: { url: wtServer.url } })
record("authoring-commands-from-worktree", { commands })
if (commands === "unknown" || !commands.includes("opsx-propose")) fail("authoring-commands", { commands })

// The proposal conversation is created in the worktree's project (the agent
// would author openspec/changes/<id>/ there).
const proposal = await wtClient.session.create({ title: "Widget work proposal" })
if (proposal.error) fail("session-create", proposal.error)
const proposalId = proposal.data!.id
record("proposal-session-created-in-worktree", { id: proposalId })

// ── 4. Leave and reopen the exact conversation from main (no cd, no /move) ─
const { lifecycleCommonDir } = await import("../src/feature-lifecycle/store")
const { addConversation, touchConversationSelection } = await import("../src/feature-lifecycle/conversations")
const commonDir = (await lifecycleCommonDir(main))!
await addConversation({ commonDir, featureId: feature.featureId, sessionId: proposalId, label: "proposal" })
await touchConversationSelection({ commonDir, featureId: feature.featureId, sessionId: proposalId })
wtServer.proc.kill()
await new Promise((resolve) => setTimeout(resolve, 500))
const mainServer = await bootServer(main)
const mainClient = createOpencodeClient({ baseUrl: mainServer.url })
const reopened = await mainClient.session.get({ sessionID: proposalId })
record("exact-session-reopened-from-main", { ok: !reopened.error, id: reopened.data?.id, title: reopened.data?.title })
if (reopened.error) fail("exact-session-reopened", reopened.error)

// ── 5. Work-scoped pipeline destination resolves to the worktree ───────────
const { resolveWorkContext } = await import("../src/feature-lifecycle/work-context")
const resolved = await resolveWorkContext({ launchDir: main, featureId: feature.featureId })
const wtReal = await realpath(wt)
record("work-context-resolved", {
  status: resolved.status,
  checkout: resolved.status === "validated" ? resolved.context.executionCheckout : resolved.reason,
  branch: resolved.status === "validated" ? resolved.context.branch : undefined,
})
if (resolved.status !== "validated" || resolved.context.executionCheckout !== wtReal) fail("work-context", { status: resolved.status })

// ── 6. Return: the board still shows the same work, refreshed ──────────────
const { loadLifecycleFeatureRows } = await import("../src/specs")
const rows = await loadLifecycleFeatureRows(main)
const row = rows?.find((entry) => entry.featureId === feature.featureId)
record("return-refresh", { found: row !== undefined, summary: row?.summary, conversations: row?.conversations?.length ?? 0, lastSelected: row?.lastSelectedConversationId === proposalId })
if (!row || row.summary !== "Awaiting proposal") fail("return-refresh", { row })

// ── 7. The flow created no commit and no extra worktree ────────────────────
record("no-commit-created", { commits: git(["rev-list", "--count", "HEAD"]).trim(), atStart: commitsAtStart })
const worktrees = git(["worktree", "list", "--porcelain"], main).split("\n").filter((line) => line.startsWith("worktree "))
record("worktree-inventory", { count: worktrees.length, dirs: worktrees.map((line) => line.replace("worktree ", "")) })

mainServer.proc.kill()
if (!process.argv.includes("--keep")) await rm(root, { recursive: true, force: true })
console.log(`SCENARIO COMPLETE${process.argv.includes("--keep") ? ` (kept: ${root})` : ""}`)
