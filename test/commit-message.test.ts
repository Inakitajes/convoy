import { describe, expect, test } from "bun:test"
import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2"

import {
  closeFallbackCommitMessage,
  commitMessagePrompt,
  defaultCommitMessageModel,
  formatCommitMessage,
  normalizeComposedMessage,
  proposeCommitMessage,
  readCommitMessage,
  templateCommitMessage,
  type CommitMessageInput,
} from "../src/commit-message"
import { parseModel } from "../src/runner"

type ProposalDeps = NonNullable<Parameters<typeof proposeCommitMessage>[1]>

const proposalInput: CommitMessageInput = {
  targetDir: "/repo",
  branch: "feat/add-login",
  prompt: "# Add login",
  commits: ["convoy(implementer): wire authentication"],
}

function createProposalHarness(reply: string | Error) {
  const calls = {
    configs: [] as Config[],
    startSignals: [] as Array<AbortSignal | undefined>,
    creates: [] as unknown[],
    prompts: [] as unknown[],
    deletes: [] as unknown[],
    close: 0,
  }
  const client = {
    session: {
      async create(input: unknown) {
        calls.creates.push(input)
        return { data: { id: "session-1" } }
      },
      async prompt(input: unknown) {
        calls.prompts.push(input)
        if (reply instanceof Error) throw reply
        return { data: { parts: [{ type: "text", text: reply }] } }
      },
      async delete(input: unknown) {
        calls.deletes.push(input)
        return { data: true }
      },
    },
  } as unknown as OpencodeClient
  const deps: ProposalDeps = {
    async startOpencode(config, signal) {
      calls.configs.push(config)
      calls.startSignals.push(signal)
      return {
        client,
        url: "http://localhost:0",
        close() {
          calls.close++
        },
      }
    },
  }
  return { calls, deps }
}

describe("proposeCommitMessage", () => {
  test("returns the model proposal through a read-only writer session", async () => {
    const { calls, deps } = createProposalHarness(
      '{"type":"feat","scope":"auth","subject":"add login","body":["wire authentication"]}',
    )

    const proposal = await proposeCommitMessage(proposalInput, deps)

    expect(proposal).toEqual({
      source: "model",
      message: { type: "feat", scope: "auth", subject: "add login", body: ["wire authentication"] },
    })
    expect(calls.startSignals[0]).toBeInstanceOf(AbortSignal)
    expect(calls.configs[0]).toMatchObject({
      permission: { question: "deny" },
      agent: {
        "convoy-commit-writer": {
          mode: "primary",
          temperature: 0,
          tools: { read: true, list: true, glob: true, grep: true, webfetch: false, write: false, edit: false, bash: false, task: false },
          permission: { read: "allow", list: "allow", glob: "allow", grep: "allow", webfetch: "deny", edit: "deny", bash: "deny", task: "deny", question: "deny" },
        },
      },
    })
    expect(calls.creates).toEqual([{ directory: "/repo", title: "convoy commit writer" }])
    expect(calls.prompts[0]).toMatchObject({
      sessionID: "session-1",
      directory: "/repo",
      model: { providerID: "openai", modelID: "gpt-5.6-luna" },
      agent: "convoy-commit-writer",
      tools: { read: true, list: true, glob: true, grep: true, webfetch: false, write: false, edit: false, bash: false },
    })
    expect(calls.deletes).toEqual([{ sessionID: "session-1", directory: "/repo" }])
    expect(calls.close).toBe(1)
  })

  test("uses the deterministic template when the writer response is not parseable", async () => {
    const { calls, deps } = createProposalHarness("I could not determine a commit message")

    const proposal = await proposeCommitMessage(proposalInput, deps)

    expect(proposal.source).toBe("template")
    expect(proposal.message).toEqual({ type: "feat", subject: "Add login", body: ["wire authentication"] })
    expect(proposal.error).toContain("no usable message")
    expect(calls.deletes).toHaveLength(1)
    expect(calls.close).toBe(1)
  })

  test("uses the deterministic template and closes the handle when the writer errors", async () => {
    const { calls, deps } = createProposalHarness(new Error("model unavailable"))

    const proposal = await proposeCommitMessage(proposalInput, deps)

    expect(proposal).toMatchObject({ source: "template", error: "model unavailable" })
    expect(calls.deletes).toHaveLength(1)
    expect(calls.close).toBe(1)
  })
})

describe("readCommitMessage", () => {
  test("reads the JSON contract from the last line of a reply that narrated first", () => {
    const reply = [
      "Let me look at the reports before answering.",
      "The run added a per-step advisor and wired it through the bridge.",
      '{"type": "feat", "scope": "advisor", "subject": "add per-step advisor model", "body": ["route calls through the bridge", "cap consultations"]}',
    ].join("\n")

    expect(readCommitMessage(reply)).toEqual({
      type: "feat",
      scope: "advisor",
      subject: "add per-step advisor model",
      body: ["route calls through the bridge", "cap consultations"],
    })
  })

  test("reads a fenced, pretty-printed object spanning several lines", () => {
    const reply = ['```json', "{", '  "type": "fix",', '  "subject": "stop the runner leaking sessions"', "}", "```"].join("\n")
    expect(readCommitMessage(reply)).toEqual({ type: "fix", subject: "stop the runner leaking sessions", body: [] })
  })

  test("falls back to feat for an unknown type and drops an unusable scope", () => {
    const reply = '{"type": "improvement", "scope": "Core Runner!", "subject": "tidy up"}'
    expect(readCommitMessage(reply)).toMatchObject({ type: "feat", scope: "corerunner" })
  })

  test("strips a doubled conventional prefix out of the subject", () => {
    const reply = '{"type": "feat", "scope": "tui", "subject": "feat(tui): add the palette."}'
    expect(readCommitMessage(reply)).toMatchObject({ subject: "add the palette" })
  })

  test("normalizes body bullets and caps the list", () => {
    const body = ["- one", "* two", "", "three", "four", "five", "six", "seven"]
    const reply = JSON.stringify({ type: "feat", subject: "do things", body })
    expect(readCommitMessage(reply)?.body).toEqual(["one", "two", "three", "four", "five", "six"])
  })

  test("caps the subject so the whole line stays inside 72 columns", () => {
    const subject = "add a very long and rather over-explained description of the change we made today"
    const message = readCommitMessage(JSON.stringify({ type: "feat", scope: "runner", subject }))
    expect(`feat(runner): ${message?.subject}`.length).toBeLessThanOrEqual(72)
    expect(message?.subject.endsWith(" ")).toBe(false)
    expect(subject.startsWith(message?.subject ?? "")).toBe(true)
  })

  test("rejects a reply with no usable subject", () => {
    expect(readCommitMessage("I couldn't determine what changed.")).toBeUndefined()
    expect(readCommitMessage('{"type": "feat"}')).toBeUndefined()
  })

  test("strips leading quotes from the subject", () => {
    const reply = '{"type": "fix", "subject": "\'fix the parser\'"}'
    expect(readCommitMessage(reply)?.subject).toBe("fix the parser")
  })

  test("strips trailing period from the subject", () => {
    const reply = '{"type": "fix", "subject": "fix the parser."}'
    expect(readCommitMessage(reply)?.subject).toBe("fix the parser")
  })

  test("rejects malformed JSON in reply", () => {
    expect(readCommitMessage('{"type": "feat", "subject": "broken')).toBeUndefined()
  })

  test("rejects reply JSON with non-object type", () => {
    expect(readCommitMessage("true")).toBeUndefined()
    expect(readCommitMessage("null")).toBeUndefined()
    expect(readCommitMessage('"string"')).toBeUndefined()
  })

  test("subject with missing type field defaults to feat", () => {
    const reply = '{"subject": "add the feature"}'
    expect(readCommitMessage(reply)?.type).toBe("feat")
  })

  test("subject with missing subject field returns undefined", () => {
    const reply = '{"type": "feat"}'
    expect(readCommitMessage(reply)).toBeUndefined()
  })

  test("handles body with non-string items", () => {
    const reply = '{"type": "feat", "subject": "do things", "body": ["one", 2, null, "four"]}'
    expect(readCommitMessage(reply)?.body).toEqual(["one", "four"])
  })

  test("handles scope with special characters", () => {
    const reply = '{"type": "feat", "scope": "CORE!!!", "subject": "fix it"}'
    expect(readCommitMessage(reply)).toMatchObject({ scope: "core", subject: "fix it" })
  })

  test("caps scope to 20 chars", () => {
    const reply = '{"type": "feat", "scope": "a-very-long-scope-name-that-exceeds", "subject": "fix it"}'
    expect(readCommitMessage(reply)?.scope?.length).toBeLessThanOrEqual(20)
  })

  test("removes the conventional prefix (type(scope):) from subject", () => {
    const reply = '{"type": "feat", "subject": "feat(runner): implement the thing."}'
    expect(readCommitMessage(reply)?.subject).toBe("implement the thing")
  })

  test("empty body becomes an empty array", () => {
    const reply = '{"type": "feat", "subject": "do things", "body": []}'
    expect(readCommitMessage(reply)?.body).toEqual([])
  })

  test("body with empty strings after trimming filters them out", () => {
    const reply = '{"type": "feat", "subject": "do things", "body": ["one", "", "  ", "two"]}'
    expect(readCommitMessage(reply)?.body).toEqual(["one", "two"])
  })
})

describe("formatCommitMessage", () => {
  test("renders subject, blank line, and a bullet body", () => {
    expect(formatCommitMessage({ type: "feat", scope: "advisor", subject: "add per-step model", body: ["one", "two"] })).toBe(
      "feat(advisor): add per-step model\n\n- one\n- two",
    )
  })

  test("omits the scope and the body when there are none", () => {
    expect(formatCommitMessage({ type: "fix", subject: "stop the leak", body: [] })).toBe("fix: stop the leak")
  })

  test("single body line renders as one bullet", () => {
    expect(formatCommitMessage({ type: "feat", subject: "do it", body: ["only one change"] })).toBe(
      "feat: do it\n\n- only one change",
    )
  })

  test("long body with many lines", () => {
    const body = ["a", "b", "c", "d", "e", "f"]
    const result = formatCommitMessage({ type: "feat", subject: "many changes", body })
    expect(result).toBe("feat: many changes\n\n- a\n- b\n- c\n- d\n- e\n- f")
  })

  test("body with empty strings before rendering filters them", () => {
    const result = formatCommitMessage({ type: "feat", subject: "work", body: ["", "a", "", "b"] })
    // formatCommitMessage doesn't filter body - it just joins them
    expect(result).toBe("feat: work\n\n- \n- a\n- \n- b")
  })
})

describe("templateCommitMessage", () => {
  test("takes the type from the branch and the subject from the PRD's first heading", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "fix/runtime-guard-limits",
      prompt: "# Add runtime guard limits\n\nThe limits must be configurable.",
      commits: ["convoy(implementer): Implementer report", "convoy(security): Security audit"],
    })

    expect(message.type).toBe("fix")
    expect(message.subject).toBe("Add runtime guard limits")
    expect(message.body).toEqual(["Implementer report", "Security audit"])
  })

  test("falls back to the branch name when there is no prompt", () => {
    const message = templateCommitMessage({ targetDir: "/repo", branch: "feat/add-onboarding-flow", commits: [] })
    expect(message).toMatchObject({ type: "feat", subject: "add onboarding flow", body: [] })
  })

  test("defaults the type when the branch carries no conventional prefix", () => {
    expect(templateCommitMessage({ targetDir: "/repo", branch: "my-branch", commits: [] }).type).toBe("feat")
  })

  test("uses first meaningful line from prompt when it has markdown heading", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "fix/issue-42",
      prompt: "### Fix issue 42\n\nThis is a fix for issue 42.",
      commits: [],
    })
    expect(message.subject).toContain("Fix issue 42")
  })

  test("subject falls back to 'update' when prompt and branch both yield nothing", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "",
      prompt: "",
      commits: [],
    })
    // A branch with no prefix uses defaultCommitType "feat", and empty rest becomes "update"
    expect(message.subject).toBe("update")
  })

  test("body strips convoy scope from step commits", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat/feature",
      commits: ["convoy(implementer): Implementer report", "convoy(security): Security audit"],
    })
    expect(message.body).toEqual(["Implementer report", "Security audit"])
  })

  test("body filters out step commits that are empty after stripping prefix", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat/feature",
      commits: ["convoy(implementer): ", "convoy(security): Security audit"],
    })
    expect(message.body).toEqual(["Security audit"])
  })

  test("body caps at maxBodyLines", () => {
    const commits = Array.from({ length: 10 }, (_, i) => `convoy(step): Commit ${i + 1}`)
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat/many",
      commits,
    })
    expect(message.body.length).toBe(6)
  })

  test("subject is capped to fit in 72 columns", () => {
    const longSubject = "a".repeat(100)
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat/long-subject",
      prompt: longSubject,
      commits: [],
    })
    expect(message.subject.length).toBeLessThanOrEqual(72)
  })

  test("branch without slash uses rest of whole branch as subject base", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat",
      commits: [],
    })
    expect(message.subject).toBe("feat")
  })
})

describe("commitMessagePrompt", () => {
  test("leads with the reports and includes every other signal it was given", () => {
    const prompt = commitMessagePrompt({
      targetDir: "/repo",
      branch: "feat/thing",
      summary: "Built the thing.",
      prompt: "Please build the thing.",
      commits: ["convoy(implementer): Implementer report"],
      diffStat: " src/thing.ts | 10 ++++",
    })

    expect(prompt.indexOf("What the run reported doing")).toBeLessThan(prompt.indexOf("What the user originally asked for"))
    expect(prompt).toContain("Branch: feat/thing")
    expect(prompt).toContain("convoy(implementer): Implementer report")
    expect(prompt).toContain("src/thing.ts")
  })

  test("omits sections it has nothing for", () => {
    const prompt = commitMessagePrompt({ targetDir: "/repo", branch: "feat/thing", commits: [] })
    expect(prompt).toBe("Branch: feat/thing")
  })

  test("omits summary when it is only whitespace", () => {
    const prompt = commitMessagePrompt({
      targetDir: "/repo",
      branch: "feat/thing",
      summary: "   ",
      commits: [],
    })
    expect(prompt).not.toContain("reported doing")
  })

  test("omits prompt when it is only whitespace", () => {
    const prompt = commitMessagePrompt({
      targetDir: "/repo",
      branch: "feat/thing",
      prompt: "   \n  \n",
      commits: [],
    })
    expect(prompt).not.toContain("originally asked for")
  })

  test("omits diffstat when it is only whitespace", () => {
    const prompt = commitMessagePrompt({
      targetDir: "/repo",
      branch: "feat/thing",
      diffStat: "  ",
      commits: [],
    })
    expect(prompt).not.toContain("Diffstat")
  })

  test("includes commits when non-empty", () => {
    const prompt = commitMessagePrompt({
      targetDir: "/repo",
      branch: "feat/thing",
      commits: ["convoy(step): Step 1"],
    })
    expect(prompt).toContain("squashed")
    expect(prompt).toContain("convoy(step): Step 1")
  })
})

describe("formatCommitMessage edge cases", () => {
  test("renders scope without body lines", () => {
    expect(formatCommitMessage({ type: "feat", scope: "cli", subject: "add the prompt", body: [] })).toBe("feat(cli): add the prompt")
  })

  test("renders body items that contain newlines", () => {
    const result = formatCommitMessage({ type: "fix", subject: "fix parser", body: ["line1\nline2", "line3"] })
    expect(result).toBe("fix: fix parser\n\n- line1\nline2\n- line3")
  })

  test("renders very long subject as-is without truncation", () => {
    const long = "a".repeat(100)
    const result = formatCommitMessage({ type: "fix", subject: long, body: [] })
    expect(result).toContain(long)
    expect(result.length).toBeGreaterThan(100)
  })

  test("renders type without scope and without body", () => {
    expect(formatCommitMessage({ type: "chore", subject: "bump deps", body: [] })).toBe("chore: bump deps")
  })

  test("renders all types correctly", () => {
    for (const type of ["feat", "fix", "refactor", "perf", "docs", "test", "chore", "build", "ci"] as const) {
      expect(formatCommitMessage({ type, subject: "change", body: [] })).toBe(`${type}: change`)
    }
  })
})

describe("readCommitMessage edge cases", () => {
  test("handles newlines embedded in body strings", () => {
    const reply = JSON.stringify({ type: "feat", subject: "do it", body: ["line1\nline2", "line3"] })
    const msg = readCommitMessage(reply)
    expect(msg?.body).toEqual(["line1\nline2", "line3"])
  })

  test("caps body at maxBodyLines (6)", () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
    const reply = JSON.stringify({ type: "feat", subject: "many lines", body })
    expect(readCommitMessage(reply)?.body?.length).toBe(6)
  })

  test("strips bullet markers from body lines", () => {
    const reply = JSON.stringify({ type: "feat", subject: "bullets", body: ["- one", "* two", "three"] })
    expect(readCommitMessage(reply)?.body).toEqual(["one", "two", "three"])
  })

  test("handles fenced json with extra whitespace", () => {
    const reply = "```json\n  {\n    \"type\": \"fix\",\n    \"subject\": \"fix it\"\n  }\n  ```"
    expect(readCommitMessage(reply)).toMatchObject({ type: "fix", subject: "fix it" })
  })

  test("strips leading/trailing quotes from subject", () => {
    const reply = JSON.stringify({ type: "feat", subject: "'add feature'" })
    expect(readCommitMessage(reply)?.subject).toBe("add feature")
  })

  test("subject with only whitespace after cleaning returns undefined", () => {
    const reply = JSON.stringify({ type: "feat", subject: "   " })
    expect(readCommitMessage(reply)).toBeUndefined()
  })

  test("body with all empty strings becomes empty array", () => {
    const reply = JSON.stringify({ type: "feat", subject: "do it", body: ["", "  ", ""] })
    expect(readCommitMessage(reply)?.body).toEqual([])
  })

  test("strips trailing period from subject", () => {
    expect(readCommitMessage(JSON.stringify({ type: "fix", subject: "fix the parser." }))?.subject).toBe("fix the parser")
  })

  test("type(scope): subject prefix in subject gets stripped", () => {
    const reply = JSON.stringify({ type: "feat", subject: "feat(cli): add the prompt" })
    expect(readCommitMessage(reply)?.subject).toBe("add the prompt")
  })
})

describe("templateCommitMessage edge cases", () => {
  test("branch with multiple slashes uses rest after first slash as subject base", () => {
    const msg = templateCommitMessage({ targetDir: "/repo", branch: "feat/feature/sub-thing", commits: [] })
    expect(msg.type).toBe("feat")
    expect(msg.subject).toBe("feature/sub thing")
  })

  test("prompt with markdown heading is used as subject", () => {
    const msg = templateCommitMessage({
      targetDir: "/repo",
      branch: "fix/bug",
      prompt: "### The bug fix\n\ndetails",
      commits: [],
    })
    expect(msg.subject).toBe("The bug fix")
  })

  test("prompt with only whitespace lines falls back to branch subject", () => {
    const msg = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat/new-ui",
      prompt: "   \n  \n",
      commits: [],
    })
    expect(msg.subject).toBe("new ui")
  })

  test("body deduplicates empty convoy step commits", () => {
    const msg = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat/x",
      commits: ["convoy(implementer): ", "convoy(tests): real change", "convoy(lint):   "],
    })
    expect(msg.body).toEqual(["real change"])
  })

  test("subject from branch with hyphens replaces them with spaces", () => {
    const msg = templateCommitMessage({ targetDir: "/repo", branch: "fix/my-bug-fix", commits: [] })
    expect(msg.subject).toBe("my bug fix")
  })

  test("caps subject when prefix + subject exceeds 72 chars", () => {
    const longSubject = "implement a very long feature that describes everything this change does and then some more details"
    const msg = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat/long-feature",
      prompt: longSubject,
      commits: [],
    })
    expect(msg.subject.length).toBeLessThanOrEqual(72)
  })

  test("scope is omitted when not set", () => {
    const msg = templateCommitMessage({ targetDir: "/repo", branch: "feat/feature", commits: [] })
    expect(msg.scope).toBeUndefined()
  })
})

describe("defaultCommitMessageModel", () => {
  // Task 1.1: the id must survive the same parsing/resolution path any run
  // model takes, so `finish` (and close) inherit it without a special case.
  test("the pinned writer model parses through the run model path", () => {
    expect(defaultCommitMessageModel).toBe("openai/gpt-5.6-luna")
    expect(parseModel(defaultCommitMessageModel)).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" })
  })
})

describe("commitMessagePrompt scope guidance", () => {
  const base = { targetDir: "/repo", branch: "feat/widget", commits: [] } satisfies CommitMessageInput

  test("a single capability is named as the scope to use", () => {
    const prompt = commitMessagePrompt({ ...base, scopeCandidates: ["cli"] })
    expect(prompt).toContain("Touched capabilities: cli")
    expect(prompt).toContain('Use "cli" as the scope')
    expect(prompt).not.toContain("omit the scope")
  })

  test("several capabilities get the omit-scope instruction", () => {
    const prompt = commitMessagePrompt({ ...base, scopeCandidates: ["cli", "ui"] })
    expect(prompt).toContain("Touched capabilities: cli, ui")
    expect(prompt).toContain("omit the scope entirely")
  })

  test("zero capabilities carry no scope section at all", () => {
    const prompt = commitMessagePrompt({ ...base, scopeCandidates: [] })
    expect(prompt).not.toContain("Touched capabilities")
    expect(prompt).not.toContain("scope")
  })

  test("the proposal document is seeded into the prompt", () => {
    const prompt = commitMessagePrompt({ ...base, proposalExcerpt: "# Add widget\n\nWhy: the board needs it." })
    expect(prompt).toContain("The change's proposal document:")
    expect(prompt).toContain("Add widget")
  })
})

describe("normalizeComposedMessage", () => {
  test("a sole touched capability replaces whatever scope the writer proposed", () => {
    const normalized = normalizeComposedMessage({ type: "feat", scope: "everything", subject: "improve the board", body: [] }, {
      scopeCandidates: ["control-board"],
      changeID: "close-ux",
    })
    expect(normalized.scope).toBe("control-board")
  })

  test("an invalid scope candidate cannot survive cleaning into a wrong scope", () => {
    const normalized = normalizeComposedMessage({ type: "feat", subject: "improve", body: [] }, { scopeCandidates: ["!!!"] })
    expect(normalized.scope).toBeUndefined()
  })

  test("zero or several capabilities remove the scope", () => {
    const none = normalizeComposedMessage({ type: "feat", scope: "x", subject: "do it", body: [] }, { scopeCandidates: [] })
    expect(none.scope).toBeUndefined()
    const many = normalizeComposedMessage({ type: "feat", scope: "x", subject: "do it", body: [] }, { scopeCandidates: ["a", "b"] })
    expect(many.scope).toBeUndefined()
  })

  test("the change id is injected first in the body and never duplicated", () => {
    const injected = normalizeComposedMessage({ type: "feat", subject: "do it", body: ["one"] }, { changeID: "close-ux" })
    expect(injected.body[0]).toBe("change close-ux")
    const already = normalizeComposedMessage({ type: "feat", subject: "do it", body: ["change close-ux", "one"] }, { changeID: "close-ux" })
    expect(already.body).toEqual(["change close-ux", "one"])
  })

  test("a collapsed subject merely containing the id does not suppress the required body line (SC-7)", () => {
    // A collapsed commit subject like "convoy(openspec): change close-ux plan"
    // contains the substring but is not the rule's own body line; the required
    // `change close-ux` line must still be injected.
    const normalized = normalizeComposedMessage({ type: "feat", subject: "improve", body: ["change close-ux plan gets archived"] }, { changeID: "close-ux" })
    expect(normalized.body[0]).toBe("change close-ux")
    expect(normalized.body).toContain("change close-ux plan gets archived")
  })
})

describe("closeFallbackCommitMessage", () => {
  test("carries the branch prefix as type, the sole capability as scope, verb + proposal title as subject, and the change id in the body", () => {
    const message = closeFallbackCommitMessage({
      branch: "feat/close-ux",
      proposal: "# Close UX\n\nBetter commits and a visible close.",
      changeID: "close-ux",
      scopeCandidates: ["feature-close"],
      commits: ["convoy(implementer): Implementer report"],
    })
    expect(message.type).toBe("feat")
    expect(message.scope).toBe("feature-close")
    expect(message.subject).toBe("improve close ux")
    expect(message.body[0]).toBe("change close-ux")
    expect(message.body).toContain("Implementer report")
  })

  test("several or zero capabilities omit the scope", () => {
    const many = closeFallbackCommitMessage({ branch: "feat/x", proposal: "# X", changeID: "x", scopeCandidates: ["a", "b"], commits: [] })
    expect(many.scope).toBeUndefined()
    const none = closeFallbackCommitMessage({ branch: "feat/x", proposal: "# X", changeID: "x", commits: [] })
    expect(none.scope).toBeUndefined()
  })

  test("a missing proposal falls back to the branch slug for the subject", () => {
    const message = closeFallbackCommitMessage({ branch: "fix/broken-thing", changeID: "broken-thing", commits: [] })
    expect(message.type).toBe("fix")
    expect(message.subject).toBe("fix broken thing")
  })

  test("every verb-map branch picks its type-appropriate imperative", () => {
    const verbOf = (branch: string, proposal: string) =>
      closeFallbackCommitMessage({ branch, proposal, changeID: "x", commits: [] }).subject.split(" ")[0]
    expect(verbOf("feat/x", "# X")).toBe("improve")
    expect(verbOf("perf/x", "# X")).toBe("improve")
    expect(verbOf("fix/x", "# X")).toBe("fix")
    expect(verbOf("refactor/x", "# X")).toBe("refactor")
    expect(verbOf("docs/x", "# X")).toBe("document")
    expect(verbOf("test/x", "# X")).toBe("test")
    expect(verbOf("chore/x", "# X")).toBe("update")
    expect(verbOf("ci/x", "# X")).toBe("update")
  })

  test("spin's change/ prefix survives as the type", () => {
    const message = closeFallbackCommitMessage({ branch: "change/rename-flow", proposal: "# Rename", changeID: "rename-flow", commits: [] })
    expect(message.type).toBe("change")
    expect(message.subject).toBe("update rename")
  })

  test("an unknown prefix defaults to feat", () => {
    const message = closeFallbackCommitMessage({ branch: "operator/x", proposal: "# X", changeID: "x", commits: [] })
    expect(message.type).toBe("feat")
  })
})
