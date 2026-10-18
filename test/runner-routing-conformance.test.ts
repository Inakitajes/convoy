import { describe, expect, test } from "bun:test"
import { Glob } from "bun"

/**
 * Runner routing conformance (change `generalize-runner-routes`, task 2.4).
 *
 * Routing, validation, preflight, provenance and prompts read a runner's
 * behavior from its descriptor (`src/runners/descriptors.ts`), never from its
 * name. A comparison against a runner id outside the runner's own adapter
 * directory, the descriptors, or a module that is the runner's own CLI helper
 * reintroduces the two-way switch this change removed.
 *
 * Registration tables keyed by runner id (`{ "claude-code": …, codex: … }`)
 * are the intended extension point and are not comparisons. Authoring
 * conversations still name their harness: Codex cannot host one, so that
 * surface is not part of runner routing.
 */
const allowed = [
  /^src\/runners\/(claude|codex|opencode)\//,
  /^src\/runners\/descriptors\.ts$/,
  /^src\/runners\/declarations\.ts$/,
  /^src\/claude-code\.ts$/,
  /^src\/codex-cli\.ts$/,
]

const runnerIds = "claude-code|codex|opencode"
const comparison = new RegExp(`(?:===|!==)\\s*"(?:${runnerIds})"|"(?:${runnerIds})"\\s*(?:===|!==)|startsWith\\("(?:claude-code|codex)/`)

/**
 * Runner-name comparisons in a source, ignoring authoring-conversation harness
 * checks and CLI subcommand words (`convoy opencode …` is a command, not a runner).
 */
export function runnerComparisons(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => comparison.test(line) && !/\bharness\b|\bargv\[/.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("//"))
}

describe("runner routing conformance", () => {
  test("no core module compares a runner name", async () => {
    const offenders: string[] = []
    for await (const path of new Glob("src/**/*.ts").scan({ cwd: process.cwd() })) {
      if (allowed.some((pattern) => pattern.test(path))) continue
      for (const line of runnerComparisons(await Bun.file(path).text())) offenders.push(`${path}: ${line.trim()}`)
    }
    expect(offenders).toEqual([])
  })

  test("the check detects every spelling of a runner comparison", () => {
    expect(runnerComparisons(`if (step.runner === "claude-code") {`)).toHaveLength(1)
    expect(runnerComparisons(`return "codex" !== runner`)).toHaveLength(1)
    expect(runnerComparisons(`model.startsWith("claude-code/")`)).toHaveLength(1)
    expect(runnerComparisons(`const opener = { "claude-code": open }`)).toHaveLength(0)
    expect(runnerComparisons(`if (input.ref.harness === "claude-code") {`)).toHaveLength(0)
  })
})
