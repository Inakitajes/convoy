import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readPrMergeState } from "../src/pr-merge-state"

/**
 * `readPrMergeState` (change `close-lands-via-github-pr`, design D4) is the one
 * hosted-merge receipt both the reality probe and the landing effect read. A
 * failed query must stay honestly unknown — never reported as an absent or
 * unmerged PR — and a merge commit is recorded only when GitHub returns a
 * resolvable 40-hex SHA.
 */

const scratch: string[] = []

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {})
  process.exitCode = 0
})

/** Runs `fn` with a stub `gh` first on PATH. */
async function withStubGh(script: string, fn: () => Promise<void>): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), "convoy-gh-stub-"))
  scratch.push(binDir)
  await writeFile(join(binDir, "gh"), script)
  await chmod(join(binDir, "gh"), 0o755)
  const savedPath = process.env.PATH
  process.env.PATH = `${binDir}:${savedPath ?? ""}`
  try {
    await fn()
  } finally {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
  }
}

const sha = "a".repeat(40)

const stub = (body: string): string => `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.0"; exit 0; fi
${body}
`

describe("readPrMergeState", () => {
  test("a merged PR reports its state and resolvable squash commit", async () => {
    await withStubGh(stub(`echo '{"state":"MERGED","mergeCommit":"${sha}"}'`), async () => {
      expect(await readPrMergeState(7, process.cwd())).toEqual({ state: "MERGED", mergeCommit: sha })
    })
  })

  test("a merge commit that is not a 40-hex SHA is not recorded as one", async () => {
    await withStubGh(stub(`echo '{"state":"MERGED","mergeCommit":"not-a-sha"}'`), async () => {
      expect(await readPrMergeState(7, process.cwd())).toEqual({ state: "MERGED" })
    })
  })

  test("a missing GitHub CLI is a reason, not an absent PR", async () => {
    await withStubGh("#!/bin/sh\nexit 1\n", async () => {
      const result = await readPrMergeState(7, process.cwd())
      expect(result.state).toBeUndefined()
      expect(result.reason).toBeTruthy()
    })
  })

  test("a failed PR query is unknown with its reason", async () => {
    await withStubGh(stub(`echo "gh: GraphQL: Could not resolve to a PullRequest" >&2\nexit 1`), async () => {
      const result = await readPrMergeState(7, process.cwd())
      expect(result.state).toBeUndefined()
      expect(result.reason).toContain("Could not resolve")
    })
  })

  test("unreadable JSON output is unknown, not a guessed state", async () => {
    await withStubGh(stub(`echo "not json"`), async () => {
      const result = await readPrMergeState(7, process.cwd())
      expect(result.state).toBeUndefined()
      expect(result.reason).toBeTruthy()
    })
  })
})
