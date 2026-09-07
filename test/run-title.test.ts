import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  conventionalTypeFromBranch,
  humanizeBranchSlug,
  readPersistedRunTitle,
  resolveChangeTitle,
  resolveRunTitle,
  resolveRunTitleFor,
} from "../src/run-title"

/**
 * One title-resolution module for every run title consumer (capability
 * run-titles, design D1/D3): the precedence change proposal title → humanized
 * branch slug → prompt first line, with each precedence level, prefix variant,
 * and empty input pinned.
 */

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function changeTree(changeId: string, proposal: string | "directory" | undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-run-title-"))
  dirs.push(dir)
  if (proposal !== undefined) {
    const changeDir = join(dir, "openspec", "changes", changeId)
    await mkdir(changeDir, { recursive: true })
    if (proposal === "directory") await mkdir(join(changeDir, "proposal.md"), { recursive: true })
    else await writeFile(join(changeDir, "proposal.md"), proposal)
  }
  return dir
}

describe("humanizeBranchSlug", () => {
  test("drops the conventional prefix and renders the slug as words", () => {
    expect(humanizeBranchSlug("feat/quiet-notifications")).toBe("quiet notifications")
    expect(humanizeBranchSlug("change/y")).toBe("y")
    expect(humanizeBranchSlug("fix/quiet_notifications")).toBe("quiet notifications")
    expect(humanizeBranchSlug("feat/specs-viewer-tabbed-reading")).toBe("specs viewer tabbed reading")
  })

  test("a branch without a slash is humanized as-is", () => {
    expect(humanizeBranchSlug("widget")).toBe("widget")
  })

  test("non-conventional and multi-segment branches render readably without a fabricated type", () => {
    expect(humanizeBranchSlug("team/alice/release-42")).toBe("team alice release 42")
  })

  test("separators collapse and control bytes are stripped", () => {
    expect(humanizeBranchSlug("feat/--odd__name--")).toBe("odd name")
    expect(humanizeBranchSlug("feat/  spaced   out  ")).toBe("spaced out")
    expect(humanizeBranchSlug("feat/a\x1b[31mb")).toBe("ab")
  })

  test("empty inputs resolve to an empty slug", () => {
    expect(humanizeBranchSlug(undefined)).toBe("")
    expect(humanizeBranchSlug("")).toBe("")
    expect(humanizeBranchSlug("feat/")).toBe("")
    expect(humanizeBranchSlug("   ")).toBe("")
  })
})

describe("conventionalTypeFromBranch", () => {
  test("recognized prefixes supply the type; nothing is fabricated", () => {
    expect(conventionalTypeFromBranch("feat/add-attach-flow")).toBe("feat")
    expect(conventionalTypeFromBranch("change/rename-cli")).toBe("change")
    expect(conventionalTypeFromBranch("fix/quiet-notifications")).toBe("fix")
    expect(conventionalTypeFromBranch("chore/deps")).toBe("chore")
  })

  test("unrecognized or missing prefixes supply no type", () => {
    expect(conventionalTypeFromBranch("team/alice/release-42")).toBeUndefined()
    expect(conventionalTypeFromBranch("widget")).toBeUndefined()
    expect(conventionalTypeFromBranch("/widget")).toBeUndefined()
    expect(conventionalTypeFromBranch(undefined)).toBeUndefined()
    expect(conventionalTypeFromBranch("")).toBeUndefined()
  })
})

describe("resolveRunTitle precedence", () => {
  test("the change proposal title wins", () => {
    expect(resolveRunTitle({ changeTitle: "Attachment flow for run reports", branch: "feat/add-attach-flow", prompt: "# Implement the attach" })).toBe(
      "Attachment flow for run reports",
    )
  })

  test("the humanized branch slug follows when no change title exists", () => {
    expect(resolveRunTitle({ branch: "feat/quiet-notifications", prompt: "Implement the attach" })).toBe("quiet notifications")
  })

  test("the prompt's first meaningful line is the last resort", () => {
    expect(resolveRunTitle({ prompt: "# Refactor the retry loop\n\ndetails" })).toBe("Refactor the retry loop")
  })

  test("empty inputs resolve no title", () => {
    expect(resolveRunTitle({})).toBeUndefined()
    expect(resolveRunTitle({ changeTitle: "  ", branch: "  ", prompt: "" })).toBeUndefined()
  })
})

describe("resolveChangeTitle / resolveRunTitleFor", () => {
  test("a readable proposal resolves its heading title with frontmatter stripped", async () => {
    const dir = await changeTree(
      "add-attach-flow",
      "---\nto: draft\n---\n\n# Attachment flow for run reports\n\n## Why\n\nPRs read better.\n",
    )
    expect(await resolveChangeTitle(dir, "feat/add-attach-flow")).toBe("Attachment flow for run reports")
  })

  test("a proposal without a heading falls back to its first line inside the reader", async () => {
    const dir = await changeTree("plain", "Plain first line\n")
    expect(await resolveChangeTitle(dir, "feat/plain")).toBe("Plain first line")
  })

  test("a missing proposal, missing change, or unreadable proposal resolves undefined", async () => {
    const empty = await changeTree("no-proposal", undefined)
    expect(await resolveChangeTitle(empty, "feat/no-proposal")).toBeUndefined()
    // A different branch resolves no change at all.
    expect(await resolveChangeTitle(empty, "feat/other")).toBeUndefined()
    // A proposal.md that cannot be read (a directory in its place) is disclosed as absent, never invented.
    const unreadable = await changeTree("broken", "directory")
    expect(await resolveChangeTitle(unreadable, "feat/broken")).toBeUndefined()
    expect(await resolveChangeTitle(empty, undefined)).toBeUndefined()
  })

  test("the full resolution walks the precedence across real files", async () => {
    const dir = await changeTree("specs-viewer-tabbed-reading", "# Tabbed reading in the specs viewer\n")
    expect(await resolveRunTitleFor({ targetDir: dir, branch: "feat/specs-viewer-tabbed-reading", prompt: "Implement the attach" })).toBe(
      "Tabbed reading in the specs viewer",
    )
    // No matching change → the branch slug; no branch → the prompt line.
    expect(await resolveRunTitleFor({ targetDir: dir, branch: "feat/quiet-notifications", prompt: "Implement the attach" })).toBe("quiet notifications")
    expect(await resolveRunTitleFor({ targetDir: dir, prompt: "# Refactor the retry loop" })).toBe("Refactor the retry loop")
  })
})

describe("readPersistedRunTitle", () => {
  test("reads a stored title and tolerates missing, corrupt, or legacy records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-run-title-meta-"))
    dirs.push(dir)
    await writeFile(join(dir, "metadata.json"), JSON.stringify({ schemaVersion: 5, title: "Persisted title", phases: {} }))
    expect(await readPersistedRunTitle(dir)).toBe("Persisted title")

    await writeFile(join(dir, "metadata.json"), JSON.stringify({ schemaVersion: 5, phases: {} }))
    expect(await readPersistedRunTitle(dir)).toBeUndefined()

    await writeFile(join(dir, "metadata.json"), "{not json")
    expect(await readPersistedRunTitle(dir)).toBeUndefined()

    expect(await readPersistedRunTitle(undefined)).toBeUndefined()
    expect(await readPersistedRunTitle("/")).toBeUndefined()
  })
})
