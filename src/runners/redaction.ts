/**
 * Secret redaction (change `runner-parity-opencode-v2`, task 3.5).
 *
 * Two layers, so both known runtime secrets and recognizable credential shapes
 * stay out of child diagnostics, logs, and error text:
 *
 *  1. a registry of exact secret values (bridge tokens, a managed server's
 *     per-boot password) registered when they are created or parsed, and
 *  2. conservative pattern rules for credential shapes that appear in arbitrary
 *     output (Authorization headers, `user:pass@host` URLs, common key prefixes).
 *
 * Redaction is best-effort and additive; it never throws.
 */

export const redactionPlaceholder = "[redacted]"

/** Exact secret values to remove wherever they appear. */
const registered = new Set<string>()

/** Minimum length so a short, coincidental registered value cannot mangle text. */
const minRegisteredLength = 8

export function registerSecret(value: string): void {
  if (value.length >= minRegisteredLength) registered.add(value)
}

/** Test seam: forget every registered secret. */
export function resetRegisteredSecrets(): void {
  registered.clear()
}

const patterns: readonly { re: RegExp; replace: (match: RegExpMatchArray) => string }[] = [
  // OpenCode V2 prints `server password <x>` on boot.
  { re: /(server password\s+)\S+/gi, replace: (m) => `${m[1]}${redactionPlaceholder}` },
  // `Authorization: Bearer x` / `Authorization: Basic x`.
  { re: /(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi, replace: (m) => `${m[1]}${redactionPlaceholder}` },
  // A `Bearer <token>` / `Basic <token>` value anywhere.
  { re: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: (m) => `${m[1]} ${redactionPlaceholder}` },
  // URLs carrying userinfo: scheme://user:pass@host.
  { re: /(\bhttps?:\/\/)[^/@\s]+@/gi, replace: (m) => `${m[1]}${redactionPlaceholder}@` },
  // Query-string credentials.
  { re: /([?&](?:password|passwd|token|api[_-]?key|access[_-]?token)=)[^&\s]+/gi, replace: (m) => `${m[1]}${redactionPlaceholder}` },
  // `password = "..."`, `api_key: ...`, `token="..."` in config/JSON text.
  {
    re: /\b(password|passwd|api[_-]?key|apikey|access[_-]?token|secret|client[_-]?secret)("?\s*[:=]\s*"?)([^"'\s,}]{6,})/gi,
    replace: (m) => `${m[1]}${m[2]}${redactionPlaceholder}`,
  },
  // Common key prefixes.
  { re: /\b(sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g, replace: () => redactionPlaceholder },
  // `opencode:<password>` Basic userinfo in a command line or URL.
  { re: /\bopencode:[^\s@/]{8,}/g, replace: (m) => `opencode:${redactionPlaceholder}` },
]

/** Removes registered secrets and recognizable credential shapes from `text`. */
export function redactSecrets(text: string): string {
  if (text.length === 0) return text
  let result = text
  for (const secret of registered) {
    if (secret.length >= minRegisteredLength && result.includes(secret)) {
      result = result.split(secret).join(redactionPlaceholder)
    }
  }
  for (const { re, replace } of patterns) {
    result = result.replace(re, (...args) => replace(args as unknown as RegExpMatchArray))
  }
  return result
}
