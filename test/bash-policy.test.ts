import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { bashPolicy, denyBashPatterns, projectScriptAllowPatterns } from "../src/bash-policy"

describe("bash policy", () => {
  test("includes web checks and keeps dangerous operations denied", () => {
    const policy = bashPolicy()

    expect(policy["pnpm run lint*"]).toBe("allow")
    expect(policy["npm run typecheck*"]).toBe("allow")
    expect(policy["bun test*"]).toBe("allow")
    expect(policy["tsc --noEmit*"]).toBe("allow")
    expect(policy["git push*"]).toBe("deny")
    expect(policy["npm install*"]).toBe("deny")
    expect(policy["npm run deploy*"]).toBe("deny")
    expect(policy["*"]).toBe("ask")
  })

  test("avoids destructive allows and over-broad denies", () => {
    const policy = bashPolicy()

    // find -delete/-exec and git branch -D must fall through to ask
    expect(policy["find*"]).toBeUndefined()
    expect(policy["git branch*"]).toBeUndefined()
    expect(policy["git branch --list*"]).toBe("allow")
    expect(policy["git branch"]).toBe("allow")

    // su/gh denies must not swallow supabase, subl, ghc…
    expect(policy["su*"]).toBeUndefined()
    expect(policy["su"]).toBe("deny")
    expect(policy["su *"]).toBe("deny")
    expect(policy["gh*"]).toBeUndefined()
    expect(policy["gh"]).toBe("deny")
    expect(policy["gh *"]).toBe("deny")

    expect(policy["rm -fr ${HOME}*"]).toBe("deny")
    expect(policy["curl* | zsh*"]).toBe("deny")
  })

  test("allows common check commands across ecosystems", () => {
    const policy = bashPolicy()

    expect(policy["pytest*"]).toBe("allow")
    expect(policy["ruff check*"]).toBe("allow")
    expect(policy["go test*"]).toBe("allow")
    expect(policy["cargo clippy*"]).toBe("allow")
    expect(policy["make test"]).toBe("allow")
    expect(policy["jq*"]).toBe("allow")

    // only the known-safe make targets, never a blanket make
    expect(policy["make*"]).toBeUndefined()
    expect(policy["make deploy"]).toBeUndefined()
  })

  test("safe package.json scripts are allowlisted, dangerous names are not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-scripts-"))
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: {
            "test:unit": "vitest run",
            "type-check": "tsc --noEmit",
            format: "prettier --write .",
            deploy: "vercel deploy",
            "build:deploy": "build && push",
            seed: "node seed.js",
          },
        }),
      )

      const patterns = projectScriptAllowPatterns(dir)
      expect(patterns).toContain("npm run test:unit")
      expect(patterns).toContain("npm run test:unit *")
      expect(patterns).toContain("bun run type-check")
      expect(patterns).toContain("pnpm format")
      expect(patterns.some((pattern) => pattern.includes("deploy"))).toBe(false)
      expect(patterns.some((pattern) => pattern.includes("seed"))).toBe(false)

      const policy = bashPolicy(dir)
      expect(policy["yarn run format"]).toBe("allow")
      expect(policy["npm run deploy"]).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("project without package.json adds no script patterns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-noscripts-"))
    try {
      expect(projectScriptAllowPatterns(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("the denylist always wins: every deny pattern stays denied in the assembled policy", () => {
    const policy = bashPolicy()
    for (const pattern of denyBashPatterns) {
      expect(policy[pattern]).toBe("deny")
    }
    // --yolo never touches the policy: unknowns still surface as ask and are
    // resolved by convoy's gate, where only ask-level requests can auto-allow.
    expect(policy["*"]).toBe("ask")
  })

  test("project permission additions extend the policy without weakening it", () => {
    const policy = bashPolicy("/tmp/non-existent-convoy-target", {
      allow: ["supabase gen types*", "git push*"],
      deny: ["stripe *"],
    })

    expect(policy["supabase gen types*"]).toBe("allow")
    expect(policy["stripe *"]).toBe("deny")
    // A config allow can never resurrect a denied pattern.
    expect(policy["git push*"]).toBe("deny")
    expect(policy["*"]).toBe("ask")
  })
})
