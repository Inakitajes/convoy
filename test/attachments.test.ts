import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { fileParts } from "../src/attachments"

describe("fileParts", () => {
  test("normalizes text attachments to text/plain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-attachments-"))
    try {
      await writeFile(join(dir, "prd.md"), "# PRD")
      await writeFile(join(dir, "phase.diff"), "diff --git a/a b/a")
      await writeFile(join(dir, "data.json"), "{}")
      await writeFile(join(dir, "main.ts"), "export {}")
      await mkdir(join(dir, "lib"))

      const parts = await fileParts(["prd.md", "phase.diff", "data.json", "main.ts", "lib"], dir, "error")

      expect(parts.map((part) => [part.filename, part.mime])).toEqual([
        ["prd.md", "text/plain"],
        ["phase.diff", "text/plain"],
        ["data.json", "text/plain"],
        ["main.ts", "text/plain"],
        ["lib", "application/x-directory"],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
