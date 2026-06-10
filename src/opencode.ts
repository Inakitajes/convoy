import "./polyfills"

import { spawnSync } from "node:child_process"
import { createServer } from "node:net"

import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2"

import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2"

export type OpencodeHandle = {
  client: OpencodeClient
  url: string
  close(): void
}

export async function startOpencode(config: Config, signal?: AbortSignal): Promise<OpencodeHandle> {
  const port = await freePort()
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port,
    timeout: 30_000,
    signal,
    config,
  })
  const client = createOpencodeClient({ baseUrl: server.url, fetch: fetchWithoutIdleTimeout as typeof fetch })

  return {
    client,
    url: server.url,
    close: server.close,
  }
}

// Bun kills fetch sockets that stay quiet for 5 minutes by default; the SSE
// event stream must outlive that during long tool runs. Bun honors the
// non-standard `timeout: false` since 1.1; on older versions it's ignored,
// which is why no single request is ever relied on for a whole phase.
function fetchWithoutIdleTimeout(request: Request) {
  return fetch(request, { timeout: false } as RequestInit)
}

export function openOpencodeSessionWindow(input: { url: string; targetDir: string; sessionID: string }) {
  if (process.platform !== "darwin") {
    throw new Error("opening a new OpenCode terminal window is currently implemented for macOS only")
  }

  const command = [
    process.env.PATH ? `export PATH=${shellQuote(process.env.PATH)}:$PATH` : "",
    ["opencode", "attach", input.url, "--dir", input.targetDir, "--session", input.sessionID].map(shellQuote).join(" "),
  ]
    .filter(Boolean)
    .join("; ")

  const script = `tell application "Terminal"\nactivate\ndo script ${appleScriptString(command)}\nend tell`
  const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `osascript exited with status ${result.status}`)
}

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("couldn't find a free port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function appleScriptString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
