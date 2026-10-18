import { homedir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { opencodeConfig } from "../src/agents"
import { runDirAccessConfig } from "../src/opencode"
import { commandEffect, type CommandEffect } from "../src/runners/policy"
import { convoySecretsDir, runPrivateDir } from "../src/workspace"

// A run's private dir holds the owned server's password and the plugin
// packages that embed the bridge tokens. With either, an agent could drive
// `permission.reply` or the bridges past Convoy's gate, so no agent-facing
// rule may grant it, whatever spelling the command uses.
const runDir = join(homedir(), ".convoy", "runs", "20261018-120000-abcd")
const privateDir = runPrivateDir(runDir)

function bashRules(readOnlyVerify: boolean): Record<string, CommandEffect> {
  const config = opencodeConfig(runDir, "/tmp/convoy-target", [
    readOnlyVerify
      ? { name: "implementer__verify", description: "verifies", readOnly: true, verify: true, builtIn: true }
      : { name: "implementer", description: "implements", builtIn: true },
  ])
  const agent = Object.values(config.agent ?? {})[0] as { permission: { bash: Record<string, CommandEffect> } }
  return agent.permission.bash
}

describe("run-private secrets stay out of agent shells", () => {
  const reads = [
    `cat ${join(privateDir, "server-auth.json")}`,
    `head -c 200 ${join(privateDir, "plugins", "convoy-report", "index.ts")}`,
    "cat ~/.convoy/runs/20261018-120000-abcd/private/server-auth.json",
    "cat $HOME/.convoy/runs/20261018-120000-abcd/private/server-auth.json",
    `cat ${runDir}/reports/../private/server-auth.json`,
    `grep -r token ${runDir}`,
    `grep -rn password ${join(homedir(), ".convoy")}`,
    "rg token ~/.convoy",
    "grep -r password ~",
  ]

  for (const verify of [false, true]) {
    for (const command of reads) {
      test(`${verify ? "verify" : "write"} agents cannot run: ${command}`, () => {
        expect(commandEffect(command, bashRules(verify))).toBe("deny")
      })
    }
  }

  test("Convoy's own secrets dir (the authoring password) is denied too", () => {
    const rules = bashRules(false)
    expect(commandEffect(`cat ${join(convoySecretsDir(), "authoring", "abc.json")}`, rules)).toBe("deny")
    expect(commandEffect(`grep -r password ${convoySecretsDir()}`, rules)).toBe("deny")
  })

  test("ordinary allowlisted reads keep running silently", () => {
    const rules = bashRules(false)
    expect(commandEffect("cat src/index.ts", rules)).toBe("allow")
    expect(commandEffect(`cat ${runDir}/reports/plan.md`, rules)).toBe("allow")
    expect(commandEffect("grep -rn foo src", rules)).toBe("allow")
  })

  test("iterate windows deny the private dir like run agents do", () => {
    const permission = (JSON.parse(runDirAccessConfig(runDir)) as {
      permission: Record<string, Record<string, string>>
    }).permission
    for (const key of ["external_directory", "read"] as const) {
      const entries = Object.entries(permission[key]!)
      // Last match wins: the private deny must follow the run-dir allow.
      expect(entries.at(-1)).toEqual([join(privateDir, "**"), "deny"])
      expect(permission[key]![join(runDir, "**")]).toBe("allow")
    }
  })
})
