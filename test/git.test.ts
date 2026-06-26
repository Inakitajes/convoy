import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ensureRepoReady, findSuspiciousStagedFiles } from "../src/git"

describe("findSuspiciousStagedFiles", () => {
  test("flags common secret filenames", () => {
    const porcelain = [
      "A  lib/feature/onboarding.dart",
      "A  .env",
      "A  android/app/keystore.jks",
      "M  config/credentials.json",
      "A  certs/server.pem",
      "A  ssh/id_rsa",
      "?? .env.local",
    ].join("\n")

    expect(findSuspiciousStagedFiles(porcelain)).toEqual([
      ".env",
      "android/app/keystore.jks",
      "config/credentials.json",
      "certs/server.pem",
      "ssh/id_rsa",
      ".env.local",
    ])
  })

  test("does not flag innocuous Flutter files", () => {
    const porcelain = [
      "A  lib/feature/onboarding.dart",
      "M  pubspec.yaml",
      "A  test/onboarding_test.dart",
      "A  assets/images/logo.png",
    ].join("\n")

    expect(findSuspiciousStagedFiles(porcelain)).toEqual([])
  })

  test("ignores deletions of previously committed secrets", () => {
    const porcelain = ["D  .env", "D  certs/server.pem"].join("\n")
    expect(findSuspiciousStagedFiles(porcelain)).toEqual([])
  })

  test("handles renames using -> arrow", () => {
    const porcelain = `R  config/old.txt -> config/credentials.json`
    expect(findSuspiciousStagedFiles(porcelain)).toEqual(["config/credentials.json"])
  })

  test("decodes C-quoted porcelain paths before matching", () => {
    const porcelain = ['A  "secret dir/.env"', 'A  "caf\\303\\251/.env"'].join("\n")
    expect(findSuspiciousStagedFiles(porcelain)).toEqual(["secret dir/.env", "cafÃ©/.env"])
  })
})

describe("ensureRepoReady", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  async function dirtyRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "archer-ensure-repo-"))
    dirs.push(dir)
    await git(["init", "-q"], dir)
    await writeFile(join(dir, "dirty.txt"), "uncommitted\n")
    // git reports the physical path; ensureRepoReady resolves symlinks too, but
    // mkdtemp on macOS hands back a /var → /private/var symlink, so compare from there.
    const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    return (await new Response(proc.stdout).text()).trim()
  }

  test("throws on a dirty tree without allowDirty", async () => {
    const dir = await dirtyRepo()
    await expect(ensureRepoReady(dir)).rejects.toThrow(/not clean/)
  })

  test("allowDirty defers the dirty-tree decision so resume can recover", async () => {
    const dir = await dirtyRepo()
    await expect(ensureRepoReady(dir, { allowDirty: true })).resolves.toBeUndefined()
  })
})
