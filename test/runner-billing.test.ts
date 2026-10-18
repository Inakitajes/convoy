import { describe, expect, test } from "bun:test"

import { resolveBilling } from "../src/runners/billing"

describe("billing resolution", () => {
  test("API-key mode always uses the account policy and requires consent", () => {
    const withKey = resolveBilling({ mode: "api-key", credentialRef: "ANTHROPIC_API_KEY" })
    expect(withKey.mode).toBe("api-key")
    expect(withKey.policy).toBe("account-policy")
    expect(withKey.mayIncurCharges).toBe(true)
    expect(withKey.requiresConsent).toBe(true)
    expect(withKey.includedOnlyVerifiable).toBe(false)

    // An API key response is independent of any included-only capability claim.
    const withKeyViaSubscriptionCap = resolveBilling({ mode: "api-key" }, { canVerifyIncludedOnly: true })
    expect(withKeyViaSubscriptionCap.policy).toBe("account-policy")
    expect(withKeyViaSubscriptionCap.requiresConsent).toBe(true)
  })

  test("subscription with account-policy may incur charges and requires consent", () => {
    const resolved = resolveBilling({ mode: "subscription", billingPolicy: "account-policy" })
    expect(resolved.mode).toBe("subscription")
    expect(resolved.policy).toBe("account-policy")
    expect(resolved.mayIncurCharges).toBe(true)
    expect(resolved.requiresConsent).toBe(true)
    expect(resolved.includedOnlyVerifiable).toBe(false)
  })

  test("subscription included-only is free only when verification exists", () => {
    const verified = resolveBilling(
      { mode: "subscription", billingPolicy: "included-only" },
      { canVerifyIncludedOnly: true },
    )
    expect(verified.mode).toBe("subscription")
    expect(verified.policy).toBe("included-only")
    expect(verified.mayIncurCharges).toBe(false)
    expect(verified.requiresConsent).toBe(false)
    expect(verified.includedOnlyVerifiable).toBe(true)
  })

  test("subscription included-only without verification is not a no-charge guarantee", () => {
    const unverified = resolveBilling({ mode: "subscription", billingPolicy: "included-only" })
    expect(unverified.policy).toBe("included-only")
    expect(unverified.mayIncurCharges).toBe(true)
    expect(unverified.requiresConsent).toBe(true)
    expect(unverified.includedOnlyVerifiable).toBe(false)
    expect(unverified.reason).toContain("login alone is not a no-charge guarantee")

    const explicitlyFalse = resolveBilling(
      { mode: "subscription", billingPolicy: "included-only" },
      { canVerifyIncludedOnly: false },
    )
    expect(explicitlyFalse.mayIncurCharges).toBe(true)
    expect(explicitlyFalse.includedOnlyVerifiable).toBe(false)
  })

  test("subscription without a billing policy conservatively assumes account-policy", () => {
    const resolved = resolveBilling({ mode: "subscription" })
    expect(resolved.policy).toBe("account-policy")
    expect(resolved.mayIncurCharges).toBe(true)
    expect(resolved.requiresConsent).toBe(true)
    expect(resolved.includedOnlyVerifiable).toBe(false)
  })
})
