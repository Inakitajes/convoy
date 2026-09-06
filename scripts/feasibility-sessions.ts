/**
 * Task 2.1 feasibility probe (`unify-work-context`): exercises the public
 * OpenCode session lifecycle against the installed binary/SDK — creation,
 * exact-ID opening, reconnect + history read, and repository scoping — using
 * the v2 SDK's parameter shapes. Everything goes through public interfaces
 * (SDK client/server, CLI); no internal session storage is read or edited.
 * Run with `bun run scripts/feasibility-sessions.ts`; pass `--keep` to retain
 * the probe checkout.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2"

const keep = process.argv.includes("--keep")
const root = await mkdtemp(join(tmpdir(), "convoy-feasibility2-"))
const mainDir = await mkdtemp(join(tmpdir(), "convoy-feasibility2-main-"))
const wtDir = join(root, "wt")
await Bun.write(join(mainDir, "README.md"), "# probe\n")
const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: mainDir, stdout: "pipe", stderr: "pipe" })
git(["init", "-q", "-b", "main"])
git(["add", "."])
git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-q", "-m", "init"])
git(["worktree", "add", "-q", "-b", "feat/probe", wtDir])

const record = (step: string, outcome: unknown) => console.log(`STEP ${step}: ${JSON.stringify(outcome).slice(0, 400)}`)
const errText = (e: unknown) => (e && typeof e === "object" ? JSON.stringify(e).slice(0, 220) : String(e))

/**
 * Spawns `opencode serve` in a checkout and resolves its URL (public CLI).
 * The SDK's createOpencodeServer cannot set cwd, so this mirrors its launch
 * with an explicit cwd — the spawn shape a per-checkout conversation service
 * would use.
 */
async function bootServer(port: number, cwd: string): Promise<{ url: string; proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe"> }> {
  const proc = Bun.spawn(["opencode", "serve", "--hostname=127.0.0.1", `--port=${port}`], { cwd, stdout: "pipe", stderr: "pipe" })
  const url = await new Promise<string>((resolve, reject) => {
const timer = setTimeout(() => {
      void (proc.stderr as ReadableStream)
        .pipeThrough(new TextDecoderStream())
        .pipeTo(
          new WritableStream({
            write(t) {
              reject(new Error(`boot timeout (stderr: ${t.slice(0, 300)}))`))
            },
          }),
        )
        .catch(() => reject(new Error("boot timeout")))
    }, 30_000)
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
    )
  })
  return { url, proc }
}

let nextPort = 26431
const freePort = () => nextPort++

const a = await bootServer(freePort(), mainDir)
record("server-a", { url: a.url, cwd: mainDir })
const clientA = createOpencodeClient({ baseUrl: a.url })

// 1. Public session creation.
const created = await clientA.session.create({ title: "authoring probe" })
if (created.error) {
  record("session-create", { error: errText(created.error) })
  process.exit(1)
}
const id = created.data!.id
record("session-create", { id, title: created.data!.title })

// 2. Exact-ID opening through the public API.
const got = await clientA.session.get({ sessionID: id })
record("session-get-by-id", { ok: !got.error, id: got.data?.id, error: got.error ? errText(got.error) : undefined })

// 3. Reconnect (fresh client) + history read for that exact session.
const clientA2 = createOpencodeClient({ baseUrl: a.url })
const messages = await clientA2.session.messages({ sessionID: id })
record("session-messages-after-reconnect", { ok: !messages.error, count: Array.isArray(messages.data) ? messages.data.length : errText(messages.error) })

// 4. A session created against the worktree checkout of the SAME repository:
//    OpenCode scopes projects by repository, so both checkouts share the store.
const b = await bootServer(freePort(), wtDir)
record("server-b", { url: b.url, cwd: wtDir })
const clientB = createOpencodeClient({ baseUrl: b.url })
const wtSession = await clientB.session.create({ title: "worktree probe" })
record("session-create-worktree-checkout", { ok: !wtSession.error, id: wtSession.data?.id })
const listA = await clientA2.session.list()
const listB = await clientB.session.list()
const idsA = (listA.data ?? []).map((s: { id: string }) => s.id)
const idsB = (listB.data ?? []).map((s: { id: string }) => s.id)
record("repository-scoped-lists", {
  mainCount: idsA.length,
  wtCount: idsB.length,
  mainSessionVisibleFromWorktree: idsB.includes(id),
  wtSessionVisibleFromMain: idsA.includes(wtSession.data?.id ?? ""),
})

// 5. Server restart in the same repository: exact-ID history resumption (the
//    conversation continuity contract), checked through both the SDK and raw
//    HTTP so an SDK-level artifact cannot mask a server-level answer.
a.proc.kill()
await new Promise((resolve) => setTimeout(resolve, 500))
const c = await bootServer(freePort(), mainDir)
const clientC = createOpencodeClient({ baseUrl: c.url })
const resumed = await clientC.session.get({ sessionID: id })
const resumedMessages = await clientC.session.messages({ sessionID: id })
const rawResumed = await fetch(`${c.url}/session/${id}`)
record("restart-same-repository-resume", {
  sdkGetOk: !resumed.error,
  id: resumed.data?.id,
  sdkMessagesOk: !resumedMessages.error,
  sdkMessageCount: Array.isArray(resumedMessages.data) ? resumedMessages.data.length : errText(resumedMessages.error),
  rawGetStatus: rawResumed.status,
})

// 6. Prompt without guaranteed provider credentials: record the observed
//    outcome honestly (expected: an auth/model error, not a hang).
const prompt = await clientC.session.promptAsync({ sessionID: id, parts: [{ type: "text", text: "say ok" }] })
record("session-prompt-async-no-credentials", { ok: !prompt.error, error: prompt.error ? errText(prompt.error) : undefined })

b.proc.kill()
c.proc.kill()
await rm(root, { recursive: true, force: true })
await rm(mainDir, { recursive: true, force: true })
console.log(`PROBE COMPLETE${keep ? ` (checkout kept: ${root})` : ""}`)
