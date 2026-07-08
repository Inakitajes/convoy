import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { addWorktree, ensureRepoReady, findSuspiciousStagedFiles, initializeRepoWithInitialCommit, repoBootstrapStatus } from "../src/git"

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

describe("initializeRepoWithInitialCommit", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function tmpRepoDir() {
    const dir = await mkdtemp(join(tmpdir(), "archer-init-repo-"))
    dirs.push(dir)
    return dir
  }

  async function gitOutput(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`)
    return stdout.trim()
  }

  test("detects a directory without a git repository", async () => {
    const dir = await tmpRepoDir()
    expect(await repoBootstrapStatus(dir)).toBe("no-repo")
  })

  test("initializes a new repository with an empty initial commit", async () => {
    const dir = await tmpRepoDir()

    await initializeRepoWithInitialCommit(dir, { baseRef: "main" })

    expect(await repoBootstrapStatus(dir)).toBe("ready")
    expect(await gitOutput(["branch", "--show-current"], dir)).toBe("main")
    expect(await gitOutput(["log", "-1", "--format=%s"], dir)).toBe("archer: initial commit")
    await expect(ensureRepoReady(dir, { baseRef: "main" })).resolves.toBeUndefined()
  })

  test("includes existing project files in the initial commit", async () => {
    const dir = await tmpRepoDir()
    await writeFile(join(dir, "README.md"), "hello\n")

    await initializeRepoWithInitialCommit(dir, { baseRef: "main" })

    expect(await gitOutput(["show", "--format=", "--name-only", "HEAD"], dir)).toBe("README.md")
    expect(await gitOutput(["status", "--porcelain"], dir)).toBe("")
  })

  test("creates an initial commit for a repository with no commits", async () => {
    const dir = await tmpRepoDir()
    await gitOutput(["init", "-q", "-b", "main"], dir)

    expect(await repoBootstrapStatus(dir)).toBe("no-commits")
    await initializeRepoWithInitialCommit(dir, { baseRef: "main" })
    expect(await repoBootstrapStatus(dir)).toBe("ready")
  })

  test("creates the initial commit on the requested base branch", async () => {
    const dir = await tmpRepoDir()
    await gitOutput(["init", "-q", "-b", "master"], dir)

    await initializeRepoWithInitialCommit(dir, { baseRef: "main" })

    expect(await gitOutput(["branch", "--show-current"], dir)).toBe("main")
    await expect(ensureRepoReady(dir, { baseRef: "main" })).resolves.toBeUndefined()
  })

  test("refuses to create an initial commit with likely secrets", async () => {
    const dir = await tmpRepoDir()
    await writeFile(join(dir, ".env"), "TOKEN=secret\n")

    await expect(initializeRepoWithInitialCommit(dir, { baseRef: "main" })).rejects.toThrow(/look like secrets/)
    expect(await repoBootstrapStatus(dir)).toBe("no-commits")
  })
})

describe("addWorktree", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "archer-test",
        GIT_AUTHOR_EMAIL: "archer-test@example.invalid",
        GIT_COMMITTER_NAME: "archer-test",
        GIT_COMMITTER_EMAIL: "archer-test@example.invalid",
      },
    })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  test("creates a branch checked out in a separate worktree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "archer-worktree-repo-"))
    const worktree = await mkdtemp(join(tmpdir(), "archer-worktree-dir-"))
    await rm(worktree, { recursive: true, force: true })
    dirs.push(repo, worktree)

    await git(["init", "-q"], repo)
    await writeFile(join(repo, "README.md"), "base\n")
    await git(["add", "README.md"], repo)
    await git(["commit", "-q", "-m", "init"], repo)

    await addWorktree(worktree, "add-onboarding-flow", "HEAD", repo)

    expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("base\n")
    const branch = Bun.spawn(["git", "branch", "--show-current"], { cwd: worktree, stdout: "pipe", stderr: "pipe" })
    expect((await new Response(branch.stdout).text()).trim()).toBe("add-onboarding-flow")
    expect(await branch.exited).toBe(0)
  })
})
