import { describe, expect, test } from "bun:test"
import { Glob } from "bun"

/**
 * Adapter dependency direction (change `unify-runner-system`, task 2.1).
 *
 * An adapter owns its harness specifics and must never depend on the engine
 * (`src/runner.ts`): the engine imports adapters, not the reverse. Before this
 * change the OpenCode phase module imported engine helpers back, forming a
 * cycle; this test keeps the direction one-way.
 */
const engineSpecifier = /^(?:\.\.\/)+runner$/

function engineImports(text: string): string[] {
  const specifiers = [
    ...text.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ]
    .map((match) => match[1])
    .filter((specifier): specifier is string => Boolean(specifier))
  return specifiers.filter((specifier) => engineSpecifier.test(specifier))
}

async function adapterSources(): Promise<{ path: string; text: string }[]> {
  const glob = new Glob("src/runners/**/*.ts")
  const sources: { path: string; text: string }[] = []
  for await (const path of glob.scan({ cwd: process.cwd() })) {
    sources.push({ path, text: await Bun.file(path).text() })
  }
  return sources
}

describe("adapter dependency direction", () => {
  test("no adapter module imports the engine (src/runner.ts)", async () => {
    const sources = await adapterSources()
    expect(sources.length).toBeGreaterThan(0)
    const offenders = sources.filter((source) => engineImports(source.text).length > 0).map((source) => source.path)
    expect(offenders).toEqual([])
  })

  test("the check detects an engine import in any relative form", () => {
    expect(engineImports(`import { watchSession } from "../../runner"`)).toEqual(["../../runner"])
    expect(engineImports(`import type { X } from "../runner"`)).toEqual(["../runner"])
    expect(engineImports(`const m = await import("../../runner")`)).toEqual(["../../runner"])
    expect(engineImports(`import { log } from "../../log"`)).toEqual([])
    expect(engineImports(`import { runner } from "../../runner-utils"`)).toEqual([])
  })

  test("core has no harness-specific attempt dispatch left (task 4.4)", async () => {
    const core = await Bun.file("src/runner.ts").text()
    // The superseded per-harness attempt implementations moved to the adapters.
    expect(core).not.toContain("phaseAttemptRunners")
    expect(core).not.toContain("executeOpenCodePhaseAttempt")
    expect(core).not.toContain("executeClaudeCodePhaseAttempt")
    // Core still dispatches through the registry, not a runner-name branch.
    expect(core).toContain("attemptFor(")
  })

  test("core resolves a session-window opener from a table, not a runner branch (task 4.2)", async () => {
    const core = await Bun.file("src/runner.ts").text()
    expect(core).toContain("sessionWindowOpeners")
    // The old `options.runner === "claude-code" ? ... : ...` gate branch is gone.
    expect(core).not.toContain('options.runner === "claude-code"')
  })

  test("the attempt context carries no engine-owned policy object (task 6.2)", async () => {
    const source = await Bun.file("src/runners/attempt.ts").text()
    const context = source.slice(source.indexOf("export type AttemptContext"), source.indexOf("/** The normalized attempt result"))
    for (const field of ["workspace", "progress", "shutdown", "reports", "advisors", "sessionRef", "loopGuard", "loopGuardConfig", "deliverableContract", "rubricWeights"]) {
      expect(context).not.toContain(`${field}:`)
      expect(context).not.toContain(`${field}?:`)
    }
    // It carries the neutral sink, signal and services instead.
    expect(context).toContain("sink: AttemptSink")
    expect(context).toContain("signal: AbortSignal")
    expect(context).toContain("services: ExecutionServices")
  })
})
