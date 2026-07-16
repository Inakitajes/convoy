import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate every test run from the developer's real ~/.convoy so tests never
// read or write the user's actual config, runs, or agent prompts. CONVOY_HOME
// points at the directory that holds `.convoy` (the same convention as a repo
// root), so the global config resolves to <tmp>/.convoy/config.yaml.
process.env.CONVOY_HOME ??= join(tmpdir(), `convoy-test-home-${process.pid}`)
mkdirSync(process.env.CONVOY_HOME, { recursive: true })
