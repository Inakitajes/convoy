import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { run } from "./runner"
import type { RunOptions } from "./types"

type ParsedArgs = Omit<RunOptions, "prompt"> & {
  prompt?: string
  promptFile?: string
  help?: boolean
}

export type CliCommand = { type: "help"; text: string } | { type: "run"; options: RunOptions }

export async function parseAndRun(argv: string[]) {
  const command = await parseCommand(argv)
  if (command.type === "help") {
    process.stdout.write(command.text)
    return
  }

  await run(command.options)
}

export async function parseCommand(argv: string[]): Promise<CliCommand> {
  const parsed = parseArgs(argv)
  if (parsed.help) return { type: "help", text: help() }

  let prompt = parsed.prompt ?? ""
  if (parsed.promptFile) {
    prompt = await readFile(resolve(process.cwd(), parsed.promptFile), "utf8")
  }

  if (!prompt && !parsed.resumeRunID) {
    throw new Error("need a prompt (positional or --prompt-file) or --resume <id>")
  }

  const { help: _help, prompt: _parsedPrompt, promptFile: _promptFile, ...options } = parsed
  return { type: "run", options: { ...options, prompt } }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    files: [],
    onlyPhases: [],
    skipPhases: [],
    resumeRunID: "",
    keepRunDir: false,
    modelOverride: "",
    maxAttempts: 2,
    baseRef: "main",
    targetDir: process.cwd(),
    includeDirty: false,
  }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (raw === "--") {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (!raw.startsWith("-")) {
      positional.push(raw)
      continue
    }

    const { flag, value } = splitFlag(raw)
    const takeValue = () => {
      if (value !== undefined) return value
      const next = argv[++i]
      if (!next) throw new Error(`${flag} requires a value`)
      return next
    }

    switch (flag) {
      case "--help":
      case "-h":
        parsed.help = true
        return parsed
      case "--prompt-file":
      case "--prd":
        parsed.promptFile = takeValue()
        break
      case "--file":
      case "-f":
        parsed.files.push(takeValue())
        break
      case "--only":
        parsed.onlyPhases.push(...listValue(takeValue()))
        break
      case "--skip":
        parsed.skipPhases.push(...listValue(takeValue()))
        break
      case "--resume":
        parsed.resumeRunID = takeValue()
        break
      case "--keep-run-dir":
        parsed.keepRunDir = true
        break
      case "--include-dirty":
        parsed.includeDirty = true
        break
      case "--model":
        parsed.modelOverride = takeValue()
        break
      case "--max-attempts":
        parsed.maxAttempts = parseInt(takeValue(), 10)
        if (!Number.isInteger(parsed.maxAttempts) || parsed.maxAttempts < 1) {
          throw new Error("--max-attempts must be a positive integer")
        }
        break
      case "--base":
        parsed.baseRef = takeValue()
        break
      case "--dir":
        parsed.targetDir = resolve(process.cwd(), takeValue())
        break
      default:
        throw new Error(`unknown flag: ${flag}`)
    }
  }

  if (positional.length > 0) parsed.prompt = positional.join(" ")
  return parsed
}

function splitFlag(raw: string) {
  const index = raw.indexOf("=")
  if (index === -1) return { flag: raw, value: undefined }
  return { flag: raw.slice(0, index), value: raw.slice(index + 1) }
}

function listValue(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function help() {
  return `archer [prompt]

Sequential OpenCode agent pipeline for implementing features.

Usage:
  archer "Add onboarding"
  archer --prompt-file prd.md --file lib/onboarding --file test/onboarding_test.dart

Flags:
  --prompt-file <path>     Read the PRD/prompt from a file
  --file, -f <path>        Attach a file or directory to all phases (repeatable)
  --only <phases>          Run only these phases (implementer,patterns,security,design,tests)
  --skip <phases>          Skip these phases
  --resume <id>            Resume a previous run by its ID
  --keep-run-dir           Don't delete the run dir when done
  --include-dirty          Include existing changes in the first commit (requires --max-attempts 1)
  --model <provider/model> Force a model for all phases
  --max-attempts <n>       Attempts per phase before failing (default: 2)
  --base <ref>             Branch/base for calculating diffs (default: main)
  --dir <path>             Target repo (default: cwd)
`
}
