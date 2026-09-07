/**
 * Task 7.1/7.2 execution legs (`unify-work-context`): the parts the headless
 * e2e probe deliberately left out, run for real —
 *
 *   propose  — the project's `opsx-propose` authoring command is INVOKED
 *              through the supported command API and a real agent authors the
 *              change artifacts in the worktree;
 *   detach   — while that agent is live with no client attached (the
 *              active-detach shape), the session reports busy and the idle
 *              release keeps the writer claim; after it goes idle the claim
 *              releases;
 *   pipeline — a real Convoy pipeline is launched headless in the worktree
 *              (the work-scoped destination), linked to the feature, and its
 *              durable metadata is verified.
 *
 * Run with `bun run scripts/verify-execution-legs.ts`. Every outcome is
 * recorded; a leg that cannot complete is reported as failed, never as
 * passing.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

const repoRoot = join(import.meta.dir, "..")
const root = await mkdtemp(join(tmpdir(), "convoy-verify-exec-"))
const main = join(root, "main")
const wt = join(root, "wt")
const home = join(root, "home")
const record = (step: string, outcome: unknown) => console.log(`STEP ${step}: ${JSON.stringify(outcome).slice(0, 500)}`)
const legs: Record<string, "pass" | "fail" | "skipped"> = {}

const git = (args: string[], cwd = main) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString().slice(0, 300)}`)
  return proc.stdout.toString()
}
const convoy = (args: string[], cwd: string) => {
  const proc = Bun.spawnSync(["bun", "run", join(repoRoot, "src", "main.ts"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CONVOY_HOME: home },
  })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

// ── fixture: repo with a working OpenSpec root and the project's real
// authoring command; an unattended-permission opencode config so the
// server-side agent is not blocked on ask-level prompts with no client
// attached (recorded, not hidden). ───────────────────────────────────────────
await mkdir(main, { recursive: true })
await writeFile(join(main, "README.md"), "# exec legs\n")
git(["init", "-q", "-b", "main"])
const init = Bun.spawnSync(["openspec", "init", "--tools", "none", "."], { cwd: main, stdout: "pipe", stderr: "pipe" })
record("openspec-init", { code: init.exitCode, out: init.stdout.toString().slice(0, 150), err: init.stderr.toString().slice(0, 150) })
await mkdir(join(main, ".opencode", "commands"), { recursive: true })
await cp(join(repoRoot, ".opencode", "commands", "opsx-propose.md"), join(main, ".opencode", "commands", "opsx-propose.md"))
await writeFile(
  join(main, "opencode.json"),
  JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { edit: "allow", bash: "allow" } }, null, 2),
)
git(["add", "."])
git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])
git(["worktree", "add", "-q", "-b", "feat/widget", wt])
// The worktree is a separate checkout: it needs the same unattended config.
await cp(join(main, "opencode.json"), join(wt, "opencode.json"))

const created = convoy(["feature", "new-work", "--branch", "feat/widget", "--worktree", wt, "--base", "main"], main)
if (created.code !== 0) throw new Error(`new-work failed: ${created.err.slice(0, 300)}`)
const featureId = created.out.match(/\(([0-9a-f-]{36})\)/)?.[1]!
record("fixture", { featureId, wt })

let nextPort = 26801
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

const only = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1]
const runLeg = (name: string) => only === undefined || only.split(",").includes(name)

// ── leg: propose — invoke the real authoring command ────────────────────────
const server = await bootServer(wt)
const client = createOpencodeClient({ baseUrl: server.url })
const session = await client.session.create({ title: "Widget work proposal" })
if (session.error) throw new Error(`session create failed: ${JSON.stringify(session.error)}`)
const sessionId = session.data!.id
const { lifecycleCommonDir } = await import("../src/feature-lifecycle/store")
const { addConversation, touchConversationSelection } = await import("../src/feature-lifecycle/conversations")
const { acquireWriterClaim, readWriterClaim, releaseWriterClaim } = await import("../src/feature-lifecycle/writer-claims")
const { sessionActivity } = await import("../src/conversations")
const commonDir = (await lifecycleCommonDir(main))!
await addConversation({ commonDir, featureId, sessionId, label: "proposal" })
await touchConversationSelection({ commonDir, featureId, sessionId })
if (runLeg("propose") || runLeg("detach")) {
  const claim = await acquireWriterClaim({ commonDir, branch: "feat/widget", checkoutPath: wt, kind: "authoring", owner: sessionId })
  record("claim-acquired", { status: claim.status })
}

let detachCheck: { activity: string; claimKept: boolean } | undefined
let released = false
let idleActivity: string | undefined
if (runLeg("propose") || runLeg("detach")) {
  try {
    // Timing the invocation decides sync vs async: a call that returns only
    // after the artifacts exist ran the agent inline; a fast return with
    // artifacts appearing later ran it in the background.
    const commandStartedAt = Date.now()
    // The command call blocks for the whole agent run (observed: ~4 minutes),
    // so the status poll below runs CONCURRENTLY — that concurrency is the
    // active-detach shape: the agent is live with no client attached.
    const commandPromise = client.session.command({ sessionID: sessionId, command: "opsx-propose", arguments: "add-greeting: add a greeting endpoint that returns hello" })
    let commandDone = false
    void commandPromise.then(
      () => {
        commandDone = true
      },
      () => {
        commandDone = true
      },
    )
    let sawBusy = false
    const pollDeadline = Date.now() + 8 * 60_000
    while (Date.now() < pollDeadline) {
      await Bun.sleep(1_000)
      const status = await client.session.status()
      const entry = (status.data as Record<string, { type?: string }> | undefined)?.[sessionId]
      const busy = entry?.type === "busy" || entry?.type === "retry"
      if (busy && !sawBusy) {
        sawBusy = true
        const activity = await sessionActivity({ checkout: wt, ref: { harness: "opencode", sessionId }, server: { url: server.url } })
        // The idle-release contract (releaseAuthoringWriterIfIdle): a busy
        // session keeps its claim — release is attempted only when idle.
        if (activity === "idle") await releaseWriterClaim({ commonDir, branch: "feat/widget", owner: sessionId })
        const after = await readWriterClaim(commonDir, "feat/widget")
        detachCheck = { activity, claimKept: after.status === "found" }
        record("active-detach-while-busy", detachCheck)
      }
      if (commandDone) break
    }
    const sent = await commandPromise
    const commandReturnedMs = Date.now() - commandStartedAt
    const proposalRightAfterCall = await Bun.file(join(wt, "openspec", "changes", "add-greeting", "proposal.md")).exists()
    record("propose-command-sent", { ok: !sent.error, commandReturnedMs, proposalRightAfterCall, sawBusyDuringCall: sawBusy, error: sent.error ? JSON.stringify(sent.error).slice(0, 200) : undefined })
    if (sent.error) throw new Error("command invoke failed")

    // After the agent is done, the idle release succeeds.
    idleActivity = await sessionActivity({ checkout: wt, ref: { harness: "opencode", sessionId }, server: { url: server.url } })
    released = idleActivity === "idle" ? await releaseWriterClaim({ commonDir, branch: "feat/widget", owner: sessionId }) : false
    record("idle-release", { activity: idleActivity, released })

    // The authored change belongs to the worktree, and the branch was not renamed.
    const list = Bun.spawnSync(["openspec", "list", "--json"], { cwd: wt, stdout: "pipe", stderr: "pipe", env: { ...process.env, CONVOY_HOME: home } })
    const changeIds = (() => {
      try {
        const parsed = JSON.parse(list.stdout.toString()) as { changes?: Array<{ name?: string }> }
        return (parsed.changes ?? []).map((change) => change.name).filter((name): name is string => typeof name === "string")
      } catch {
        return [] as string[]
      }
    })()
    const changeRoot = changeIds.length > 0 ? join(wt, "openspec", "changes", changeIds[0]!) : undefined
    const artifacts = changeRoot
      ? await Promise.all(["proposal.md", "design.md", "tasks.md", "specs"].map(async (name) => ((await Bun.file(join(changeRoot, name)).exists()) ? name : undefined))).then((entries) => entries.filter((entry): entry is string => entry !== undefined))
      : []
    const proposalExists = changeIds.length > 0 && (await Bun.file(join(wt, "openspec", "changes", changeIds[0]!, "proposal.md")).exists())
    const branch = git(["branch", "--show-current"], wt).trim()
    record("propose-executed", { changeIds, artifacts: artifacts.slice(0, 10), proposalExists, branchUnchanged: branch === "feat/widget" })
    legs.propose = proposalExists && branch === "feat/widget" ? "pass" : "fail"
    legs.detach = detachCheck?.activity === "busy" && detachCheck.claimKept && released ? "pass" : "fail"
  } catch (error) {
    record("propose-leg-failed", { error: error instanceof Error ? error.message.slice(0, 300) : String(error) })
    legs.propose = "fail"
    legs.detach = "fail"
  }
}
server.proc.kill()

// ── leg: pipeline — a real headless run in the worktree, feature-linked ─────
if (runLeg("pipeline")) {
  try {
    // The authored change is associated through the explicit revise workflow
    // first (task 5.4): the run's contract cross-check refuses a --feature
    // whose contract set does not include the attached change.
    const revise = convoy(["feature", "revise", featureId, "--change", "add-greeting", "--base", "main"], main)
    record("associate-authored-change", { code: revise.code, out: revise.out.slice(0, 200), err: revise.err.slice(0, 200) })
    await mkdir(join(wt, ".convoy", "agents"), { recursive: true })
    await writeFile(join(wt, ".convoy", "agents", "verify.md"), "Do not use any tools. Reply with exactly: ok\n")
    await writeFile(
      join(wt, ".convoy", "config.yaml"),
      ["agents:", "  verify:", "    description: replies ok", "pipelines:", "  verify-e2e:", "    steps:", "      - agent: verify", ""].join("\n"),
    )
    // A leftover authoring claim (e.g. when only this leg runs) would refuse
    // the launch — the coordination contract, not a defect. Release it so the
    // launch itself is what gets exercised.
    const released = await releaseWriterClaim({ commonDir, branch: "feat/widget", owner: sessionId })
    record("pipeline-claim-clear", { released })
    // The operator's next step after proposing is committing the artifacts;
    // the run's dirty-tree gate otherwise refuses the checkout (observed).
    git(["add", "."], wt)
    git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "propose add-greeting"], wt)
    record("worktree-committed", { clean: git(["status", "--porcelain"], wt).trim() === "" })
    const run = convoy(["Reply with exactly: ok", "-p", "verify-e2e", "--no-tui", "--yolo", "--no-confirm", "--no-human-step", "--feature", featureId], wt)
    record("pipeline-run", { code: run.code, out: run.out.slice(-500) })
    record("pipeline-run-stderr-tail", run.err.slice(-600))
    const logPath = run.err.match(/coordinator log: (\S+)/)?.[1]
    if (logPath) {
      const log = await Bun.file(logPath).text().catch(() => "(unreadable)")
      record("coordinator-log-tail", log.split("\n").slice(-12).join("\n").slice(0, 700))
    }
    // Durable linkage: the run's metadata names the worktree and the feature.
    // convoyRoot() is CONVOY_HOME itself; the home's `.convoy` holds runs.
    const runsRoot = join(home, ".convoy", "runs")
    const { readdir } = await import("node:fs/promises")
    const runDirs = await readdir(runsRoot).catch(() => [] as string[])
    let metadata: Record<string, unknown> | undefined
    for (const dir of runDirs) {
      const file = Bun.file(join(runsRoot, dir, "metadata.json"))
      if (await file.exists()) metadata = (await file.json()) as Record<string, unknown>
    }
    const featureLink = metadata?.feature as Record<string, unknown> | undefined
    record("pipeline-metadata", {
      runFound: metadata !== undefined,
      targetDir: metadata?.targetDir,
      featureId: featureLink?.featureId,
      branch: featureLink?.branch,
    })
    legs.pipeline = run.code === 0 && metadata !== undefined && featureLink?.featureId === featureId ? "pass" : "fail"
  } catch (error) {
    record("pipeline-leg-failed", { error: error instanceof Error ? error.message.slice(0, 300) : String(error) })
    legs.pipeline = "fail"
  }
}

// ── return: the board still shows the same work ─────────────────────────────
const { loadLifecycleFeatureRows } = await import("../src/specs")
const rows = await loadLifecycleFeatureRows(main)
const row = rows?.find((entry) => entry.featureId === featureId)
record("return-refresh", { found: row !== undefined, summary: row?.summary, conversations: row?.conversations?.length ?? 0 })

console.log(`LEGS: ${JSON.stringify(legs)}`)
if (!process.argv.includes("--keep")) await rm(root, { recursive: true, force: true })
