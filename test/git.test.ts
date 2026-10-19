import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  addAllAndCommit,
  addWorktree,
  branchExists,
  detectBaseRef,
  diffOverview,
  ensureRepoReady,
  findSuspiciousStagedFiles,
  initializeRepoWithInitialCommit,
  listChangedFiles,
  repoBootstrapStatus,
  resolveWorktreeDefault,
  worktreeDefaultFor,
  writeDiff,
} from "../src/git"

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
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "convoy-test",
        GIT_AUTHOR_EMAIL: "convoy-test@example.invalid",
        GIT_COMMITTER_NAME: "convoy-test",
        GIT_COMMITTER_EMAIL: "convoy-test@example.invalid",
      },
    })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  async function emptyRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-ensure-repo-"))
    dirs.push(dir)
    await git(["init", "-q"], dir)
    // git reports the physical path; ensureRepoReady resolves symlinks too, but
    // mkdtemp on macOS hands back a /var → /private/var symlink, so compare from there.
    const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    return (await new Response(proc.stdout).text()).trim()
  }

  async function dirtyRepo(): Promise<string> {
    const dir = await emptyRepo()
    await writeFile(join(dir, "dirty.txt"), "uncommitted\n")
    return dir
  }

  test("throws on a dirty tree without allowDirty", async () => {
    const dir = await dirtyRepo()
    await expect(ensureRepoReady(dir)).rejects.toThrow(/not clean/)
  })

  test("allowDirty defers the dirty-tree decision so resume can recover", async () => {
    const dir = await dirtyRepo()
    await expect(ensureRepoReady(dir, { allowDirty: true })).resolves.toBeUndefined()
  })

  test("rejects an explicit base ref that doesn't exist, pointing at auto-detection", async () => {
    const dir = await emptyRepo()
    await git(["commit", "-q", "--allow-empty", "-m", "init"], dir)
    await expect(ensureRepoReady(dir, { baseRef: "nope" })).rejects.toThrow(/auto-detect/)
  })

  test("reports a repo with no commits instead of blaming the base ref", async () => {
    const dir = await emptyRepo()
    await expect(ensureRepoReady(dir, { baseRef: "main" })).rejects.toThrow(/no commits/)
  })

  // The launcher's worktree pre-check: a dirty source tree is fine (the run
  // gets a fresh worktree) but a bad base ref must still fail before launch.
  test("allowDirty still rejects a base ref that doesn't exist", async () => {
    const dir = await dirtyRepo()
    await git(["add", "."], dir)
    await git(["commit", "-q", "-m", "init"], dir)
    await writeFile(join(dir, "dirty.txt"), "uncommitted again\n")
    await expect(ensureRepoReady(dir, { allowDirty: true, baseRef: "nope" })).rejects.toThrow(/auto-detect/)
    await expect(ensureRepoReady(dir, { allowDirty: true, baseRef: "HEAD" })).resolves.toBeUndefined()
  })
})

describe("detectBaseRef", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "convoy-test",
        GIT_AUTHOR_EMAIL: "convoy-test@example.invalid",
        GIT_COMMITTER_NAME: "convoy-test",
        GIT_COMMITTER_EMAIL: "convoy-test@example.invalid",
      },
    })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  async function repo(branch: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-detect-base-"))
    dirs.push(dir)
    await git(["init", "-q", "-b", branch], dir)
    await git(["commit", "-q", "--allow-empty", "-m", "init"], dir)
    return dir
  }

  /** Points origin/HEAD at a fabricated remote-tracking branch, no network involved. */
  async function setOriginHead(dir: string, branch: string, options: { createRef?: boolean } = {}) {
    if (options.createRef !== false) await git(["update-ref", `refs/remotes/origin/${branch}`, "HEAD"], dir)
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`], dir)
  }

  test("origin/HEAD wins over the probe order", async () => {
    const dir = await repo("develop")
    await git(["branch", "main"], dir) // decoy: the probe alone would pick main
    await setOriginHead(dir, "develop")
    expect(await detectBaseRef(dir)).toEqual({ ref: "develop", source: "origin-head" })
  })

  test("uses the remote-tracking ref when the default branch has no local checkout", async () => {
    const dir = await repo("main")
    await setOriginHead(dir, "develop")
    expect(await detectBaseRef(dir)).toEqual({ ref: "origin/develop", source: "origin-head" })
  })

  test("ignores an origin/HEAD that points at a deleted branch", async () => {
    const dir = await repo("main")
    await setOriginHead(dir, "gone", { createRef: false })
    expect(await detectBaseRef(dir)).toEqual({ ref: "main", source: "probe" })
  })

  test("probes common base names in order", async () => {
    const dir = await repo("master")
    await git(["branch", "develop"], dir)
    expect(await detectBaseRef(dir)).toEqual({ ref: "master", source: "probe" })
  })

  test("probe finds develop when it is the only common name", async () => {
    const dir = await repo("develop")
    expect(await detectBaseRef(dir)).toEqual({ ref: "develop", source: "probe" })
  })

  test("falls back to the current branch for exotic names", async () => {
    const dir = await repo("dev-trunk")
    expect(await detectBaseRef(dir)).toEqual({ ref: "dev-trunk", source: "current-branch" })
  })

  test("falls back to HEAD when detached", async () => {
    const dir = await repo("dev-trunk")
    await git(["checkout", "-q", "--detach"], dir)
    expect(await detectBaseRef(dir)).toEqual({ ref: "HEAD", source: "current-branch" })
  })

  test("returns undefined for a repo with no commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-detect-base-"))
    dirs.push(dir)
    await git(["init", "-q"], dir)
    expect(await detectBaseRef(dir)).toBeUndefined()
  })

  test("returns undefined outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-detect-base-"))
    dirs.push(dir)
    expect(await detectBaseRef(dir)).toBeUndefined()
  })

  describe("resolveWorktreeDefault", () => {
    test("worktree management turned off never isolates, even on a trunk", async () => {
      const dir = await repo("main")
      expect(await worktreeDefaultFor(dir, false)).toEqual({ isolate: false, reason: "features.worktrees is off" })
      expect(await worktreeDefaultFor(dir, true)).toEqual({ isolate: true, reason: "main is a base branch" })
    })

    test("isolates on a conventional trunk", async () => {
      const dir = await repo("main")
      expect(await resolveWorktreeDefault(dir)).toEqual({ isolate: true, reason: "main is a base branch" })
    })

    test("runs in place on a branch of your own", async () => {
      const dir = await repo("main")
      await git(["checkout", "-q", "-b", "feat/thing"], dir)
      expect(await resolveWorktreeDefault(dir)).toEqual({ isolate: false, reason: "feat/thing is not a base branch" })
    })

    test("isolates on develop even when origin/HEAD points at main", async () => {
      // The union of both criteria: detectBaseRef answers "main" here, so the
      // conventional-name check is what keeps develop from being treated as a
      // working branch.
      const dir = await repo("main")
      await setOriginHead(dir, "main")
      await git(["checkout", "-q", "-b", "develop"], dir)
      expect(await resolveWorktreeDefault(dir)).toEqual({ isolate: true, reason: "develop is a base branch" })
    })

    test("isolates on an exotically named trunk that origin/HEAD points at", async () => {
      const dir = await repo("mainline")
      await setOriginHead(dir, "mainline")
      expect(await resolveWorktreeDefault(dir)).toEqual({ isolate: true, reason: "mainline is this repo's base branch" })
    })

    test("isolates on an exotically named branch when the repo has no other base", async () => {
      // detectBaseRef falls back to the current branch, which makes it the base
      // by definition — there is nothing else to branch from.
      const dir = await repo("dev-trunk")
      expect(await resolveWorktreeDefault(dir)).toEqual({ isolate: true, reason: "dev-trunk is this repo's base branch" })
    })

    test("isolates when HEAD is detached, where committing in place is never right", async () => {
      const dir = await repo("main")
      await git(["checkout", "-q", "--detach"], dir)
      expect(await resolveWorktreeDefault(dir)).toEqual({ isolate: true, reason: "no branch is checked out" })
    })

    test("falls back to isolating outside a git repository", async () => {
      const dir = await mkdtemp(join(tmpdir(), "convoy-worktree-default-"))
      dirs.push(dir)
      expect((await resolveWorktreeDefault(dir)).isolate).toBe(true)
    })
  })
})

describe("initializeRepoWithInitialCommit", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function tmpRepoDir() {
    const dir = await mkdtemp(join(tmpdir(), "convoy-init-repo-"))
    dirs.push(dir)
    return dir
  }

  async function gitOutput(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
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
    expect(await gitOutput(["log", "-1", "--format=%s"], dir)).toBe("convoy: initial commit")
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

describe("unsigned commits", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`)
    return stdout.trim()
  }

  /**
   * A repo whose config demands a signature it can never produce: /usr/bin/false
   * stands in for a 1Password/gpg-agent prompt nobody answers during an
   * unattended run. Any commit Convoy makes without --no-gpg-sign dies here.
   */
  async function repoThatCannotSign(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-unsigned-"))
    dirs.push(dir)
    await git(["init", "-q", "-b", "main"], dir)
    await git(["config", "user.name", "convoy-test"], dir)
    await git(["config", "user.email", "convoy-test@example.invalid"], dir)
    await git(["config", "commit.gpgsign", "true"], dir)
    await git(["config", "gpg.format", "ssh"], dir)
    await git(["config", "user.signingkey", join(dir, "nonexistent.pub")], dir)
    await git(["config", "gpg.ssh.program", "/usr/bin/false"], dir)
    return dir
  }

  test("initializeRepoWithInitialCommit commits when the repo config forces signing", async () => {
    const dir = await repoThatCannotSign()
    await writeFile(join(dir, "README.md"), "hello\n")

    await initializeRepoWithInitialCommit(dir, { baseRef: "main" })

    expect(await repoBootstrapStatus(dir)).toBe("ready")
    expect(await git(["log", "-1", "--format=%s"], dir)).toBe("convoy: initial commit")
  })

  test("addAllAndCommit commits when the repo config forces signing", async () => {
    const dir = await repoThatCannotSign()
    await git(["commit", "-q", "--allow-empty", "-m", "base"], dir)
    await writeFile(join(dir, "feature.ts"), "export const feature = true\n")

    expect(await addAllAndCommit("convoy(implement): add feature", dir)).toBe(true)

    expect(await git(["log", "-1", "--format=%s"], dir)).toBe("convoy(implement): add feature")
    expect(await git(["log", "-1", "--format=%an <%ae>"], dir)).toBe("convoy <convoy@local>")
    // %G? is "N" for an unsigned commit; anything else means we tried to sign.
    expect(await git(["log", "-1", "--format=%G?"], dir)).toBe("N")
    expect(await git(["status", "--porcelain"], dir)).toBe("")
  })
})

describe("addWorktree", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "convoy-test",
        GIT_AUTHOR_EMAIL: "convoy-test@example.invalid",
        GIT_COMMITTER_NAME: "convoy-test",
        GIT_COMMITTER_EMAIL: "convoy-test@example.invalid",
      },
    })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  test("branchExists tells a taken branch name from a free one", async () => {
    const repo = await mkdtemp(join(tmpdir(), "convoy-branch-exists-"))
    dirs.push(repo)

    await git(["init", "-q"], repo)
    await writeFile(join(repo, "README.md"), "base\n")
    await git(["add", "README.md"], repo)
    await git(["commit", "-q", "-m", "init"], repo)
    await git(["branch", "feat/add-onboarding"], repo)

    expect(await branchExists("feat/add-onboarding", repo)).toBe(true)
    expect(await branchExists("feat/add-onboarding-2", repo)).toBe(false)
    expect(await branchExists("", repo)).toBe(false)
  })

  test("creates a branch checked out in a separate worktree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "convoy-worktree-repo-"))
    const worktree = await mkdtemp(join(tmpdir(), "convoy-worktree-dir-"))
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

describe("writeDiff", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const identity = ["-c", "user.name=convoy-test", "-c", "user.email=convoy-test@example.invalid"]
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...identity, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  async function commitFile(repo: string, file: string, content: string) {
    await writeFile(join(repo, file), content)
    await git(["add", "-A"], repo)
    await git(["commit", "-q", "-m", file], repo)
  }

  /** A feature branch with one change of its own, forked from a main that has since moved on. */
  async function forkedRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "convoy-write-diff-"))
    dirs.push(repo)
    await git(["init", "-q", "-b", "main"], repo)
    await commitFile(repo, "README.md", "base\n")
    await git(["checkout", "-q", "-b", "feat/search"], repo)
    await commitFile(repo, "search.ts", "export const search = true\n")
    await git(["checkout", "-q", "main"], repo)
    await commitFile(repo, "landed-on-main.ts", "export const later = true\n")
    await git(["checkout", "-q", "feat/search"], repo)
    return repo
  }

  test("measures the branch from its merge base, leaving out what main gained after the fork", async () => {
    const repo = await forkedRepo()
    await writeFile(join(repo, "README.md"), "base\nuncommitted\n")
    const path = join(repo, ".run", "scope.pre.diff")

    expect(await writeDiff(path, "main", repo)).toBe(path)

    const diff = await readFile(path, "utf8")
    expect(diff).toContain("+++ b/search.ts")
    expect(diff).toContain("+uncommitted")
    expect(diff).not.toContain("landed-on-main.ts")
    expect(await listChangedFiles("main", repo)).toEqual(["README.md", "search.ts"])
  })

  test("falls back to the base itself when the histories share no merge base", async () => {
    const repo = await forkedRepo()
    await git(["checkout", "-q", "--orphan", "unrelated"], repo)
    await git(["rm", "-rq", "--cached", "."], repo)
    await writeFile(join(repo, "unrelated.txt"), "elsewhere\n")
    await git(["add", "unrelated.txt"], repo)
    await git(["commit", "-q", "-m", "unrelated"], repo)
    await git(["checkout", "-q", "-f", "feat/search"], repo)
    const path = join(repo, ".run", "scope.pre.diff")

    expect(await writeDiff(path, "unrelated", repo)).toBe(path)

    const diff = await readFile(path, "utf8")
    expect(diff).toContain("--- a/unrelated.txt")
    expect(diff).toContain("+++ b/search.ts")
  })

  test("falls back to the working tree against HEAD when the base does not resolve", async () => {
    const repo = await forkedRepo()
    await writeFile(join(repo, "README.md"), "base\nuncommitted\n")
    const path = join(repo, ".run", "scope.pre.diff")

    expect(await writeDiff(path, "no-such-ref", repo)).toBe(path)

    const diff = await readFile(path, "utf8")
    expect(diff).toContain("+uncommitted")
    expect(diff).not.toContain("search.ts")
  })

  test("attaches the diff whole up to exactly the limit and an overview one byte past it", async () => {
    const repo = await forkedRepo()
    const path = join(repo, ".run", "scope.pre.diff")
    await writeDiff(path, "main", repo)
    const bytes = Buffer.byteLength(await readFile(path, "utf8"))

    expect(await writeDiff(path, "main", repo, bytes)).toBe(path)
    expect(await writeDiff(path, "main", repo, bytes - 1)).toBe(join(repo, ".run", "scope.pre.overview.md"))
  })

  test("attaches an overview instead of a diff over the inline limit, keeping the full diff beside it", async () => {
    const repo = await forkedRepo()
    await commitFile(repo, "catalog.json", `${"x".repeat(8192)}\n`)
    const path = join(repo, ".run", "scope.pre.diff")

    const attached = await writeDiff(path, "main", repo, 4096)

    expect(attached).toBe(join(repo, ".run", "scope.pre.overview.md"))
    expect(await readFile(path, "utf8")).toContain("x".repeat(8192))
    const overview = await readFile(attached, "utf8")
    expect(Buffer.byteLength(overview)).toBeLessThanOrEqual(4096)
    expect(overview).toContain("- catalog.json (")
    expect(overview).not.toContain("x".repeat(8192))
    expect(overview).toContain("+export const search = true")
    expect(overview).toContain(path)
  })

  test("names omitted files by git's own paths: spaces with \" b/\", non-ASCII, and renames", async () => {
    const repo = await forkedRepo()
    const big = `${"x".repeat(8192)}\n`
    await git(["mv", "README.md", "GUIDE.md"], repo)
    await writeFile(join(repo, "GUIDE.md"), big)
    await mkdir(join(repo, "src", "foo b"), { recursive: true })
    await writeFile(join(repo, "src", "foo b", "bar.ts"), big)
    await writeFile(join(repo, "café.ts"), big)
    await git(["add", "-A"], repo)
    await git(["commit", "-q", "-m", "paths"], repo)

    const overview = await readFile(await writeDiff(join(repo, ".run", "scope.pre.diff"), "main", repo, 4096), "utf8")

    expect(overview).toContain("- src/foo b/bar.ts (")
    expect(overview).toContain("- café.ts (")
    expect(overview).toContain("- GUIDE.md (")
  })

  test("removes a stale overview once the diff fits again", async () => {
    const repo = await forkedRepo()
    const path = join(repo, ".run", "scope.pre.diff")
    const overviewPath = await writeDiff(path, "main", repo, 1)

    expect(await writeDiff(path, "main", repo)).toBe(path)
    expect(await Bun.file(overviewPath).exists()).toBe(false)
  })
})

describe("diffOverview", () => {
  const section = (file: string, body: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${body}\n`

  test("inlines the smallest files that fit, in diff order, and lists the rest with sizes", () => {
    const diff = section("a.ts", "a") + section("generated.json", "g".repeat(20_000)) + section("b.ts", "b")

    const overview = diffOverview(diff, { base: "abc123", fullDiffPath: "/run/diffs/scope.pre.diff", maxInlineBytes: 4096 })

    expect(overview).toContain("- generated.json (")
    expect(overview).not.toContain("- a.ts")
    expect(overview).not.toContain("g".repeat(500))
    expect(overview.indexOf("+++ b/a.ts")).toBeLessThan(overview.indexOf("+++ b/b.ts"))
    expect(overview).toContain("git diff abc123 -- <path>")
  })

  test("stays within the limit on a many-file diff, counting the omitted files it cannot list", () => {
    const diff = Array.from({ length: 20_000 }, (_, index) => section(`apps/catalog/generated/locale-${index}/exercises.json`, "x".repeat(600))).join("")

    const overview = diffOverview(diff, { base: "abc123", fullDiffPath: "/run/diffs/scope.pre.diff", maxInlineBytes: 1024 * 1024 })

    expect(Buffer.byteLength(overview)).toBeLessThanOrEqual(1024 * 1024)
    expect(overview).toMatch(/- … and \d+ more; list them all with `git diff --stat abc123`/)
  })

  test("prefers the supplied file names, falling back to the headers when the count disagrees", () => {
    const diff = section("a.ts", "a".repeat(5000)) + section("src/foo b/bar.ts", "b".repeat(5000))
    const options = { base: "main", fullDiffPath: "/d", maxInlineBytes: 4096 }

    expect(diffOverview(diff, { ...options, files: ["first.ts", "second.ts"] })).toContain("- second.ts (")
    expect(diffOverview(diff, { ...options, files: ["only-one.ts"] })).toContain("- src/foo b/bar.ts (")
  })

  test("fences the inlined diffs past any backtick run they contain", () => {
    const overview = diffOverview(section("README.md", "```ts"), { base: "main", fullDiffPath: "/d", maxInlineBytes: 4096 })

    expect(overview).toContain("````diff\n")
  })

  test("survives an inlined body with more backtick runs than a call takes arguments", () => {
    const diff = section("ticks.md", "` ".repeat(700_000)) + section("big.json", "x".repeat(8 * 1024 * 1024))

    const overview = diffOverview(diff, { base: "main", fullDiffPath: "/d", maxInlineBytes: 4 * 1024 * 1024 })

    expect(overview).toContain("+++ b/ticks.md")
    expect(overview).toContain("- big.json (")
  })
})
