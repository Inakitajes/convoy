import { describe, expect, test } from "bun:test"

import type { AuthenticationSelection } from "../src/runners/contracts"
import { ClaudeAuthError, claudeCredentialEnvVars, resolveClaudeAuth } from "../src/runners/claude/auth"

describe("claude auth resolution", () => {
  test("subscription unsets ambient API-key vars and leaks no secret", () => {
    const apiKey = "sk-ant-ambient-secret-value"
    const authToken = "oauth-ambient-secret-value"

    const resolved = resolveClaudeAuth({
      selection: { mode: "subscription" },
      env: { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: authToken },
    })

    expect(resolved.mode).toBe("subscription")
    expect(resolved.unset).toContain("ANTHROPIC_API_KEY")
    expect(resolved.unset).toContain("ANTHROPIC_AUTH_TOKEN")
    // Sets nothing secret for the operator's login.
    expect(resolved.set).toEqual({})
    expect(resolved.description).not.toContain(apiKey)
    expect(resolved.description).not.toContain(authToken)
    expect(resolved.description.toLowerCase()).toContain("subscription")
    // A subscription OAuth token is a valid subscription login, not an override.
    expect(resolved.unset).not.toContain("CLAUDE_CODE_OAUTH_TOKEN")
  })

  test("subscription with a credentialRef is a configuration error", () => {
    expect(() =>
      resolveClaudeAuth({ selection: { mode: "subscription", credentialRef: "ANTHROPIC_API_KEY" } }),
    ).toThrow(ClaudeAuthError)
  })

  test("api-key resolves the key, isolates ambient OAuth, and hides the secret", () => {
    const secret = "sk-ant-explicit-api-key-value"

    const resolved = resolveClaudeAuth({
      selection: { mode: "api-key", credentialRef: "MY_CLAUDE_API_KEY" },
      env: {
        MY_CLAUDE_API_KEY: secret,
        ANTHROPIC_AUTH_TOKEN: "ambient-auth-token",
        CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth-token",
      },
    })

    expect(resolved.mode).toBe("api-key")
    expect(resolved.set.ANTHROPIC_API_KEY).toBe(secret)
    expect(resolved.unset).toContain("ANTHROPIC_AUTH_TOKEN")
    expect(resolved.unset).toContain("CLAUDE_CODE_OAUTH_TOKEN")
    expect(resolved.description).not.toContain(secret)
    // The description may name the source variable, but never its value.
    expect(resolved.description).toContain("MY_CLAUDE_API_KEY")
  })

  test("api-key with a missing or empty credential variable throws", () => {
    expect(() =>
      resolveClaudeAuth({ selection: { mode: "api-key", credentialRef: "ABSENT_KEY" }, env: {} }),
    ).toThrow(ClaudeAuthError)

    expect(() =>
      resolveClaudeAuth({ selection: { mode: "api-key", credentialRef: "EMPTY_KEY" }, env: { EMPTY_KEY: "" } }),
    ).toThrow(ClaudeAuthError)

    // The actionable error names the variable without a value.
    try {
      resolveClaudeAuth({ selection: { mode: "api-key", credentialRef: "ABSENT_KEY" }, env: {} })
      throw new Error("expected resolveClaudeAuth to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeAuthError)
      expect((error as Error).message).toContain("ABSENT_KEY")
    }
  })

  test("api-key without a credentialRef throws", () => {
    expect(() =>
      resolveClaudeAuth({ selection: { mode: "api-key" }, env: { ANTHROPIC_API_KEY: "sk-ant-ignored" } }),
    ).toThrow(ClaudeAuthError)
  })

  test("an invalid billingPolicy or unknown mode throws", () => {
    expect(() =>
      resolveClaudeAuth({ selection: { mode: "subscription", billingPolicy: "free-forever" } as unknown as AuthenticationSelection }),
    ).toThrow(ClaudeAuthError)

    expect(() =>
      resolveClaudeAuth({ selection: { mode: "mystery" } as unknown as AuthenticationSelection }),
    ).toThrow(ClaudeAuthError)
  })

  test("the considered ambient credential set is exported", () => {
    expect([...claudeCredentialEnvVars]).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ])
  })
})
