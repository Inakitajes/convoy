import { createServer } from "node:net"

import { log } from "./log"
import { qualityDimensions } from "./quality-score"
import { writeReportScope, writeReportToolName, type WriteReportScope } from "./report"
import type { ReportRuntime } from "./report-runtime"
import { registerSecret } from "./runners/redaction"
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
  registerSecret(token)
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

/** The run agent's properties its write_report scope derives from. */
export type WriteReportAgent = { name: string; readOnly?: boolean }

/**
 * Materializes the write_report tool as a V2 plugin package before the run
 * server starts; the server loads it through its config's `plugins` list.
 * The tool is registered through the plugin context's `tool.transform`
 * editor. Returns the plugin's entry file.
 *
 * V2 registers one tool for the whole server, so it is registered unscoped
 * and each of the run's `agents` gets its own phase-scoped schema through the
 * session `context` hook, which edits the tools offered to that agent's
 * model request. An agent's read-only flag is its phase's: forced read-only
 * steps run on a synthesized `__ro` agent.
 */
export async function installWriteReportTool(options: { url?: string; token?: string; dir: string; agents?: readonly WriteReportAgent[] }): Promise<string> {
  const { dir } = options
  const scoped = Object.fromEntries(
    (options.agents ?? []).map((agent) => {
      const scope = writeReportScope(agent.name, agent.readOnly)
      return [agent.name, { description: writeReportToolDescriptionFor(scope), input: writeReportInputJsonSchemaFor(scope) }]
    }),
  )
  const [url, token] =
    options.url && options.token
      ? [JSON.stringify(escapeForSource(options.url)), JSON.stringify(escapeForSource(options.token))]
      : [`process.env.${reportUrlEnv}`, `process.env.${reportTokenEnv}`]
  return await writeOpencodePlugin(dir, writeReportToolName, writeReportToolSource(url, token, scoped))
}

function escapeForSource(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$")
}

const reportSentences =
  "Persist this phase's complete Markdown report through Convoy. Call it before finishing every phase. Convoy fixes the report path; do not use write or edit for the report."
const commitClause =
  "commit: an imperative English subject describing the repository outcome (never the report, agent, or process) plus up to three concrete details — Convoy renders them into this phase's step commit."
const scoringSentence = `Pass dimensions scoring every quality dimension (${qualityDimensions.join(", ")}) as a number from 0–100, plus mustFix, gaps, and confidence; never invent score or verdict.`

/**
 * The write_report description for one phase's scope. Unscoped, it describes
 * every field a phase could be offered, for a session Convoy did not configure.
 */
export function writeReportToolDescriptionFor(scope?: WriteReportScope): string {
  if (!scope) {
    return `${reportSentences} In read-only phases this is the only permitted report write. Writable phases may also pass ${commitClause} Scoring agents pass dimensions, mustFix, gaps, and confidence; never invent score or verdict.`
  }
  return [
    reportSentences,
    scope.writable ? `You may also pass ${commitClause}` : "This phase is read-only: this is its only permitted write, and it creates no step commit.",
    ...(scope.scoring ? [scoringSentence] : []),
  ].join(" ")
}

/**
 * The write_report input JSON schema for one phase's scope, shared by
 * OpenCode's plugin tool (V2 tools take a JSON Schema `input`) and the CLI
 * runners' MCP tool so every runner offers the identical contract. Models
 * follow the schema more than the description, so a read-only phase is never
 * offered commit, a non-scoring phase never the scoring fields, and a scoring
 * phase must send every dimension in range. Unscoped, it offers every field.
 */
export function writeReportInputJsonSchemaFor(scope?: WriteReportScope): Record<string, unknown> {
  const writable = scope?.writable ?? true
  const scoring = scope?.scoring ?? true
  const perDimension = (type: Record<string, unknown>) => Object.fromEntries(qualityDimensions.map((dimension) => [dimension, type]))
  return {
    type: "object",
    properties: {
      markdown: { type: "string" },
      ...(scoring
        ? {
            dimensions: { type: "object", properties: perDimension({ type: "number", minimum: 0, maximum: 100 }), required: [...qualityDimensions] },
            mustFix: { type: "array", items: { type: "string" } },
            gaps: { type: "object", properties: perDimension({ type: "string" }) },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          }
        : {}),
      ...(writable ? { commit: { type: "object", properties: { subject: { type: "string" }, details: { type: "array", items: { type: "string" } } }, required: ["subject"] } } : {}),
    },
    required: scope?.scoring ? ["markdown", "dimensions"] : ["markdown"],
  }
}

/** The unscoped contract: what a session Convoy did not configure is offered. */
const writeReportToolDescription = writeReportToolDescriptionFor()
const writeReportInputJsonSchema = writeReportInputJsonSchemaFor()

type ScopedWriteReportTool = { description: string; input: Record<string, unknown> }

function writeReportToolSource(url: string, token: string, scoped: Record<string, ScopedWriteReportTool>): string {
  const name = JSON.stringify(writeReportToolName)
  // Each run agent is offered the write_report schema of its own phase scope;
  // a session on any other agent keeps the unscoped registration.
  const scopedHook =
    Object.keys(scoped).length === 0
      ? ""
      : `
    const scoped = ${JSON.stringify(scoped)}
    await ctx.session.hook("context", (request) => {
      const tool = scoped[request.agent]
      if (tool && request.tools[${name}]) request.tools[${name}] = tool
    })`
  return `// Generated by Convoy. Do not edit: it is rewritten on every run.
import { Plugin } from "@opencode/plugin"
export default Plugin.define({
  id: "convoy-write-report",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: ${name},
        description: ${JSON.stringify(writeReportToolDescription)},
        // V2 hides plugin tools behind Code Mode by default; the phase contract
        // needs write_report on the model's native tool list.
        options: { codemode: false },
        input: ${JSON.stringify(writeReportInputJsonSchema)},
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
    })${scopedHook}
  },
})
`
}
