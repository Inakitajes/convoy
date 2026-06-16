import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.ARCHER_HOME ??= join(tmpdir(), `archer-test-home-${process.pid}`)
mkdirSync(process.env.ARCHER_HOME, { recursive: true })
