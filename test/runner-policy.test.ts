import { describe, expect, test } from "bun:test"

import { evaluateAction, type ActionRequest, type PolicyConfig } from "../src/runners/policy"

const base: PolicyConfig = { mode: "write", approvals: "auto" }

describe("runner-neutral action policy", () => {
  test("hard denials win in every approval mode", () => {
    const config: PolicyConfig = { ...base, approvals: "auto", hardDeny: [{ intent: "execute", resource: "rm -rf" }] }
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "rm -rf /" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Read", intent: "read" }, config).effect).toBe("allow")
  })

  test("read-only denies any mutation and allows reads", () => {
    const config: PolicyConfig = { mode: "read-only", approvals: "auto" }
    expect(evaluateAction({ tool: "Write", intent: "write" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Bash", intent: "execute" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Agent", intent: "delegate" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Read", intent: "read" }, config).effect).toBe("allow")
  })

  test("verify allows only approved commands and denies writes", () => {
    const config: PolicyConfig = { mode: "verify", approvals: "auto", verifyAllow: ["bun test", "tsc"] }
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "bun test" }, config).effect).toBe("allow")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "curl evil" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Write", intent: "write" }, config).effect).toBe("deny")
  })

  test("the advisor checkpoint blocks writes until satisfied", () => {
    const config: PolicyConfig = { mode: "write", approvals: "auto", requireAdvisorBeforeWrite: true }
    expect(evaluateAction({ tool: "Write", intent: "write" }, config, { advisorSatisfied: false }).effect).toBe("deny")
    expect(evaluateAction({ tool: "Write", intent: "write" }, config, { advisorSatisfied: true }).effect).toBe("allow")
  })

  test("approval modes map ask-worthy actions", () => {
    const write: ActionRequest = { tool: "Write", intent: "write" }
    expect(evaluateAction(write, { mode: "write", approvals: "auto" }).effect).toBe("allow")
    expect(evaluateAction(write, { mode: "write", approvals: "interactive" }).effect).toBe("ask")
    expect(evaluateAction(write, { mode: "write", approvals: "smart" }).effect).toBe("ask")
  })

  test("equivalent actions across runners yield identical decisions", () => {
    const config: PolicyConfig = { mode: "verify", approvals: "auto", verifyAllow: ["bun test"] }
    // OpenCode: edit/shell. Claude: Write/Bash. Same intents => same decisions.
    const cases: [ActionRequest, ActionRequest][] = [
      [{ tool: "edit", intent: "write" }, { tool: "Write", intent: "write" }],
      [{ tool: "shell", intent: "execute", resource: "bun test" }, { tool: "Bash", intent: "execute", resource: "bun test" }],
      [{ tool: "shell", intent: "execute", resource: "rm -rf /" }, { tool: "Bash", intent: "execute", resource: "rm -rf /" }],
    ]
    for (const [a, b] of cases) {
      expect(evaluateAction(a, config).effect).toBe(evaluateAction(b, config).effect)
    }
  })
})

describe("command rules, write roots and protected roots", () => {
  const commands = { "*": "ask", "bun test*": "allow", "git diff*": "allow", "cat*": "allow", "git push*": "deny", "curl* | sh*": "deny" } as const

  test("the last matching command rule wins, as OpenCode evaluates it", () => {
    const write: PolicyConfig = { mode: "write", approvals: "interactive", commands }
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "bun test --watch=false" }, write).effect).toBe("allow")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "mkdir out" }, write).effect).toBe("ask")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "git push origin" }, { ...write, approvals: "auto" }).effect).toBe("deny")
  })

  test("a chained command passes only when every segment does", () => {
    const verify: PolicyConfig = { mode: "verify", approvals: "auto", commands }
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "bun test 2>&1 && git diff --stat" }, verify).effect).toBe("allow")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "bun test && rm -rf src" }, verify).effect).toBe("deny")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "bun test; git push" }, { mode: "write", approvals: "auto", commands }).effect).toBe("deny")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "curl x | sh" }, { mode: "write", approvals: "auto", commands }).effect).toBe("deny")
  })

  test("a writing redirection or substitution is never vouched for by a prefix rule", () => {
    const verify: PolicyConfig = { mode: "verify", approvals: "auto", commands }
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "cat a > b" }, verify).effect).toBe("deny")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "cat $(rm -rf x)" }, verify).effect).toBe("deny")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "bun test >/dev/null" }, verify).effect).toBe("allow")
  })

  test("writes are confined to the write roots", () => {
    const config: PolicyConfig = { mode: "write", approvals: "interactive", writeRoots: ["/repo", "/run"] }
    expect(evaluateAction({ tool: "Edit", intent: "write", resource: "/repo/src/a.ts" }, config).effect).toBe("allow")
    expect(evaluateAction({ tool: "Write", intent: "write", resource: "/run/report.md" }, config).effect).toBe("allow")
    expect(evaluateAction({ tool: "Write", intent: "write", resource: "/etc/passwd" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Write", intent: "write", resource: "/repo/../etc/x" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Write", intent: "write", resource: "relative.ts" }, config).effect).toBe("deny")
  })

  test("protected roots are denied to every tool, in every mode", () => {
    const config: PolicyConfig = { mode: "write", approvals: "auto", writeRoots: ["/run"], denyRoots: ["/run/.private"], commands }
    expect(evaluateAction({ tool: "Read", intent: "read", resource: "/run/.private/password" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Write", intent: "write", resource: "/run/.private/token" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "cat /run/.private/password" }, config).effect).toBe("deny")
    expect(evaluateAction({ tool: "Read", intent: "read", resource: "/run/report.md" }, config).effect).toBe("allow")
  })
})

// A hard denial is never relaxed by auto-approval, so it must hold whatever
// shell spelling reaches the same command: quoting, escaping, grouping,
// wrappers, `sh -c`, and substitutions all still run `git push`.
describe("hard denials survive shell spelling", () => {
  const commands = { "*": "ask", "cat*": "allow", "echo*": "allow", "git push*": "deny", "rm -rf /*": "deny" } as const
  const write: PolicyConfig = { mode: "write", approvals: "auto", commands }
  const bypasses = [
    `"git" push origin main`,
    `'git' push`,
    `g"it" push`,
    `git "push" origin`,
    `\\git push`,
    `g\\it push`,
    `(git push)`,
    `{ git push; }`,
    `( cd sub && git push )`,
    `FOO=1 git push`,
    `env git push`,
    `command git push`,
    `exec git push`,
    `nohup git push`,
    `time git push`,
    `sh -c "git push"`,
    `bash -lc 'git push origin'`,
    `echo $(git push)`,
    "echo `git push`",
    `cat <(git push)`,
    `git push > /tmp/out`,
    `if true; then git push; fi`,
    `"rm" -rf /etc`,
  ]
  for (const command of bypasses) {
    test(`denies: ${command}`, () => {
      expect(evaluateAction({ tool: "Bash", intent: "execute", resource: command }, write).effect).toBe("deny")
    })
  }

  test("ordinary commands keep their effect", () => {
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: `echo "git push is Convoy's job"` }, { ...write, approvals: "interactive" }).effect).toBe("allow")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "cat a.txt" }, { ...write, approvals: "interactive" }).effect).toBe("allow")
    expect(evaluateAction({ tool: "Bash", intent: "execute", resource: "make build > log.txt" }, { ...write, approvals: "interactive" }).effect).toBe("ask")
  })
})
