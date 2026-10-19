import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { proposeCommitMessage } from "../src/commit-message"
import { advisorAuthFor, advisorAuthOf, authoringHarnessOf, parseConvoyConfig, pipelineDefaultsOf, runnerAuthOf } from "../src/config"
import {
  authoringClientArgv,
  claudeClientEnv,
  claudeSessionFile,
  createAuthoringConversation,
  listClaudeAuthoringCommands,
  validateAuthoringSession,
} from "../src/conversations"
import { helperAuth, helperModel } from "../src/helper-routes"
import { builtInAgents, resolvePipeline } from "../src/pipeline"
import type { HelperInferenceInput } from "../src/runners/helper-inference"
import type { AgentStep } from "../src/types"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("helper routes", () => {
  const builtIn = "openai/gpt-5.6-luna"
  test("an explicit route wins, a legacy OpenCode model is never converted, then the run-wide runner", () => {
    expect(helperModel("commitMessage", undefined, builtIn)).toBe(builtIn)
    expect(helperModel("commitMessage", { helperRoutes: { commitMessage: { runner: "claude-code", model: "sonnet" } } }, builtIn)).toBe("claude-code/sonnet")
    expect(helperModel("commitMessage", { helperRoutes: { commitMessage: { runner: "claude-code" } } }, builtIn)).toBe("claude-code/haiku")
    expect(helperModel("commitMessage", { runner: "claude-code", commitMessageModel: "openai/gpt-5.5" }, builtIn)).toBe("openai/gpt-5.5")
    expect(helperModel("branchName", { runner: "claude-code" }, builtIn)).toBe("claude-code/haiku")
    // A Claude-only plan inherits its runner when nothing is configured.
    expect(helperModel("commitMessage", {}, builtIn, "claude-code")).toBe("claude-code/haiku")
    expect(helperModel("commitMessage", { runner: "opencode" }, builtIn, "claude-code")).toBe(builtIn)
  })

  test("a Claude commit writer runs one read-only Claude inference, never OpenCode", async () => {
    let seen: HelperInferenceInput | undefined
    const proposal = await proposeCommitMessage(
      { targetDir: "/tmp", branch: "feat/x", commits: ["convoy(implement): add x"], model: "claude-code/haiku", auth: { mode: "subscription" } },
      {
        startOpencode: async () => {
          throw new Error("OpenCode must not start for a Claude writer")
        },
        inference: () => async (input) => {
          seen = input
          return { text: JSON.stringify({ type: "feat", subject: "add the x flow", body: ["wire x"] }) }
        },
      },
    )
    expect(proposal).toMatchObject({ source: "model", message: { type: "feat", subject: "add the x flow" } })
    expect(seen).toMatchObject({ model: "haiku", tools: "read-only", auth: { mode: "subscription" }, cwd: "/tmp" })
  })

  test("CLI helpers inherit their runner's configured auth", () => {
    expect(helperAuth(undefined, "claude-code/haiku")).toEqual({ mode: "subscription" })
    expect(helperAuth({ defaults: { claudeAuth: { authMode: "api-key", credentialRef: "CONVOY_KEY" } } }, "claude-code/haiku")).toEqual({ mode: "api-key", credentialRef: "CONVOY_KEY" })
    expect(helperAuth({ defaults: {}, runners: { codex: { auth: { authMode: "api-key", credentialRef: "CONVOY_OPENAI_KEY" } } } }, "codex/gpt-5.5")).toEqual({ mode: "api-key", credentialRef: "CONVOY_OPENAI_KEY" })
    // An OpenCode helper authenticates through its own provider configuration.
    expect(helperAuth({ defaults: {}, runners: { codex: { auth: { authMode: "api-key", credentialRef: "CONVOY_OPENAI_KEY" } } } }, "openai/gpt-5.5")).toEqual({ mode: "subscription" })
  })
})

describe("route defaults", () => {
  test("defaults.runner and defaults.advisorRoute apply, with no 'not applied' warning", () => {
    const config = parseConvoyConfig(`version: 1
defaults:
  runner: claude-code
  claudeAuth:
    authMode: api-key
    credentialRef: CONVOY_ANTHROPIC_KEY
  advisorRoute:
    runner: claude-code
    model: opus
    authMode: subscription
  authoring:
    runner: claude-code
`, "config.yaml", "/tmp")
    expect(pipelineDefaultsOf(config.defaults)).toMatchObject({ defaultRunner: "claude-code", defaultAdvisor: "claude-code/opus" })
    expect(advisorAuthOf(config)).toEqual({ runner: "claude-code", selection: { mode: "subscription" } })
    const pipeline = resolvePipeline({ name: "p", spec: { steps: [{ agent: "implementer", model: "sonnet" }] }, agents: builtInAgents, ...pipelineDefaultsOf(config.defaults) })
    const step = pipeline.steps[0] as AgentStep
    expect(step.runner).toBe("claude-code")
    expect(step.advisor).toBe("claude-code/opus")
  })

  test("advisorRoute.authMode applies only to advisors on its own runner", () => {
    const config = parseConvoyConfig(`version: 1
runners:
  codex:
    auth:
      authMode: api-key
      credentialRef: CONVOY_OPENAI_KEY
defaults:
  claudeAuth:
    authMode: subscription
  advisorRoute:
    runner: codex
    model: openai/gpt-5.5
    authMode: api-key
`, "config.yaml", "/tmp")
    const options = { advisorAuth: advisorAuthOf(config), runnerAuth: runnerAuthOf(config) }
    expect(advisorAuthFor("codex", options)).toEqual({ mode: "api-key", credentialRef: "CONVOY_OPENAI_KEY" })
    // A step's own Claude advisor never consults under the Codex route's OpenAI key.
    expect(advisorAuthFor("claude-code", options)).toEqual({ mode: "subscription" })
  })

  test("a runner-less advisorRoute.authMode is for the advisor model's runner, else Claude, never defaults.runner", () => {
    const route = (runner: string, extra = "") =>
      parseConvoyConfig(`version: 1
defaults:
  runner: ${runner}
  claudeAuth:
    authMode: api-key
    credentialRef: CONVOY_ANTHROPIC_KEY
  advisorRoute:
    authMode: api-key
${extra}`, "config.yaml", "/tmp")
    // An OpenCode run-wide runner leaves a previously valid config loadable.
    expect(advisorAuthOf(route("opencode"))).toEqual({ runner: "claude-code", selection: { mode: "api-key", credentialRef: "CONVOY_ANTHROPIC_KEY" } })
    // A Codex run-wide runner does not move the override off the Claude advisor.
    expect(advisorAuthOf(route("codex"))?.runner).toBe("claude-code")
    // A runner-qualified advisor model names the runner.
    expect(() => route("opencode", "    model: codex/gpt-5.5\n")).toThrow("api-key needs runners.codex.auth.credentialRef")
  })

  test("authoring.authMode is checked against the harness authoring opens, which an OpenCode harness ignores", () => {
    const config = parseConvoyConfig(`version: 1
defaults:
  runner: opencode
  authoring:
    authMode: api-key
`, "config.yaml", "/tmp")
    expect(config.defaults.authoring?.authMode).toBe("api-key")
    expect(authoringHarnessOf(config)).toBe("opencode")
    expect(() => parseConvoyConfig(`version: 1\ndefaults:\n  authoring:\n    runner: claude-code\n    authMode: api-key\n`, "config.yaml", "/tmp")).toThrow("api-key needs runners.claude-code.auth.credentialRef")
  })

  test("an inherited Claude runner refuses an OpenCode model instead of guessing", () => {
    expect(() =>
      resolvePipeline({ name: "p", spec: { steps: [{ agent: "implementer", model: "openai/gpt-5.5" }] }, agents: builtInAgents, defaultRunner: "claude-code" }),
    ).toThrow(/runs on claude-code through defaults.runner but names the model "openai\/gpt-5.5", which claude-code does not execute/)
  })

  test("claudeAuth defaults to subscription, so a billing policy alone is valid", () => {
    const config = parseConvoyConfig(`version: 1\ndefaults:\n  claudeAuth:\n    billingPolicy: account-policy\n`, "config.yaml", "/tmp")
    expect(config.defaults.claudeAuth).toEqual({ authMode: "subscription", billingPolicy: "account-policy" })
    expect(() => parseConvoyConfig(`version: 1\ndefaults:\n  claudeAuth:\n    credentialRef: KEY\n`, "config.yaml", "/tmp")).toThrow(/subscription mode must not set credentialRef/)
  })

  test("an api-key advisor or authoring route needs the Claude credential reference", () => {
    expect(() => parseConvoyConfig(`version: 1\ndefaults:\n  advisorRoute:\n    authMode: api-key\n`, "config.yaml", "/tmp")).toThrow(/credentialRef/)
    expect(() => parseConvoyConfig(`version: 1\ndefaults:\n  runner: claude-code\n  authoring:\n    authMode: api-key\n`, "config.yaml", "/tmp")).toThrow(/credentialRef/)
  })
})

describe("Claude authoring conversations", () => {
  test("a new conversation is a fresh exact session, reopened by resume once Claude persisted it", async () => {
    const checkout = await realpath(await mkdtemp(join(tmpdir(), "convoy-claude-authoring-")))
    const config = await mkdtemp(join(tmpdir(), "convoy-claude-config-"))
    dirs.push(checkout, config)
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = config
    try {
      const ref = await createAuthoringConversation({ checkout, harness: "claude-code" })
      expect(ref.harness).toBe("claude-code")
      expect(ref.sessionId).toMatch(/^[0-9a-f-]{36}$/)
      expect(await validateAuthoringSession({ ref, checkout })).toMatchObject({ status: "unavailable" })
      expect(authoringClientArgv({ checkout, ref, prompt: "/opsx:propose" })).toEqual(["claude", "--session-id", ref.sessionId, "/opsx:propose"])

      const file = claudeSessionFile(checkout, ref.sessionId)
      expect(file).toBe(join(config, "projects", checkout.replace(/[^A-Za-z0-9]/g, "-"), `${ref.sessionId}.jsonl`))
      await mkdir(join(file, ".."), { recursive: true })
      await writeFile(file, "{}\n")
      expect(await validateAuthoringSession({ ref, checkout })).toEqual({ status: "available" })
      expect(authoringClientArgv({ checkout, ref })).toEqual(["claude", "--resume", ref.sessionId])
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  test("the client runs under the reviewed auth overlay, never an ambient key", () => {
    const env = claudeClientEnv({ mode: "subscription" }, { ANTHROPIC_API_KEY: "sk-ambient", HERDR_PANE_ID: "p", PATH: "/bin" })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.HERDR_PANE_ID).toBeUndefined()
    expect(env.PATH).toBe("/bin")
  })

  test("discovers the project's Claude slash commands", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "convoy-claude-commands-"))
    dirs.push(checkout)
    expect(await listClaudeAuthoringCommands(checkout)).toEqual([])
    await mkdir(join(checkout, ".claude", "commands", "opsx"), { recursive: true })
    await writeFile(join(checkout, ".claude", "commands", "opsx", "propose.md"), "# propose\n")
    await writeFile(join(checkout, ".claude", "commands", "review.md"), "# review\n")
    expect(await listClaudeAuthoringCommands(checkout)).toEqual(["opsx:propose", "review"])
  })
})
