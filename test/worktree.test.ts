import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { OpencodeClient } from "../src/opencode-client"

import {
  askForBranchName,
  branchNameTaken,
  cleanBranchName,
  ensureFreeBranchName,
  excerpt,
  extractDeclaredBranchName,
  fallbackBranchName,
  heuristicBranchName,
  namerMessage,
  proposeBranchName,
  readBranchName,
  resolveNamingPrompt,
  slugifyBranch,
} from "../src/worktree"

type FakeNamerOptions = {
  promptText?: string
  promptThrows?: boolean
  onCreate?: (input: unknown, options: unknown) => void
  onPrompt?: (input: unknown, options: unknown) => void
  onDelete?: (input: unknown) => void
}

type NamerPromptInput = {
  sessionID: string
  directory: string
  model: { providerID: string; modelID: string }
  variant?: string
  agent?: string
  system?: string
  tools: Record<string, boolean>
  parts: Array<{ type: string; text: string }>
}

function fakeNamerClient(opts: FakeNamerOptions): OpencodeClient {
  return {
    session: {
      create: async (input: unknown, options: unknown) => {
        opts.onCreate?.(input, options)
        return { data: { id: "namer-session" }, error: undefined }
      },
      prompt: async (input: unknown, options: unknown) => {
        opts.onPrompt?.(input, options)
        if (opts.promptThrows) throw new Error("provider unavailable")
        return { data: { info: {}, parts: [{ type: "text", text: opts.promptText ?? "" }] }, error: undefined }
      },
      delete: async (input: unknown) => {
        opts.onDelete?.(input)
        return { data: undefined, error: undefined }
      },
    },
  } as unknown as OpencodeClient
}

describe("cleanBranchName", () => {
  test("coerces candidates into git-safe type/kebab-case", () => {
    expect(cleanBranchName("Add onboarding flow")).toBe("feat/add-onboarding-flow")
    expect(cleanBranchName("fix/login redirect")).toBe("fix/login-redirect")
    expect(cleanBranchName("`refactor/config-tui`")).toBe("refactor/config-tui")
    expect(cleanBranchName("chore: bump deps")).toBe("chore/bump-deps")
  })

  test("maps the conventional-type spellings people actually write", () => {
    expect(cleanBranchName("feature/dark mode")).toBe("feat/dark-mode")
    expect(cleanBranchName("bugfix: login redirect")).toBe("fix/login-redirect")
    expect(cleanBranchName("hotfix/crash on start")).toBe("fix/crash-on-start")
  })

  test("keeps accented letters as letters instead of collapsing them into hyphens", () => {
    expect(cleanBranchName("implementar onboarding en español")).toBe("feat/implementar-onboarding-en-espanol")
    expect(cleanBranchName("límites de ejecución")).toBe("feat/limites-de-ejecucion")
  })

  test("rejects prose so a conversational reply can never become a branch", () => {
    // The regression that produced ~/.convoy/worktrees/cu-l-es-tu-siguiente-paso.
    expect(cleanBranchName("¿Cuál es tu siguiente paso?")).toBe("")
    expect(cleanBranchName("What would you like me to do next?")).toBe("")
    expect(cleanBranchName("I have read the PRD and I am ready to start working on it")).toBe("")
  })

  test("rejects empty and punctuation-only candidates", () => {
    expect(cleanBranchName("")).toBe("")
    expect(cleanBranchName("--- !!! ---")).toBe("")
  })

  test("an authored name keeps the shape the user typed, prose check included", () => {
    expect(cleanBranchName("my-own-branch", { authored: true })).toBe("my-own-branch")
    expect(cleanBranchName("fix/login", { authored: true })).toBe("fix/login")
    expect(cleanBranchName("404 page", { authored: true })).toBe("task-404-page")
    // Long-winded, but the user typed it on purpose: never silently discarded.
    expect(cleanBranchName("the branch about the budget limits and the runtime guard", { authored: true })).toBe("the-branch-about-the-budget-limits-and-the")
  })

  test("caps long names on a hyphen boundary, keeping the prefix", () => {
    const cleaned = cleanBranchName("feat/improve-first-routine-recommendation-payload-for-new-users")
    expect(cleaned.length).toBeLessThanOrEqual(48)
    expect(cleaned.startsWith("feat/improve-first-routine")).toBe(true)
    // Never ends mid-word the way the old 40-char slice did ("…-pay").
    expect(cleaned.endsWith("-")).toBe(false)
    expect("feat/improve-first-routine-recommendation-payload-for-new-users".startsWith(cleaned)).toBe(true)
  })
})

describe("readBranchName", () => {
  test("reads the JSON contract from the last line", () => {
    expect(readBranchName('{"type": "feat", "name": "add-onboarding-flow"}')).toBe("feat/add-onboarding-flow")
    expect(readBranchName('Looking up DEV-1339…\nIt is about push reminders.\n\n{"type":"fix","name":"dev-1339-push-reminders"}')).toBe("fix/dev-1339-push-reminders")
  })

  test("reads a pretty-printed or fenced object too", () => {
    expect(readBranchName('```json\n{\n  "type": "refactor",\n  "name": "config-tui"\n}\n```')).toBe("refactor/config-tui")
  })

  test("falls back to an unknown type rather than dropping the answer", () => {
    expect(readBranchName('{"type": "banana", "name": "dark-mode-toggle"}')).toBe("feat/dark-mode-toggle")
  })

  test("does not double the prefix when the name already carries one", () => {
    expect(readBranchName('{"type": "fix", "name": "fix/login-redirect"}')).toBe("fix/login-redirect")
  })

  test("salvages a bare slug when the model ignored the JSON contract", () => {
    expect(readBranchName("I checked the repo.\nadd-push-reminders")).toBe("feat/add-push-reminders")
  })

  test("returns nothing when the reply is conversation, so naming falls through", () => {
    expect(readBranchName("He leído el PRD sobre los límites.\n\n¿Cuál es tu siguiente paso?")).toBe("")
    expect(readBranchName("")).toBe("")
  })
})

describe("heuristicBranchName", () => {
  test("names the branch after the prompt's opening heading", () => {
    expect(heuristicBranchName("# Propuesta de implementación\n\nLa solución debería tener tres capas")).toBe("feat/propuesta-implementacion")
  })

  test("strips the Implementation Plan / PRD wrapper so the title is what gets named", () => {
    expect(heuristicBranchName("# Implementation Plan: Compact Mode for Pipeline Launcher TUI")).toBe(
      "feat/compact-mode-pipeline-launcher",
    )
    expect(heuristicBranchName("PRD — Auditorías de review fiables: Scope con verify")).toBe("feat/auditorias-review-fiables-scope")
    expect(heuristicBranchName("Plan conjunto: fix de permisos + OpenCode 1.18.18")).toBe("feat/fix-permisos-opencode")
  })

  test("ignores later hash comments so a plan's # File: line cannot become the name", () => {
    expect(
      heuristicBranchName("Implementation Plan: Reliable Phase Report Delivery\n\n# Create test for last message extraction"),
    ).toBe("feat/reliable-phase-report-delivery")
  })

  test("uses the first line when there is no heading, dropping stop words", () => {
    expect(heuristicBranchName("Add a budget limit to the execution supervisor")).toBe("feat/budget-limit-execution-supervisor")
  })

  test("returns nothing when there is nothing to derive", () => {
    expect(heuristicBranchName("")).toBe("")
    expect(heuristicBranchName("!!! ???")).toBe("")
  })
})

describe("fallbackBranchName / slugifyBranch", () => {
  test("fallbackBranchName is deterministic in shape and git-safe", () => {
    const name = fallbackBranchName()
    expect(name).toMatch(/^convoy-\d{8}-[a-z0-9]{4}$/)
    expect(name.length).toBeLessThanOrEqual(48)
  })

  test("slugifyBranch flattens the type prefix into the directory name", () => {
    expect(slugifyBranch("feat/add-onboarding-flow")).toBe("feat-add-onboarding-flow")
    expect(slugifyBranch("Add Onboarding Flow")).toBe("add-onboarding-flow")
    expect(slugifyBranch("límites")).toBe("limites")
    expect(slugifyBranch("!!!")).toMatch(/^convoy-[a-z0-9]{6}$/)
  })
})

describe("namer payload", () => {
  test("excerpt keeps both ends of a long PRD so the closing ask survives", () => {
    const prd = `${"a".repeat(2_000)}RECOMENDACION FINAL`
    const sent = excerpt(prd)
    expect(sent.length).toBeLessThan(prd.length)
    expect(sent.startsWith("aaa")).toBe(true)
    expect(sent.endsWith("RECOMENDACION FINAL")).toBe(true)
    expect(sent).toContain("\n…\n")
  })

  test("excerpt leaves a short prompt untouched", () => {
    expect(excerpt("build onboarding")).toBe("build onboarding")
  })

  test("namerMessage puts the user's guidance above the prompt", () => {
    const message = namerMessage("build onboarding", "call it after the budget limits")
    expect(message.indexOf("budget limits")).toBeLessThan(message.indexOf("build onboarding"))
    expect(message).toContain("Prompt:\nbuild onboarding")
    expect(namerMessage("build onboarding")).toContain("Prompt:\nbuild onboarding")
    expect(namerMessage("build onboarding")).toContain("feat/build-onboarding")
  })

  test("namerMessage pins a declared branch name so the model cannot paraphrase it", () => {
    const message = namerMessage("# Compact Mode\n\n**Intended Branch Name:** `feat/launcher-compact-mode`")
    expect(message).toContain("The document already names the branch")
    expect(message).toContain("feat/launcher-compact-mode")
    expect(message).not.toContain("Name suggested by the document title")
  })
})

describe("askForBranchName", () => {
  test("asks a read-only namer agent and collects text parts", async () => {
    let createInput: unknown
    let promptInput: NamerPromptInput | undefined
    const client = fakeNamerClient({
      promptText: '{"type":"feat","name":"add-onboarding-flow"}',
      onCreate: (input) => (createInput = input),
      onPrompt: (input) => (promptInput = input as NamerPromptInput),
    })

    const reply = await askForBranchName(client, { prompt: "build onboarding", targetDir: "/repo", model: "openai/gpt-5.5" })

    expect(readBranchName(reply)).toBe("feat/add-onboarding-flow")
    expect(createInput).toMatchObject({ directory: "/repo", title: "convoy branch namer" })
    const perms = (createInput as { permissions?: Array<{ action: string; effect: string }> }).permissions ?? []
    expect(perms[0]).toMatchObject({ action: "*", effect: "deny" })
    expect(perms.slice(1).map((p) => `${p.action}:${p.effect}`).sort()).toEqual(["glob:allow", "grep:allow", "list:allow", "read:allow", "webfetch:allow"])
    expect(promptInput?.sessionID).toBe("namer-session")
    expect(promptInput?.directory).toBe("/repo")
    expect(promptInput?.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" })
    // The registered agent is what replaces opencode's conversational default.
    expect(promptInput?.agent).toBe("convoy-branch-namer")
    expect(promptInput?.system).toContain("ENGLISH")
    expect(promptInput?.tools).toEqual({ read: true, list: true, glob: true, grep: true, webfetch: true, write: false, edit: false, bash: false, todoread: false, todowrite: false })
    expect(promptInput?.parts[0]?.text).toContain("Prompt:\nbuild onboarding")
    expect(promptInput?.parts[0]?.text).toContain("feat/build-onboarding")
  })

  test("sends both ends of a long prompt to the naming model", async () => {
    let promptInput: NamerPromptInput | undefined
    const client = fakeNamerClient({ promptText: "long-prompt-work", onPrompt: (input) => (promptInput = input as NamerPromptInput) })

    await askForBranchName(client, { prompt: `${"x".repeat(2_000)}CLOSING ASK`, targetDir: "/repo", model: "anthropic/claude-haiku-4-5" })

    const sent = promptInput?.parts[0]?.text ?? ""
    expect(sent.endsWith("CLOSING ASK")).toBe(true)
    expect(sent).toContain("\n…\n")
  })

  test("preserves a reviewed branch-namer model variant", async () => {
    let promptInput: NamerPromptInput | undefined
    const client = fakeNamerClient({ promptText: "add-onboarding", onPrompt: (input) => (promptInput = input as NamerPromptInput) })

    await askForBranchName(client, { prompt: "build onboarding", targetDir: "/repo", model: "vercel/openai/gpt-5.6-sol#xhigh" })

    expect(promptInput?.model).toEqual({ providerID: "vercel", modelID: "openai/gpt-5.6-sol" })
    expect(promptInput?.variant).toBe("xhigh")
  })

  test("cleans up the throwaway session when the provider call fails", async () => {
    let deleted: unknown
    const client = fakeNamerClient({ promptThrows: true, onDelete: (input) => (deleted = input) })

    await expect(askForBranchName(client, { prompt: "fix login", targetDir: "/repo", model: "openai/gpt-5.5" })).rejects.toThrow("provider unavailable")
    expect(deleted).toEqual({ sessionID: "namer-session", directory: "/repo" })
  })
})

describe("extractDeclaredBranchName", () => {
  test("reads Intended Branch Name from a plan header", () => {
    expect(extractDeclaredBranchName("# Compact Mode\n\n**Intended Branch Name:** `feat/launcher-compact-mode`\n")).toBe(
      "feat/launcher-compact-mode",
    )
    expect(extractDeclaredBranchName("Intended Branch Name: fix/reliable-score-report-extraction\n")).toBe(
      "fix/reliable-score-report-extraction",
    )
  })

  test("reads a git checkout -b instruction", () => {
    expect(extractDeclaredBranchName("1. Create branch: git checkout -b fix/reliable-score-report-extraction")).toBe(
      "fix/reliable-score-report-extraction",
    )
  })

  test("ignores documents that never name a branch", () => {
    expect(extractDeclaredBranchName("# Compact Mode\n\nAdd a stacked layout for narrow terminals.")).toBe("")
  })
})

describe("resolveNamingPrompt", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("reads a short prompt that is just a plan path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-namer-path-"))
    dirs.push(dir)
    await writeFile(join(dir, "plan.md"), "# Compact Mode\n\n**Intended Branch Name:** `feat/launcher-compact-mode`\n")
    const resolved = await resolveNamingPrompt("docs/plans/ignored.md implement plan.md", dir)
    expect(resolved).toContain("feat/launcher-compact-mode")
    expect(await resolveNamingPrompt("plan.md", dir)).toContain("Intended Branch Name")
  })

  test("leaves a long pasted PRD alone even if it mentions a path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-namer-long-"))
    dirs.push(dir)
    await writeFile(join(dir, "other.md"), "SHOULD NOT BE READ")
    const prd = `${"context ".repeat(80)}see other.md for notes`
    expect(await resolveNamingPrompt(prd, dir)).toBe(prd)
  })
})

describe("proposeBranchName", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("uses the PRD's intended name without calling a model", async () => {
    const proposal = await proposeBranchName({
      prompt: "# Compact Mode\n\n**Intended Branch Name:** `feat/launcher-compact-mode`\n",
      targetDir: "/repo",
    })
    expect(proposal).toEqual({ branch: "feat/launcher-compact-mode", source: "declared" })
  })

  test("reads a referenced plan file and takes its intended name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-namer-propose-"))
    dirs.push(dir)
    await mkdir(join(dir, "docs/plans"), { recursive: true })
    await writeFile(
      join(dir, "docs/plans/2026-08-16-launcher-compact-mode.md"),
      "# Implementation Plan: Compact Mode for Pipeline Launcher TUI\n\n**Intended Branch Name:** `feat/launcher-compact-mode`\n",
    )
    const proposal = await proposeBranchName({
      prompt: "docs/plans/2026-08-16-launcher-compact-mode.md",
      targetDir: dir,
    })
    expect(proposal).toEqual({ branch: "feat/launcher-compact-mode", source: "declared" })
  })
})

describe("excerpt highlights", () => {
  test("keeps an Intended Branch Name that sits past the head window", () => {
    const prd = `${"a".repeat(1_200)}\n**Intended Branch Name:** \`feat/launcher-compact-mode\`\n${"b".repeat(1_200)}`
    const sent = excerpt(prd)
    expect(sent).toContain("feat/launcher-compact-mode")
    expect(sent).toContain("\n…\n")
  })
})

describe("ensureFreeBranchName", () => {
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

  async function repoWithBranches(branches: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-free-branch-"))
    dirs.push(dir)
    await git(["init", "-q"], dir)
    await writeFile(join(dir, "README.md"), "base\n")
    await git(["add", "README.md"], dir)
    await git(["commit", "-q", "-m", "init"], dir)
    for (const branch of branches) await git(["branch", branch], dir)
    return dir
  }

  test("keeps a free name as it is", async () => {
    const dir = await repoWithBranches([])
    expect(await ensureFreeBranchName("feat/add-onboarding", dir)).toBe("feat/add-onboarding")
    expect(await branchNameTaken("feat/add-onboarding", dir)).toBe(false)
  })

  test("suffixes until the branch name is free", async () => {
    const dir = await repoWithBranches(["feat/add-onboarding", "feat/add-onboarding-2"])
    expect(await branchNameTaken("feat/add-onboarding", dir)).toBe(true)
    expect(await ensureFreeBranchName("feat/add-onboarding", dir)).toBe("feat/add-onboarding-3")
  })
})
