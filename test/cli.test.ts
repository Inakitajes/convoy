import { describe, expect, test } from "bun:test"
import { afterAll, afterEach, beforeEach } from "bun:test"

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { goalModeFor, parseArgs, parseCommand, resolveRunOptions, runHomeNavigationLoop, shouldLaunchHome } from "../src/cli"
import { modelGateways } from "../src/model-routing"
import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import type { Pipeline, RunPlan } from "../src/types"

const validRunID = "20240101-120000-abcd"

describe("home launcher gate", () => {
  test("opens only for truly empty argv with interactive stdin and stdout", () => {
    expect(shouldLaunchHome([], true, true)).toBeTrue()
    expect(shouldLaunchHome([], false, true)).toBeFalse()
    expect(shouldLaunchHome([], true, false)).toBeFalse()
    expect(shouldLaunchHome([], undefined, true)).toBeFalse()
  })

  test("does not consume arguments such as --dir", () => {
    expect(shouldLaunchHome(["--dir", "/some/repo"], true, true)).toBeFalse()
    expect(shouldLaunchHome(["--help"], true, true)).toBeFalse()
  })
})

describe("home navigation loop", () => {
  test("a destination close returns to Home with that destination still selected", async () => {
    const contexts: Array<string | undefined> = []
    const destinations: string[] = []
    let opens = 0

    await runHomeNavigationLoop({
      interrupted: () => false,
      route: {} as never,
      targetDir: ".",
      openHome: async () => {
        contexts.push("ok")
        return opens++ === 0 ? { type: "destination", destination: "specs" } : undefined
      },
      openWork: async () => {},
      openRun: async () => {},
      openChange: async () => {},
      createWork: async () => {},
      openDestination: async (selection) => {
        destinations.push(selection)
      },
    })

    expect(contexts).toEqual(["ok", "ok"])
    expect(destinations).toEqual(["specs"])
  })

  test("an interrupt inside a destination exits without reopening Home", async () => {
    let interrupted = false
    let homeOpens = 0

    await runHomeNavigationLoop({
      interrupted: () => interrupted,
      route: {} as never,
      targetDir: ".",
      openHome: async () => {
        homeOpens += 1
        return { type: "destination", destination: "runs" }
      },
      openWork: async () => {},
      openRun: async () => {},
      openChange: async () => {},
      createWork: async () => {},
      openDestination: async () => {
        interrupted = true
      },
    })

    expect(homeOpens).toBe(1)
  })

  test("an interrupted home context load exits without opening Home", async () => {
    let homeOpens = 0

    await runHomeNavigationLoop({
      interrupted: () => false,
      route: {} as never,
      targetDir: ".",
      // The transition-wrapped loader answers undefined when Ctrl+C lands
      // while the loading transition is up.
      loadHome: async () => undefined,
      openHome: async () => {
        homeOpens += 1
        return undefined
      },
      openWork: async () => {},
      openRun: async () => {},
      openChange: async () => {},
      createWork: async () => {},
      openDestination: async () => {},
    })

    expect(homeOpens).toBe(0)
  })

  test("the injected home load refreshes on every return to Home", async () => {
    let loads = 0
    let homeOpens = 0

    await runHomeNavigationLoop({
      interrupted: () => false,
      route: {} as never,
      targetDir: ".",
      loadHome: async () => {
        loads += 1
        return { worktrees: [] }
      },
      openHome: async () => {
        homeOpens += 1
        return homeOpens === 1 ? { type: "destination", destination: "specs" } : undefined
      },
      openWork: async () => {},
      openRun: async () => {},
      openChange: async () => {},
      createWork: async () => {},
      openDestination: async () => {},
    })

    expect(loads).toBe(2)
    expect(homeOpens).toBe(2)
  })
})

describe("parseArgs", () => {
  test("parses a positional prompt", () => {
    const result = parseArgs(["add onboarding"])
    expect(result.prompt).toBe("add onboarding")
  })

  test("parses --prompt-file", () => {
    const result = parseArgs(["--prompt-file", "prd.md"])
    expect(result.promptFile).toBe("prd.md")
  })

  test("parses --file", () => {
    const result = parseArgs(["--file", "lib/main.dart", "-f", "test/main_test.dart"])
    expect(result.files).toEqual(["lib/main.dart", "test/main_test.dart"])
  })

  test("parses --pipeline", () => {
    const result = parseArgs(["-p", "bug-fix"])
    expect(result.pipeline).toBe("bug-fix")
  })

  test("parses --only and --skip with comma-separated values", () => {
    const result = parseArgs(["--only", "design,security", "--skip", "tests"])
    expect(result.onlySteps).toEqual(["design", "security"])
    expect(result.skipSteps).toEqual(["tests"])
  })

  test("parses --resume", () => {
    const result = parseArgs(["--resume", "run-abc123"])
    expect(result.resumeRunID).toBe("run-abc123")
  })

  test("parses --model", () => {
    const result = parseArgs(["--model", "anthropic/claude-sonnet-4-5#thinking"])
    expect(result.modelOverride).toBe("anthropic/claude-sonnet-4-5#thinking")
  })

  test("parses --advisor", () => {
    const result = parseArgs(["--advisor", "openai/gpt-5"])
    expect(result.advisorOverride).toBe("openai/gpt-5")
    expect(result.advisorDisabled).toBe(false)
  })

  test("parses --no-advisor", () => {
    const result = parseArgs(["--no-advisor"])
    expect(result.advisorDisabled).toBe(true)
    expect(result.advisorOverride).toBeUndefined()
  })

  test("parses --gateway", () => {
    const result = parseArgs(["--gateway", "openrouter"])
    expect(result.gateway).toBe("openrouter")
    expect(parseArgs(["--gateway", "nitro"]).gateway).toBe("nitro")
  })

  test("throws for invalid --gateway", () => {
    expect(() => parseArgs(["--gateway", "invalid"])).toThrow()
    expect(() => parseArgs(["--gateway", "invalid"])).toThrow('"nitro"')
  })

  test("the retired goal flags fail with a migration error before any side effect", () => {
    // Retired with the embedded goal step: the refusal happens in the parser,
    // before plan review, worktree creation, or run startup.
    for (const flag of ["--goal", "--goal-max-iterations", "--goal-plateau"]) {
      expect(() => parseArgs([flag, "90"])).toThrow(new RegExp(`retired flag: ${flag}`.replace("-", "\\-")))
      expect(() => parseArgs([flag, "90"])).toThrow(/goal`? step/)
    }
  })

  test("parses --plan", () => {
    const result = parseArgs(["--plan"])
    expect(result.planOnly).toBe(true)
  })

  test("parses --no-confirm", () => {
    const result = parseArgs(["--no-confirm"])
    expect(result.noConfirm).toBe(true)
  })

  test("parses --tui and --no-tui", () => {
    expect(parseArgs(["--tui"]).tui).toBe(true)
    expect(parseArgs(["--no-tui"]).tui).toBe(false)
  })

  test("parses --worktree and --no-worktree", () => {
    expect(parseArgs(["--worktree"]).worktree).toBe(true)
    expect(parseArgs(["--no-worktree"]).worktree).toBe(false)
  })

  test("parses --branch", () => {
    const result = parseArgs(["--branch", "feat/my-feature"])
    expect(result.branch).toBe("feat/my-feature")
  })

  test("parses --base", () => {
    const result = parseArgs(["--base", "develop"])
    expect(result.baseRef).toBe("develop")
  })

  test("parses --include-dirty", () => {
    const result = parseArgs(["--include-dirty"])
    expect(result.includeDirty).toBe(true)
  })

  test("parses --yolo", () => {
    const result = parseArgs(["--yolo"])
    expect(result.yolo).toBe(true)
  })

  test("parses --smart", () => {
    const result = parseArgs(["--smart"])
    expect(result.smart).toBe(true)
  })

  test("parses --smart-model", () => {
    const result = parseArgs(["--smart-model", "anthropic/claude-opus-5"])
    expect(result.smartModel).toBe("anthropic/claude-opus-5")
  })

  test("parses --notify and --no-notify", () => {
    expect(parseArgs(["--notify"]).notify).toBe(true)
    expect(parseArgs(["--no-notify"]).notify).toBe(false)
  })

  test("parses --human-review", () => {
    expect(parseArgs(["--human-review"]).humanReview).toBe(true)
    expect(parseArgs(["--no-human-review"]).humanReview).toBe(false)
  })

  test("parses --max-concurrent", () => {
    const result = parseArgs(["--max-concurrent", "5"])
    expect(result.maxConcurrent).toBe(5)
  })

  test("throws for invalid --max-concurrent", () => {
    expect(() => parseArgs(["--max-concurrent", "0"])).toThrow()
    expect(() => parseArgs(["--max-concurrent", "abc"])).toThrow()
  })

  test("parses --keep-run-dir and --no-keep-run-dir", () => {
    expect(parseArgs(["--keep-run-dir"]).keepRunDir).toBe(true)
    expect(parseArgs(["--no-keep-run-dir"]).keepRunDir).toBe(false)
  })

  test("parses --dir", () => {
    const result = parseArgs(["--dir", "/some/repo"])
    expect(result.targetDir).toBe("/some/repo")
  })

  test("parses --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true)
    expect(parseArgs(["-h"]).help?.toString()).toBe("true")
  })

  test("stops parsing at -- and treats everything after as positional", () => {
    const result = parseArgs(["--", "add", "login", "--verbose"])
    expect(result.prompt).toBe("add login --verbose")
  })

  test("throws for unknown flags", () => {
    expect(() => parseArgs(["--foobar"])).toThrow("unknown flag")
  })

  test("parses --model with = syntax", () => {
    const result = parseArgs(["--model=anthropic/claude-sonnet-4-5"])
    expect(result.modelOverride).toBe("anthropic/claude-sonnet-4-5")
  })

  test("parses --pipeline with = syntax", () => {
    const result = parseArgs(["--pipeline=bug-fix"])
    expect(result.pipeline).toBe("bug-fix")
  })

  test("parses --base with = syntax", () => {
    const result = parseArgs(["--base=main"])
    expect(result.baseRef).toBe("main")
  })

  test("parses --branch with = syntax", () => {
    const result = parseArgs(["--branch=feat/foo"])
    expect(result.branch).toBe("feat/foo")
  })

  test("parses --dir with = syntax", () => {
    const result = parseArgs(["--dir=/some/repo"])
    expect(result.targetDir).toBe("/some/repo")
  })

  test("parses --gateway with = syntax", () => {
    const result = parseArgs(["--gateway=direct"])
    expect(result.gateway).toBe("direct")
    expect(parseArgs(["--gateway=nitro"]).gateway).toBe("nitro")
  })

  test("parses --only with = syntax", () => {
    const result = parseArgs(["--only=design,security"])
    expect(result.onlySteps).toEqual(["design", "security"])
  })

  test("parses --advisor with = syntax", () => {
    const result = parseArgs(["--advisor=openai/gpt-5"])
    expect(result.advisorOverride).toBe("openai/gpt-5")
  })

  test("parses --resume with = syntax", () => {
    const result = parseArgs(["--resume=run-abc123"])
    expect(result.resumeRunID).toBe("run-abc123")
  })

  test("parses -f with = syntax", () => {
    const result = parseArgs(["-f=lib/main.dart"])
    expect(result.files).toEqual(["lib/main.dart"])
  })

  test("--no-advisor does not take a value with = syntax", () => {
    expect(() => parseArgs(["--no-advisor=foo"])).toThrow("--no-advisor does not take a value")
  })

  test("--no-worktree does not take a value with = syntax", () => {
    expect(() => parseArgs(["--no-worktree=true"])).toThrow("--no-worktree does not take a value")
  })

  test("--plan does not take a value with = syntax", () => {
    expect(() => parseArgs(["--plan=1"])).toThrow("--plan does not take a value")
  })

  test("--no-confirm does not take a value with = syntax", () => {
    expect(() => parseArgs(["--no-confirm=1"])).toThrow("--no-confirm does not take a value")
  })

  test("--notify does not take a value with = syntax", () => {
    expect(() => parseArgs(["--notify=1"])).toThrow("--notify does not take a value")
  })

  test("--worktree does not take a value with = syntax", () => {
    expect(() => parseArgs(["--worktree=1"])).toThrow("--worktree does not take a value")
  })

  test("stops parsing at -- with just separator and positional", () => {
    const result = parseArgs(["--", "some prompt"])
    expect(result.prompt).toBe("some prompt")
  })

  test("-- separator with no positional args", () => {
    const result = parseArgs(["--model", "gpt-4", "--"])
    expect(result.modelOverride).toBe("gpt-4")
    expect(result.prompt).toBeUndefined()
  })

  test("-- separator with no args at all", () => {
    const result = parseArgs([])
    expect(result.prompt).toBeUndefined()
    expect(result.files).toEqual([])
    expect(result.onlySteps).toEqual([])
    expect(result.skipSteps).toEqual([])
  })
})

describe("parseCommand", () => {
  test("--help returns help text", async () => {
    const cmd = await parseCommand(["--help"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy [prompt]")
      expect(cmd.text).toContain("Commands:")
      expect(cmd.text).toContain("Flags:")
      expect(cmd.text).toContain("Pipelines, Specs, Runs, or Config")
      expect(cmd.text).toContain(`--gateway <${modelGateways.join("|")}>`)
    }
  })

  test("-h returns help text", async () => {
    const cmd = await parseCommand(["-h"])
    expect(cmd.type).toBe("help")
  })

  test("--coordinate parses as the internal coordinator command", async () => {
    const cmd = await parseCommand(["--coordinate", "/tmp/launch.json"])
    expect(cmd).toEqual({ type: "coordinate", launchPath: "/tmp/launch.json" })
    await expect(parseCommand(["--coordinate"])).rejects.toThrow(/internal/)
  })

  test("--coordinate is not advertised in the help text", async () => {
    const cmd = await parseCommand(["--help"])
    if (cmd.type === "help") {
      expect(cmd.text).not.toContain("--coordinate")
    }
  })

  test("parses --version", async () => {
    const cmd = await parseCommand(["--version"])
    expect(cmd.type).toBe("version")
  })

  test("parses -V", async () => {
    const cmd = await parseCommand(["-V"])
    expect(cmd.type).toBe("version")
  })

  test("parses update command", async () => {
    const cmd = await parseCommand(["update"])
    expect(cmd.type).toBe("update")
    expect((cmd as { checkOnly: boolean }).checkOnly).toBe(false)
  })

  test("parses update --check", async () => {
    const cmd = await parseCommand(["update", "--check"])
    expect(cmd.type).toBe("update")
    expect((cmd as { checkOnly: boolean }).checkOnly).toBe(true)
  })

  test("parses update --help", async () => {
    const cmd = await parseCommand(["update", "--help"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy update [--check]")
      expect(cmd.text).toContain("--check")
    }
  })

  test("parses update -h", async () => {
    const cmd = await parseCommand(["update", "-h"])
    expect(cmd.type).toBe("help")
  })

  test("throws for unknown update args", async () => {
    await expect(parseCommand(["update", "--unknown"])).rejects.toThrow("usage: convoy update")
  })

  test("parses auth status", async () => {
    const cmd = await parseCommand(["auth"])
    expect(cmd.type).toBe("auth")
    if (cmd.type === "auth") {
      expect(cmd.provider).toBe("openrouter")
      expect(cmd.action).toBe("status")
    }
  })

  test("parses auth openrouter", async () => {
    const cmd = await parseCommand(["auth", "openrouter"])
    expect(cmd.type).toBe("auth")
    if (cmd.type === "auth") {
      expect(cmd.provider).toBe("openrouter")
      expect(cmd.action).toBe("set")
    }
  })

  test("parses auth openrouter --remove", async () => {
    const cmd = await parseCommand(["auth", "openrouter", "--remove"])
    expect(cmd.type).toBe("auth")
    if (cmd.type === "auth") {
      expect(cmd.provider).toBe("openrouter")
      expect(cmd.action).toBe("remove")
    }
  })

  test("throws for invalid auth subcommand", async () => {
    await expect(parseCommand(["auth", "invalid"])).rejects.toThrow("usage: convoy auth")
  })

  test("parses init", async () => {
    const cmd = await parseCommand(["init"])
    expect(cmd.type).toBe("init")
  })

  test("parses init --global", async () => {
    const cmd = await parseCommand(["init", "--global"])
    expect(cmd.type).toBe("init")
    if (cmd.type === "init") {
      expect(cmd.options.global).toBe(true)
    }
  })

  test("parses init --help", async () => {
    const cmd = await parseCommand(["init", "--help"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy init [--global]")
    }
  })

  test("parses init -h", async () => {
    const cmd = await parseCommand(["init", "-h"])
    expect(cmd.type).toBe("help")
  })

  test("parses runs", async () => {
    const cmd = await parseCommand(["runs"])
    expect(cmd.type).toBe("runs")
    if (cmd.type === "runs") {
      expect(cmd.runID).toBeUndefined()
    }
  })

  test("parses runs with a run ID", async () => {
    const cmd = await parseCommand(["runs", validRunID])
    expect(cmd.type).toBe("runs")
    if (cmd.type === "runs") {
      expect(cmd.runID).toBe(validRunID)
    }
  })

  test("throws for runs with extra args", async () => {
    await expect(parseCommand(["runs", validRunID, "extra"])).rejects.toThrow("usage: convoy runs")
  })

  test("throws for an invalid run ID", async () => {
    await expect(parseCommand(["runs", "../../malicious"])).rejects.toThrow("invalid run id")
  })

  test("parses config", async () => {
    const cmd = await parseCommand(["config"])
    expect(cmd.type).toBe("config")
  })

  test("throws for config with extra args", async () => {
    await expect(parseCommand(["config", "extra"])).rejects.toThrow("usage: convoy config")
  })

  test("agents without subcommand shows help", async () => {
    const cmd = await parseCommand(["agents"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy agents eject")
    }
  })

  test("agents --help shows help", async () => {
    const cmd = await parseCommand(["agents", "--help"])
    expect(cmd.type).toBe("help")
  })

  test("agents eject with no agent name throws", async () => {
    await expect(parseCommand(["agents", "eject"])).rejects.toThrow("usage: convoy agents eject")
  })

  test("agents eject with --help shows help", async () => {
    const cmd = await parseCommand(["agents", "eject", "--help"])
    expect(cmd.type).toBe("help")
  })

  test("agents with invalid subcommand throws", async () => {
    await expect(parseCommand(["agents", "invalid"])).rejects.toThrow("usage: convoy agents eject")
  })

  test("retired finish command fails with the removal diagnostic", async () => {
    const cmd = await parseCommand(["finish", "--branch", "feat/x"])
    expect(cmd.type).toBe("retired-finish")
  })

  test("rejects both --prompt and --prompt-file", async () => {
    await expect(parseCommand(["prompt arg", "--prompt-file", "prd.md"])).rejects.toThrow("use either a positional prompt or --prompt-file")
  })

  test("rejects --resume with a new prompt", async () => {
    await expect(parseCommand(["--resume", validRunID, "new prompt"])).rejects.toThrow("can't take a new prompt")
  })

  test("parses a run command with prompt", async () => {
    // parseCommand defaults targetDir to this repo, whose OpenSpec contract
    // rule (implement needs an active change) depends on main's archive
    // state — red right after a close archives everything, green mid-feature.
    // A bare temp dir has no openspec/, keeping this parse-level assertion
    // hermetic against the repo's own change lifecycle.
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-run-parse-"))
    try {
      const cmd = await parseCommand(["--dir", dir, "add login"])
      expect(cmd.type).toBe("run")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// The fallback resolves the pipeline through the merged config, so these tests
// point CONVOY_HOME at a throwaway home: a real global config could shadow a
// built-in pipeline or set defaults.pipeline and flip the expectations.
describe("parseCommand default prompt fallback", () => {
  const dirs: string[] = []
  let savedHome: string | undefined

  beforeEach(async () => {
    savedHome = process.env.CONVOY_HOME
    const root = await mkdtemp(join(tmpdir(), "convoy-cli-prompt-home-"))
    dirs.push(root)
    process.env.CONVOY_HOME = root
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CONVOY_HOME
    else process.env.CONVOY_HOME = savedHome
  })

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("uses the pipeline's defaultPrompt when no prompt is given", async () => {
    const cmd = await parseCommand(["-p", "review", "--manual"])
    expect(cmd.type).toBe("run")
    if (cmd.type === "run") {
      expect(cmd.options.prompt).toBe(
        "Review the current branch against its base and report prioritized findings with a verified quality score.",
      )
      expect(cmd.options.plan?.prompt.source).toBe("default")
    }
  })

  test("rejects a run without prompt when the default pipeline has no defaultPrompt", async () => {
    // implement (the default) has no defaultPrompt, so a bare invocation still errors.
    await expect(parseCommand([])).rejects.toThrow("need a prompt")
  })

  test("still errors when the selected pipeline has no defaultPrompt", async () => {
    await expect(parseCommand(["-p", "implement"])).rejects.toThrow("need a prompt")
  })

  test("--change without a prompt injects the canned OpenSpec prompt", async () => {
    const repo = await mkdtemp(join(tmpdir(), "convoy-cli-change-"))
    dirs.push(repo)
    await mkdir(join(repo, "openspec", "changes", "add-login"), { recursive: true })
    await writeFile(join(repo, "openspec", "changes", "add-login", "proposal.md"), "# Add Login\n")

    const implement = await parseCommand(["--dir", repo, "-p", "implement", "--change", "add-login"])
    expect(implement.type).toBe("run")
    if (implement.type === "run") {
      expect(implement.options.prompt).toBe("Implement the attached OpenSpec change.")
      expect(implement.options.changes).toEqual(["add-login"])
      expect(implement.options.plan?.openspec?.changeIds).toEqual(["add-login"])
    }

    const review = await parseCommand(["--dir", repo, "-p", "review", "--change", "add-login"])
    expect(review.type).toBe("run")
    if (review.type === "run") {
      expect(review.options.prompt).toBe("Review the attached OpenSpec change.")
    }
  })

  test("a positional prompt beats the defaultPrompt", async () => {
    const cmd = await parseCommand(["-p", "review", "--manual", "my own prompt"])
    expect(cmd.type).toBe("run")
    if (cmd.type === "run") {
      expect(cmd.options.prompt).toBe("my own prompt")
      expect(cmd.options.plan?.prompt.source).toBe("inline")
    }
  })

  test("an explicitly empty positional prompt does not fall back to defaultPrompt", async () => {
    await expect(parseCommand(["-p", "review", ""])).rejects.toThrow("need a prompt")
  })

  test("--prompt-file beats the defaultPrompt and is marked as file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-prompt-"))
    dirs.push(dir)
    const promptFile = join(dir, "prd.md")
    await writeFile(promptFile, "from file")
    const cmd = await parseCommand(["-p", "review", "--manual", "--prompt-file", promptFile])
    expect(cmd.type).toBe("run")
    if (cmd.type === "run") {
      expect(cmd.options.prompt).toBe("from file")
      expect(cmd.options.plan?.prompt.source).toBe("file")
    }
  })

  test("an explicitly empty prompt file does not fall back to defaultPrompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-empty-prompt-"))
    dirs.push(dir)
    const promptFile = join(dir, "prd.md")
    await writeFile(promptFile, "")
    await expect(parseCommand(["-p", "review", "--prompt-file", promptFile])).rejects.toThrow("need a prompt")
  })

  test("an empty --resume value is rejected instead of starting a default-prompt run", async () => {
    await expect(parseCommand(["-p", "review", "--resume="])).rejects.toThrow("invalid run id")
  })

  async function writeGlobalConfig(body: string): Promise<void> {
    const home = process.env.CONVOY_HOME
    if (!home) throw new Error("CONVOY_HOME must be set by beforeEach")
    await mkdir(join(home, ".convoy"), { recursive: true })
    await writeFile(join(home, ".convoy", "config.yaml"), body)
  }

  test("falls back through defaults.pipeline to a configured pipeline's defaultPrompt", async () => {
    await writeGlobalConfig(
      [
        "defaults:",
        "  pipeline: triage",
        "pipelines:",
        "  triage:",
        "    description: Triage incoming reports",
        "    defaultPrompt: Triage the incoming reports and summarize.",
        "    steps:",
        "      - implementer",
      ].join("\n"),
    )
    const cmd = await parseCommand(["--manual"])
    expect(cmd.type).toBe("run")
    if (cmd.type === "run") {
      expect(cmd.options.prompt).toBe("Triage the incoming reports and summarize.")
      expect(cmd.options.plan?.prompt.source).toBe("default")
    }
  })

  test("a configured pipeline shadowing a built-in name hides its defaultPrompt", async () => {
    // The project's review replaces the built-in wholesale, so the built-in's
    // defaultPrompt must not leak through the fallback.
    await writeGlobalConfig(
      ["pipelines:", "  review:", "    description: Project review", "    steps:", "      - patterns"].join("\n"),
    )
    await expect(parseCommand(["-p", "review"])).rejects.toThrow("need a prompt")
  })

  test("an unknown pipeline surfaces its error instead of the prompt error", async () => {
    await expect(parseCommand(["-p", "nope"])).rejects.toThrow('unknown pipeline "nope"')
  })

  test("requesting goal-fix directly never starts a run and lists it nowhere", async () => {
    // `goal-fix` is reserved: goal fragments are internal to the owning
    // pipeline's terminal goal step, so there is no public pipeline by that
    // name to select through the CLI, launcher, plan-only, retry, or resume.
    await expect(parseCommand(["-p", "goal-fix", "build it"])).rejects.toThrow('unknown pipeline "goal-fix"')
    expect(Object.keys(builtInPipelines)).not.toContain("goal-fix")
  })
})

describe("resolveRunOptions", () => {
  test("uses explicit maxConcurrentAgents", async () => {
    const parsed = parseArgs(["--max-concurrent", "5"])
    const options = await resolveRunOptions(parsed)
    expect(options.maxConcurrentAgents).toBe(5)
  })

  test("resolves humanReview from TTY", async () => {
    const parsed = parseArgs(["--no-human-review"])
    const options = await resolveRunOptions(parsed)
    expect(options.humanReview).toBe(false)
  })

  test("resolves planOnly from flag", async () => {
    const parsed = parseArgs(["--plan"])
    const options = await resolveRunOptions(parsed)
    expect(options.planOnly).toBe(true)
  })

  test("resolves noConfirm from flag", async () => {
    const parsed = parseArgs(["--no-confirm"])
    const options = await resolveRunOptions(parsed)
    expect(options.noConfirm).toBe(true)
  })
})

describe("goalModeFor", () => {
  // Goal execution is enabled exclusively by the pipeline's own terminal goal
  // step; there is no run flag, no toggle, and no separate goal-fix pipeline to
  // resolve. The resolver validated the step's structure and fragment roles.
  const ship = resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents })
  const review = resolvePipeline({ name: "review", spec: builtInPipelines.review!, agents: builtInAgents })
  const implement = resolvePipeline({ name: "implement", spec: builtInPipelines.implement!, agents: builtInAgents })

  function planWith(pipeline: Pipeline): RunPlan {
    return { pipeline } as RunPlan
  }

  test("is off when the pipeline has no goal step", () => {
    expect(goalModeFor(planWith(implement))).toEqual({ mode: "off" })
    expect(goalModeFor(planWith(review))).toEqual({ mode: "off" })
  })

  test("is on for ship, whose terminal goal step declares target 85 with defaults", () => {
    expect(goalModeFor(planWith(ship))).toEqual({ mode: "on", goal: 85, maxIterations: 3, plateau: 3 })
  })

  test("is off for a pipeline whose goal step is absent even when it ends in a score", () => {
    const reviewScored = resolvePipeline({ name: "review", spec: builtInPipelines.review!, agents: builtInAgents })
    // review ends in a quality-score-report step but declares no goal step:
    // ending in a score alone no longer implies goal execution.
    expect(goalModeFor(planWith(reviewScored)).mode).toBe("off")
  })
})
