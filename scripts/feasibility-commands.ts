/**
 * Task 2.3 feasibility probe (`unify-work-context`): verifies project
 * authoring-command discovery (the project's `.opencode/commands/*.md` set)
 * through OpenCode's public command API, plus the invocation endpoint shape.
 * No global command installation is performed. Run with
 * `bun run scripts/feasibility-commands.ts` from this repository.
 */
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2"

const record = (step: string, outcome: unknown) => console.log(`STEP ${step}: ${JSON.stringify(outcome).slice(0, 400)}`)
const errText = (e: unknown) => (e && typeof e === "object" ? JSON.stringify(e).slice(0, 200) : String(e))

const repoDir = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0, timeout: 30_000 })
record("server", { url: server.url, cwd: repoDir })
const client = createOpencodeClient({ baseUrl: server.url })

// 1. Discovery through the public command API.
const commands = await client.command.list()
if (commands.error) {
  record("command-list", { error: errText(commands.error) })
} else {
  const ids = (commands.data ?? []).map((entry: { name?: string; trigger?: string }) => entry.name ?? entry.trigger)
  record("command-list", { count: ids.length, ids: ids.filter((id: string | undefined) => typeof id === "string" && id.includes("opsx")).slice(0, 10) })
  record("opsx-propose-discovered", { present: ids.includes("opsx-propose") })
}

// 2. Raw HTTP cross-check (the SDK's typed get/messages drifted from the
//    installed CLI; command discovery is verified on the wire too).
const raw = await fetch(`${server.url}/command`)
const rawCommands = raw.ok ? ((await raw.json()) as Array<{ name?: string }>) : undefined
record("raw-command-list", {
  status: raw.status,
  opsxCommands: (rawCommands ?? []).map((entry) => entry.name).filter((name) => typeof name === "string" && name.startsWith("opsx")).sort(),
})

// 3. Invocation endpoint shape (documented; NOT executed — a live command run
//    would start a real proposal workflow against this repository):
//    POST /session/{id}/command with { command: "opsx-propose", arguments: "..." }.
//    Verified present in the installed CLI's route table via the SDK types:
//    `Session.command` → url "/session/{id}/command".
record("invocation-endpoint", { method: "POST", url: "/session/{id}/command", body: { command: "opsx-propose", arguments: "<change name or description>" }, note: "shape documented from SDK types; not executed to avoid a real proposal run" })

server.close()
console.log("PROBE COMPLETE")
