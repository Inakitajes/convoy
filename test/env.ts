import { afterAll } from "bun:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setLimitsFetcherForTests } from "../src/limits"
import { stopOwnedTestServers } from "./process-teardown"

// Isolate every test run from the developer's real ~/.convoy so tests never
// read or write the user's actual config, runs, or agent prompts. CONVOY_HOME
// points at the directory that holds `.convoy` (the same convention as a repo
// root), so the global config resolves to <tmp>/.convoy/config.yaml.
process.env.CONVOY_HOME ??= join(tmpdir(), `convoy-test-home-${process.pid}`)
mkdirSync(process.env.CONVOY_HOME, { recursive: true })

// Same for the developer's own subscriptions: dashboards under test must not
// pick up the real ChatGPT/OpenRouter meters. Tests that need a snapshot
// assign it to `dashboard.limits` directly.
setLimitsFetcherForTests(async () => ({}))

// Run-level teardown: this preload `afterAll` runs once for the whole `bun test`
// invocation, while the owner process is still alive. It stops any managed
// OpenCode server a test still owns and drops its record, so a helper whose
// promise outlived its test file can never leave an orphan the production
// reconciliation in `~/.convoy/processes/` would never see (this run's records
// live under the throwaway test `CONVOY_HOME`, above).
afterAll(async () => {
  await stopOwnedTestServers().catch(() => {})
})
