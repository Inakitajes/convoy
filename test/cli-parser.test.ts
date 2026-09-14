import { describe, expect, test } from "bun:test"

import { parseArgs, parseCommand, resolveRunOptions } from "../src/cli"

describe("resolveRunOptions", () => {
  test("returns options with defaults applied", async () => {
    const parsed = {
      files: [],
      onlySteps: [],
      skipSteps: [],
      targetDir: process.cwd(),
      keepRunDir: undefined,
      modelOverride: undefined,
      advisorOverride: undefined,
      advisorDisabled: undefined,
      tui: undefined,
      notify: undefined,
      humanReview: undefined,
      maxConcurrent: undefined,
      baseRef: undefined,
      worktree: undefined,
      branch: undefined,
      baseDetectionDir: undefined,
      includeDirty: undefined,
      yolo: undefined,
      smart: undefined,
      smartModel: undefined,
      gateway: undefined,
      planOnly: undefined,
      noConfirm: undefined,
      resumeRunID: undefined,
      pipeline: undefined,
      prompt: undefined,
      promptFile: undefined,
      help: undefined,
      advisor: undefined,
      changes: [],
    }

    const options = await resolveRunOptions(parsed)
    expect(options.targetDir).toBe(process.cwd())
    expect(options.files).toEqual([])
    expect(options.pipeline).toBeDefined()
    expect(options.pipeline.steps.length).toBeGreaterThan(0)
    expect(typeof options.gateway).toBe("string")
  })

  test("--change carries into resolved run options", async () => {
    const options = await resolveRunOptions({
      files: [],
      onlySteps: [],
      skipSteps: [],
      targetDir: process.cwd(),
      keepRunDir: undefined,
      modelOverride: undefined,
      advisorOverride: undefined,
      advisorDisabled: undefined,
      tui: undefined,
      notify: undefined,
      humanReview: undefined,
      maxConcurrent: undefined,
      baseRef: undefined,
      worktree: undefined,
      branch: undefined,
      baseDetectionDir: undefined,
      includeDirty: undefined,
      yolo: undefined,
      smart: undefined,
      smartModel: undefined,
      gateway: undefined,
      planOnly: undefined,
      noConfirm: undefined,
      resumeRunID: undefined,
      pipeline: undefined,
      prompt: undefined,
      promptFile: undefined,
      help: undefined,
      changes: ["add-login"],
    })
    expect(options.changes).toEqual(["add-login"])
  })

  test("parseArgs collects repeatable --change ids in order and --manual as a flag", () => {
    expect(parseArgs(["--change", "add-b", "--change", "add-a"]).changes).toEqual(["add-b", "add-a"])
    expect(parseArgs(["--change=add-bar"]).changes).toEqual(["add-bar"])
    expect(parseArgs(["--manual"]).manual).toBe(true)
    expect(parseArgs([]).changes).toEqual([])
  })

  test("parseCommand routes opencode install; unknown subcommands and extras are usage errors", async () => {
    expect(await parseCommand(["opencode", "install"])).toEqual({ type: "opencode-install" })
    await expect(parseCommand(["opencode", "install", "--force"])).rejects.toThrow("usage: convoy opencode install")
    await expect(parseCommand(["opencode", "uninstall"])).rejects.toThrow("usage: convoy opencode install")
    const help = await parseCommand(["opencode", "--help"])
    expect(help.type).toBe("help")
    if (help.type === "help") expect(help.text).toContain("convoy opencode install")
  })

  test("parseCommand accepts specs with no arguments and rejects extras", async () => {
    expect(await parseCommand(["specs"])).toEqual({ type: "specs", targetDir: process.cwd() })
    await expect(parseCommand(["specs", "--flag"])).rejects.toThrow("usage: convoy specs")
    await expect(parseCommand(["specs", "extra"])).rejects.toThrow("usage: convoy specs")
  })

  test("parseCommand keeps control as the worktree control board alias", async () => {
    expect(await parseCommand(["control"])).toEqual({ type: "worktrees", args: [] })
    await expect(parseCommand(["control", "extra"])).rejects.toThrow("usage: convoy control")
  })

  test("the retired --feature flag fails before any plan is built", () => {
    // Feature-ID selectors are retired (capability feature-lifecycle): the
    // refusal happens in the parser, before plan review or any side effect.
    expect(() => parseArgs(["--feature", "f-1"])).toThrow(/retired flag: --feature/)
    expect(() => parseArgs(["--feature=f-1"])).toThrow(/retired flag: --feature/)
    expect(() => parseArgs(["--feature", "f-1", "prompt"])).toThrow(/convoy worktrees run/)
  })

  test("parseCommand parses spin flags into SpinOptions", async () => {
    const command = await parseCommand(["spin", "--change", "add-foo", "--prefix", "fix"])
    expect(command.type).toBe("spin")
    const options = (command as { options: { changeID?: string; prefix?: string; targetDir: string } }).options
    expect(options.changeID).toBe("add-foo")
    expect(options.prefix).toBe("fix")
    expect(options.targetDir).toBe(process.cwd())
    expect((await parseCommand(["spin"])).type).toBe("spin")
    expect(((await parseCommand(["spin", "--change=add-bar"])) as { options: { changeID?: string } }).options.changeID).toBe("add-bar")
  })

  test("parseCommand rejects malformed spin arguments", async () => {
    await expect(parseCommand(["spin", "--change"])).rejects.toThrow("--change requires a change id")
    await expect(parseCommand(["spin", "--prefix"])).rejects.toThrow("--prefix requires")
    await expect(parseCommand(["spin", "surprise"])).rejects.toThrow("usage: convoy spin")
  })

  test("spin --help explains its usage", async () => {
    const command = await parseCommand(["spin", "--help"])
    expect(command.type).toBe("help")
    if (command.type === "help") expect(command.text).toContain("convoy spin")
  })
})

describe("convoy publish parsing", () => {
  test("parses defaults, values, and inline flags", async () => {
    expect(await parseCommand(["publish"])).toEqual({ type: "publish", options: { yes: false, dryRun: false } })
    expect(await parseCommand(["publish", "--worktree", "/repo", "--run-dir", "/runs/x", "--yes"])).toEqual({
      type: "publish",
      options: { worktree: "/repo", runDir: "/runs/x", yes: true, dryRun: false },
    })
    expect(await parseCommand(["publish", "--run", "20260912-164500-abcd", "--dry-run"])).toEqual({
      type: "publish",
      options: { runId: "20260912-164500-abcd", yes: false, dryRun: true },
    })
    expect(await parseCommand(["publish", "--title=feat: X", "--body=why"])).toEqual({
      type: "publish",
      options: { title: "feat: X", body: "why", yes: false, dryRun: false },
    })
  })

  test("rejects unknown flags, conflicting modes, and incomplete overrides", async () => {
    await expect(parseCommand(["publish", "--nope"])).rejects.toThrow("usage: convoy publish")
    await expect(parseCommand(["publish", "--yes", "--dry-run"])).rejects.toThrow("either --yes")
    await expect(parseCommand(["publish", "--title", "feat: X"])).rejects.toThrow("--title and --body must be provided together")
    await expect(parseCommand(["publish", "--run-dir", "/a", "--run", "20260912-164500-abcd"])).rejects.toThrow("either --run-dir or --run")
    await expect(parseCommand(["publish", "--run", "not-an-id"])).rejects.toThrow("invalid run id")
  })

  test("publish --help explains its usage", async () => {
    const command = await parseCommand(["publish", "--help"])
    expect(command.type).toBe("help")
    if (command.type === "help") expect(command.text).toContain("convoy publish")
  })
})
