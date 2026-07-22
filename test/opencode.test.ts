import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { iterateSessionShellCommand, sessionShellCommand, shellQuote } from "../src/opencode"

describe("session terminal command", () => {
  test("does not launch the session command when changing directory fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-session-command-"))
    const marker = join(root, "launched")
    const command = sessionShellCommand(`touch ${shellQuote(marker)}`, join(root, "missing"), "/usr/bin:/bin")

    try {
      expect(command).toContain(" && cd ")
      expect(command).toContain(" && touch ")

      const child = Bun.spawn(["zsh", "-c", command], { stdout: "ignore", stderr: "ignore" })
      expect(await child.exited).not.toBe(0)
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("starts a new iterate session from the target project", () => {
    const command = iterateSessionShellCommand(
      { targetDir: "/projects/my app", prompt: "Read the run reports, then wait." },
      "/usr/bin:/bin",
    )

    expect(command).toBe(
      "export PATH='/usr/bin:/bin':$PATH && cd '/projects/my app' && 'opencode' '/projects/my app' '--prompt' 'Read the run reports, then wait.'",
    )
  })
})
