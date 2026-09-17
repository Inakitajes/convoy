import { describe, expect, test } from "bun:test"

import {
  cleanBranchName,
  defaultBranchNameModel,
  excerpt,
  fallbackBranchName,
  heuristicBranchName,
  namerMessage,
  readBranchName,
  slugifyBranch,
  worktreeDirFor,
} from "../src/worktree"

const maxNameLength = 48

describe("defaultBranchNameModel", () => {
  test("is a constant string", () => {
    expect(typeof defaultBranchNameModel).toBe("string")
    expect(defaultBranchNameModel.length).toBeGreaterThan(0)
  })

  test("is set to the expected default model", () => {
    expect(defaultBranchNameModel).toBe("openrouter/deepseek/deepseek-v4.1-flash")
  })
})

describe("cleanBranchName edge cases", () => {
  test("empty string returns empty", () => {
    expect(cleanBranchName("")).toBe("")
    expect(cleanBranchName("   ")).toBe("")
  })

  test("already-clean name without type prefix is left clean", () => {
    expect(cleanBranchName("add-onboarding-flow")).toBe("feat/add-onboarding-flow")
  })

  test("already-clean name with type prefix is left clean", () => {
    expect(cleanBranchName("feat/add-onboarding-flow")).toBe("feat/add-onboarding-flow")
    expect(cleanBranchName("fix/login-redirect")).toBe("fix/login-redirect")
  })

  test("names with spaces are converted to kebab-case", () => {
    expect(cleanBranchName("add onboarding flow")).toBe("feat/add-onboarding-flow")
    expect(cleanBranchName("fix login redirect")).toBe("feat/fix-login-redirect")
  })

  test("names with @ and : are cleaned", () => {
    expect(cleanBranchName("add@onboarding")).toBe("feat/add-onboarding")
    expect(cleanBranchName("fix..login")).toBe("feat/fix-login")
  })

  test("names with ~ symbol are cleaned", () => {
    expect(cleanBranchName("fix~login")).toBe("feat/fix-login")
  })

  test("names with ^ symbol are cleaned", () => {
    expect(cleanBranchName("refactor^config")).toBe("feat/refactorconfig")
  })

  test("names with dots are handled", () => {
    expect(cleanBranchName("fix.login.redirect")).toBe("feat/fix-login-redirect")
    expect(cleanBranchName("v2.1.upgrade")).toBe("feat/v2-1-upgrade")
  })

  test("names with .lock are not special for cleanBranchName (only git cares about .lock)", () => {
    expect(cleanBranchName("fix/login.lock")).toBe("fix/login-lock")
  })

  test("names with uppercase are lowercased", () => {
    expect(cleanBranchName("Add-Onboarding-Flow")).toBe("feat/add-onboarding-flow")
    expect(cleanBranchName("FIX/Login-Redirect")).toBe("fix/login-redirect")
  })

  test("leading dashes are stripped", () => {
    expect(cleanBranchName("--add-onboarding")).toBe("feat/add-onboarding")
  })

  test("trailing dashes are stripped", () => {
    expect(cleanBranchName("add-onboarding--")).toBe("feat/add-onboarding")
  })

  test("consecutive dashes are collapsed", () => {
    expect(cleanBranchName("add--onboarding---flow")).toBe("feat/add-onboarding-flow")
  })

  test("names with @ symbol are cleaned", () => {
    expect(cleanBranchName("user@input/feature")).toBe("feat/user-input-feature")
  })

  test("names with ~ symbol are collapsed", () => {
    expect(cleanBranchName("~temp~/feature")).toBe("feat/temp-feature")
  })

  test("names with ^ symbol are collapsed", () => {
    expect(cleanBranchName("fix^carrot")).toBe("feat/fixcarrot")
  })

  test("names with : symbol are treated as type prefix", () => {
    expect(cleanBranchName("fix:my-feature")).toBe("fix/my-feature")
    expect(cleanBranchName("my:feature")).toBe("feat/my-feature")
  })

  test("names with .. are collapsed in body", () => {
    expect(cleanBranchName("fix..my..feature")).toBe("feat/fix-my-feature")
  })

  test("names with .lock in the body are not special for cleanBranchName", () => {
    expect(cleanBranchName("fix/my-branch.lock")).toBe("fix/my-branch-lock")
  })

  test("names that are too long are trimmed on a hyphen boundary", () => {
    const long = "feat/" + "a".repeat(maxNameLength)
    const cleaned = cleanBranchName(long)
    expect(cleaned.length).toBeLessThanOrEqual(maxNameLength)
    expect(cleaned.endsWith("-")).toBe(false)
  })

  test("long name without hyphens is still trimmed", () => {
    const long = "feat/" + "a".repeat(maxNameLength)
    const cleaned = cleanBranchName(long)
    expect(cleaned).toBe("feat/" + "a".repeat(maxNameLength - 5))
  })

  test("authored: true keeps the users chosen prefix", () => {
    expect(cleanBranchName("fix/login", { authored: true })).toBe("fix/login")
    expect(cleanBranchName("login", { authored: true })).toBe("login")
  })

  test("authored: true does not add a default type prefix", () => {
    expect(cleanBranchName("my-branch", { authored: true })).toBe("my-branch")
  })

  test("authored: true still guards leading digits", () => {
    expect(cleanBranchName("404-page", { authored: true })).toBe("task-404-page")
  })

  test("authored: true with long name is still capped", () => {
    const long = "a".repeat(maxNameLength + 20)
    const cleaned = cleanBranchName(long, { authored: true })
    expect(cleaned.length).toBeLessThanOrEqual(maxNameLength)
  })

  test("authored: true with empty string returns empty", () => {
    expect(cleanBranchName("", { authored: true })).toBe("")
  })
})

describe("worktreeDirFor", () => {
  test("returns a predictable path ending with the slugified branch name", () => {
    const dir = worktreeDirFor("feat/add-onboarding-flow")
    expect(dir).toContain(".convoy/worktrees/")
    expect(dir.endsWith("feat-add-onboarding-flow")).toBe(true)
  })

  test("handles branches with accented characters", () => {
    const dir = worktreeDirFor("feat/implementar-espanol")
    expect(dir).toContain(".convoy/worktrees/")
    expect(dir.endsWith("feat-implementar-espanol")).toBe(true)
  })

  test("handles branches without a type prefix", () => {
    const dir = worktreeDirFor("my-custom-branch")
    expect(dir).toContain(".convoy/worktrees/")
    expect(dir.endsWith("my-custom-branch")).toBe(true)
  })

  test("handles branches with dots", () => {
    const dir = worktreeDirFor("fix/v2.1-login")
    expect(dir).toContain(".convoy/worktrees/")
    expect(dir.endsWith("fix-v2-1-login")).toBe(true)
  })
})

describe("readBranchName additional edge cases", () => {
  test("strips enclosing quotes from bare slug fallback", () => {
    expect(readBranchName("`fix/login-redirect`")).toBe("fix/login-redirect")
    expect(readBranchName("'fix/login-redirect'")).toBe("fix/login-redirect")
    expect(readBranchName('"fix/login-redirect"')).toBe("fix/login-redirect")
  })

  test("empty reply returns empty string", () => {
    expect(readBranchName("")).toBe("")
    expect(readBranchName("   ")).toBe("")
    expect(readBranchName("\n\n\n")).toBe("")
  })

  test("reply with only prose returns empty string", () => {
    expect(readBranchName("I have analyzed the codebase and found the issue.")).toBe("")
  })

  test("narrative followed by JSON works", () => {
    const reply = `I looked at the issue tracker.
    The ticket is about adding a dark mode toggle.
    {"type": "feat", "name": "dark-mode-toggle"}`
    expect(readBranchName(reply)).toBe("feat/dark-mode-toggle")
  })
})

describe("heuristicBranchName additional edge cases", () => {
  test("single word after stop-word removal produces a valid branch", () => {
    expect(heuristicBranchName("the budget")).toBe("feat/budget")
  })

  test("heading with stop words only returns empty", () => {
    expect(heuristicBranchName("# the a an")).toBe("")
  })

  test("heading with mixed stop and meaningful words", () => {
    expect(heuristicBranchName("# Add the new budget limit")).toBe("feat/budget-limit")
  })

  test("prompt with multiple headings uses the first one", () => {
    expect(heuristicBranchName("# First heading\n\n# Second heading")).toBe("feat/first-heading")
  })

  test("prompt with only stop words returns empty", () => {
    expect(heuristicBranchName("the and for")).toBe("")
  })
})

describe("fallbackBranchName", () => {
  test("produces a git-safe branch name matching expected format", () => {
    const name = fallbackBranchName()
    expect(name).toMatch(/^convoy-\d{8}-[a-z0-9]{4}$/)
    expect(name.length).toBeLessThanOrEqual(maxNameLength)
  })

  test("produces different names on successive calls (different timestamp or slug)", () => {
    const names = new Set(Array.from({ length: 5 }, () => fallbackBranchName()))
    expect(names.size).toBeGreaterThan(1)
  })
})

describe("slugifyBranch additional edge cases", () => {
  test("flattens type prefix into the directory name", () => {
    expect(slugifyBranch("feat/add-onboarding-flow")).toBe("feat-add-onboarding-flow")
    expect(slugifyBranch("fix/login-redirect")).toBe("fix-login-redirect")
  })

  test("handles branches without a type prefix", () => {
    expect(slugifyBranch("my-branch")).toBe("my-branch")
  })

  test("handles branches with uppercase", () => {
    expect(slugifyBranch("FEAT/Add-Onboarding")).toBe("feat-add-onboarding")
  })

  test("handles branches with special characters (^ and ~ collapse without hyphen)", () => {
    expect(slugifyBranch("fix@login^redirect")).toBe("fix-loginredirect")
  })

  test("falls back to a random slug for all-punctuation input", () => {
    const result = slugifyBranch("!!!")
    expect(result).toMatch(/^convoy-[a-z0-9]{6}$/)
  })
})

describe("excerpt", () => {
  test("keeps both ends of a long prompt", () => {
    const long = "a".repeat(1000) + "MIDDLE" + "b".repeat(1000)
    const result = excerpt(long)
    expect(result).toContain("…")
    expect(result.startsWith("a".repeat(900))).toBe(true)
    expect(result.endsWith("b".repeat(500))).toBe(true)
  })

  test("leaves a short prompt untouched", () => {
    expect(excerpt("short prompt")).toBe("short prompt")
  })

  test("empty string stays empty", () => {
    expect(excerpt("")).toBe("")
  })

  test("exactly at boundary is not truncated", () => {
    const value = "a".repeat(1400)
    expect(excerpt(value)).toBe(value)
  })

  test("one over boundary is truncated (may be slightly longer due to separator)", () => {
    const value = "a".repeat(2000)
    const result = excerpt(value)
    expect(result.length).toBeLessThan(value.length)
    expect(result).toContain("…")
  })
})

describe("namerMessage", () => {
  test("uses guidance when provided", () => {
    const msg = namerMessage("build onboarding", "call it budget-limits")
    expect(msg).toContain("How the user wants it named")
    expect(msg).toContain("budget-limits")
    expect(msg).toContain("Prompt:")
    expect(msg).toContain("build onboarding")
  })

  test("guidance appears before the prompt", () => {
    const msg = namerMessage("build onboarding", "call it budget-limits")
    const guidanceIdx = msg.indexOf("How the user wants it named")
    const promptIdx = msg.indexOf("Prompt:")
    expect(guidanceIdx).toBeLessThan(promptIdx)
  })

  test("without guidance, includes the prompt and a title suggestion", () => {
    const msg = namerMessage("build onboarding")
    expect(msg).not.toContain("How the user wants it named")
    expect(msg).toContain("Prompt:")
    expect(msg).toContain("build onboarding")
    expect(msg).toContain("feat/build-onboarding")
  })

  test("empty prompt with guidance still uses guidance", () => {
    const msg = namerMessage("", "user said name it fix-login")
    expect(msg).toContain("How the user wants it named")
    expect(msg).not.toContain("Prompt:")
  })
})