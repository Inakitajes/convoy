import { describe, expect, test } from "bun:test"

import type { OpencodeClient } from "@opencode-ai/sdk/v2"

import { askForBranchName, cleanBranchName, fallbackBranchName, slugifyBranch } from "../src/worktree"

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

describe("worktree branch name helpers", () => {
  test("cleanBranchName coerces model replies into git-safe kebab-case", () => {
    expect(cleanBranchName("Add onboarding flow")).toBe("add-onboarding-flow")
    expect(cleanBranchName("Fix bug #123 (login redirect)")).toBe("fix-bug-123-login-redirect")
    expect(cleanBranchName("`refactor-config-tui`")).toBe("refactor-config-tui")
    expect(cleanBranchName("  FEATURE: dark mode!!  ")).toBe("feature-dark-mode")
    expect(cleanBranchName("implementar onboarding en español")).toBe("implementar-onboarding-en-espa-ol")
  })

  test("cleanBranchName reads the last non-empty line so investigation chatter is ignored", () => {
    expect(cleanBranchName("Looking up DEV-1339…\nThe issue is about push reminders.\n\nadd-push-reminders\n")).toBe("add-push-reminders")
    expect(cleanBranchName("add-onboarding-flow\n")).toBe("add-onboarding-flow")
  })

  test("cleanBranchName prefixes a leading digit so the name isn't ambiguous", () => {
    expect(cleanBranchName("123 fix login")).toBe("task-123-fix-login")
    expect(cleanBranchName("404-page")).toBe("task-404-page")
  })

  test("cleanBranchName rejects empty / punctuation-only replies", () => {
    expect(cleanBranchName("")).toBe("")
    expect(cleanBranchName("--- !!! ---")).toBe("")
    expect(cleanBranchName("a")).toBe("a")
  })

  test("cleanBranchName caps overly long names", () => {
    const long = "fix-" + "a".repeat(60)
    const cleaned = cleanBranchName(long)
    expect(cleaned.length).toBeLessThanOrEqual(40)
    expect(cleaned.startsWith("fix-")).toBe(true)
  })

  test("fallbackBranchName is deterministic in shape and git-safe", () => {
    const name = fallbackBranchName()
    expect(name).toMatch(/^convoy-\d{8}-[a-z0-9]{4}$/)
    expect(name.length).toBeLessThanOrEqual(40)
  })

  test("slugifyBranch mirrors cleanBranchName rules for the worktree directory", () => {
    expect(slugifyBranch("Add Onboarding Flow")).toBe("add-onboarding-flow")
    expect(slugifyBranch("feature/foo bar")).toBe("feature-foo-bar")
    // Always returns something, even for garbage input.
    expect(slugifyBranch("!!!")).toMatch(/^convoy-[a-z0-9]{6}$/)
  })
})

describe("askForBranchName", () => {
  test("asks a read-only session for a branch name and collects text parts", async () => {
    let createInput: unknown
    let promptInput: NamerPromptInput | undefined
    const client = fakeNamerClient({
      promptText: "add-onboarding-flow",
      onCreate: (input) => (createInput = input),
      onPrompt: (input) => (promptInput = input as NamerPromptInput),
    })

    await expect(askForBranchName(client, "build onboarding", "/repo", "openai/gpt-5.5")).resolves.toBe("add-onboarding-flow")
    expect(createInput).toEqual({ directory: "/repo", title: "convoy branch namer" })
    expect(promptInput?.sessionID).toBe("namer-session")
    expect(promptInput?.directory).toBe("/repo")
    expect(promptInput?.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" })
    expect(promptInput?.tools).toEqual({ read: true, list: true, glob: true, grep: true, webfetch: true, write: false, edit: false, bash: false, todoread: false, todowrite: false })
    expect(promptInput?.parts).toEqual([{ type: "text", text: "Prompt:\nbuild onboarding" }])
  })

  test("truncates long prompts before sending them to the naming model", async () => {
    let promptInput: NamerPromptInput | undefined
    const client = fakeNamerClient({ promptText: "long-prompt-work", onPrompt: (input) => (promptInput = input as NamerPromptInput) })

    await askForBranchName(client, "x".repeat(1_300), "/repo", "anthropic/claude-haiku-4-5")

    const sent = promptInput?.parts[0]?.text ?? ""
    expect(sent.length).toBe("Prompt:\n".length + 1_200)
    expect(sent.endsWith("…")).toBe(true)
  })

  test("preserves a reviewed branch-namer model variant", async () => {
    let promptInput: NamerPromptInput | undefined
    const client = fakeNamerClient({ promptText: "add-onboarding", onPrompt: (input) => (promptInput = input as NamerPromptInput) })

    await askForBranchName(client, "build onboarding", "/repo", "vercel/openai/gpt-5.6-sol#xhigh")

    expect(promptInput?.model).toEqual({ providerID: "vercel", modelID: "openai/gpt-5.6-sol" })
    expect(promptInput?.variant).toBe("xhigh")
  })

  test("cleans up the throwaway session when the provider call fails", async () => {
    let deleted: unknown
    const client = fakeNamerClient({ promptThrows: true, onDelete: (input) => (deleted = input) })

    await expect(askForBranchName(client, "fix login", "/repo", "openai/gpt-5.5")).rejects.toThrow("provider unavailable")
    expect(deleted).toEqual({ sessionID: "namer-session", directory: "/repo" })
  })
})
