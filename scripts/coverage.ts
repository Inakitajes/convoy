#!/usr/bin/env bun
/**
 * Coverage runner and badge generator.
 *
 * Usage:
 *   bun run scripts/coverage.ts              # run tests, check threshold, generate badge
 *   bun run scripts/coverage.ts --check      # check threshold against existing coverage
 *   bun run scripts/coverage.ts --badge      # generate badge from existing coverage
 *
 * Environment variables:
 *   COVERAGE_THRESHOLD_LINES     minimum line coverage % (default 90)
 *   COVERAGE_THRESHOLD_FUNCS     minimum function coverage % (default 90)
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs"
import { join, resolve } from "node:path"

import { badgeColor, generateBadgeSVG, parseTextCoverage, type CoverageTotals } from "./coverage-core"

const ROOT = resolve(import.meta.dirname, "..")
const COVERAGE_DIR = join(ROOT, "coverage")
const BADGE_PATH = join(ROOT, "assets", "coverage.svg")
const CACHED_SUMMARY = join(COVERAGE_DIR, "summary.txt")
const THRESHOLD_LINES = Number(process.env.COVERAGE_THRESHOLD_LINES ?? 90)
const THRESHOLD_FUNCS = Number(process.env.COVERAGE_THRESHOLD_FUNCS ?? 90)

function runTestsWithCoverage(): CoverageTotals {
  console.log("🧪 Running tests with coverage...")
  const result = spawnSync(
    "bun",
    ["test", "--coverage", "--coverage-reporter=text", `--coverage-dir=${COVERAGE_DIR}`],
    { cwd: ROOT, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  )
  // Bun writes the coverage table to stderr, while regular test output can use
  // either stream. Their relative order is irrelevant to the summary parser.
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`

  // Cache the summary for --check / --badge modes
  if (!existsSync(COVERAGE_DIR)) mkdirSync(COVERAGE_DIR, { recursive: true })
  writeFileSync(CACHED_SUMMARY, output, "utf-8")

  if (result.error || result.status !== 0) {
    // Synchronously: an async write to a pipe is cut short by the exit the
    // throw causes, which hid the failing tests from CI logs.
    writeSync(2, output)
    throw result.error ?? new Error(`Tests with coverage failed with exit code ${result.status ?? "unknown"}`)
  }

  return parseTextCoverage(output)
}

function readCachedSummary(): CoverageTotals {
  if (!existsSync(CACHED_SUMMARY)) {
    console.error("❌ No cached coverage found. Run tests with coverage first.")
    process.exit(1)
  }
  return parseTextCoverage(readFileSync(CACHED_SUMMARY, "utf-8"))
}

function checkThreshold(totals: CoverageTotals): boolean {
  console.log(`\n📊 Coverage Summary (from bun text reporter):`)
  console.log(`   Lines:      ${totals.linePct}%`)
  console.log(`   Functions:  ${totals.funcPct}%`)
  console.log(`   Threshold:  ${THRESHOLD_LINES}% lines, ${THRESHOLD_FUNCS}% functions`)

  let ok = true
  if (totals.linePct < THRESHOLD_LINES) {
    console.error(`❌ Line coverage ${totals.linePct}% is below threshold of ${THRESHOLD_LINES}%`)
    ok = false
  } else {
    console.log(`✅ Line coverage ${totals.linePct}% meets threshold of ${THRESHOLD_LINES}%`)
  }

  if (totals.funcPct < THRESHOLD_FUNCS) {
    console.error(`❌ Function coverage ${totals.funcPct}% is below threshold of ${THRESHOLD_FUNCS}%`)
    ok = false
  } else {
    console.log(`✅ Function coverage ${totals.funcPct}% meets threshold of ${THRESHOLD_FUNCS}%`)
  }

  return ok
}

function generateBadge(totals: CoverageTotals): void {
  const color = badgeColor(totals.linePct)
  const value = `${totals.linePct}%`
  const svg = generateBadgeSVG("coverage", value, color)

  const dir = join(BADGE_PATH, "..")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(BADGE_PATH, svg, "utf-8")
  console.log(`\n🏷️  Coverage badge written to ${BADGE_PATH}`)
}

function main() {
  const args = process.argv.slice(2)
  const mode = args.includes("--check") ? "check" : args.includes("--badge") ? "badge" : "full"

  let totals: CoverageTotals

  if (mode === "check") {
    totals = readCachedSummary()
    const ok = checkThreshold(totals)
    if (!ok) process.exit(1)
    console.log("\n✅ All coverage checks passed!")
  } else if (mode === "badge") {
    totals = readCachedSummary()
    generateBadge(totals)
  } else {
    totals = runTestsWithCoverage()
    const ok = checkThreshold(totals)
    generateBadge(totals)
    if (!ok) {
      console.error("\n❌ Coverage check failed!")
      process.exit(1)
    }
    console.log("\n✅ All coverage checks passed!")
  }
}

if (import.meta.main) main()
