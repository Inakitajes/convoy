import { describe, expect, test } from "bun:test"

import {
  assertSupportedOpencodeRuntime,
  opencodeBinEnv,
  parseOpencodeVersion,
  resolveOpencodeBin,
  supportedOpencodeMajor,
  testedOpencodeVersion,
  UnsupportedOpencodeRuntimeError,
} from "../src/runners/opencode/runtime"

// Every probe is injected: these tests exercise the gate's logic only and never
// spawn a real OpenCode process.

describe("opencode runtime version gate", () => {
  test("accepts a 2.x version and returns major 2", async () => {
    const info = await assertSupportedOpencodeRuntime({
      resolveBin: () => "/usr/local/bin/opencode",
      run: async () => ({ stdout: "opencode v2.0.28\n", exitCode: 0 }),
    })

    expect(info).toEqual({ version: "2.0.28", major: 2, executable: "/usr/local/bin/opencode" })
  })

  test("accepts a non-zero patch 2.x version", async () => {
    const info = await assertSupportedOpencodeRuntime({
      resolveBin: () => "opencode",
      run: async () => ({ stdout: "2.4.7", exitCode: 0 }),
    })

    expect(info.major).toBe(2)
    expect(info.version).toBe("2.4.7")
  })

  test("rejects a 1.x version with the detected version", async () => {
    const failure = assertSupportedOpencodeRuntime({
      resolveBin: () => "opencode",
      run: async () => ({ stdout: "opencode v1.9.4\n", exitCode: 0 }),
    })

    await expect(failure).rejects.toBeInstanceOf(UnsupportedOpencodeRuntimeError)
    await failure.catch((error: UnsupportedOpencodeRuntimeError) => {
      expect(error.detected).toBe("1.9.4")
      expect(error.message).toContain("1.9.4")
      expect(error.message).toContain(`V${supportedOpencodeMajor}.x`)
    })
  })

  test("rejects a missing binary when run throws", async () => {
    const failure = assertSupportedOpencodeRuntime({
      resolveBin: () => "/nowhere/opencode",
      run: async () => {
        throw new Error("spawn /nowhere/opencode ENOENT")
      },
    })

    await expect(failure).rejects.toBeInstanceOf(UnsupportedOpencodeRuntimeError)
    await failure.catch((error: UnsupportedOpencodeRuntimeError) => {
      expect(error.message).toContain("ENOENT")
    })
  })

  test("rejects unparseable output", async () => {
    const failure = assertSupportedOpencodeRuntime({
      resolveBin: () => "opencode",
      run: async () => ({ stdout: "opencode (development build)\n", exitCode: 0 }),
    })

    await expect(failure).rejects.toBeInstanceOf(UnsupportedOpencodeRuntimeError)
    await failure.catch((error: UnsupportedOpencodeRuntimeError) => {
      expect(error.message).toContain(opencodeBinEnv)
    })
  })

  test("skip: true short-circuits without calling run", async () => {
    let ran = false
    const info = await assertSupportedOpencodeRuntime({
      resolveBin: () => "opencode",
      skip: true,
      run: async () => {
        ran = true
        return { stdout: "1.0.0", exitCode: 0 }
      },
    })

    expect(ran).toBe(false)
    expect(info).toEqual({ version: testedOpencodeVersion, major: supportedOpencodeMajor, executable: "opencode" })
  })
})

describe("parseOpencodeVersion", () => {
  test("extracts a semver token from decorated output", () => {
    expect(parseOpencodeVersion("opencode v2.0.28")).toBe("2.0.28")
  })

  test("returns undefined when no version is present", () => {
    expect(parseOpencodeVersion("opencode (development build)")).toBeUndefined()
  })
})

describe("resolveOpencodeBin", () => {
  test("honours a non-empty env override", () => {
    expect(resolveOpencodeBin({ [opencodeBinEnv]: " /opt/opencode/bin/opencode " })).toBe("/opt/opencode/bin/opencode")
  })

  test("defaults to opencode when unset or blank", () => {
    expect(resolveOpencodeBin({})).toBe("opencode")
    expect(resolveOpencodeBin({ [opencodeBinEnv]: "   " })).toBe("opencode")
  })
})
