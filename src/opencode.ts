import { createServer } from "node:net"

import { createOpencode } from "@opencode-ai/sdk/v2"

import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2"

export type OpencodeHandle = {
  client: OpencodeClient
  url: string
  close(): void
}

export async function startOpencode(config: Config): Promise<OpencodeHandle> {
  const port = await freePort()
  const { client, server } = await createOpencode({
    hostname: "127.0.0.1",
    port,
    timeout: 30_000,
    config,
  })

  return {
    client,
    url: server.url,
    close: server.close,
  }
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
