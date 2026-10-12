import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  assertSupportedOpencodeRuntime,
  opencodeBinEnv,
  parseOpencodeVersion,
  resolveOpencodeBin,
  supportedOpencodeMajor,
  testedOpencodeVersion,
  UnsupportedOpencodeRuntimeError,
} from "../src/opencode-runtime"

describe("parseOpencodeVersion", () => {
  test("extracts a bare, v-prefixed or embedded semantic version", () => {
    expect(parseOpencodeVersion("2.0.26")).toBe("2.0.26")
    expect(parseOpencodeVersion("v2.0.26")).toBe("2.0.26")
    expect(parseOpencodeVersion("opencode v2.0.26\n")).toBe("2.0.26")
  })

  test("returns undefined when no version is present", () => {
    expect(parseOpencodeVersion("not a version")).toBeUndefined()
    expect(parseOpencodeVersion("")).toBeUndefined()
  })
})

describe("resolveOpencodeBin", () => {
  test("defaults to opencode on PATH", () => {
    expect(resolveOpencodeBin({} as NodeJS.ProcessEnv)).toBe("opencode")
  })

  test("honors the explicit override, ignoring blank values", () => {
    expect(resolveOpencodeBin({ [opencodeBinEnv]: "/opt/opencode" } as NodeJS.ProcessEnv)).toBe("/opt/opencode")
    expect(resolveOpencodeBin({ [opencodeBinEnv]: "   " } as NodeJS.ProcessEnv)).toBe("opencode")
  })
})

describe("assertSupportedOpencodeRuntime", () => {
  test("accepts a supported V2 runtime", async () => {
    const info = await assertSupportedOpencodeRuntime({ run: async () => ({ stdout: "2.0.26", exitCode: 0 }) })
    expect(info.version).toBe("2.0.26")
    expect(info.major).toBe(supportedOpencodeMajor)
  })

  test("rejects a V1 runtime with an actionable, non-destructive error", async () => {
    const error = await assertSupportedOpencodeRuntime({ run: async () => ({ stdout: "1.18.4", exitCode: 0 }) }).then(
      () => undefined,
      (reason: unknown) => reason as UnsupportedOpencodeRuntimeError,
    )
    expect(error).toBeInstanceOf(UnsupportedOpencodeRuntimeError)
    expect(error?.detected).toBe("1.18.4")
    expect(error?.message).toContain("1.18.4")
    expect(error?.message).toContain(`V${supportedOpencodeMajor}.x`)
    expect(error?.message).toContain("never installs")
  })

  test("rejects a missing runtime without mutating the installation", async () => {
    const error = await assertSupportedOpencodeRuntime({
      run: async () => {
        throw new Error("ENOENT")
      },
    }).then(
      () => undefined,
      (reason: unknown) => reason as UnsupportedOpencodeRuntimeError,
    )
    expect(error).toBeInstanceOf(UnsupportedOpencodeRuntimeError)
    expect(error?.message).toContain("not found")
    expect(error?.message).toContain("never installs")
  })

  test("rejects an unparseable version output", async () => {
    const error = await assertSupportedOpencodeRuntime({ run: async () => ({ stdout: "who knows", exitCode: 0 }) }).then(
      () => undefined,
      (reason: unknown) => reason as UnsupportedOpencodeRuntimeError,
    )
    expect(error).toBeInstanceOf(UnsupportedOpencodeRuntimeError)
    expect(error?.message).toContain("Could not determine the OpenCode version")
  })

  // A wedged binary must not hang every run boot: the probe is bounded and
  // the hung child is killed.
  test("rejects a runtime whose version probe hangs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-runtime-probe-"))
    const bin = join(dir, "opencode")
    await writeFile(bin, "#!/bin/sh\nsleep 30\n")
    await chmod(bin, 0o755)
    try {
      const started = Date.now()
      const probe = assertSupportedOpencodeRuntime({ resolveBin: () => bin, probeTimeoutMs: 200 })
      await expect(probe).rejects.toBeInstanceOf(UnsupportedOpencodeRuntimeError)
      await expect(probe).rejects.toThrow(/timed out/)
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("the skip seam bypasses probing entirely", async () => {
    let probed = false
    const info = await assertSupportedOpencodeRuntime({
      skip: true,
      run: async () => {
        probed = true
        return { stdout: "1.0.0", exitCode: 0 }
      },
    })
    expect(probed).toBe(false)
    expect(info.version).toBe(testedOpencodeVersion)
  })
})
