import { describe, expect, test } from "bun:test"

import { toolPermissions } from "../src/opencode-client"

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

/** V2's evaluation: the last rule whose action and resource match wins. */
function effectOf(rules: readonly Rule[], action: string): Rule["effect"] | undefined {
  const glob = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value)
  let effect: Rule["effect"] | undefined
  for (const rule of rules) if (glob(rule.action, action) && glob(rule.resource, "x")) effect = rule.effect
  return effect
}

// Helper sessions (commit writer, branch namer) run a model on repository
// content. Naming the tools to deny leaves every other one — `task`
// subagents, MCP and plugin tools, `external_directory` — to the agent's
// defaults, so a session's ruleset starts from deny-all and re-allows only
// the tools the helper is meant to have.
describe("helper session tool permissions", () => {
  const writer = { read: true, list: true, glob: true, grep: true, webfetch: false, write: false, edit: false, bash: false, todoread: false, todowrite: false }

  test("tools the helper was not given are denied, named or not", () => {
    const rules = toolPermissions(writer)
    for (const action of ["task", "subagent", "convoy_write_report", "mcp_github_create_issue", "external_directory", "write", "edit", "bash", "shell", "webfetch"]) {
      expect(effectOf(rules, action)).toBe("deny")
    }
  })

  test("the tools it was given stay allowed", () => {
    const rules = toolPermissions(writer)
    for (const action of ["read", "list", "glob", "grep"]) expect(effectOf(rules, action)).toBe("allow")
  })

  test("a tool-less helper denies everything", () => {
    expect(toolPermissions({ "*": false })).toEqual([{ action: "*", resource: "*", effect: "deny" }])
  })
})
