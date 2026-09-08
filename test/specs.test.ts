import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { execFile as nodeExecFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"

import {
  browseSpecs,
  classifySpecArtifact,
  groupChangeArtifacts,
  loadSpecsView,
  printSpecsList,
  specArtifactLabel,
  specGroupSource,
  specsIteratePrompt,
  type SpecGroup,
  type SpecsChangeEntry,
} from "../src/specs"

let root: string
let symlinkCreated = false

/**
 * Git reports physical paths; /tmp and /var are symlinks on macOS. Tolerates
 * paths that no longer exist by resolving the nearest existing ancestor.
 */
async function phys(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return join(await phys(dirname(path)), basename(path))
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "convoy-specs-test-"))
  const openspec = join(root, "openspec")
  const changes = join(openspec, "changes")

  await mkdir(join(changes, "archive", "old"), { recursive: true })
  await writeFile(join(changes, "archive", "old", "proposal.md"), "# Archived\n")
  await mkdir(join(changes, ".hidden"), { recursive: true })
  await writeFile(join(changes, ".hidden", "proposal.md"), "# Hidden\n")
  await writeFile(join(changes, "loose.md"), "# Stray\n")
  await mkdir(join(changes, "empty-change"), { recursive: true })

  // A symlink named like a change id is not a change (see openspec.ts).
  try {
    await symlink(join(changes, "add-login"), join(changes, "linked-change"))
    symlinkCreated = true
  } catch {
    symlinkCreated = false
  }

  await mkdir(join(changes, "add-login", "specs", "cli"), { recursive: true })
  await writeFile(join(changes, "add-login", "proposal.md"), "---\ntitle: ignored\n---\n# Add login\n\nwhy\n")
  await writeFile(join(changes, "add-login", "design.md"), "# Design\n\nhow\n")
  await writeFile(join(changes, "add-login", "tasks.md"), "# Tasks\n\n1. do\n")
  await writeFile(join(changes, "add-login", "specs", "cli", "spec.md"), "# Delta\n\n## ADDED Requirements\n")
  await writeFile(join(changes, "add-login", "notes.md"), "# Notes\n")

  await mkdir(join(changes, "empty-change"), { recursive: true })

  await mkdir(join(openspec, "specs", "api", "users"), { recursive: true })
  await writeFile(join(openspec, "specs", "api", "users", "spec.md"), "# Users\n")
  await writeFile(join(openspec, "specs", "core.md"), "# Core\n")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("classifySpecArtifact", () => {
  test("maps the planning trio by exact basename", () => {
    expect(classifySpecArtifact("proposal.md")).toEqual({ section: "proposal" })
    expect(classifySpecArtifact("design.md")).toEqual({ section: "design" })
    expect(classifySpecArtifact("tasks.md")).toEqual({ section: "tasks" })
  })

  test("groups delta files under their capability directory", () => {
    expect(classifySpecArtifact("specs/cli/spec.md")).toEqual({ section: "delta", capability: "cli" })
    expect(classifySpecArtifact("specs/web/deep/path/spec.md")).toEqual({ section: "delta", capability: "web" })
  })

  test("keeps a lone specs-level file in the delta group without a capability", () => {
    expect(classifySpecArtifact("spec.md")).toEqual({ section: "other" })
    expect(classifySpecArtifact("specs/spec.md")).toEqual({ section: "delta" })
  })

  test("lands unmatched files in the other group", () => {
    expect(classifySpecArtifact("notes.md")).toEqual({ section: "other" })
  })

  test("labels every section", () => {
    expect(specArtifactLabel("proposal")).toBe("Proposal")
    expect(specArtifactLabel("design")).toBe("Design")
    expect(specArtifactLabel("tasks")).toBe("Tasks")
    expect(specArtifactLabel("delta", "cli")).toBe("Delta Specs (cli)")
    expect(specArtifactLabel("delta")).toBe("Delta Specs")
    expect(specArtifactLabel("other")).toBe("Other")
  })
})

describe("loadSpecsView", () => {
  test("lists active changes with titles, artifacts, and canonical specs", async () => {
    const view = await loadSpecsView(root)

    expect(view.present).toBe(true)
    expect(view.changes.map((change) => change.id)).toEqual(["add-login", "empty-change"])

    const [login, empty] = view.changes
    expect(login!.title).toBe("Add login")
    // Artifacts are absolute paths into the change's own checkout (design D3:
    // files are local inputs keyed by (checkout, local path)). This fixture is
    // not a git repo, so the degraded board serves the launch checkout's own
    // reads with its recorded path.
    expect(login!.artifacts.map((artifact) => [artifact.section, artifact.capability, artifact.file])).toEqual([
      ["proposal", undefined, join(root, "openspec", "changes", "add-login", "proposal.md")],
      ["design", undefined, join(root, "openspec", "changes", "add-login", "design.md")],
      ["tasks", undefined, join(root, "openspec", "changes", "add-login", "tasks.md")],
      ["delta", "cli", join(root, "openspec", "changes", "add-login", "specs", "cli", "spec.md")],
      ["other", undefined, join(root, "openspec", "changes", "add-login", "notes.md")],
    ])
    // The degraded board has no rows; the entry is keyed to the launch checkout.
    expect(login!.checkout).toBe(root)

    expect(empty!.title).toBe("empty-change")
    expect(empty!.artifacts).toEqual([])

    expect(view.specs).toEqual([join("openspec", "specs", "api", "users", "spec.md"), join("openspec", "specs", "core.md")])
  })

  test("excludes archive, dotfiles, stray files, and symlinked change dirs", async () => {
    const view = await loadSpecsView(root)
    const ids = view.changes.map((change) => change.id)
    expect(ids).not.toContain("old")
    expect(ids).not.toContain(".hidden")
    expect(ids).not.toContain("loose.md")
    if (symlinkCreated) expect(ids).not.toContain("linked-change")
  })

  test("reports an absent openspec directory as not present", async () => {
    const bare = await mkdtemp(join(tmpdir(), "convoy-specs-bare-"))
    try {
      const view = await loadSpecsView(bare)
      expect(view.present).toBe(false)
      expect(view.changes).toEqual([])
      expect(view.specs).toEqual([])
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  test("an archive-only changes dir is present but has no active changes", async () => {
    // Spec scenario: `openspec/changes/` containing only `archive` must report
    // (or show) Active Changes empty while canonical specs remain browsable.
    const archived = await mkdtemp(join(tmpdir(), "convoy-specs-archived-"))
    try {
      await mkdir(join(archived, "openspec", "changes", "archive", "old"), { recursive: true })
      await writeFile(join(archived, "openspec", "changes", "archive", "old", "proposal.md"), "# Archived\n")
      await mkdir(join(archived, "openspec", "specs", "cli"), { recursive: true })
      await writeFile(join(archived, "openspec", "specs", "cli", "spec.md"), "# Cli\n")
      const view = await loadSpecsView(archived)
      expect(view.present).toBe(true)
      expect(view.changes).toEqual([])
      expect(view.specs).toEqual([join("openspec", "specs", "cli", "spec.md")])
    } finally {
      await rm(archived, { recursive: true, force: true })
    }
  })
})

describe("printSpecsList", () => {
  test("prints changes with artifact inventory, then canonical specs, without control sequences", async () => {
    const view = await loadSpecsView(root)
    const writes: string[] = []
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      printSpecsList(view)
    } finally {
      spy.mockRestore()
    }
    const output = writes.join("")
    expect(output).toContain("active changes:")
    expect(output).toContain("add-login — Add login")
    expect(output).toContain("delta specs (cli): ")
    expect(output).toContain("empty-change")
    expect(output).toContain("canonical specs:")
    expect(output).toContain(join("openspec", "specs", "core.md"))
    expect(output).not.toContain("\u001b")
  })

  test("reports empty sections instead of crashing", async () => {
    const writes: string[] = []
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      printSpecsList({ board: { worktrees: [] }, changes: [], specs: [] })
    } finally {
      spy.mockRestore()
    }
    const output = writes.join("")
    expect(output).toContain("(none)")
  })
})

describe("browseSpecs outside a terminal", () => {
  test("pipes the plain listing and exits without opening any UI", async () => {
    const writes: string[] = []
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      const resolution = await browseSpecs(root)
      expect(resolution).toEqual({ type: "exit" })
    } finally {
      spy.mockRestore()
    }
    const output = writes.join("")
    expect(output).toContain("add-login")
    expect(output).toContain("canonical specs:")
  })

  test("prints a single message and exits 0-style when there are no specs", async () => {
    const bare = await mkdtemp(join(tmpdir(), "convoy-specs-bare-"))
    try {
      const writes: string[] = []
      const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      }) as typeof process.stdout.write)
      try {
        const resolution = await browseSpecs(bare)
        expect(resolution).toEqual({ type: "exit" })
      } finally {
        spy.mockRestore()
      }
      expect(writes.join("")).toContain("no worktrees or specs found")
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})

describe("specsIteratePrompt", () => {
  test("lists the change's planning files as context", () => {
    const files = [
      join("openspec", "changes", "add-login", "proposal.md"),
      join("openspec", "changes", "add-login", "design.md"),
      join("openspec", "changes", "add-login", "tasks.md"),
      join("openspec", "changes", "add-login", "specs", "cli", "spec.md"),
    ]
    const prompt = specsIteratePrompt("add-login", files)
    expect(prompt).toContain("add-login")
    for (const file of files) expect(prompt).toContain(file)
    expect(prompt.split("\n")).toHaveLength(1)
  })

  test("falls back to the change directory when there are no files", () => {
    const prompt = specsIteratePrompt("bare-change", [])
    expect(prompt).toContain(join("openspec", "changes", "bare-change") + "/")
  })
})

describe("buildIterateSessionInput", () => {
  test("roots at the repo dir and lists the change's planning files", async () => {
    const { buildIterateSessionInput } = await import("../src/specs")
    const view = await loadSpecsView(root)
    const input = buildIterateSessionInput(root, view, "add-login")

    expect(input.targetDir).toBe(root)
    expect(input.runDir).toBe(root)
    expect(input.prompt).toContain("add-login")
    for (const file of [join("openspec", "changes", "add-login", "proposal.md"), join("openspec", "changes", "add-login", "specs", "cli", "spec.md")]) {
      expect(input.prompt).toContain(file)
    }
  })

  test("falls back to an empty prompt inventory for an unknown change id", async () => {
    const { buildIterateSessionInput } = await import("../src/specs")
    const view = await loadSpecsView(root)
    const input = buildIterateSessionInput(root, view, "not-a-change")
    expect(input.prompt).toContain(join("openspec", "changes", "not-a-change") + "/")
  })
})

describe("groupChangeArtifacts", () => {
  function change(artifacts: SpecsChangeEntry["artifacts"]): SpecsChangeEntry {
    return { kind: "change", id: "multi", checkout: "/c", title: "Multi", artifacts }
  }

  test("merges multi-capability deltas into one Delta Specs group in stable order", () => {
    // loadSpecsView pre-sorts artifacts into canonical order before grouping,
    // so the group order is stable regardless of filesystem read order.
    const groups = groupChangeArtifacts(
      change([
        { section: "proposal", file: "/c/proposal.md" },
        { section: "design", file: "/c/design.md" },
        { section: "tasks", file: "/c/tasks.md" },
        { section: "delta", capability: "cli", file: "/c/specs/cli/spec.md" },
        { section: "delta", capability: "ui", file: "/c/specs/ui/spec.md" },
      ]),
    )
    // Stable order, one merged delta group regardless of how many capabilities.
    expect(groups.map((group) => group.label)).toEqual(["Proposal", "Design", "Tasks", "Delta Specs"])
    expect(groups).toHaveLength(4)
    const delta = groups.find((group) => group.delta)!
    expect(delta.entries.map((entry) => entry.capability)).toEqual(["cli", "ui"])
    expect(delta.entries.every((entry) => entry.file.startsWith("/c/specs/"))).toBe(true)
    // Input order independence: the group set is identical if deltas appear first.
    const shuffled = groupChangeArtifacts(
      change([
        { section: "delta", capability: "ui", file: "/c/specs/ui/spec.md" },
        { section: "proposal", file: "/c/proposal.md" },
        { section: "delta", capability: "cli", file: "/c/specs/cli/spec.md" },
      ]),
    )
    expect(shuffled.map((group) => group.label).sort()).toEqual(["Delta Specs", "Proposal"])
  })

  test("a lone delta capability and Other land as their own groups", () => {
    const groups = groupChangeArtifacts(
      change([
        { section: "delta", capability: "cli", file: "/c/specs/cli/spec.md" },
        { section: "other", file: "/c/notes.md" },
      ]),
    )
    expect(groups.map((group) => group.label)).toEqual(["Delta Specs", "Other"])
    expect(groups[0]!.delta).toBe(true)
    expect(groups[1]!.delta).toBe(false)
  })
})

describe("specGroupSource", () => {
  const bodyOf = (file: string) => `BODY of ${file}`

  test("injects a capability heading before each delta entry only", () => {
    const group: SpecGroup = {
      label: "Delta Specs",
      delta: true,
      entries: [
        { file: "specs/cli/spec.md", capability: "cli" },
        { file: "specs/ui/spec.md", capability: "ui" },
      ],
    }
    const source = specGroupSource(group, bodyOf)
    expect(source).toBe("## cli\n\nBODY of specs/cli/spec.md\n\n## ui\n\nBODY of specs/ui/spec.md")
  })

  test("non-delta bodies pass through untouched, frontmatter included", () => {
    const design = "---\nowner: someone\n---\n# Design\n"
    const source = specGroupSource({ label: "Design", delta: false, entries: [{ file: "design.md" }] }, () => design)
    expect(source).toBe(design)
  })

  test("a delta entry without a capability contributes only its body (no heading)", () => {
    const source = specGroupSource({ label: "Delta Specs", delta: true, entries: [{ file: "specs/core.md" }] }, bodyOf)
    expect(source).toBe("BODY of specs/core.md")
  })
})

describe("SC-1: the board shows features spun out into worktrees", () => {
  test("a change living in a feature worktree still appears in Active Changes from main", async () => {
    const repo = await mkdtemp(join(tmpdir(), "convoy-specs-sc1-"))
    const exec = promisify(nodeExecFile)
    const git = async (...args: string[]) => (await exec("git", args, { cwd: repo })).stdout.trim()
    try {
      await git("init", "-b", "main")
      await git("config", "user.email", "operator@example.com")
      await git("config", "user.name", "Operator")
      await writeFile(join(repo, "README.md"), "# repo\n")
      await git("add", ".")
      await git("commit", "-m", "chore: init")

      // An uncommitted change on main, then spin it into a worktree — exactly
      // the move `convoy spin` performs (change files leave main and arrive
      // untracked in the feature worktree).
      const changeDir = join(repo, "openspec", "changes", "add-widget")
      await mkdir(join(changeDir, "specs", "cli"), { recursive: true })
      await writeFile(join(changeDir, "proposal.md"), "# Add widget\n")
      await writeFile(join(changeDir, "tasks.md"), "- [x] one\n- [ ] two\n")
      await writeFile(join(changeDir, "specs", "cli", "spec.md"), "## ADDED Requirements\n### Requirement: Widget\n")

      const wt = join(repo, "wt")
      await git("worktree", "add", "-b", "feat/add-widget", wt, "main")
      for (const rel of ["proposal.md", "tasks.md", "specs/cli/spec.md"]) {
        await mkdir(join(wt, "openspec", "changes", "add-widget", "specs", "cli"), { recursive: true })
        await writeFile(join(wt, "openspec", "changes", "add-widget", rel), await readFile(join(changeDir, rel), "utf8"))
      }
      await rm(changeDir, { recursive: true, force: true })

      const home = await mkdtemp(join(tmpdir(), "convoy-specs-sc1-home-"))
      const prevHome = process.env.CONVOY_HOME
      process.env.CONVOY_HOME = home
      try {
        const view = await loadSpecsView(repo)
        // The spun-out change is visible even though main's openspec/changes/
        // no longer carries it.
        const entry = view.changes.find((change) => change.id === "add-widget")
        expect(entry).toBeDefined()
        expect(entry!.title).toBe("Add widget")
        expect(entry!.artifacts.length).toBeGreaterThan(0)
        // Artifact paths are absolute into the worktree, so the browser's
        // readFile (run from main's cwd) can load them.
        const file = entry!.artifacts[0]!.file
        expect(file).toContain(wt)
        await expect(readFile(file, "utf8")).resolves.toContain("Add widget")
      } finally {
        if (prevHome === undefined) delete process.env.CONVOY_HOME
        else process.env.CONVOY_HOME = prevHome
        await rm(home, { recursive: true, force: true })
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

/**
 * A minimal repo with one committed commit and a `git(...)` helper — the same
 * shape the SC-1 fixture uses. The caller adds changes, worktrees, and files.
 */
async function initGitRepo(prefix: string): Promise<{
  repo: string
  git: (...args: string[]) => Promise<string>
  cleanup: () => Promise<void>
}> {
  const repo = await mkdtemp(join(tmpdir(), prefix))
  const exec = promisify(nodeExecFile)
  const git = async (...args: string[]) => (await exec("git", args, { cwd: repo })).stdout.trim()
  await git("init", "-b", "main")
  await git("config", "user.email", "operator@example.com")
  await git("config", "user.name", "Operator")
  await writeFile(join(repo, "README.md"), "# repo\n")
  await git("add", ".")
  await git("commit", "-m", "chore: init")
  return {
    repo,
    git,
    cleanup: async () => {
      await rm(repo, { recursive: true, force: true })
    },
  }
}

/** Isolates CONVOY_HOME for the duration of `fn` so the board join never reads the operator's real runs. */
async function withIsolatedHome(fn: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "convoy-specs-home-"))
  const prevHome = process.env.CONVOY_HOME
  process.env.CONVOY_HOME = home
  try {
    await fn()
  } finally {
    if (prevHome === undefined) delete process.env.CONVOY_HOME
    else process.env.CONVOY_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
}

describe("worktree-backed changes read their artifacts from the worktree", () => {
  test("a stale skeleton on the launch checkout no longer shadows the worktree's artifacts", async () => {
    const { repo, git, cleanup } = await initGitRepo("convoy-specs-husk-")
    try {
      // The husk the incident reported: a change directory on the launch
      // checkout whose `specs/` survives but holds no markdown anywhere.
      await mkdir(join(repo, "openspec", "changes", "add-gadget", "specs"), { recursive: true })

      // The real files live untracked in the feature worktree.
      const wt = join(repo, "wt")
      await git("worktree", "add", "-b", "feat/add-gadget", wt, "main")
      const wtChange = join(wt, "openspec", "changes", "add-gadget")
      await mkdir(join(wtChange, "specs", "cli"), { recursive: true })
      await writeFile(join(wtChange, "proposal.md"), "# Add gadget\n")
      await writeFile(join(wtChange, "design.md"), "# Design\n")
      await writeFile(join(wtChange, "tasks.md"), "- [ ] one\n")
      await writeFile(join(wtChange, "specs", "cli", "spec.md"), "## ADDED Requirements\n### Requirement: Gadget\n")

      await withIsolatedHome(async () => {
        const view = await loadSpecsView(repo)
        // Same-id copies are independent entries keyed to their checkout
        // (design D3): the main husk lists by id with no artifacts, and the
        // worktree copy carries its own title and files.
        const copies = view.changes.filter((change) => change.id === "add-gadget")
        expect(copies).toHaveLength(2)
        const wtPhys = await phys(wt)
        const husk = copies.find((change) => change.checkout !== wtPhys)!
        const entry = copies.find((change) => change.checkout === wtPhys)!
        expect(husk.title).toBe("add-gadget")
        expect(husk.artifacts).toEqual([])
        // Title and artifacts come from the worktree's own proposal.
        expect(entry.title).toBe("Add gadget")
        expect(entry.artifacts.length).toBe(4)
        for (const artifact of entry.artifacts) {
          expect(artifact.file).toContain(wt)
          await expect(readFile(artifact.file, "utf8")).resolves.toBeDefined()
        }
      })
    } finally {
      await cleanup()
    }
  })

  test("diverging copies resolve to the worktree", async () => {
    const { repo, git, cleanup } = await initGitRepo("convoy-specs-diverge-")
    try {
      // Both sides carry markdown for the same id, with different titles.
      const baseChange = join(repo, "openspec", "changes", "renamed-thing")
      await mkdir(baseChange, { recursive: true })
      await writeFile(join(baseChange, "proposal.md"), "# Base proposal\n")

      const wt = join(repo, "wt")
      await git("worktree", "add", "-b", "feat/renamed-thing", wt, "main")
      const wtChange = join(wt, "openspec", "changes", "renamed-thing")
      await mkdir(wtChange, { recursive: true })
      await writeFile(join(wtChange, "proposal.md"), "# Worktree proposal\n")
      await writeFile(join(wtChange, "tasks.md"), "- [ ] only in the worktree\n")

      await withIsolatedHome(async () => {
        const view = await loadSpecsView(repo)
        // Diverging copies stay independent: each checkout's entry carries
        // its own title and files, and neither borrows from the other.
        const copies = view.changes.filter((change) => change.id === "renamed-thing")
        expect(copies).toHaveLength(2)
        const wtPhys = await phys(wt)
        const entry = copies.find((change) => change.checkout === wtPhys)!
        expect(entry.title).toBe("Worktree proposal")
        for (const artifact of entry.artifacts) {
          expect(artifact.file).toContain(wtPhys)
        }
        const proposal = entry.artifacts.find((artifact) => artifact.section === "proposal")
        await expect(readFile(proposal!.file, "utf8")).resolves.toBe("# Worktree proposal\n")
        const baseEntry = copies.find((change) => change.checkout !== wt)!
        expect(baseEntry.title).toBe("Base proposal")
      })
    } finally {
      await cleanup()
    }
  })

  test("a worktree copy without markdown leaves the launch checkout's entry standing", async () => {
    const { repo, git, cleanup } = await initGitRepo("convoy-specs-guard-")
    try {
      // The launch checkout carries the change's real files (untracked — a
      // committed copy would travel into the worktree via the base ref).
      const baseChange = join(repo, "openspec", "changes", "keep-main")
      await mkdir(baseChange, { recursive: true })
      await writeFile(join(baseChange, "proposal.md"), "# Keep on main\n")

      // A worktree also lists the id (and a second, launch-unknown id), but
      // neither worktree copy has a single markdown file.
      const wt = join(repo, "wt")
      await git("worktree", "add", "-b", "feat/elsewhere", wt, "main")
      await mkdir(join(wt, "openspec", "changes", "keep-main"), { recursive: true })
      await mkdir(join(wt, "openspec", "changes", "ghost-change"), { recursive: true })

      await withIsolatedHome(async () => {
        const view = await loadSpecsView(repo)
        // Each checkout's copies are their own entries: the launch checkout's
        // real files keep their absolute paths and title; the worktree's husk
        // copies list by id with no artifacts and no borrowed facts.
        const wtPhys = await phys(wt)
        const kept = view.changes.find((change) => change.id === "keep-main" && change.checkout !== wtPhys)
        expect(kept).toBeDefined()
        expect(kept!.title).toBe("Keep on main")
        expect(kept!.artifacts.map((artifact) => artifact.file)).toEqual([
          await phys(join(repo, "openspec", "changes", "keep-main", "proposal.md")),
        ])
        const ghost = view.changes.find((change) => change.id === "ghost-change")
        expect(ghost).toBeDefined()
        expect(ghost!.checkout).toBe(wtPhys)
        expect(ghost!.title).toBe("ghost-change")
        expect(ghost!.artifacts).toEqual([])
      })
    } finally {
      await cleanup()
    }
  })

  test("a stranded change keeps repo-relative paths beside a worktree-backed one", async () => {
    const { repo, git, cleanup } = await initGitRepo("convoy-specs-stranded-")
    try {
      // Stranded on the launch checkout: no worktree resolves to it.
      const stranded = join(repo, "openspec", "changes", "stranded-idea")
      await mkdir(stranded, { recursive: true })
      await writeFile(join(stranded, "proposal.md"), "# Stranded idea\n")

      const wt = join(repo, "wt")
      await git("worktree", "add", "-b", "feat/add-gadget", wt, "main")
      const wtChange = join(wt, "openspec", "changes", "add-gadget")
      await mkdir(wtChange, { recursive: true })
      await writeFile(join(wtChange, "proposal.md"), "# Add gadget\n")

      await withIsolatedHome(async () => {
        const view = await loadSpecsView(repo)
        const wtPhys = await phys(wt)
        const strandedEntry = view.changes.find((change) => change.id === "stranded-idea")
        expect(strandedEntry).toBeDefined()
        expect(strandedEntry!.checkout).toBe(view.board.worktrees[0]!.path)
        expect(strandedEntry!.artifacts.map((artifact) => artifact.file)).toEqual([
          await phys(join(repo, "openspec", "changes", "stranded-idea", "proposal.md")),
        ])
        const worktreeEntry = view.changes.find((change) => change.id === "add-gadget")
        expect(worktreeEntry).toBeDefined()
        expect(worktreeEntry!.artifacts.length).toBeGreaterThan(0)
        expect(worktreeEntry!.artifacts.every((artifact) => artifact.file.includes(wtPhys))).toBe(true)
      })
    } finally {
      await cleanup()
    }
  })
})
