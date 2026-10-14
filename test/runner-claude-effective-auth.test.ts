import { describe, expect, test } from "bun:test"

import { resolveClaudeAuth } from "../src/runners/claude/auth"
import {
  ambientApiKeyVars,
  applyAuthOverlay,
  apiKeyAuthMethods,
  conflictingAuthMethods,
  subscriptionAuthMethods,
  validateEffectiveAuth,
  type EffectiveAuthProbe,
  type EffectiveAuthResult,
} from "../src/runners/claude/effective-auth"

const secret = "sk-ant-effective-secret-value-0123456789"
const ambientToken = "oauth-ambient-secret-value"

function probeReturning(authMethod: string): EffectiveAuthProbe {
  return async () => ({ authMethod })
}

/** Every string the result can carry, to assert no secret leaks. */
function stringsOf(result: EffectiveAuthResult): string[] {
  return result.ok ? [result.effective.source, result.effective.description] : [result.error]
}

describe("claude effective authentication", () => {
  test("subscription accepts every subscription auth method", async () => {
    for (const method of subscriptionAuthMethods) {
      const result = await validateEffectiveAuth({
        resolution: { mode: "subscription", set: {}, unset: [], description: "Claude subscription review." },
        probe: probeReturning(method),
        env: {},
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected subscription to validate")
      expect(result.effective.mode).toBe("subscription")
      expect(result.effective.source).toBe("claude-cli-login")
      expect(result.effective.description).toContain(method)
    }
  })

  test("subscription rejects an ambient API key that survived isolation", async () => {
    const result = await validateEffectiveAuth({
      // unset is empty: the overlay failed to remove the ambient key.
      resolution: { mode: "subscription", set: {}, unset: [], description: "Claude subscription review." },
      // Even a subscription-reported probe cannot rescue a leaked key.
      probe: probeReturning("claude.ai"),
      env: { ANTHROPIC_API_KEY: secret },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a conflict")
    expect(result.error).toContain("ANTHROPIC_API_KEY")
    expect(result.error).toContain("isolation is incomplete")
    expect(result.error).not.toContain(secret)
  })

  test("subscription rejects an ambient ANTHROPIC_AUTH_TOKEN that survived isolation", async () => {
    const result = await validateEffectiveAuth({
      resolution: { mode: "subscription", set: {}, unset: [], description: "Claude subscription review." },
      probe: probeReturning("oauth_token"),
      env: { ANTHROPIC_AUTH_TOKEN: ambientToken },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a conflict")
    expect(result.error).toContain("ANTHROPIC_AUTH_TOKEN")
    expect(result.error).not.toContain(ambientToken)
  })

  test("subscription accepts a correctly isolated ambient key and probes without it", async () => {
    const resolution = resolveClaudeAuth({ selection: { mode: "subscription" }, env: { ANTHROPIC_API_KEY: secret } })
    let probedEnv: NodeJS.ProcessEnv | undefined
    const result = await validateEffectiveAuth({
      resolution,
      probe: async (env) => {
        probedEnv = env
        return { authMethod: "claude.ai" }
      },
      env: { ANTHROPIC_API_KEY: secret },
    })
    expect(result.ok).toBe(true)
    // The probe sees the child environment after isolation, not the parent.
    expect(probedEnv?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(JSON.stringify(probedEnv ?? {})).not.toContain(secret)
  })

  test("subscription rejects a probe reporting a conflicting billing source", async () => {
    for (const method of conflictingAuthMethods) {
      const result = await validateEffectiveAuth({
        resolution: { mode: "subscription", set: {}, unset: [], description: "Claude subscription review." },
        probe: probeReturning(method),
        env: {},
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected a conflict")
      expect(result.error).toContain(method)
    }
  })

  test("subscription rejects an unknown or empty probe method", async () => {
    for (const method of ["mystery_provider", ""]) {
      const result = await validateEffectiveAuth({
        resolution: { mode: "subscription", set: {}, unset: [], description: "Claude subscription review." },
        probe: probeReturning(method),
        env: {},
      })
      expect(result.ok).toBe(false)
    }
  })

  test("subscription fails closed when the probe throws, without leaking the error secret", async () => {
    const result = await validateEffectiveAuth({
      resolution: { mode: "subscription", set: {}, unset: [], description: "Claude subscription review." },
      probe: async () => {
        throw new Error(`auth status failed with ${secret}`)
      },
      env: {},
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a probe failure")
    expect(result.error).toContain("could not be verified")
    expect(result.error).not.toContain(secret)
  })

  test("api-key accepts a probe reporting api_key and hides the key", async () => {
    const resolution = resolveClaudeAuth({
      selection: { mode: "api-key", credentialRef: "MY_CLAUDE_API_KEY" },
      env: { MY_CLAUDE_API_KEY: secret },
    })
    const result = await validateEffectiveAuth({
      resolution,
      probe: probeReturning("api_key"),
      env: { MY_CLAUDE_API_KEY: secret },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected api-key to validate")
    expect(result.effective.mode).toBe("api-key")
    expect(result.effective.source).toBe("external-api-key")
    expect(result.effective.description).toContain("MY_CLAUDE_API_KEY")
    expect(result.effective.description).not.toContain(secret)
  })

  test("api-key rejects any probe other than api_key", async () => {
    const resolution = resolveClaudeAuth({
      selection: { mode: "api-key", credentialRef: "MY_CLAUDE_API_KEY" },
      env: { MY_CLAUDE_API_KEY: secret },
    })
    for (const method of ["claude.ai", "oauth_token", "api_key_helper", "third_party", "mystery", ""]) {
      const result = await validateEffectiveAuth({ resolution, probe: probeReturning(method), env: {} })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected a mismatch")
      expect(result.error).not.toContain(secret)
    }
  })

  test("api-key fails closed when the probe throws, without leaking the key", async () => {
    const resolution = resolveClaudeAuth({
      selection: { mode: "api-key", credentialRef: "MY_CLAUDE_API_KEY" },
      env: { MY_CLAUDE_API_KEY: secret },
    })
    const result = await validateEffectiveAuth({
      resolution,
      probe: async () => {
        throw new Error(`probe used ${secret}`)
      },
      env: { MY_CLAUDE_API_KEY: secret },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a probe failure")
    expect(result.error).not.toContain(secret)
  })

  test("no result description or error ever contains a secret value", async () => {
    const resolutions = [
      { mode: "subscription" as const, set: {}, unset: [], description: "Claude subscription review." },
      resolveClaudeAuth({ selection: { mode: "api-key", credentialRef: "MY_CLAUDE_API_KEY" }, env: { MY_CLAUDE_API_KEY: secret } }),
    ]
    const probes = [probeReturning("claude.ai"), probeReturning("oauth_token"), probeReturning("api_key"), probeReturning("api_key_helper"), probeReturning("third_party")]
    const envs: NodeJS.ProcessEnv[] = [{}, { ANTHROPIC_API_KEY: secret }, { MY_CLAUDE_API_KEY: secret }]

    for (const resolution of resolutions) {
      for (const probe of probes) {
        for (const env of envs) {
          const result = await validateEffectiveAuth({ resolution, probe, env })
          for (const text of stringsOf(result)) {
            expect(text).not.toContain(secret)
            expect(text).not.toContain(ambientToken)
          }
        }
      }
    }
  })

  test("applyAuthOverlay applies set and unset and equals the child environment", () => {
    const child = applyAuthOverlay(
      { ANTHROPIC_API_KEY: secret, KEEP: "yes" },
      { mode: "subscription", set: { EXTRA: "1" }, unset: ["ANTHROPIC_API_KEY"], description: "d" },
    )
    expect(child.ANTHROPIC_API_KEY).toBeUndefined()
    expect(child.KEEP).toBe("yes")
    expect(child.EXTRA).toBe("1")
  })

  test("exports the recognized method and ambient-variable sets", () => {
    expect([...subscriptionAuthMethods]).toEqual(["claude.ai", "oauth_token"])
    expect([...apiKeyAuthMethods]).toEqual(["api_key"])
    expect([...conflictingAuthMethods]).toEqual(["api_key", "api_key_helper", "third_party"])
    expect([...ambientApiKeyVars]).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])
  })
})
