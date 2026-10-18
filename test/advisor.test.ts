import { describe, expect, test } from "bun:test"

import type { OpencodeClient, Part } from "../src/opencode-client"

import {
  advisorFallbackText,
  advisorModelID,
  advisorNeedsOf,
  advisorProviderOverride,
  advisorSelectionFor,
  advisorToolName,
  buildAdvisorPrompt,
  clampMiddle,
  consultAdvisor,
  defaultAdvisorMaxTokens,
  isAdvisorModelID,
  renderTranscript,
  type TranscriptMessage,
} from "../src/advisor"

const textPart = (text: string): Part => ({ id: "p", sessionID: "s", messageID: "m", type: "text", text }) as Part
const reasoningPart = (text: string): Part =>
  ({ id: "p", sessionID: "s", messageID: "m", type: "reasoning", text, time: { start: 0 } }) as Part
const toolPart = (tool: string, state: Record<string, unknown>): Part =>
  ({ id: "p", sessionID: "s", messageID: "m", type: "tool", callID: "c", tool, state }) as unknown as Part

const message = (role: "user" | "assistant", parts: Part[]): TranscriptMessage => ({ info: { role }, parts })

describe("renderTranscript", () => {
  test("renders the executor's text, reasoning, and tool calls with their observed output", () => {
    const rendered = renderTranscript([
      message("user", [textPart("Fix the retry bug")]),
      message("assistant", [
        reasoningPart("the retry path looks wrong"),
        toolPart("read", { status: "completed", input: { filePath: "src/retry.ts" }, output: "export function retry() {}" }),
        textPart("Found it"),
      ]),
    ])

    expect(rendered).toContain("### USER\nFix the retry bug")
    expect(rendered).toContain("[reasoning] the retry path looks wrong")
    expect(rendered).toContain('[tool read] {"filePath":"src/retry.ts"}')
    expect(rendered).toContain("→ export function retry() {}")
    expect(rendered).toContain("### ASSISTANT\nFound it")
  })

  test("keeps failed tool calls, which are exactly what a stuck executor needs advice about", () => {
    const rendered = renderTranscript([message("assistant", [toolPart("bash", { status: "error", input: { command: "bun test" }, error: "2 tests failed" })])])

    expect(rendered).toContain("[tool bash]")
    expect(rendered).toContain("→ ERROR: 2 tests failed")
  })

  test("marks a pending tool call rather than dropping it", () => {
    expect(renderTranscript([message("assistant", [toolPart("bash", { status: "running", input: {} })])])).toContain("→ (running)")
  })

  test("truncates a huge tool output but says how much it dropped", () => {
    const rendered = renderTranscript([message("assistant", [toolPart("read", { status: "completed", input: {}, output: "x".repeat(9_000) })])])

    expect(rendered.length).toBeLessThan(4_000)
    expect(rendered).toMatch(/more chars/)
  })

  test("skips parts that carry no transcript value", () => {
    const rendered = renderTranscript([
      message("assistant", [textPart("   "), reasoningPart(""), { id: "p", sessionID: "s", messageID: "m", type: "step-start" } as Part]),
    ])

    expect(rendered).toBe("(the executor's transcript is empty)")
  })

  test("says so explicitly when there is nothing to show", () => {
    expect(renderTranscript([])).toBe("(the executor's transcript is empty)")
  })
})

describe("clampMiddle", () => {
  test("keeps both ends, because the task is at the start and the current state at the end", () => {
    const clamped = clampMiddle(`HEAD${"m".repeat(5_000)}TAIL`, 400)

    expect(clamped.startsWith("HEAD")).toBe(true)
    expect(clamped.endsWith("TAIL")).toBe(true)
    expect(clamped).toContain("characters of transcript omitted from the middle")
  })

  test("leaves anything within budget untouched", () => {
    expect(clampMiddle("short", 400)).toBe("short")
  })
})

describe("buildAdvisorPrompt", () => {
  test("asks the question the moment poses and requests brevity in the second person", () => {
    const first = buildAdvisorPrompt("T", { reason: "first-write" })
    expect(first).toContain("<transcript>")
    expect(first).toContain("about to make my first change")
    expect(first).toContain("(Advisor: keep your guidance under 80 words")

    expect(buildAdvisorPrompt("T", { reason: "completion" })).toContain("believe this phase is complete")
    expect(buildAdvisorPrompt("T", { reason: "on-demand", question: "which lock ordering?" })).toContain("which lock ordering?")
    expect(buildAdvisorPrompt("T", { reason: "on-demand", brevityWords: 40 })).toContain("under 40 words")
  })
})

describe("advisorProviderOverride", () => {
  test("aliases the advising model with a capped output limit, keeping the real id", () => {
    const provider = advisorProviderOverride([{ providerID: "anthropic", modelID: "claude-opus-5" }])
    const alias = provider.anthropic?.models?.["convoy-advisor-claude-opus-5"]

    expect(alias?.id).toBe("claude-opus-5")
    expect(alias?.limit?.output).toBe(defaultAdvisorMaxTokens)
  })

  test("declares a complete limit, since a partial one makes OpenCode drop the provider's whole model list", () => {
    const alias = advisorProviderOverride([{ providerID: "zai", modelID: "glm-5.2" }]).zai?.models?.["convoy-advisor-glm-5.2"]

    expect(alias?.limit?.context).toBeGreaterThan(defaultAdvisorMaxTokens)
    expect(alias?.limit?.output).toBe(defaultAdvisorMaxTokens)
  })

  test("states no cost, leaving OpenCode to resolve real pricing from the aliased id", () => {
    const alias = advisorProviderOverride([{ providerID: "anthropic", modelID: "claude-opus-5" }]).anthropic?.models?.["convoy-advisor-claude-opus-5"]

    expect(alias?.cost).toBeUndefined()
  })

  test("honours a custom output cap", () => {
    const alias = advisorProviderOverride([{ providerID: "anthropic", modelID: "claude-opus-5" }], 3_072).anthropic?.models?.[
      "convoy-advisor-claude-opus-5"
    ]

    expect(alias?.limit?.output).toBe(3_072)
  })

  test("groups several advisors per provider and de-duplicates repeats", () => {
    const provider = advisorProviderOverride([
      { providerID: "anthropic", modelID: "claude-opus-5" },
      { providerID: "anthropic", modelID: "claude-opus-4-8" },
      { providerID: "anthropic", modelID: "claude-opus-5" },
    ])

    expect(Object.keys(provider.anthropic?.models ?? {}).sort()).toEqual(["convoy-advisor-claude-opus-4-8", "convoy-advisor-claude-opus-5"])
  })

  test("never aliases an alias, so re-deriving the override is idempotent", () => {
    expect(advisorProviderOverride([{ providerID: "anthropic", modelID: advisorModelID("claude-opus-5") }])).toEqual({})
    expect(isAdvisorModelID(advisorModelID("claude-opus-5"))).toBe(true)
    expect(isAdvisorModelID("claude-opus-5")).toBe(false)
  })
})

describe("advisorFallbackText", () => {
  test("always says something, since silence would read as approval", () => {
    for (const code of ["max_uses_exceeded", "prompt_too_long", "execution_time_exceeded", "unavailable"] as const) {
      const text = advisorFallbackText({ kind: "error", code, message: "x" })
      expect(text.length).toBeGreaterThan(20)
      expect(text).toContain("not a failure of your phase")
    }
    expect(advisorFallbackText({ kind: "error", code: "max_uses_exceeded", message: "x" })).toContain("advisor budget")
  })
})

type FakeOptions = {
  messages?: TranscriptMessage[]
  messagesError?: boolean
  promptParts?: Part[]
  promptThrows?: Error
  onPrompt?: (body: Record<string, unknown>) => void
  onDelete?: (id: string) => void
}

function fakeClient(opts: FakeOptions): OpencodeClient {
  return {
    session: {
      messages: async () =>
        opts.messagesError
          ? { data: undefined, error: { message: "boom" } }
          : { data: opts.messages ?? [message("user", [textPart("do the thing")])], error: undefined },
      create: async () => ({ data: { id: "advisor-session" }, error: undefined }),
      prompt: async (body: Record<string, unknown>) => {
        opts.onPrompt?.(body)
        if (opts.promptThrows) throw opts.promptThrows
        return {
          data: {
            info: { cost: 0.021, providerID: "anthropic", modelID: "convoy-advisor-claude-opus-5", tokens: { input: 8_100, output: 620, reasoning: 300, cache: { read: 4_000, write: 120 } } },
            parts: opts.promptParts ?? [textPart("Read src/retry.ts first; the bug is in the backoff reset.")],
          },
          error: undefined,
        }
      },
      delete: async ({ sessionID }: { sessionID: string }) => {
        opts.onDelete?.(sessionID)
        return { data: undefined, error: undefined }
      },
    },
  } as unknown as OpencodeClient
}

const consultInput = {
  sessionID: "ses_executor",
  directory: "/repo",
  model: { providerID: "anthropic", modelID: "convoy-advisor-claude-opus-5" },
  reason: "first-write" as const,
}

describe("consultAdvisor", () => {
  test("returns the advice text plus separable usage", async () => {
    const result = await consultAdvisor({ client: fakeClient({}), ...consultInput })

    expect(result.kind).toBe("advice")
    if (result.kind !== "advice") return
    expect(result.text).toContain("backoff reset")
    expect(result.usage).toEqual({
      cost: 0.021,
      tokens: { input: 8_100, output: 620, reasoning: 300, cacheRead: 4_000, cacheWrite: 120 },
      model: "anthropic/convoy-advisor-claude-opus-5",
    })
  })

  test("runs with every tool disabled, so the advisor can never act", async () => {
    let body: Record<string, unknown> | undefined
    await consultAdvisor({ client: fakeClient({ onPrompt: (b) => (body = b) }), ...consultInput })

    const tools = body?.tools as Record<string, boolean>
    expect(Object.keys(tools).length).toBeGreaterThan(8)
    expect(Object.values(tools).every((enabled) => enabled === false)).toBe(true)
    // An enumerated denylist only ever covers the built-ins; the wildcard is what
    // holds for MCP servers and anything else the config directory contributes.
    expect(tools["*"]).toBe(false)
    // Convoy's own tool included, or the advisor can consult an advisor.
    expect(tools[advisorToolName]).toBe(false)
    expect(body?.system).toContain("You are advising an agent")
  })

  test("drops the advisor's reasoning, keeping only the advice", async () => {
    const result = await consultAdvisor({
      client: fakeClient({ promptParts: [reasoningPart("let me think about the lock ordering"), textPart("Take the mutex first.")] }),
      ...consultInput,
    })

    expect(result.kind).toBe("advice")
    if (result.kind !== "advice") return
    expect(result.text).toBe("Take the mutex first.")
    expect(result.text).not.toContain("let me think")
  })

  test("deletes its throwaway session, including when the prompt fails", async () => {
    const deleted: string[] = []
    await consultAdvisor({ client: fakeClient({ onDelete: (id) => deleted.push(id) }), ...consultInput })
    await consultAdvisor({ client: fakeClient({ onDelete: (id) => deleted.push(id), promptThrows: new Error("provider unavailable") }), ...consultInput })

    expect(deleted).toEqual(["advisor-session", "advisor-session"])
  })

  test("degrades instead of throwing when the transcript can't be read", async () => {
    const result = await consultAdvisor({ client: fakeClient({ messagesError: true }), ...consultInput })

    expect(result).toMatchObject({ kind: "error", code: "unavailable" })
  })

  test("classifies a timeout and an overlong prompt distinctly", async () => {
    const timedOut = await consultAdvisor({ client: fakeClient({ promptThrows: new Error("request timed out") }), ...consultInput })
    expect(timedOut).toMatchObject({ kind: "error", code: "execution_time_exceeded" })

    const tooLong = await consultAdvisor({ client: fakeClient({ promptThrows: new Error("context window exceeded") }), ...consultInput })
    expect(tooLong).toMatchObject({ kind: "error", code: "prompt_too_long" })
  })

  test("treats an empty answer as no advice rather than as approval", async () => {
    const result = await consultAdvisor({ client: fakeClient({ promptParts: [textPart("   ")] }), ...consultInput })

    expect(result).toMatchObject({ kind: "error" })
  })

  test("aborts on the caller's signal", async () => {
    const controller = new AbortController()
    controller.abort(new Error("phase cancelled"))
    const result = await consultAdvisor({
      client: fakeClient({ promptThrows: new Error("The operation was aborted") }),
      ...consultInput,
      signal: controller.signal,
    })

    expect(result.kind).toBe("error")
  })

  test("honours its own timeout without hanging the phase", async () => {
    // Mirrors the real client, which passes the signal down to fetch: a hung
    // request is cancelled by the signal, not by abandoning the promise.
    const client = {
      session: {
        messages: (_params: unknown, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
          }),
      },
    } as unknown as OpencodeClient

    const result = await consultAdvisor({ client, ...consultInput, timeoutMs: 20 })
    expect(result).toMatchObject({ kind: "error", code: "execution_time_exceeded" })
  })
})

describe("advisorNeedsOf", () => {
  const step = (agentName: string, advisor?: { providerID: string; modelID: string }) => ({
    type: "agent",
    agentName,
    ...(advisor ? { resolvedAdvisor: advisor } : {}),
  })

  test("collects only the agents and models that actually have an advisor", () => {
    const needs = advisorNeedsOf([
      step("implementer", { providerID: "anthropic", modelID: "claude-opus-5" }),
      step("bug-auditor"),
      { type: "human" },
    ])

    expect([...needs.agents]).toEqual(["implementer"])
    expect(needs.models).toEqual([{ providerID: "anthropic", modelID: "claude-opus-5" }])
  })

  test("de-duplicates a model shared by several steps", () => {
    const needs = advisorNeedsOf([
      step("implementer", { providerID: "anthropic", modelID: "claude-opus-5" }),
      step("tests", { providerID: "anthropic", modelID: "claude-opus-5" }),
    ])

    expect(needs.models).toHaveLength(1)
    expect([...needs.agents].sort()).toEqual(["implementer", "tests"])
  })

  test("returns nothing for a pipeline with no advisors, so the config is unchanged", () => {
    const needs = advisorNeedsOf([step("implementer"), step("tests")])

    expect(needs.agents.size).toBe(0)
    expect(needs.models).toEqual([])
  })
})

describe("advisorSelectionFor", () => {
  test("reaches the routed advising model through its capped alias, keeping the variant", () => {
    expect(advisorSelectionFor({ resolvedAdvisor: { providerID: "anthropic", modelID: "claude-opus-5", variant: "high" } })).toEqual({
      providerID: "anthropic",
      modelID: "convoy-advisor-claude-opus-5",
      variant: "high",
    })
    expect(advisorSelectionFor({})).toBeUndefined()
  })
})
