import { describe, expect, test } from "bun:test"

import {
  ambiguousBillingEnvVars,
  resolveClaudeMode,
  subscriptionLoginEnvVars,
  type ClaudeModeResult,
} from "../src/runners/claude/mode"

const secret = "sk-ant-mode-secret-value-0123456789"

/** Fails unless the message requests an explicit choice without implying consent. */
function assertNoApiConsent(result: ClaudeModeResult): void {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("expected a refusal")
  const error = result.error.toLowerCase()
  expect(error).toMatch(/will not|never/)
  expect(error).not.toContain("will use the api key")
  expect(error).not.toContain("defaults to api")
  expect(error).toContain("authmode")
  expect(result.error).not.toContain(secret)
}

describe("claude mode resolution", () => {
  test("an explicit subscription mode is honored", () => {
    const result = resolveClaudeMode({ config: { authMode: "subscription" }, interactive: false, env: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected subscription")
    expect(result.selection.mode).toBe("subscription")
    expect(result.selection.credentialRef).toBeUndefined()
  })

  test("an explicit api-key mode requires a credentialRef", () => {
    const result = resolveClaudeMode({ config: { authMode: "api-key" }, interactive: false, env: {} })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a refusal")
    expect(result.error).toContain("credentialRef")
  })

  test("an explicit api-key mode with a credentialRef resolves and hides the secret", () => {
    const result = resolveClaudeMode({
      config: { authMode: "api-key", credentialRef: "MY_CLAUDE_API_KEY" },
      interactive: false,
      env: { MY_CLAUDE_API_KEY: secret },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected api-key")
    expect(result.selection).toEqual({ mode: "api-key", credentialRef: "MY_CLAUDE_API_KEY" })
    expect(JSON.stringify(result.selection)).not.toContain(secret)
  })

  test("subscription mode forbids a credentialRef", () => {
    const result = resolveClaudeMode({
      config: { authMode: "subscription", credentialRef: "MY_CLAUDE_API_KEY" },
      interactive: false,
      env: {},
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a refusal")
    expect(result.error).toContain("Subscription mode must not carry a credential reference")
  })

  test("a bare credentialRef without an authMode is ambiguous, not implicit API consent", () => {
    assertNoApiConsent(
      resolveClaudeMode({
        config: { credentialRef: "MY_CLAUDE_API_KEY" },
        interactive: true,
        env: { MY_CLAUDE_API_KEY: secret },
      }),
    )
  })

  test("a missing mode with a verifiable subscription login is allowed (interactive and noninteractive)", () => {
    for (const interactive of [true, false]) {
      const result = resolveClaudeMode({
        config: {},
        interactive,
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-login-token" },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected subscription inference")
      expect(result.selection).toEqual({ mode: "subscription" })
    }
  })

  test("a missing mode that cannot be verified asks for an explicit choice without API consent", () => {
    assertNoApiConsent(resolveClaudeMode({ config: {}, interactive: true, env: {} }))
    assertNoApiConsent(resolveClaudeMode({ config: undefined, interactive: false, env: {} }))
  })

  test("a noninteractive launch with an ambiguous billing source is refused", () => {
    const result = resolveClaudeMode({ config: {}, interactive: false, env: { ANTHROPIC_API_KEY: secret } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a refusal")
    expect(result.error).toContain("ambiguous")
    expect(result.error).toContain("noninteractive")
    expect(result.error).not.toContain(secret)
    expect(result.error.toLowerCase()).toMatch(/will not|never/)
  })

  test("an interactive launch with an ambiguous billing source is refused for review", () => {
    const result = resolveClaudeMode({ config: {}, interactive: true, env: { ANTHROPIC_AUTH_TOKEN: secret } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a refusal")
    expect(result.error).toContain("launch review")
    expect(result.error).toContain("ANTHROPIC_AUTH_TOKEN")
    expect(result.error).not.toContain(secret)
  })

  test("a subscription login alongside an ambient API key is ambiguous and refused", () => {
    const result = resolveClaudeMode({
      config: {},
      interactive: false,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-login-token", ANTHROPIC_API_KEY: secret },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a refusal")
    expect(result.error).toContain("ambiguous")
  })

  test("imported environment sets are the recognized legacy evidence", () => {
    expect([...subscriptionLoginEnvVars]).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"])
    expect([...ambiguousBillingEnvVars]).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])
  })
})
