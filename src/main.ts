#!/usr/bin/env bun
import { parseAndRun } from "./cli"
import { log } from "./log"
import { isUserAbortError } from "./runner"

// The opencode SDK's SSE client cancels its reader on abort without awaiting
// it; on Bun that surfaces as an unhandled rejection that would kill the run.
process.on("unhandledRejection", (reason) => {
  log.warn(`ignored async error: ${reason instanceof Error ? reason.message : String(reason)}`)
})

parseAndRun(Bun.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(isUserAbortError(error) ? 130 : 1)
})
