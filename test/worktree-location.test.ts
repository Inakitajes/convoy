import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { parseConvoyConfig } from "../src/config"
import { findWorktreeDirForBranch } from "../src/git"
import { convoyHome } from "../src/workspace"
import {
  branchNameTaken,
  createIsolatedWorktree,
  documentedWorktreeConvention,
  ensureFreeBranchName,
  expandLocationTemplate,
  resolveWorktreeDir,
  worktreeDirFor,
} from "../src/worktree"

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim()
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function writeRepoConfig(repo: string, yaml: string) {
  await mkdir(join(repo, ".convoy"), { recursive: true })
  await writeFile(join(repo, ".convoy", "config.yaml"), yaml)
}

function configWithLocation(location: string) {
  return parseConvoyConfig(`defaults:\n  worktreeLocation: ${location}\n`, "test", process.cwd())
}

describe("expandLocationTemplate", () => {
  test("expands {repo} and {branch} and a leading ~", () => {
    const expanded = expandLocationTemplate("~/dev/worktrees/{repo}/{branch}", { repo: "calisteniapp", branch: "feat-new-feature" })
    expect(expanded).toBe(resolve(homedir(), "dev/worktrees/calisteniapp/feat-new-feature"))
  })

  test("expands a bare ~ to home", () => {
    expect(expandLocationTemplate("~", { repo: "r", branch: "b" })).toBe(homedir())
  })

  test("a template without placeholders passes through unchanged", () => {
    expect(expandLocationTemplate("/absolute/worktrees", { repo: "r", branch: "b" })).toBe("/absolute/worktrees")
  })

  test("repeated placeholders are all expanded", () => {
    expect(expandLocationTemplate("~/wt/{branch}/{branch}", { repo: "r", branch: "x" })).toBe(join(homedir(), "wt/x/x"))
  })
})

describe("documentedWorktreeConvention", () => {
  test("reads a plain marker from AGENTS.md", async () => {
    const dir = await tempDir("convoy-wt-loc-marker-")
    try {
      await writeFile(join(dir, "AGENTS.md"), "# Guide\n\nworktree location: ~/dev/wt/{repo}/{branch}\n")
      expect(await documentedWorktreeConvention(dir)).toBe("~/dev/wt/{repo}/{branch}")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("accepts bulleted and README forms, AGENTS.md first", async () => {
    const dir = await tempDir("convoy-wt-loc-bullet-")
    try {
      await writeFile(join(dir, "README.md"), "Setup:\n\n- worktrees: ~/wt/{branch}\n")
      expect(await documentedWorktreeConvention(dir)).toBe("~/wt/{branch}")
      await writeFile(join(dir, "AGENTS.md"), "> worktree-location: /abs/wt/{repo}\n")
      expect(await documentedWorktreeConvention(dir)).toBe("/abs/wt/{repo}")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("ignores prose that is not a recognized marker", async () => {
    const dir = await tempDir("convoy-wt-loc-prose-")
    try {
      await writeFile(
        join(dir, "AGENTS.md"),
        ["Worktrees keep work isolated.", "We organize worktrees below.", "The worktrees live elsewhere, ask Ops."].join("\n"),
      )
      expect(await documentedWorktreeConvention(dir)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a marker whose value is not a path or template falls through", async () => {
    const dir = await tempDir("convoy-wt-loc-invalid-")
    try {
      await writeFile(join(dir, "AGENTS.md"), "worktree location: see the wiki for details\n")
      expect(await documentedWorktreeConvention(dir)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns undefined when neither doc exists", async () => {
    const dir = await tempDir("convoy-wt-loc-empty-")
    try {
      expect(await documentedWorktreeConvention(dir)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("ignores a marker inside a fenced code block (an example, not a convention)", async () => {
    const dir = await tempDir("convoy-wt-loc-fence-")
    try {
      await writeFile(
        join(dir, "AGENTS.md"),
        ["## Example config.yaml", "", "```yaml", "worktree location: ~/wt/{branch}", "```", ""].join("\n"),
      )
      expect(await documentedWorktreeConvention(dir)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a real marker outside a fence is still honored after a fenced example", async () => {
    const dir = await tempDir("convoy-wt-loc-fence-after-")
    try {
      await writeFile(
        join(dir, "AGENTS.md"),
        ["```yaml", "worktree location: ~/wt/example/{branch}", "```", "", "worktree location: ~/wt/real/{repo}/{branch}"].join("\n"),
      )
      expect(await documentedWorktreeConvention(dir)).toBe("~/wt/real/{repo}/{branch}")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("strips a trailing # comment and surrounding backticks from the marker value", async () => {
    const dir = await tempDir("convoy-wt-loc-comment-")
    try {
      await writeFile(join(dir, "AGENTS.md"), "worktree location: `~/wt/{repo}/{branch}` # team convention\n")
      expect(await documentedWorktreeConvention(dir)).toBe("~/wt/{repo}/{branch}")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("resolveWorktreeDir", () => {
  test("built-in default when no convention or config applies", async () => {
    const repo = await tempDir("convoy-wt-loc-builtin-")
    try {
      const dir = await resolveWorktreeDir("feat/add-onboarding", repo)
      expect(dir).toBe(worktreeDirFor("feat/add-onboarding"))
      expect(dir).toBe(join(convoyHome(), "worktrees", "feat-add-onboarding"))
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("repo convention wins over config", async () => {
    const repo = await tempDir("convoy-wt-loc-priority-")
    const wtRoot = await tempDir("convoy-wt-loc-target-")
    try {
      await writeFile(join(repo, "AGENTS.md"), "worktree location: ~/wt-from-marker/{repo}/{branch}\n")
      const dir = await resolveWorktreeDir("feat/x", repo, { config: configWithLocation("~/wt-from-config/{branch}") })
      expect(dir).toBe(join(homedir(), "wt-from-marker", basename(repo), "feat-x"))
      expect(wtRoot).toBeTruthy()
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })

  test("config wins over the built-in default", async () => {
    const repo = await tempDir("convoy-wt-loc-config-")
    const wtRoot = await tempDir("convoy-wt-loc-target-")
    try {
      const dir = await resolveWorktreeDir("feat/x", repo, {
        config: configWithLocation(join(wtRoot, "wt-{repo}-{branch}")),
      })
      expect(dir).toBe(join(wtRoot, `wt-${basename(repo)}-feat-x`))
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })

  test("an unusable declared location falls back to config, then built-in", async () => {
    const repo = await tempDir("convoy-wt-loc-fallback-")
    const wtRoot = await tempDir("convoy-wt-loc-target-")
    try {
      // A regular file blocks the parent the marker would need.
      await writeFile(join(wtRoot, "blocker"), "not a directory")
      await writeFile(join(repo, "AGENTS.md"), `worktree location: ${join(wtRoot, "blocker", "sub", "{branch}")}\n`)
      const dir = await resolveWorktreeDir("feat/x", repo, { config: configWithLocation(join(wtRoot, "cfg/{branch}")) })
      expect(dir).toBe(join(wtRoot, "cfg", "feat-x"))
      await rm(join(repo, "AGENTS.md"))
      const fallback = await resolveWorktreeDir("feat/x", repo, { config: configWithLocation(join(wtRoot, "blocker", "sub", "{branch}")) })
      expect(fallback).toBe(worktreeDirFor("feat/x"))
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })

  test("a resolved path inside the repo is rejected", async () => {
    const repo = await tempDir("convoy-wt-loc-nested-")
    try {
      const dir = await resolveWorktreeDir("feat/x", repo, { config: configWithLocation(`${repo}/{branch}`) })
      expect(dir).toBe(worktreeDirFor("feat/x"))
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a relative template is unusable and falls back", async () => {
    const repo = await tempDir("convoy-wt-loc-relative-")
    try {
      const dir = await resolveWorktreeDir("feat/x", repo, { config: configWithLocation("relative/{branch}") })
      expect(dir).toBe(worktreeDirFor("feat/x"))
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a template without {branch} still gives each branch its own directory", async () => {
    const repo = await tempDir("convoy-wt-loc-fixed-")
    const wtRoot = await tempDir("convoy-wt-loc-target-")
    try {
      const config = configWithLocation(join(wtRoot, "wt"))
      expect(await resolveWorktreeDir("feat/one", repo, { config })).toBe(join(wtRoot, "wt", "feat-one"))
      expect(await resolveWorktreeDir("feat/two", repo, { config })).toBe(join(wtRoot, "wt", "feat-two"))
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })

  test("a fixed-path marker is honored with the slug appended", async () => {
    const repo = await tempDir("convoy-wt-loc-fixed-marker-")
    const wtRoot = await tempDir("convoy-wt-loc-target-")
    try {
      await writeFile(join(repo, "AGENTS.md"), `worktree location: ${join(wtRoot, "fixed")}\n`)
      expect(await resolveWorktreeDir("feat/x", repo)).toBe(join(wtRoot, "fixed", "feat-x"))
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })

  test("a symlinked parent pointing into the repo is rejected on the physical path", async () => {
    const repo = await tempDir("convoy-wt-loc-link-")
    const outside = await tempDir("convoy-wt-loc-outside-")
    try {
      await symlink(repo, join(outside, "repo-link"))
      // Lexically outside the repo, physically inside — the guard must fall back.
      const config = configWithLocation(join(outside, "repo-link", "wt", "{branch}"))
      expect(await resolveWorktreeDir("feat/x", repo, { config })).toBe(worktreeDirFor("feat/x"))
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe("resolution is read-only until creation", () => {
  test("resolving and collision probes create no directories", async () => {
    const repo = await tempDir("convoy-wt-loc-readonly-")
    const wtRoot = await tempDir("convoy-wt-loc-target-")
    try {
      const config = configWithLocation(join(wtRoot, "deep", "nested", "{branch}"))
      expect(await resolveWorktreeDir("feat/x", repo, { config })).toBe(join(wtRoot, "deep", "nested", "feat-x"))
      expect(await branchNameTaken("feat/x", repo, { config })).toBe(false)
      // The probe must leave the declared location's parent chain untouched.
      const parentCreated = await stat(join(wtRoot, "deep")).then(
        () => true,
        () => false,
      )
      expect(parentCreated).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })
})

describe("collision checks on the resolved location", () => {
  test("branchNameTaken sees an existing directory at a declared location", async () => {
    const repo = await tempDir("convoy-wt-loc-taken-")
    const wtRoot = await tempDir("convoy-wt-loc-target-")
    try {
      const config = configWithLocation(join(wtRoot, "{branch}"))
      const dir = await resolveWorktreeDir("feat/x", repo, { config })
      await mkdir(dir, { recursive: true })
      expect(await branchNameTaken("feat/x", repo, { config })).toBe(true)
      expect(await branchNameTaken("feat/y", repo, { config })).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })

  test("ensureFreeBranchName suffixes against the declared layout", async () => {
    const repo = await tempDir("convoy-wt-loc-suffix-")
    const wtRoot = await tempDir("convoy-wt-loc-target-")
    try {
      await writeRepoConfig(repo, `defaults:\n  worktreeLocation: ${join(wtRoot, "{branch}")}\n`)
      await mkdir(join(wtRoot, "feat-x"), { recursive: true })
      const free = await ensureFreeBranchName("feat/x", repo)
      expect(free).toBe("feat/x-2")
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })

  test("suffixing separates directories at a fixed-path location", async () => {
    const repo = await tempDir("convoy-wt-loc-fixed-suffix-")
    const wtRoot = await tempDir("convoy-wt-loc-target-")
    try {
      await writeRepoConfig(repo, `defaults:\n  worktreeLocation: ${join(wtRoot, "fixed")}\n`)
      await mkdir(join(wtRoot, "fixed", "feat-x"), { recursive: true })
      const free = await ensureFreeBranchName("feat/x", repo)
      expect(free).toBe("feat/x-2")
      expect(await resolveWorktreeDir(free, repo)).toBe(join(wtRoot, "fixed", "feat-x-2"))
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })

  test("a second worktree against a fixed-path location gets its own directory", async () => {
    const repo = await tempDir("convoy-wt-loc-fixed-create-")
    const wtRoot = await tempDir("convoy-wt-loc-target-")
    try {
      git(["init", "-q", "-b", "main"], repo)
      git(["config", "user.email", "test@test.com"], repo)
      git(["config", "user.name", "Tester"], repo)
      git(["commit", "-q", "--allow-empty", "-m", "chore: initial"], repo)
      await writeRepoConfig(repo, `defaults:\n  worktreeLocation: ${join(wtRoot, "fixed")}\n`)
      const first = await createIsolatedWorktree({ targetDir: repo, branch: "feat/first" })
      const second = await createIsolatedWorktree({ targetDir: repo, branch: "feat/second" })
      expect(first.dir).toBe(join(wtRoot, "fixed", "feat-first"))
      expect(second.dir).toBe(join(wtRoot, "fixed", "feat-second"))
      expect(second.branch).toBe("feat/second")
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })

  test("createIsolatedWorktree lands at the resolved location", async () => {
    const repo = await tempDir("convoy-wt-loc-create-")
    const wtRoot = await tempDir("convoy-wt-loc-target-")
    try {
      git(["init", "-q", "-b", "main"], repo)
      git(["config", "user.email", "test@test.com"], repo)
      git(["config", "user.name", "Tester"], repo)
      git(["commit", "-q", "--allow-empty", "-m", "chore: initial"], repo)
      await writeRepoConfig(repo, `defaults:\n  worktreeLocation: ${join(wtRoot, "{repo}", "{branch}")}\n`)
      const result = await createIsolatedWorktree({ targetDir: repo, branch: "feat/located" })
      expect(result.branch).toBe("feat/located")
      expect(result.dir).toBe(join(wtRoot, basename(repo), "feat-located"))
      // A linked worktree's .git is a file pointing at the repo's worktree metadata.
      const info = await stat(join(result.dir, ".git"))
      expect(info.isFile()).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })
})

describe("findWorktreeDirForBranch", () => {
  test("locates a worktree registered in the repo's worktree list", async () => {
    const repo = await tempDir("convoy-wt-loc-list-")
    const wt = await tempDir("convoy-wt-loc-listed-")
    try {
      git(["init", "-q", "-b", "main"], repo)
      git(["config", "user.email", "test@test.com"], repo)
      git(["config", "user.name", "Tester"], repo)
      git(["commit", "-q", "--allow-empty", "-m", "chore: initial"], repo)
      git(["worktree", "add", "-b", "feat/custom", "--", wt, "main"], repo)
      // git reports the physical path, so compare against the realpath of the worktree.
      const physical = await realpath(wt)
      expect(await findWorktreeDirForBranch("feat/custom", repo)).toBe(physical)
      expect(await findWorktreeDirForBranch("feat/unknown", repo)).toBeUndefined()
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(wt, { recursive: true, force: true })
    }
  })
})

describe("config validation for defaults.worktreeLocation", () => {
  test("accepts a path template", () => {
    const config = parseConvoyConfig("defaults:\n  worktreeLocation: ~/wt/{repo}/{branch}\n", "test", process.cwd())
    expect(config.defaults.worktreeLocation).toBe("~/wt/{repo}/{branch}")
  })

  test("rejects a non-string value", () => {
    expect(() => parseConvoyConfig("defaults:\n  worktreeLocation: 3\n", "test", process.cwd())).toThrow()
  })
})

describe("documented configuration is not a worktree convention", () => {
  test("the wiki config example is not misread when included in a repository README", async () => {
    const repoRoot = resolve(import.meta.dir, "..")
    const guide = await readFile(join(repoRoot, "docs", "configuration.md"), "utf8")
    expect(guide).toContain("worktree: true")
    const dir = await tempDir("convoy-wt-doc-example-")
    try {
      await writeFile(join(dir, "README.md"), guide)
      expect(await documentedWorktreeConvention(dir)).toBeUndefined()
      expect(await documentedWorktreeConvention(repoRoot)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
