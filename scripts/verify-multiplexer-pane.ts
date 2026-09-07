/**
 * Task 7.2 multiplexer leg (`unify-work-context`): the external-presentation
 * SUCCESS path inside a real Zellij session. The probe is launched as a
 * Zellij pane (via a layout under a pty hosted by `script`), so the ZELLIJ
 * environment is live and `openConversationExternal` takes the zellij backend:
 * a new pane is created running the real `opencode <worktree> --session=<id>`
 * client, the linked session is verified through the authoring server, and
 * the outcome is recorded. Run:
 *
 *   script -q /dev/null zellij --session convoy-verify-mux \
 *     --new-session-with-layout scripts/verify-multiplexer-layout.kdl
 *
 * The layout's pane command runs this script; the log lands at
 * $CONVOY_VERIFY_LOG (default verify-multiplexer.log).
 */
import { appendFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { openConversationExternal } from "../src/conversations"

const logPath = process.env.CONVOY_VERIFY_LOG ?? "verify-multiplexer.log"
const record = (step: string, outcome: unknown) => appendFileSync(logPath, `STEP ${step}: ${JSON.stringify(outcome).slice(0, 400)}\n`)

record("environment", { insideZellij: Boolean(process.env.ZELLIJ), insideHerdr: Boolean(process.env.HERDR_ENV) })

const root = await mkdtemp(join(tmpdir(), "convoy-verify-mux-"))
const wt = join(root, "wt")
await mkdir(wt, { recursive: true })
await writeFile(join(wt, "README.md"), "# mux\n")
const git = (args: string[]) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd: wt, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString().slice(0, 200)}`)
}
git(["init", "-q", "-b", "main"])
git(["add", "."])
git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])

let nextPort = 27001
const proc = Bun.spawn(["opencode", "serve", "--hostname=127.0.0.1", `--port=${nextPort}`], { cwd: wt, stdout: "pipe", stderr: "pipe" })
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
const client = createOpencodeClient({ baseUrl: url })
const session = await client.session.create({ title: "multiplexer probe" })
if (session.error) throw new Error(`session create failed: ${JSON.stringify(session.error)}`)
const sessionId = session.data!.id
record("fixture", { sessionId, wt })

// The success path: pane creation and session verification through the same
// validated work and session reference the foreground path uses.
const outcome = await openConversationExternal({ checkout: wt, ref: { harness: "opencode", sessionId }, server: { url } })
record("external-pane-outcome", {
  status: outcome.status,
  backend: outcome.status === "opened" || outcome.status === "opened-unverified" ? outcome.backend : undefined,
  reason: outcome.status === "opened-unverified" || outcome.status === "failed" ? outcome.reason.slice(0, 200) : undefined,
})

// Give the pane's client a moment, then record whether it is running (the
// pane's client itself is unobservable; the session's server-side state is
// what Convoy can honestly know).
await Bun.sleep(4_000)
const status = await client.session.status()
record("session-status-after-pane", { data: JSON.stringify(status.data).slice(0, 200) })

proc.kill()
await rm(root, { recursive: true, force: true })
record("done", {})
process.exit(0)
