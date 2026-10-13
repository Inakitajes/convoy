import { beforeEach, describe, expect, test } from "bun:test"

import { redactSecrets, registerSecret, resetRegisteredSecrets, redactionPlaceholder } from "../src/runners/redaction"

const R = redactionPlaceholder

beforeEach(() => resetRegisteredSecrets())

describe("secret redaction", () => {
  test("removes a registered exact secret wherever it appears", () => {
    registerSecret("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
    const text = `bridge token a1b2c3d4-e5f6-7890-abcd-ef1234567890 in a line`
    expect(redactSecrets(text)).toBe(`bridge token ${R} in a line`)
  })

  test("ignores a too-short registered value", () => {
    registerSecret("short")
    expect(redactSecrets("a short value")).toBe("a short value")
  })

  test("redacts the OpenCode v2 boot password line", () => {
    expect(redactSecrets("server listening on http://127.0.0.1:4096\nserver password s3cr3tTokenValue")).toBe(
      `server listening on http://127.0.0.1:4096\nserver password ${R}`,
    )
  })

  test("redacts authorization headers", () => {
    expect(redactSecrets("authorization: Bearer abc.def.ghijklmno")).toBe(`authorization: Bearer ${R}`)
    expect(redactSecrets("Authorization: Basic b3BlbmNvZGU6c2VjcmV0")).toBe(`Authorization: Basic ${R}`)
  })

  test("redacts credentials in URLs and query strings", () => {
    expect(redactSecrets("https://opencode:hunter2hunter2@example.test/api")).toBe(`https://${R}@example.test/api`)
    expect(redactSecrets("http://host/x?token=abcdef123456&y=1")).toBe(`http://host/x?token=${R}&y=1`)
  })

  test("redacts config key/value credential shapes", () => {
    expect(redactSecrets(`password = "hunter2hunter2"`)).toBe(`password = "${R}"`)
    expect(redactSecrets(`"api_key":"sk-abcdefghijklmnop"`)).toBe(`"api_key":"${R}"`)
  })

  test("redacts common key prefixes", () => {
    expect(redactSecrets("key sk-abcdefghijklmnopqrst")).toBe(`key ${R}`)
    expect(redactSecrets("key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toBe(`key ${R}`)
    expect(redactSecrets("key AKIAIOSFODNN7EXAMPLE")).toBe(`key ${R}`)
  })

  test("redacts opencode basic userinfo", () => {
    expect(redactSecrets("opencode:supersecretvalue")).toBe(`opencode:${R}`)
  })

  test("leaves ordinary text untouched", () => {
    expect(redactSecrets("compiled 12 files and ran 340 tests")).toBe("compiled 12 files and ran 340 tests")
  })
})
