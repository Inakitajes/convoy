/**
 * Billing resolution (change `runner-parity-opencode-v2`, tasks 3.7 and 10.6).
 *
 * Authentication and billing are independent (design D3): a Claude subscription
 * login proves who is authenticated, not that execution is free. This module
 * turns a selected authentication plus the runner's ability to *verify* an
 * included-only restriction into a single reviewed decision, so executors,
 * helpers, advisors, resumed/background requests, and authoring routes can all
 * inherit one explicit policy instead of guessing from auth status.
 *
 * `included-only` is advertised as no-charge only when a supported control can
 * verify and enforce it for every applicable call. Otherwise login alone is not
 * a no-charge guarantee, so the resolution demands explicit account-policy
 * consent rather than implying free usage or silently switching to an API key.
 */

import type { AuthenticationMode, AuthenticationSelection, BillingPolicy } from "./contracts"

export type BillingResolution = {
  mode: AuthenticationMode
  policy: BillingPolicy
  /** True when the account may be charged usage credits or paid features. */
  mayIncurCharges: boolean
  /** True when the operator must explicitly accept the account billing policy. */
  requiresConsent: boolean
  /** True only when included-only was verified and enforceable, not assumed. */
  includedOnlyVerifiable: boolean
  reason: string
}

/**
 * Resolves the effective billing policy for one authentication selection.
 * `capabilities.canVerifyIncludedOnly` is the adapter's assertion that an
 * included-only restriction can actually be enforced; it is never inferred from
 * the authentication mode alone.
 */
export function resolveBilling(
  auth: AuthenticationSelection,
  capabilities: { canVerifyIncludedOnly?: boolean } = {},
): BillingResolution {
  if (auth.mode === "api-key") {
    return {
      mode: "api-key",
      policy: "account-policy",
      mayIncurCharges: true,
      requiresConsent: true,
      includedOnlyVerifiable: false,
      reason: "API-key execution is billed to the account and requires explicit consent",
    }
  }

  if (auth.billingPolicy === "account-policy") {
    return {
      mode: "subscription",
      policy: "account-policy",
      mayIncurCharges: true,
      requiresConsent: true,
      includedOnlyVerifiable: false,
      reason: "account policy acknowledges subscription usage credits or paid features may incur charges",
    }
  }

  if (auth.billingPolicy === undefined) {
    return {
      mode: "subscription",
      policy: "account-policy",
      mayIncurCharges: true,
      requiresConsent: true,
      includedOnlyVerifiable: false,
      reason: "subscription has no billing policy; conservatively treating it as account-policy",
    }
  }

  // subscription + included-only
  if (capabilities.canVerifyIncludedOnly) {
    return {
      mode: "subscription",
      policy: "included-only",
      mayIncurCharges: false,
      requiresConsent: false,
      includedOnlyVerifiable: true,
      reason: "included-only is verified and enforceable for this runner",
    }
  }

  return {
    mode: "subscription",
    policy: "included-only",
    mayIncurCharges: true,
    requiresConsent: true,
    includedOnlyVerifiable: false,
    reason: "login alone is not a no-charge guarantee; included-only cannot be verified",
  }
}
