import { describe, expect, test } from "bun:test"

import { ConfigError, parseConvoyConfig, serializeConvoyConfig } from "../src/config"

const body = `
version: 1
defaults:
  runner: claude-code
  claudeAuth:
    authMode: api-key
    credentialRef: CONVOY_ANTHROPIC_KEY
  helperRoutes:
    branchName:
      runner: claude-code
      model: sonnet
    commitMessage:
      runner: opencode
      model: openai/gpt
  advisorRoute:
    runner: claude-code
    model: opus
    authMode: subscription
  authoring:
    runner: claude-code
    authMode: subscription
`

function parse(text: string) {
  return parseConvoyConfig(text, "test", process.cwd())
}

describe("runner config routes", () => {
  test("parses runner defaults, auth, helper/advisor routes, and authoring selection", () => {
    const config = parse(body)
    expect(config.defaults.runner).toBe("claude-code")
    expect(config.defaults.claudeAuth).toEqual({ authMode: "api-key", credentialRef: "CONVOY_ANTHROPIC_KEY" })
    expect(config.defaults.helperRoutes?.branchName).toEqual({ runner: "claude-code", model: "sonnet" })
    expect(config.defaults.helperRoutes?.commitMessage).toEqual({ runner: "opencode", model: "openai/gpt" })
    expect(config.defaults.advisorRoute).toEqual({ runner: "claude-code", model: "opus", authMode: "subscription" })
    expect(config.defaults.authoring).toEqual({ runner: "claude-code", authMode: "subscription" })
  })

  test("round-trips through serialization", () => {
    const config = parse(body)
    const reparsed = parse(serializeConvoyConfig(config))
    expect(reparsed.defaults).toEqual(config.defaults)
  })

  test("rejects a credential reference that looks like a secret value", () => {
    expect(() => parse(`version: 1\ndefaults:\n  claudeAuth:\n    authMode: api-key\n    credentialRef: sk-ant-1234567890\n`)).toThrow(ConfigError)
  })

  test("rejects invalid auth combinations and runner ids", () => {
    expect(() => parse(`version: 1\ndefaults:\n  claudeAuth:\n    authMode: api-key\n`)).toThrow(ConfigError)
    expect(() => parse(`version: 1\ndefaults:\n  claudeAuth:\n    authMode: subscription\n    credentialRef: SOME_VAR\n`)).toThrow(ConfigError)
    expect(() => parse(`version: 1\ndefaults:\n  runner: nope\n`)).toThrow(ConfigError)
  })
})
