import { createServer } from "node:net"

import { log } from "./log"
import { writeReportToolName } from "./report"
import type { ReportRuntime } from "./report-runtime"
import { writeOpencodePlugin } from "./workspace"

export const reportUrlEnv = "CONVOY_REPORT_URL"
export const reportTokenEnv = "CONVOY_REPORT_TOKEN"

export type ReportBridge = {
  url: string
  token: string
  close(): void
}

export type StartReportBridgeOptions = {
  /** Resolved after OpenCode starts, before any executor session is created. */
  reports: () => ReportRuntime | undefined
  hostname?: string
}

/** Starts the authenticated loopback hop used by OpenCode's write_report shim. */
export async function startReportBridge(options: StartReportBridgeOptions): Promise<ReportBridge> {
  const token = crypto.randomUUID()
  const hostname = options.hostname ?? "127.0.0.1"
  const port = await freePort(hostname)
  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 0,
    fetch: (request) => handleReport(request, options.reports, token),
  })
  const url = `http://${hostname}:${server.port}/report`
  log.info(`[report] bridge listening at ${url}`)
  return { url, token, close: () => server.stop(true) }
}

async function handleReport(request: Request, reports: (() => ReportRuntime | undefined) | ReportRuntime, token: string): Promise<Response> {
  const runtime = typeof reports === "function" ? reports() : reports
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 })
  let body: { sessionID?: unknown; payload?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return new Response("invalid json", { status: 400 })
  }
  const sessionID = typeof body.sessionID === "string" ? body.sessionID : ""
  if (!sessionID) return new Response("sessionID required", { status: 400 })
  const handle = runtime?.handleFor(sessionID)
  if (!handle) return new Response("unknown report session", { status: 404 })
  const result = await handle.write(body.payload)
  if ("error" in result) return Response.json(result, { status: 400 })
  return Response.json({ message: "Report saved.", chars: result.markdown.length })
}

async function freePort(hostname: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, hostname, () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("couldn't find a free port for the report bridge"))
        return
      }
      probe.close(() => resolve(address.port))
    })
  })
}

/**
 * Materializes the write_report tool as a V2 plugin package before the run
 * server starts; the server loads it through its config's `plugins` list.
 * The tool is registered through the plugin context's `tool.transform`
 * editor. Returns the plugin's entry file.
 */
export async function installWriteReportTool(options: { url?: string; token?: string; dir: string }): Promise<string> {
  const { dir } = options
  const source = options.url && options.token ? writeReportToolSourceWith(options.url, options.token) : fallbackWriteReportToolSource
  return await writeOpencodePlugin(dir, writeReportToolName, source)
}

function writeReportToolSourceWith(url: string, token: string): string {
  return writeReportToolSource(JSON.stringify(escapeForSource(url)), JSON.stringify(escapeForSource(token)))
}

function escapeForSource(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$")
}

const writeReportToolDescription =
  "Persist this phase's complete Markdown report through Convoy. Call it before finishing every phase. Convoy fixes the report path; do not use write or edit for the report. In read-only phases this is the only permitted report write. Writable phases may also pass commit: an imperative English subject describing the repository outcome (never the report, agent, or process) plus up to three concrete details — Convoy renders them into this phase's step commit. Scoring agents pass dimensions, mustFix, gaps, and confidence; never invent score or verdict."

/** The write_report input JSON schema (V2 tools take a JSON Schema `input`). */
const writeReportInputSchema = `{
          type: "object",
          properties: {
            markdown: { type: "string" },
            dimensions: { type: "object", properties: { prd: { type: "number" }, tests: { type: "number" }, security: { type: "number" }, maintainability: { type: "number" }, operational: { type: "number" }, scope: { type: "number" } } },
            mustFix: { type: "array", items: { type: "string" } },
            gaps: { type: "object", properties: { prd: { type: "string" }, tests: { type: "string" }, security: { type: "string" }, maintainability: { type: "string" }, operational: { type: "string" }, scope: { type: "string" } } },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            commit: { type: "object", properties: { subject: { type: "string" }, details: { type: "array", items: { type: "string" } } }, required: ["subject"] },
          },
          required: ["markdown"],
        }`

function writeReportToolSource(url: string, token: string): string {
  return `// Generated by Convoy. Do not edit: it is rewritten on every run.
import { Plugin } from "@opencode/plugin"
export default Plugin.define({
  id: "convoy-write-report",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: ${JSON.stringify(writeReportToolName)},
        description: ${JSON.stringify(writeReportToolDescription)},
        // V2 hides plugin tools behind Code Mode by default; the phase contract
        // needs write_report on the model's native tool list.
        options: { codemode: false },
        input: ${writeReportInputSchema},
        async execute(args, context) {
          const url = ${url}
          const token = ${token}
          try {
            const response = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: "Bearer " + token },
              body: JSON.stringify({ sessionID: context?.sessionID, payload: args }),
              signal: context?.signal,
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "report bridge returned " + response.status)
            return { content: typeof body?.message === "string" ? body.message : "Report saved." }
          } catch (error) {
            throw new Error("write_report failed: " + (error instanceof Error ? error.message : String(error)))
          }
        },
      })
    })
  },
})
`
}

const fallbackWriteReportToolSource = writeReportToolSource(`process.env.${reportUrlEnv}`, `process.env.${reportTokenEnv}`)
