/**
 * Task 7.2 verification (`unify-work-context`): the foreground return contract
 * against the REAL OpenCode interactive client, plus the two-work concurrency
 * and external-pane reporting legs. Run under a real pty, e.g.
 * `script -q /dev/null bun run scripts/verify-foreground-client.ts` with
 * CONVOY_VERIFY_LOG pointing at a durable record file (the pty's
 * alternate-screen paints would clobber stdout lines).
 *
 * The client child is `opencode <worktree> --session=<id>` — the exact argv
 * the foreground conversation path builds (authoringClientArgv). A watchdog
 * shell delivers SIGINT to the client (the signal the terminal's Ctrl+C
 * produces) after a delay, with SIGKILL as the recorded fallback, so the
 * probe terminates deterministically; the observed exit path is recorded
 * honestly rather than assumed.
 */
import { appendFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliRenderer } from "@opentui/core"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { runForegroundChild } from "../src/terminal-host"
import { openConversationExternal } from "../src/conversations"

const logPath = process.env.CONVOY_VERIFY_LOG ?? "verify-foreground.log"
const record = (step: string, outcome: unknown) => appendFileSync(logPath, `STEP ${step}: ${JSON.stringify(outcome).slice(0, 400)}\n`)

// ── fixture: repo + worktree + one authoring session ───────────────────────
const root = await mkdtemp(join(tmpdir(), "convoy-verify-fg-"))
const main = join(root, "main")
const wt = join(root, "wt")
await mkdir(main, { recursive: true })
await writeFile(join(main, "README.md"), "# fg\n")
const git = (args: string[]) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd: main, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString().slice(0, 200)}`)
  return proc.stdout.toString()
}
git(["init", "-q", "-b", "main"])
git(["add", "."])
git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])
git(["worktree", "add", "-q", "-b", "feat/fg-probe", wt])

let nextPort = 26701
async function bootServer(cwd: string): Promise<{ url: string; proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe"> }> {
  const proc = Bun.spawn(["opencode", "serve", "--hostname=127.0.0.1", `--port=${nextPort++}`], { cwd, stdout: "pipe", stderr: "pipe" })
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

const server = await bootServer(wt)
const client = createOpencodeClient({ baseUrl: server.url })
const created = await client.session.create({ title: "foreground probe" })
if (created.error) throw new Error(`session create failed: ${JSON.stringify(created.error)}`)
const sessionId = created.data!.id
record("fixture", { sessionId, wt })

// ── 1. The real client as the foreground child ─────────────────────────────
const renderer = await createCliRenderer({ screenMode: "alternate-screen", consoleMode: "console-overlay", exitOnCtrlC: false })
await renderer.waitForThemeMode(1_000).catch(() => null)
const dimensionsAtStart = { width: renderer.width, height: renderer.height }
record("renderer-up", { ...dimensionsAtStart, destroyed: renderer.isDestroyed })

const events: string[] = []
const suspend = () => {
  events.push("suspend")
  renderer.suspend()
}
const resume = () => {
  events.push("resume")
  renderer.resume()
}

// The watchdog runs the exact client argv, checks after 3s whether the client
// is still running, SIGINTs it if so (the terminal's Ctrl+C signal), and
// falls back to SIGKILL so the probe always terminates. Which branch fired is
// recorded via a marker file, not assumed.
const marker = join(root, "client-marker.txt")
const watchdog = `opencode '${wt}' --session='${sessionId}' & cpid=$!; sleep 3; if kill -0 $cpid 2>/dev/null; then echo still-running > '${marker}'; kill -INT $cpid 2>/dev/null; sleep 5; kill -9 $cpid 2>/dev/null; else echo exited-early > '${marker}'; fi; wait $cpid; exit $?`
const childStartedAt = Date.now()
const exitCode = await runForegroundChild({ argv: ["sh", "-lc", watchdog], cwd: wt, suspend, resume })
const markerText = await Bun.file(marker).text().catch(() => "(marker missing)")
record("real-client-foreground", {
  exitCode,
  clientBehavior: markerText.trim(),
  elapsedMs: Date.now() - childStartedAt,
  events: events.splice(0),
  destroyed: renderer.isDestroyed,
  dimensionsAfter: { width: renderer.width, height: renderer.height },
  inputAlive: renderer.keyInput !== undefined,
})

// ── 2. Two-work concurrency: claims are scoped per checkout branch ─────────
const { acquireWriterClaim } = await import("../src/writer-claims")
const { repoCommonDir } = await import("../src/repo-store")
const commonDir = (await repoCommonDir(main))!
git(["worktree", "add", "-q", "-b", "feat/second-probe", join(root, "wt2")])
const first = await acquireWriterClaim({ commonDir, branch: "feat/fg-probe", checkoutPath: wt, kind: "authoring", owner: sessionId })
const second = await acquireWriterClaim({ commonDir, branch: "feat/second-probe", checkoutPath: join(root, "wt2"), kind: "authoring", owner: "ses_other" })
const blocked = await acquireWriterClaim({ commonDir, branch: "feat/fg-probe", checkoutPath: wt, kind: "authoring", owner: "ses_other" })
record("two-work-concurrency", { first: first.status, secondIndependentCheckout: second.status, sameCheckoutSecondWriter: blocked.status })

// ── 3. External pane creation fails independently and is never claimed ─────
// No live Zellij session exists in this environment, so the FORCED zellij
// backend exercises the honest failure path: pane creation fails, the outcome
// is `failed`, and nothing reports a running conversation. A forced backend
// never falls through to a macOS window (that fall-through is unforced-only),
// so this leg cannot open a real Terminal window.
process.env.CONVOY_TERMINAL = "zellij"
const external = await openConversationExternal({ checkout: wt, ref: { harness: "opencode", sessionId } })
record("external-pane-failure-path", { status: external.status, reason: external.status === "failed" ? external.reason.slice(0, 120) : undefined })

renderer.destroy()
server.proc.kill()
await rm(root, { recursive: true, force: true })
record("teardown", { destroyed: renderer.isDestroyed })
console.log("PROBE COMPLETE")
process.exit(0)
