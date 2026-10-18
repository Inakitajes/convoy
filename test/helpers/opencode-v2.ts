import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { launchManagedServer, type ManagedServer } from "../../src/managed-server"
import { createOpencodeClient, type Config, type OpencodeClient } from "../../src/opencode-client"
import { createProcessRecordStore } from "../../src/process-records"

/**
 * Real-runtime fixture for the OpenCode V2 integration: an isolated `opencode
 * serve` (throwaway HOME/XDG, no provider credentials in the child's
 * environment) plus a scripted OpenAI-compatible provider, so model turns run
 * through the real runtime deterministically and without reaching a paid model.
 */

export const opencodeAvailable = Boolean(Bun.which("opencode"))

export type ScriptedReply = { text: string } | { tool: string; args: unknown } | { status: number }

export type ScriptedProvider = {
  url: string
  /** Every chat-completions request body the runtime sent, in order. */
  requests: Array<Record<string, unknown>>
  stop(): void
}

/** Names of the tools offered to the model in one request. */
export function offeredTools(body: Record<string, unknown> | undefined): string[] {
  const tools = (body?.tools ?? []) as Array<{ function?: { name?: string } }>
  return tools.map((tool) => tool.function?.name ?? "")
}

/** Whether the request answers a tool result (the model's previous turn called a tool). */
export function answersToolResult(body: Record<string, unknown>): boolean {
  const messages = (body.messages ?? []) as Array<{ role?: string }>
  return messages[messages.length - 1]?.role === "tool"
}

export function startScriptedProvider(reply: (body: Record<string, unknown>, index: number) => ScriptedReply): ScriptedProvider {
  const requests: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/models")) return Response.json({ data: [{ id: "mock-model", object: "model" }] })
      if (!path.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await request.json()) as Record<string, unknown>
      requests.push(body)
      const next = reply(body, requests.length - 1)
      if ("status" in next) return Response.json({ error: { message: "scripted failure", type: "invalid_request_error" } }, { status: next.status })
      const id = `cmpl-${requests.length}`
      const delta = "text" in next
        ? { role: "assistant", content: next.text }
        : { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: next.tool, arguments: JSON.stringify(next.args) } }] }
      const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "mock-model", choices: [{ index: 0, ...choice }], ...extra })}\n\n`
      const stream =
        chunk({ delta, finish_reason: null }) +
        chunk({ delta: {}, finish_reason: "text" in next ? "stop" : "tool_calls" }, { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) +
        "data: [DONE]\n\n"
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

/** The operator's global OpenCode config declaring the scripted provider. */
export function scriptedProviderConfig(baseURL: string): Record<string, unknown> {
  return {
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL, apiKey: "mock" },
        models: {
          "mock-model": {
            name: "Mock Model",
            limit: { context: 100_000, output: 4_000 },
            cost: { input: 1, output: 2 },
            variants: { deep: { reasoningEffort: "high" } },
          },
        },
      },
    },
    enabled_providers: ["mock"],
  }
}

export type IsolatedRuntime = {
  root: string
  checkout: string
  /** Environment for anything spawned against this runtime: isolated, credential-free. */
  env: Record<string, string>
  cleanup(): Promise<void>
}

/** Throwaway HOME/XDG and a committed git checkout; real provider credentials are stripped. */
export async function createIsolatedRuntime(globalConfig?: Record<string, unknown>): Promise<IsolatedRuntime> {
  const root = await mkdtemp(join(tmpdir(), "convoy-v2-runtime-"))
  const checkout = join(root, "repo")
  await mkdir(checkout, { recursive: true })
  await Bun.write(join(checkout, "README.md"), "# repo\n")
  await Bun.$`git init -q && git add . && git -c user.email=t@t -c user.name=t commit -qm init`.cwd(checkout).quiet()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /API_KEY|TOKEN|SECRET|PASSWORD|ANTHROPIC|OPENAI|OPENROUTER|^OPENCODE_|^HERDR_/i.test(key)) continue
    env[key] = value
  }
  Object.assign(env, {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  })
  if (globalConfig) {
    await mkdir(join(root, "config", "opencode"), { recursive: true })
    await Bun.write(join(root, "config", "opencode", "opencode.json"), JSON.stringify(globalConfig))
  }
  return { root, checkout, env, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("no free port"))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })
}

export type BootedRuntime = { server: ManagedServer; client: OpencodeClient }

/** Boots the real runtime with Convoy's run config injected exactly as the run server receives it. */
export async function bootRuntime(runtime: IsolatedRuntime, config: Config = {}): Promise<BootedRuntime> {
  const server = await launchManagedServer({
    command: "opencode",
    args: ["serve", "--hostname=127.0.0.1", `--port=${await freePort()}`],
    cwd: runtime.checkout,
    env: { ...runtime.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    lifetime: "helper",
    label: "v2 runtime fixture",
    timeoutMs: 30_000,
    deps: { store: createProcessRecordStore(join(runtime.root, "processes")), reconcile: async () => {} },
  })
  const client = createOpencodeClient({ baseUrl: server.url, ...(server.password ? { password: server.password } : {}) })
  return { server, client }
}

/** Polls until `check` holds or the deadline passes; returns whether it held. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await Bun.sleep(100)
  }
  return false
}
