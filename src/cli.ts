import { readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { advisorAuthOf, authoringHarnessOf, runnerAuthOf, buildAgentRegistry, ejectAgentPrompt, emptyHooksConfig, featuresOf, globalConfigPath, loadMergedConvoyConfig, loadPipelineFile, pipelineDefaultsOf, selectPipelineSpec, writeDefaultGlobalConfig, writeDefaultProjectConfig, type ConvoyDefaults } from "./config"
import { readControlFile } from "./control-client"
import { detectBaseRef, currentBranch, listChangedFiles, worktreeDefaultFor } from "./git"
import { openRouterKeySources } from "./limits"
import { log } from "./log"
import { builtInAgents, defaultGptModel, defaultGptVariant, defaultPipeline, defaultPipelineName, hasWritableStep, resolvePipeline, splitModelVariant, validateStepFilters } from "./pipeline"
import { consensusStep } from "./quality-score"
import { defaultMaxConcurrentAgents, parseModel } from "./runner"
import { buildRunPlan, defaultHelperRoute, soleCliRunner, type BuildRunPlanInput } from "./run-plan"
import { parseModelOverride } from "./step-runners"
import { helperModel } from "./helper-routes"
import { defaultCommitMessageModel } from "./commit-message"
import { confirmRunPlan, renderRunPlan } from "./run-review"
import { loadPrdHistoryPreview } from "./prd-history"
import { loadOpenSpecBundle, openSpecPromptFor } from "./openspec"
import { isModelGateway, modelGatewayChoices, modelGateways, type ModelGateway } from "./model-routing"
import { browseRuns, isControlLive, isServerLive } from "./runs"
import { browseSpecs, buildIterateSessionInput, loadSpecsView, type SpecsResolution, type SpecsResumeSelection } from "./specs"
import { deleteKeychainSecret, keychainAvailable, storeKeychainSecret } from "./secrets"
import type { Pipeline, RunOptions, RunPlan } from "./types"
import { isValidRunID, resumeWorkspace } from "./workspace"
import { readRunMetadata, type RunMetadata } from "./metadata"
import { preflightRunPlan } from "./preflight"
import type { LaunchBranchCheck, LaunchBranchProposal, LaunchFeaturePreset, LaunchRunPreparation, LaunchRunSelection } from "./launch-tui"
import type { SpinOptions } from "./spin"
import type { PublishCommandOptions } from "./publish-command"
import { formatVersion } from "./version"
import type { UpdateResult } from "./update"
import type { TuiRoute } from "./tui-session"
import type { HomeDestination, HomeResolution, HomeWorkAction } from "./home-tui"
import type { LocalActiveChange, ReadResult } from "./checkout-openspec"
import type { RunsCommand } from "./runs-command"
import type { SkillTarget } from "./skill-install"

/**
 * Flags as written: every scalar stays undefined until the user sets it, so
 * resolveRunOptions can tell "flag given" from "flag at its default" and apply
 * the precedence chain flag > .convoy/config.yaml defaults > built-in default.
 */
export type ParsedArgs = {
  prompt?: string
  promptFile?: string
  help?: boolean
  pipeline?: string
  /** --pipeline-file: run a pipeline defined in its own YAML file instead of a named one. */
  pipelineFile?: string
  files: string[]
  onlySteps: string[]
  skipSteps: string[]
  resumeRunID?: string
  keepRunDir?: boolean
  modelOverride?: string
  /** --advisor: force an advising model on every eligible step, whatever config says. */
  advisorOverride?: string
  /** --no-advisor: run every step without an advisor, whatever config says. */
  advisorDisabled?: boolean
  tui?: boolean
  notify?: boolean
  humanReview?: boolean
  maxConcurrent?: number
  baseRef?: string
  /** --worktree / --no-worktree: isolate the run on a fresh branch in its own worktree. */
  worktree?: boolean
  /** --branch: pin the worktree branch name instead of asking the naming model for one. */
  branch?: string
  /**
   * Repo to auto-detect the base ref in when it differs from targetDir. TUI
   * worktree runs point targetDir at the fresh worktree, whose checked-out
   * branch is the new agent branch — the current-branch fallback must look at
   * the original repo instead.
   */
  baseDetectionDir?: string
  targetDir: string
  includeDirty?: boolean
  yolo?: boolean
  smart?: boolean
  smartModel?: string
  gateway?: ModelGateway
  planOnly?: boolean
  noConfirm?: boolean
  /** --detach: return once the coordinator is up instead of streaming the run to its end. */
  detach?: boolean
  /** --change: explicit OpenSpec change ids, in review order (repeatable); selection is explicit only. */
  changes: string[]
  /** --manual: the explicit no-change run mode (valid with zero selected changes). */
  manual?: boolean
}

export type InitOptions = {
  targetDir: string
  global: boolean
  force: boolean
  quiet: boolean
}

export type CliCommand =
  | { type: "help"; text: string }
  | { type: "run"; options: RunOptions }
  | { type: "runs"; runID?: string }
  | { type: "runs-query"; command: Exclude<RunsCommand, { kind: "browse" }> }
  | { type: "pipelines"; targetDir: string; json: boolean; name?: string; pipelineFile?: string }
  | { type: "skill"; action: "install" | "uninstall"; targets: SkillTarget[] }
  | { type: "skill-show"; file?: string }
  | { type: "specs"; targetDir: string }
  | { type: "spin"; options: SpinOptions }
  | { type: "opencode-install" }
  | { type: "close"; args: string[] }
  | { type: "worktrees"; args: string[] }
  | { type: "publish"; options: PublishCommandOptions }
  | { type: "retired-feature"; args: string[] }
  | { type: "config"; targetDir: string }
  | { type: "init"; options: InitOptions }
  | { type: "agents"; action: "eject"; agentName: string; options: InitOptions }
  | { type: "retired-finish" }
  | { type: "auth"; provider: "openrouter"; action: "set" | "remove" | "status" }
  | { type: "version" }
  | { type: "update"; checkOnly: boolean }
  | { type: "coordinate"; launchPath: string }
  | { type: "hook" }
  | { type: "mcp"; args: string[] }

export async function parseAndRun(argv: string[]) {
  if (shouldLaunchHome(argv, process.stdin.isTTY, process.stdout.isTTY)) {
    await runHomeSession(process.cwd())
    return
  }

  const command = await parseCommand(argv)
  if (command.type === "coordinate") {
    // Internal: the detached coordinator's child boot (`--coordinate` is not
    // advertised in --help). CONVOY_COORDINATE_READY points at the parent's
    // ready file, which ControlProgress writes as soon as the run exists.
    const { runCoordinateBoot } = await import("./coordinate")
    const code = await runCoordinateBoot(command.launchPath, process.env.CONVOY_COORDINATE_READY)
    process.exitCode = code
    return
  }
  if (command.type === "help") {
    process.stdout.write(command.text)
    return
  }
  if (command.type === "version") {
    process.stdout.write(`${formatVersion()}\n`)
    return
  }
  if (command.type === "update") {
    const { runUpdate } = await import("./update")
    writeUpdateResult(await runUpdate({ checkOnly: command.checkOnly }))
    return
  }
  if (command.type === "runs") {
    await openRunsBrowser(command.runID)
    return
  }
  if (command.type === "runs-query") {
    const { printRunsJson, runAction, waitForRun } = await import("./runs-command")
    const query = command.command
    if (query.kind === "json") await printRunsJson(query.runID)
    else if (query.kind === "wait") process.exitCode = await waitForRun(query.runID, { timeoutMs: query.timeoutMs, json: query.json })
    else await runAction(query.runID, query.action)
    return
  }
  if (command.type === "pipelines") {
    const { runPipelinesCommand } = await import("./pipelines-command")
    await runPipelinesCommand(command)
    return
  }
  if (command.type === "skill") {
    const { runSkillCommand } = await import("./skill-install")
    process.exitCode = await runSkillCommand(command.action, command.targets)
    return
  }
  if (command.type === "skill-show") {
    const { skillFileText } = await import("./skill-install")
    process.stdout.write(skillFileText(command.file))
    return
  }
  if (command.type === "specs") {
    await assertSpecsEnabled(command.targetDir, "convoy specs")
    await openSpecsBrowser(command.targetDir)
    return
  }
  if (command.type === "spin") {
    await assertSpecsEnabled(command.options.targetDir, "convoy spin")
    const { runSpin, printSpinHandoff } = await import("./spin")
    const result = await runSpin(command.options)
    printSpinHandoff(result)
    return
  }
  if (command.type === "opencode-install") {
    const { runOpencodeInstallCommand } = await import("./opencode-install")
    await runOpencodeInstallCommand()
    return
  }
  if (command.type === "hook") {
    const { runHookCommand } = await import("./runners/commands")
    await runHookCommand()
    return
  }
  if (command.type === "mcp") {
    const { runMcpCommand } = await import("./runners/commands")
    await runMcpCommand(command.args)
    return
  }
  if (command.type === "close") {
    const { parseCloseCommandArgs, runCloseCommandFromArgs } = await import("./worktree-commands")
    await runCloseCommandFromArgs(parseCloseCommandArgs(command.args))
    return
  }
  if (command.type === "worktrees") {
    const { runWorktreesCommand, parseWorktreesArgs } = await import("./worktree-commands")
    if (command.args.length === 0) {
      await runWorktreesCommand({ kind: "inventory" })
      return
    }
    if (command.args[0] === "--help" || command.args[0] === "-h") {
      const { worktreesHelp } = await import("./worktree-commands")
      process.stdout.write(worktreesHelp())
      return
    }
    const parsed = parseWorktreesArgs(command.args)
    // The worktree-scoped run delegates to the launcher this process already
    // owns (design D4: one run path, explicit execution checkout and change
    // selection); the parser above has already required the explicit mode.
    if (parsed.kind === "run") {
      await runWorktreeScopedRun(parsed)
      return
    }
    await runWorktreesCommand(parsed)
    return
  }
  if (command.type === "publish") {
    // The explicit headless publication request (capability run-finalization):
    // the only way a non-interactive run is published. The seam it wraps keeps
    // every current-target/provenance/recovery guard the dashboard has.
    const { runPublishCommand } = await import("./publish-command")
    process.exitCode = await runPublishCommand(command.options)
    return
  }
  if (command.type === "retired-feature") {
    process.stderr.write(`${retiredFeatureDiagnostic(command.args)}\n`)
    process.exitCode = 1
    return
  }
  if (command.type === "config") {
    await openConfigEditor(command.targetDir)
    return
  }
  if (command.type === "auth") {
    await runAuthCommand(command.action)
    return
  }
  if (command.type === "retired-finish") {
    process.stderr.write(`${retiredFinishDiagnostic()}\n`)
    process.exitCode = 1
    return
  }
  if (command.type === "init") {
    const result = command.options.global
      ? await writeDefaultGlobalConfig(command.options.force)
      : await writeDefaultProjectConfig(command.options.targetDir, command.options.force)
    if (!command.options.quiet) {
      const scope = command.options.global ? "global config" : "project config"
      process.stdout.write(`${result.created ? "created" : "ensured"} ${scope}: ${result.path}\n`)
    }
    return
  }
  if (command.type === "agents") {
    const configDir = command.options.global ? dirname(globalConfigPath()) : join(command.options.targetDir, ".convoy")
    const result = await ejectAgentPrompt(configDir, command.agentName, command.options.force)
    if (!command.options.quiet) {
      process.stdout.write(
        result.created
          ? `ejected ${command.agentName}: ${result.path}\n\nThis file now overrides the built-in prompt and will keep doing so across upgrades. Delete it to go back to the built-in.\n`
          : `${result.path} already exists; pass --force to overwrite it\n`,
      )
    }
    return
  }

  const plan = command.options.plan ?? (await buildReviewedPlan(command.options))
  if (command.options.planOnly) {
    process.stdout.write(renderRunPlan(plan))
    return
  }
  // A pipeline named "goal-fix" is reserved: goal fragments are internal to the
  // owning pipeline's terminal goal step, so no public pipeline by that name
  // exists and requesting one must never start an unbriefed improvement flow.
  if (plan.pipeline.name === "goal-fix") {
    throw new Error('no public pipeline named "goal-fix" exists; goal fragments are internal to a pipeline\'s terminal goal step — run a pipeline that declares one (e.g. convoy -p ship).')
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (interactive && !command.options.noConfirm) {
    if (!(await confirmRunPlan(plan))) {
      log.info("Run cancelled")
      return
    }
  } else {
    process.stdout.write(renderRunPlan(plan, true))
  }
  // Without an auto-attached dashboard nobody answers a permission request:
  // it holds until someone opens the run. Say so before an agent or script
  // starts a run that would otherwise go quiet at its first ask.
  if (plan.permissions === "interactive" && !(command.options.tui && process.stdout.isTTY)) {
    log.warn("permissions: interactive — requests wait for an answer (`convoy runs <id> approve|deny <request>`, or the `convoy runs` dashboard); pass --smart or --yolo for an unattended run")
  }
  await preflightRunPlan(plan, undefined, { reviewed: interactive && !command.options.noConfirm })
  // Nothing has touched the repo yet; the worktree is the first effect, and only
  // once the plan has been accepted.
  let options = command.options
  if (options.worktree) {
    const { ensureRepoReady } = await import("./git")
    await ensureRepoReady(options.targetDir, { baseRef: options.baseRef, allowDirty: true })
    options = await prepareWorktreeForRun(options.targetDir, options)
  }
  // Managed writer ownership (design D5): a pipeline that can write refuses
  // to start in a checkout whose live claim another managed writer holds.
  await refuseConflictingWriter(options.targetDir, plan)
  await executeRun(options, plan)
}

/**
 * Refuses to start a managed writer in a checkout that another managed
 * writer's live claim already covers (capability work-conversations, design
 * D5). Uncertain claims refuse with reconciliation guidance — never an
 * unconditional takeover; unrelated checkouts are unaffected.
 */
async function refuseConflictingWriter(executionDir: string, plan: RunPlan): Promise<void> {
  if (!hasWritableStep(plan.pipeline)) return
  const { repoCommonDir } = await import("./repo-store")
  const { readWriterClaim, claimLiveness, writerConflictGuidance } = await import("./writer-claims")
  const commonDir = await repoCommonDir(executionDir).catch(() => undefined)
  if (!commonDir) return
  const { currentBranch } = await import("./git")
  const branch = plan.target.branch ?? (await currentBranch(executionDir).catch(() => undefined))
  if (!branch) return
  const claim = await readWriterClaim(commonDir, branch)
  if (claim.status !== "found") return
  if (claimLiveness(claim.value) === "live") {
    throw new Error(writerConflictGuidance(claim.value).join("\n"))
  }
}

/** Only a truly bare invocation with interactive input and output owns the home screen. */
export function shouldLaunchHome(argv: readonly string[], stdinTTY: boolean | undefined, stdoutTTY: boolean | undefined): boolean {
  return argv.length === 0 && stdinTTY === true && stdoutTTY === true
}

/**
 * The Home worktree actions that mutate the checkout's evidence. After one of
 * these, the session invalidates that checkout's cached fingerprint so the next
 * gated refresh recomputes it instead of trusting a possibly stale token.
 */
const mutatingHomeActions: ReadonlySet<HomeWorkAction> = new Set<HomeWorkAction>([
  "fetch",
  "sync",
  "push",
  "pr",
  "squash",
  "archive",
  "close",
  "remove",
])

/** One alternate-screen owner routes every destination until Home itself quits. */
/**
 * The session loop when the launcher is the first screen: every return from a
 * destination or a run reopens it, and leaving the launcher itself ends it.
 */
export async function runRootLauncherLoop(launch: () => Promise<"quit" | "continue">, interrupted: () => boolean): Promise<void> {
  while (!interrupted()) {
    if ((await launch()) === "quit") return
  }
}

/** Refuses an OpenSpec-only command in a project that turned specs off. */
async function assertSpecsEnabled(targetDir: string, command: string): Promise<void> {
  if (featuresOf(await loadMergedConvoyConfig(targetDir).catch(() => undefined)).specs) return
  throw new Error(`${command} needs OpenSpec, which this project turned off (features.specs: false)`)
}

async function runHomeSession(targetDir: string): Promise<void> {
  // Probe the Kitty graphics protocol before the session renderer takes
  // stdin; over SSH the client's environment doesn't travel, so the terminal
  // itself has to answer.
  const { probeKittyGraphics } = await import("./kitty-graphics")
  const kittyGraphics = await probeKittyGraphics()
  const [{ launchHomeTui }, { createTuiSession }] = await Promise.all([import("./home-tui"), import("./tui-session")])
  const session = await createTuiSession(kittyGraphics)
  // One repository-scoped board source per Home session (change
  // `live-board-cache-and-refresh`, design D3): cache-first paints and the
  // continuous background refresh both ride it, and it outlives individual
  // Home opens so returning is instant.
  const { BoardSource } = await import("./board-refresh")
  const boardSource = new BoardSource({ targetDir })
  let interrupted = false
  const route: TuiRoute = {
    session,
    onInterrupt: () => {
      interrupted = true
    },
  }
  // Within one session, returning to Home reopens on the checkout the operator
  // was viewing, by verified identity; the first open passes none and selects
  // New worktree. Persisted hints stay non-authoritative and never drive this.
  let lastSelection: { path: string; branch?: string } | undefined
  const features = featuresOf(await loadMergedConvoyConfig(targetDir).catch(() => undefined))

  try {
    // Without worktree management the session opens on Pipelines: the
    // launcher is the root screen, reaching Runs, Config, and (when on) Specs,
    // and its q ends the session.
    if (!features.worktrees) {
      await runRootLauncherLoop(() => launchInteractiveRun(targetDir, undefined, undefined, route, { root: true, specsDestination: features.specs }), () => interrupted)
      return
    }
    await runHomeNavigationLoop({
      interrupted: () => interrupted,
      route,
      targetDir,
      // Every Home open — the first launch and each return from a destination —
      // covers a genuinely slow context load with the shared loading transition.
      loadHome: () => loadHomeWithTransition(route, targetDir, () => homeWorkContext(targetDir, boardSource)),
      openHome: (context) =>
        launchHomeTui(targetDir, {
          route,
          kittyGraphics,
          source: boardSource,
          worktrees: context.worktrees,
          builtAt: context.builtAt,
          initialWorktree: lastSelection,
          onWorktreeSelected: (selection) => {
            lastSelection = selection
          },
          specs: features.specs,
        }),
      openWork: async (worktree, action) => {
        await dispatchWorkAction(targetDir, route, worktree, action)
        // A mutating action changed this checkout's evidence; invalidating its
        // fingerprint makes the next gated Home refresh recompute it even if a
        // same-size, mtime-preserving edit would look unchanged (change
        // `live-board-cache-and-refresh`).
        if (mutatingHomeActions.has(action)) boardSource.invalidate(worktree)
      },
      openRun: async (worktree, runId) => {
        // A run entry opens the runs browser on that run: the dashboard
        // focuses it; history and retry stay one esc away.
        await openRunsBrowser(runId, route)
      },
      openChange: async (worktree, changeId) => {
        // A linked change opens the specs browser restored on that change's
        // row — the identity-keyed resume, never a position guess. The home
        // session's board source is shared so the specs board is cache-warm.
        await openSpecsBrowser(targetDir, route, { changeId, checkout: worktree }, boardSource)
      },
      createWork: async (draft) => {
        await createWorkFromDraft(targetDir, route, draft)
      },
      openDestination: async (selection) => {
        if (selection === "pipelines") await launchInteractiveRun(targetDir, undefined, undefined, route)
        else if (selection === "specs") await openSpecsBrowser(targetDir, route, undefined, boardSource)
        else if (selection === "runs") await openRunsBrowser(undefined, route)
        else await openConfigEditor(targetDir, route)
      },
    })
  } finally {
    session.destroy()
  }
}

/** The resolved context Home opens with: the worktree rows and their freshness. */
export type HomeContext = {
  worktrees: import("./control-board").BoardWorktree[]
  /** When the displayed board was assembled (the age Home discloses). */
  builtAt?: number
}

/**
 * The context Home opens with (task 3.1): a warm cache paints immediately and
 * kicks a background refresh through the launcher's own poll timer; a cold or
 * unusable cache performs the first assembly (which the loading transition
 * covers) and stores it. Without a source (tests, non-session callers) this is
 * the original one-shot assembly.
 */
export async function homeWorkContext(targetDir: string, source?: import("./board-refresh").BoardSource): Promise<HomeContext> {
  if (!source) {
    const { assembleControlBoard } = await import("./control-board")
    const board = await assembleControlBoard(targetDir)
    return { worktrees: board.worktrees }
  }
  const cached = await source.cached()
  if (cached) return { worktrees: cached.board.worktrees, builtAt: cached.builtAt }
  const result = await source.refresh()
  return { worktrees: result.snapshot.board.worktrees, builtAt: result.snapshot.builtAt }
}

/**
 * The home session's context load wrapped in the shared loading transition —
 * the same convoy-current handoff the destinations use, so the first launch and
 * every return to Home cover a genuinely slow control-board load instead of
 * freezing on the previous frame. Fast loads and non-interactive paths never
 * see it. A Ctrl+C during the transition has already flagged the session's
 * interrupt; this loader answers undefined so the navigation loop exits
 * quietly instead of opening Home.
 */
export async function loadHomeWithTransition(
  route: TuiRoute,
  targetDir: string,
  load: () => Promise<HomeContext> = () => homeWorkContext(targetDir),
  options: { thresholdMs?: number; reducedMotion?: boolean | (() => boolean | Promise<boolean>) } = {},
): Promise<HomeContext | undefined> {
  const { withLoadingTransition, isLoadingInterrupted } = await import("./loading-transition")
  try {
    // Home's wordmark is the brand (CONVOY); the destination stays "home" for
    // the status line and the failure messages.
    return await withLoadingTransition(route, "CONVOY", load, { targetDir, label: "home", ...options })
  } catch (error) {
    if (!isLoadingInterrupted(error)) throw error
    return undefined
  }
}

/**
 * The `convoy worktrees run` entry (design D4, gap CC-10): the explicit
 * execution checkout and the explicit ordered change selection (or the
 * explicit manual/no-change mode the parser required) drive the standard
 * launcher against that checkout. A missing selected source stops — never a
 * same-id copy from another checkout, never a launch-directory fallback.
 */
async function runWorktreeScopedRun(command: { worktree: string; changes: string[]; manual: boolean }): Promise<void> {
  const { observeCheckoutTarget } = await import("./worktree-target")
  try {
    await observeCheckoutTarget(command.worktree)
  } catch (error) {
    throw new Error(`the selected checkout is not a valid target: ${error instanceof Error ? error.message : String(error)}`)
  }
  const { validateRunSelection } = await import("./worktree-commands")
  await validateRunSelection(command.worktree, command.changes)
  const { currentBranch } = await import("./git")
  const branch = await currentBranch(command.worktree)
  const preset = branch ? { worktreeDir: command.worktree, branch, contracts: command.changes } : undefined
  // The full ordered selection rides into the launcher and the durable plan:
  // `--change B --change A` reviews and freezes B then A, never just the first.
  await launchInteractiveRun(process.cwd(), command.changes, preset, undefined)
  process.stdout.write(`run prepared against ${command.worktree}${command.changes.length > 0 ? ` with ${command.changes.join(", ")}` : " (manual/no-change mode)"}\n`)
}

/** Runs one worktree detail action from Home: every action targets the same validated checkout. */
export async function dispatchWorkAction(targetDir: string, route: TuiRoute, worktree: string, action: HomeWorkAction): Promise<void> {
  // Fresh target validation before any effect: the row was observed at view
  // load; the action re-observes so a moved/removed checkout reports instead
  // of executing against a replacement (capability work-context delta).
  const { observeCheckoutTarget } = await import("./worktree-target")
  let branch: string | undefined
  let observedTarget: import("./worktree-target").ObservedCheckoutTarget | undefined
  try {
    const target = await observeCheckoutTarget(worktree)
    branch = target.branch
    observedTarget = target
  } catch (error) {
    const { showNoticeTui } = await import("./notice-tui")
    await showNoticeTui(route, {
      title: "worktree unavailable",
      message: `${worktree} is no longer a valid checkout:\n${error instanceof Error ? error.message : String(error)}\n\nRefresh the Worktrees list and reselect.`,
    })
    return
  }
  // The acted-on checkout becomes the last-selection hint (task 3.3): a
  // non-authoritative navigation hint, restored only when it still verifies.
  if (observedTarget) {
    const { repoCommonDir } = await import("./repo-store")
    const { saveLastSelection } = await import("./session-hints")
    const commonDir = await repoCommonDir(targetDir).catch(() => undefined)
    if (commonDir) await saveLastSelection(commonDir, observedTarget).catch(() => {})
  }
  if (action === "conversation") {
    await openCheckoutConversation({ launchDir: targetDir, route, checkout: worktree, displayName: branch ?? "worktree" })
    return
  }
  if (action === "conversation-external") {
    await openCheckoutConversationExternal({ launchDir: targetDir, route, checkout: worktree, branch: branch ?? "" })
    return
  }
  if (action === "propose") {
    await proposeInCheckout({ launchDir: targetDir, route, checkout: worktree, branch: branch ?? "", displayName: branch ?? "worktree" })
    return
  }
  if (action === "pipeline") {
    // The worktree-scoped pipeline launch reuses the validated checkout and
    // its actual branch; change selection stays an explicit launcher decision.
    await launchInteractiveRun(targetDir, undefined, { worktreeDir: worktree, branch: branch ?? "" }, route)
    return
  }
  if (action === "close") {
    const { runWorktreeClose } = await import("./worktree-commands")
    const { detectBaseRef } = await import("./git")
    const detected = await detectBaseRef(targetDir).catch(() => undefined)
    const base = detected?.ref
    if (!base) {
      await reportHandoffBlocker("no base could be detected for close — pass an explicit base with `convoy worktrees close --base <ref>`", [], route)
      return
    }
    // The archive set is the checkout's own active changes, read fresh here and
    // disclosed in the confirmation before any effect (capability feature-close:
    // an explicit archive set, never a silent zero-archive from the menu path).
    const { readCheckoutActiveChanges } = await import("./checkout-openspec")
    const archive = await readCheckoutActiveChanges(worktree)
    // Launch-time pre-mutation confirmation (task 10.1), same contract the
    // specs browser shows: name source worktree/path/branch, selected base,
    // the explicit archive set (empty allowed), whole-branch scope, and the
    // source/base diff-stat (task 10.5) before any sync/archive/squash effect.
    if (!(await confirmHomeClose({ route, worktree, branch: branch ?? "", base, targetDir, archive }))) return
    // A refused close shows its blockers in a visible notice (task 7.9)
    // instead of writing them to stderr behind the TUI and returning to Home
    // as if nothing happened.
    await runMenuGuarded(route, () =>
      runWorktreeClose({ checkout: worktree, base, changes: archive.kind === "known" ? archive.value.map((change) => change.changeId) : [], route }, targetDir),
    )
    return
  }
  if (action === "archive") {
    // Archive acts on explicitly selected changes (never by discovery), so the
    // operator marks one or more of the checkout's own active changes first.
    const { readCheckoutActiveChanges } = await import("./checkout-openspec")
    const { showNoticeTui } = await import("./notice-tui")
    const active = await readCheckoutActiveChanges(worktree)
    if (active.kind === "unknown") {
      await showNoticeTui(route, { title: "archive change", message: `this checkout's active changes could not be read: ${active.reason}` })
      return
    }
    if (active.value.length === 0) {
      await showNoticeTui(route, { title: "archive change", message: "this checkout has no active changes to archive" })
      return
    }
    const { showChangePickerTui } = await import("./change-picker-tui")
    const choice = await showChangePickerTui(route, {
      title: "archive change",
      changes: active.value.map((change) => ({ changeId: change.changeId, ...(change.title !== undefined ? { title: change.title } : {}) })),
    })
    // A confirmed empty batch is not a selection: archive nothing and report
    // no success rather than running the guarded archive.
    if (choice.kind !== "select" || choice.changeIds.length === 0) return
    const { runWorktreeArchive } = await import("./worktree-commands")
    await runMenuGuarded(route, () => runWorktreeArchive({ worktree, changes: choice.changeIds, route }))
    return
  }
  if (action === "fetch" || action === "sync" || action === "push" || action === "pr" || action === "squash" || action === "remove") {
    await runWorktreeMenuOperation(targetDir, route, worktree, action)
    return
  }
}

/**
 * Runs one of Home's independent Git/publication menu actions through the same
 * guarded command surface the CLI uses (capability home-launcher delta: shared
 * per-action guards, handlers revalidate before effects). The menu action
 * never bypasses the operation guards — it delegates to `runWorktreesCommand`,
 * so a blocked action reports the same reason the CLI would.
 */
/**
 * Runs one guarded menu operation with the blocked reporter routed to a visible
  * TUI notice (capability worktree-operations, task 7.9): a blocked fetch/sync/
  * push/pr/squash/close renders every blocker and remediation instead of writing
  * to an unwritten stderr stream and silently returning to the menu. When no
  * route (headless), the default stderr/exit reporting stands.
  */
async function runMenuGuarded(route: TuiRoute | undefined, fn: () => Promise<void>): Promise<void> {
  if (!route) return fn()
  const { withBlockedReporter, formatBlockers } = await import("./worktree-commands")
  const { showNoticeTui } = await import("./notice-tui")
  await withBlockedReporter(
    (blockers, reason) => {
      void showNoticeTui(route, { title: "worktree action", message: formatBlockers(blockers, reason) })
    },
    fn,
  )
}

/**
 * The Home launch-time close confirmation (capability feature-close, task
 * 10.1): naming the source worktree/path/branch, selected base, the explicit
 * archive set (the checkout's own active changes; empty allowed), whole-branch
 * scope, and the source/base diff-stat (task 10.5) before any effect.
 * Cancellation performs nothing.
 */
async function confirmHomeClose(input: {
  route: TuiRoute
  worktree: string
  branch: string
  base: string
  targetDir: string
  archive: ReadResult<LocalActiveChange[]>
}): Promise<boolean> {
  const { showRemovalConfirmTui } = await import("./removal-confirm-tui")
  const { execFile } = await import("./git")
  const displayName = input.worktree.split("/").pop() || input.worktree
  const stat = await execFile("git", ["diff", "--stat", `${input.base}...HEAD`, "--", "."], { cwd: input.worktree, allowFailure: true })
  const diffStat = stat.exitCode === 0 && stat.stdout.trim() ? stat.stdout.trim().split("\n").slice(0, 8).join("\n") : "unavailable"
  // The same facts validateArchiveInputs enforces at execution: a change
  // without a known-complete tasks file blocks the ordinary archive, so the
  // confirmation discloses that before the operator commits to the run.
  const incomplete =
    input.archive.kind === "known" &&
    input.archive.value.some((change) => change.tasks === undefined || change.tasks === "unknown" || change.tasks.done < change.tasks.total)
  const message = [
    `Close ${displayName} (${input.worktree})?`,
    "",
    "Close runs sync → archive → landing: it archives the checkout's active changes and lands ONE commit covering the WHOLE branch on the base — including edits outside the selected changes. Without a linked open pull request nothing is pushed or merged; when close detects one, the landing is hosted (push the branch, GitHub squash-merges that PR with the reviewed message, fast-forward the base) and the review gate names those steps before any effect. Push and cleanup stay separate otherwise.",
    "",
    `branch   ${input.branch || "(no local branch)"}`,
    `base     ${input.base}`,
    `archive  ${describeHomeCloseArchiveSet(input.archive)}`,
    "scope    whole-branch (selecting changes never narrows publication or squash scope)",
    ...(incomplete ? ["note     a change with unknown or incomplete tasks blocks the archive step — cancel to complete it first"] : []),
    "",
    `diffstat ${diffStat}`,
    "",
    "Selection never narrows close's whole-branch squash; cancel safely.",
  ].join("\n")
  const choice = await showRemovalConfirmTui(input.route, { title: "close worktree", message, mode: "confirm", confirmLabel: "confirm" })
  return choice === "confirm"
}

/**
 * The confirmation's archive-set disclosure (exported for tests): the
 * checkout's own active changes with their task state, an honest "none", or
 * the unreadable fact — exactly the set the archive step will act on, never an
 * assumed empty set.
 */
export function describeHomeCloseArchiveSet(archive: ReadResult<LocalActiveChange[]>): string {
  if (archive.kind === "unknown") return `unknown (${archive.reason}) — nothing will be archived`
  if (archive.value.length === 0) return "none — no active changes in this checkout"
  return archive.value
    .map((change) => {
      const state =
        change.tasks === undefined
          ? " (no tasks file)"
          : change.tasks === "unknown"
            ? " (tasks unknown)"
            : ` (${change.tasks.done}/${change.tasks.total} tasks)`
      return `${change.changeId}${state}`
    })
    .join(", ")
}

async function runWorktreeMenuOperation(targetDir: string, route: TuiRoute, worktree: string, action: "fetch" | "sync" | "push" | "pr" | "squash" | "remove"): Promise<void> {
  const { runWorktreesCommand } = await import("./worktree-commands")
  const { showNoticeTui } = await import("./notice-tui")
  const blocked = async (message: string): Promise<void> => {
    await showNoticeTui(route, { title: "worktree action", message })
  }
  try {
    if (action === "fetch") {
      // Fetch names an explicit remote; with exactly one configured remote it
      // is unambiguous, otherwise the operator selects it through the CLI.
      const { execFile } = await import("./git")
      const remotes = await execFile("git", ["remote"], { cwd: worktree, allowFailure: true })
      const names = remotes.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
      if (names.length !== 1) {
        await blocked(
          names.length === 0
            ? "no remote is configured for this checkout — add one with `git remote add` first"
            : `several remotes are configured (${names.join(", ")}) — run \`convoy worktrees fetch --worktree <path> --remote <name>\` explicitly`,
        )
        return
      }
      await runMenuGuarded(route, () => runWorktreesCommand({ kind: "fetch", worktree, remote: names[0]! }))
      return
    }
    if (action === "sync" || action === "squash") {
      const { detectBaseRef } = await import("./git")
      const detected = await detectBaseRef(targetDir).catch(() => undefined)
      if (!detected?.ref) {
        await blocked(`no base could be detected — pass an explicit base with \`convoy worktrees ${action} --worktree <path> --base <ref>\``)
        return
      }
      await runMenuGuarded(route, () => runWorktreesCommand(action === "sync" ? { kind: "sync", worktree, base: detected.ref } : { kind: "squash", worktree, base: detected.ref }))
      return
    }
    if (action === "push") {
      await runMenuGuarded(route, () => runWorktreesCommand({ kind: "push", worktree }))
      return
    }
    if (action === "pr") {
      // The interactive surface reviews and edits the composed text, then
      // pushes before creating (reusing the publication seam) and reports the
      // outcome in a dialog — it never writes raw stdout over the live UI and
      // never creates a PR from a stale remote head.
      const { runInteractivePublish } = await import("./publish-action")
      await runInteractivePublish({ worktree, route })
      return
    }
    if (action === "remove") {
      await removeWorktreeInteractive(targetDir, route, worktree)
      return
    }
  } catch (error) {
    await blocked(error instanceof Error ? error.message : String(error))
  }
}

/** One blocked reason plus its remediation, indented for a dialog body. */
function removalBlockersText(blockers: Array<{ reason: string; remediation: string }>): string {
  return blockers.map((blocker) => `- ${blocker.reason}\n  ${blocker.remediation}`).join("\n")
}

/**
 * The Home "remove worktree" action (delta spec worktree-operations): the
 * guarded removal is confirmed at launch naming the checkout and its
 * branch-retention outcome; a blocked removal shows every blocker with its
 * remediation and offers an explicit force path only when the blockers are all
 * content — main/process checkout, unverified registration, lock, writer
 * conflict, and unknown/unreadable state never offer force. The headless
 * `convoy worktrees remove [--force]` path keeps its stderr reporting.
 */
async function removeWorktreeInteractive(targetDir: string, route: TuiRoute, worktree: string): Promise<void> {
  const { showNoticeTui } = await import("./notice-tui")
  const { showRemovalConfirmTui } = await import("./removal-confirm-tui")
  const { removeRegisteredWorktree, reviewOperation, reviewWorktreeRemoval } = await import("./operation-handlers")
  const { repoCommonDir } = await import("./repo-store")
  const commonDir = await repoCommonDir(targetDir)
  if (!commonDir) {
    await showNoticeTui(route, { title: "worktree action", message: "not a git repository — nothing was removed" })
    return
  }

  // Review once for the dialog (read-only); the guarded handler re-reviews and
  // revalidates before the actual removal, so the confirmation is a projection
  // of the same checks rather than an independent decision.
  const safety = await reviewWorktreeRemoval(worktree)
  const op = await reviewOperation({ action: "remove", checkout: worktree, commonDir })
  const blockers = [...safety, ...(op.ok ? [] : op.blockers)]

  const report = async (outcome: Awaited<ReturnType<typeof removeRegisteredWorktree>>): Promise<void> => {
    if (outcome.ok) {
      await showNoticeTui(route, {
        title: "worktree removed",
        message: `removed ${worktree}\nIts branch was retained. Deleting the branch is a separate action.`,
      })
    } else {
      await showNoticeTui(route, {
        title: "worktree action",
        message: `can't remove ${worktree}:\n${removalBlockersText(outcome.blockers)}`,
      })
    }
  }

  if (blockers.length === 0) {
    // Safe checkout: launch-time confirmation before any effect.
    const choice = await showRemovalConfirmTui(route, {
      title: "remove worktree",
      message: `Remove ${worktree}?\nIts branch is retained. Nothing else is deleted.`,
      mode: "confirm",
    })
    if (choice === "cancel") return
    await report(await removeRegisteredWorktree({ checkout: worktree, commonDir }))
    return
  }

  // Blocked: show every blocker; force removal is offered only when the only
  // thing in the way is local content that force would delete. After the
  // blockers are disclosed, choosing force opens a SECOND deliberate
  // confirmation that names exactly what would be deleted (task 7.11); only an
  // explicit confirm there proceeds — force never bypasses main/process,
  // unverified, locked, or unknown-state blockers.
  const forceAvailable = blockers.length > 0 && blockers.every((blocker) => blocker.content === true)
  const choice = await showRemovalConfirmTui(route, {
    title: "remove worktree",
    message: `can't remove ${worktree}:\n${removalBlockersText(blockers)}`,
    mode: "blocked",
    forceAvailable,
  })
  if (choice === "cancel") return
  if (choice === "force") {
    const deletionList = blockers.filter((blocker) => blocker.content === true).map((blocker) => `- ${blocker.reason}`).join("\n")
    const consent = await showRemovalConfirmTui(route, {
      title: "force remove worktree",
      message: `Force removal of ${worktree} deletes the following local content:\n${deletionList}\n\nThe branch is retained. Force bypasses only content blockers; the main checkout, the process's own checkout, locks, and unknown state still refuse.\n\nContinue with force removal?`,
      mode: "force",
    })
    if (consent !== "confirm") return
    await report(await removeRegisteredWorktree({ checkout: worktree, commonDir, force: true }))
    return
  }
}

/**
 * Creates the reviewed worktree before any proposal (capability work-context
 * delta, task 3.4/3.5): the reviewed draft becomes an unresolved creation
 * operation, then the Git worktree. No feature record, spec, commit, PR, or
 * authoring session is created; a retry reconciles the pending operation
 * against actual Git state instead of duplicating the checkout.
 */
async function createWorkFromDraft(
  targetDir: string,
  route: TuiRoute,
  draft: { displayName: string; branch: string; base: string; worktree: string },
): Promise<void> {
  const { execFile } = await import("./git")
  const { repoCommonDir } = await import("./repo-store")
  const { createOperation, acknowledgeStep, resolveOperation } = await import("./operation-journal")
  const { showNoticeTui } = await import("./notice-tui")

  const commonDir = await repoCommonDir(targetDir)
  if (!commonDir) {
    await showNoticeTui(route, { title: "new worktree", message: "not a git repository — nothing was created" })
    return
  }

  // 1. Intent before any filesystem effect (design D9): recovery evidence
  //    outside the checkout this operation may create.
  const { ensureOperationsRoot } = await import("./operation-journal")
  await ensureOperationsRoot(commonDir).catch(() => {})
  const created = await createOperation(commonDir, {
    kind: "worktree-create",
    intent: { displayName: draft.displayName, branch: draft.branch, base: draft.base, worktree: draft.worktree },
    steps: ["create"],
  })
  const operationId = created.ok ? created.operation.operationId : undefined
  if (operationId) {
    const { recordStepIntent } = await import("./operation-journal")
    await recordStepIntent(commonDir, operationId, "create", { branch: draft.branch, worktree: draft.worktree, base: draft.base }).catch(() => {})
  }

  // 2. The worktree at the reviewed destination. A retry after a partial
  //    creation reuses a validated matching worktree instead of failing on
  //    the existing path (never create a duplicate; never delete potential
  //    authored content).
  const { findWorktreeDirForBranch } = await import("./git")
  const existing = await findWorktreeDirForBranch(draft.branch, targetDir).catch(() => undefined)
  if (!existing) {
    const added = await execFile("git", ["worktree", "add", "-b", draft.branch, draft.worktree, draft.base], { cwd: targetDir, allowFailure: true })
    if (added.exitCode !== 0) {
      await showNoticeTui(route, {
        title: "new worktree",
        message: `creating the worktree failed:\n${(added.stderr || added.stdout).trim()}\n\n${operationId ? `The creation intent is retained — inspect or cancel it with \`convoy worktrees recover --operation ${operationId}\`.` : "Nothing was created."}`,
      })
      return
    }
  }

  // 3. Acknowledge the verified creation and release the operation journal:
  //    a resolved creation leaves no recovery record behind (design D9).
  if (operationId) {
    await acknowledgeStep(commonDir, operationId, "create", { worktree: existing ?? draft.worktree }).catch(() => {})
    await resolveOperation({ commonDir, operationId, gitCwd: targetDir, outcome: "resolved" }).catch(() => {})
  }
  // The created checkout becomes the last-selection hint (task 3.3).
  const { observeCheckoutTarget } = await import("./worktree-target")
  const { saveLastSelection } = await import("./session-hints")
  const createdTarget = await observeCheckoutTarget(existing ?? draft.worktree).catch(() => undefined)
  if (createdTarget) await saveLastSelection(commonDir, createdTarget).catch(() => {})
  await showNoticeTui(route, {
    title: "worktree created",
    message: `${draft.displayName} is ready at ${existing ?? draft.worktree} on ${draft.branch}\n\nSelect it on the Worktrees list to open a conversation or propose the first change.`,
  })
}

/** Pure navigation loop: destination close means back; only Home close quits. */
export async function runHomeNavigationLoop(options: {
  interrupted: () => boolean
  route: TuiRoute
  targetDir: string
  /**
   * The Home context load; the home session injects the transition-wrapped
   * loader (loadHomeWithTransition). An undefined answer means the load was
   * interrupted (Ctrl+C while the transition was up) — the loop exits quietly
   * instead of opening Home. The default runs the plain context load.
   */
  loadHome?: () => Promise<HomeContext | undefined>
  openHome: (context: HomeContext) => Promise<HomeResolution>
  openWork: (worktree: string, action: HomeWorkAction) => Promise<void>
  /** Opens one of the checkout's recent runs, focused on that run. */
  openRun: (worktree: string, runId: string) => Promise<void>
  /** Opens the checkout's linked change in the focused specs view. */
  openChange: (worktree: string, changeId: string) => Promise<void>
  createWork: (draft: { displayName: string; branch: string; base: string; worktree: string }) => Promise<void>
  openDestination: (selection: HomeDestination) => Promise<void>
}): Promise<void> {
  while (!options.interrupted()) {
    const context = options.loadHome ? await options.loadHome() : await homeWorkContext(options.targetDir)
    if (!context) return
    const resolution = await options.openHome(context)
    if (!resolution || options.interrupted()) return
    if (resolution.type === "destination") {
      await options.openDestination(resolution.destination)
    } else if (resolution.type === "work") {
      await options.openWork(resolution.worktree, resolution.action)
    } else if (resolution.type === "work-run") {
      await options.openRun(resolution.worktree, resolution.runId)
    } else if (resolution.type === "work-change") {
      await options.openChange(resolution.worktree, resolution.changeId)
    } else if (resolution.type === "new-work" && resolution.draft) {
      await options.createWork(resolution.draft)
    }
  }
}

/** Builds the operator-reviewed plan, including a checkout-local PRD history preview. */
async function buildReviewedPlan(input: BuildRunPlanInput): Promise<RunPlan> {
  // Lookup the launch checkout's current branch, not `input.branch` — that is the
  // *new* worktree name when isolate is on, and would miss history sitting here.
  let branch: string | undefined
  try {
    branch = await currentBranch(input.targetDir)
  } catch {
    branch = undefined
  }
  const preview = await loadPrdHistoryPreview({
    targetDir: input.targetDir,
    enabled: input.prdHistory,
    isolateWorktree: Boolean(input.worktree),
    attachesHistory: input.pipeline.steps.some((step) => step.type === "agent" && step.prdHistory),
    branch,
    excludeRunID: input.resumeRunID || undefined,
  })
  // `features.specs: false` keeps OpenSpec out of the plan entirely: nothing
  // attached, no change selection required, and an explicit --change refused.
  const specsEnabled = featuresOf(await loadMergedConvoyConfig(input.targetDir).catch(() => undefined)).specs
  if (!specsEnabled && (input.changes?.length ?? 0) > 0) {
    throw new Error("--change needs OpenSpec, which this project turned off (features.specs: false)")
  }
  // An OpenSpec contract, when the repo has one: discovered against the launch
  // checkout (before any worktree isolate), so the launcher and `--change`
  // resolve the change the same way the runtime attaches it later.
  const openspec = specsEnabled
    ? await loadOpenSpecBundle({
        targetDir: input.targetDir,
        explicitIds: input.changes,
      })
    : undefined
  // Every explicitly requested id must resolve: a typo or an archived id
  // refuses the run naming it, rather than silently dropping that contract.
  const requested = input.changes ?? []
  if (requested.length > 0) {
    const missing = openspec ? requested.filter((id) => !openspec.changeIds.includes(id)) : requested
    if (missing.length > 0) {
      throw new Error(`--change "${missing.join('", "')}" matched no active change under openspec/changes/ (archived or absent)`)
    }
  }
  // Selection is explicit only (run-launcher delta): a launch with zero
  // selected changes is valid solely through the explicit no-change mode —
  // `--manual` headless, or the launcher's Manual-prompt decision. Nothing
  // auto-attaches a singleton, a branch match, or a diff composition, and a
  // resume/retry keeps its frozen context instead of re-selecting.
  if (openspec && openspec.changeIds.length === 0 && !input.manual && !input.resumeRunID) {
    const { listChangeIds } = await import("./openspec")
    const activeCount = (await listChangeIds(join(input.targetDir, "openspec", "changes"))).length
    throw new Error(
      activeCount === 0
        ? "no active change under openspec/changes/: run /opsx:propose first, or pass --manual for an explicit no-change run"
        : "no change is selected: pass --change <id> (repeatable, in review order) or --manual for an explicit no-change run; in the launcher, esc at the prompt opens the change list to pick from",
    )
  }
  // No feature link is resolved or persisted on the launch path (capability
  // feature-lifecycle retirement): the reviewed plan carries the explicit
  // checkout and ordered local changes, and execution validates those Git
  // facts — never a feature association.
  return buildRunPlan({ ...input, prdHistoryPreview: preview, ...(openspec ? { openspec } : {}) })
}

/** The result of deciding whether goal mode applies to a resolved run. */
export type GoalModeDecision = { mode: "off" } | { mode: "on"; goal: number; maxIterations: number; plateau: number }

/**
 * Pure decision: does this run enter goal mode, and with what policy? Goal
 * execution is enabled exclusively by the pipeline's own terminal goal step —
 * the resolver validated its structure and fragment roles, so there is nothing
 * left to reject here. Exported so the classification is exercised by tests
 * rather than left untested inside the module-private execution path.
 */
export function goalModeFor(plan: RunPlan): GoalModeDecision {
  const goal = plan.pipeline.goalPlan
  if (!goal) return { mode: "off" }
  return { mode: "on", goal: goal.target, maxIterations: goal.maxIterations, plateau: goal.plateau }
}

/** Runs the plan; the coordinator enters the goal loop when the reviewed pipeline declares a terminal goal step. */
async function executeRun(options: RunOptions, plan: RunPlan, route?: TuiRoute): Promise<void> {
  await spawnAndAttachRun(options, plan, route)
}

/**
 * Every production run becomes a detached coordinator plus, on a TTY, an
 * auto-attached controller dashboard. Tests keep calling `run()` in-process
 * with an injected `progress`.
 */
async function spawnAndAttachRun(options: RunOptions, plan: RunPlan, route?: TuiRoute): Promise<void> {
  const { CoordinatorBootTimeoutError, forwardCoordinatorLogs, launchPayload, rmPendingLaunch, spawnCoordinator, waitForCoordinatorReady, writePendingLaunch } = await import("./coordinate")
  const pending = await writePendingLaunch(launchPayload(options, plan))
  let child: { pid: number; exited: Promise<number> } | undefined
  try {
    child = await spawnCoordinator(pending)
    const ready = await waitForCoordinatorReady(pending.readyPath)
    // The coordinator is live; attach or wait, depending on the terminal.
    if (options.tui && process.stdout.isTTY) {
      const { openRunDashboard } = await import("./attach")
      await openRunDashboard(ready.runID, { ctrlC: "abort" }, route)
      // The attach resolved because the user backgrounded the run; land on the
      // runs menu with it selected (the coordinator keeps running). Liveness
      // is the coordinator's, not iteration 1's OpenCode server: a goal loop
      // releases each iteration's server while the coordinator lives on.
      if (await isCoordinatorLiveFor(ready.runID)) {
        const resumed = await openRunsBrowser(await currentCoordinatedRunID(ready.runID), route)
        // A resume/retry ran its own coordinator inside the browser and owns
        // the exit code; a run still alive after the browser was backgrounded
        // on purpose — a successful handoff is exit 0.
        if (resumed || (await isCoordinatorLiveFor(ready.runID))) return
      }
      // The run is over and the user watched it end: the CLI's exit code is
      // the coordinator's (0 on success, non-zero on failure or abort).
      const code = await child.exited
      process.exitCode = code
      // A failed run's error went to the coordinator's log, not this terminal;
      // a deliberate abort (130) already said goodbye on the dashboard.
      if (code !== 0 && code !== 130) await printCoordinatorFailure(pending.logPath)
      await rmPendingLaunch(pending.dir)
      return
    }
    // --detach: the coordinator already survives this process, so hand the
    // run back to the caller (an agent session, a script) and let it poll.
    // The pending dir stays: it holds the log the coordinator is writing, and
    // the sweep only removes it once that coordinator is gone.
    if (options.detach) {
      process.stdout.write(detachedRunMessage(ready.runID, child.pid, pending.logPath))
      return
    }
    // --no-tui / CI: don't attach; stream the coordinator's log to the
    // terminal, wait for its exit, and forward the exit code.
    process.stdout.write(`coordinator ${child.pid} running run ${ready.runID}; logs: ${pending.logPath}\n`)
    const forwarder = await forwardCoordinatorLogs(pending.logPath, (chunk) => process.stdout.write(chunk))
    const code = await child.exited
    await forwarder.stop()
    process.exitCode = code
    // The log was forwarded in full — the pending dir holds nothing the
    // parent hasn't already shown.
    await rmPendingLaunch(pending.dir)
  } catch (error) {
    // Boot timeout or spawn failure: surface it, keep the workspace resumable.
    if (child) {
      try {
        process.kill(child.pid, "SIGTERM")
      } catch {
        // Already gone.
      }
    }
    log.warn(`coordinator failed to start; pending launch left at ${pending.launchPath}`)
    if (error instanceof CoordinatorBootTimeoutError) {
      log.error(`  → ${error.message}`)
      log.error(`  → coordinator log: ${pending.logPath}`)
      // The friendly lines above are the error; a zero exit would hide the
      // failure from scripts and CI. The workspace stays resumable with `R`.
      process.exitCode = 1
    } else {
      throw error
    }
  }
}

/** What `--detach` prints: a stable `run <id> started` first line, then where to look and how to follow. */
export function detachedRunMessage(runID: string, pid: number, logPath: string): string {
  return [
    `run ${runID} started (coordinator ${pid}, detached)`,
    `log: ${logPath}`,
    `follow: convoy runs ${runID} --wait`,
    `status: convoy runs ${runID} --json`,
    "",
  ].join("\n")
}

/** Surfaces the coordinator's last words on a failed TTY run: its stderr went to the pending log, not this terminal. */
async function printCoordinatorFailure(logPath: string): Promise<void> {
  try {
    const body = await readFile(logPath, "utf8")
    const tail = body.trimEnd().split("\n").slice(-30)
    if (tail.length > 0) process.stderr.write(`coordinator failed (last log lines):\n${tail.join("\n")}\n`)
  } catch {
    // Log unreadable; the exit code already says it failed.
  }
}

/** Reads the run's liveness through the run-history module (pid + TCP probe). */
async function isServerLiveFor(runID: string): Promise<boolean> {
  const workspace = await resumeWorkspace(runID).catch(() => undefined)
  if (!workspace) return false
  const metadata = await readRunMetadata(resolve(workspace.dir, "metadata.json"))
  return Boolean(metadata && (await isServerLive(metadata.server)))
}

/**
 * Whether the run's *coordinator* is still alive. The control server outlives
 * every per-iteration OpenCode server, so this (not server liveness) is what
 * "the run is still going" means for a backgrounded run — especially mid-goal-
 * loop, where each iteration's server dies while the loop continues.
 */
async function isCoordinatorLiveFor(runID: string): Promise<boolean> {
  const control = await readControlFile(runID)
  if (!control) return isServerLiveFor(runID)
  return isControlLive(control)
}

/**
 * The runID a coordinated run is currently on. A goal cycle runs inside one
 * logical run, so this is the run's own ID; the helper remains for callers
 * that need the current run ID from the control file.
 */
async function currentCoordinatedRunID(fallback: string): Promise<string> {
  const control = await readControlFile(fallback)
  if (!control) return fallback
  try {
    const response = await fetch(`${control.url}/status`, {
      headers: { authorization: `Bearer ${control.token}` },
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) return fallback
    const status = (await response.json()) as { runID?: string }
    return status.runID ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Creates the run's isolated worktree and repoints the options at it. Shared by
 * the launcher, where the branch was already confirmed in the branch step, and
 * the headless path, where it is either pinned with --branch or proposed by the
 * naming model.
 */
export async function prepareWorktreeForRun(sourceDir: string, options: RunOptions): Promise<RunOptions> {
  const { createIsolatedWorktree } = await import("./worktree")
  // A pinned name is sanitized the same way the launcher sanitizes a typed one;
  // an unusable one is a flag error, not something to silently rename around.
  const branch = options.branch
    ? (await checkInteractiveBranchName(sourceDir, options.branch)).branch
    : (await proposeInteractiveBranchName(sourceDir, { prompt: options.prompt })).branch
  if (!branch) throw new Error(`--branch "${options.branch}" isn't usable as a git branch name`)
  const worktree = await createIsolatedWorktree({ targetDir: sourceDir, branch })
  log.info(`running in isolated worktree (branch: ${worktree.branch})`)
  log.info(`  dir: ${worktree.dir}`)
  // A fresh worktree starts clean, so there is nothing dirty left to include.
  return { ...options, targetDir: worktree.dir, branch: worktree.branch, includeDirty: false }
}

/**
 * Opens the run launcher and carries out what it resolves to. Answers "quit"
 * when the operator left the launcher itself, so a root launcher (no worktree
 * board) ends the session, and "continue" after a navigation or a run.
 */
async function launchInteractiveRun(
  targetDir: string,
  presetChanges?: readonly string[],
  presetFeature?: LaunchFeaturePreset,
  route?: TuiRoute,
  navigation: { root?: boolean; specsDestination?: boolean } = {},
): Promise<"quit" | "continue"> {
  // Imported lazily so normal CLI invocations don't pull in OpenTUI until they
  // explicitly ask for the zero-argument interactive launcher.
  const { launchRunTui } = await import("./launch-tui")
  const selection = await launchRunTui(
    {
      targetDir,
      // A specs-viewer or `worktrees run` handoff arrives with the changes
      // already chosen, in review order: the launcher pins that selection
      // instead of running any auto-detect heuristic. An empty list is the
      // explicit no-change mode.
      ...(presetChanges ? { presetChanges } : {}),
      // A worktree handoff arrives with the verified worktree/branch: the
      // launcher reuses them and never asks the namer (work-context, D1/D2).
      ...(presetFeature ? { presetFeature } : {}),
      prepareRun: (runSelection) => prepareInteractiveRun(targetDir, runSelection),
      proposeBranchName: (input) => proposeInteractiveBranchName(targetDir, input),
      checkBranchName: (name) => checkInteractiveBranchName(targetDir, name),
      ...navigation,
    },
    route,
  )
  if (!selection) return "quit"
  if (selection.action === "runs") {
    await openRunsBrowser(undefined, route)
    return "continue"
  }
  if (selection.action === "config") {
    await openConfigEditor(targetDir, route)
    return "continue"
  }
  if (selection.action === "specs") {
    await openSpecsBrowser(targetDir, route)
    return "continue"
  }

  let options = selection.options
  const plan = selection.plan
  const runSelection = selection.selection
  // The launcher's review screen is where the operator accepted this plan.
  await preflightRunPlan(plan, undefined, { reviewed: true })
  if (runSelection.initializeGit) {
    const { initializeRepoWithInitialCommit } = await import("./git")
    await initializeRepoWithInitialCommit(targetDir, { baseRef: options.baseRef === "HEAD" ? undefined : options.baseRef })
  }
  // Revalidate Git only after the native Review has been accepted. In
  // particular, validate the source before a worktree can create a branch.
  // A feature-row "continue" handoff executes inside the feature's existing
  // worktree — its own checkout with its own dirt. The launcher's cwd (where
  // the board was opened, e.g. main) is irrelevant to that run, so the
  // readiness gate checks the run's home directory, not it. Otherwise a
  // stranded uncommitted change on main (a first-class board state) would
  // block continuing an unrelated feature (SC-5).
  const { ensureRepoReady } = await import("./git")
  const executionDir = presetFeature?.worktreeDir ?? targetDir
  await ensureRepoReady(executionDir, {
    baseRef: options.baseRef,
    includeDirty: options.includeDirty,
    // A fresh worktree starts clean, so source changes are intentionally left
    // untouched and don't need to be included in this run.
    allowDirty: options.worktree,
  })
  if (options.worktree) {
    if (!options.branch) throw new Error("worktree plan is missing its confirmed branch name")
    options = await prepareWorktreeForRun(targetDir, options)
  }
  // Managed writer ownership (design D5): the interactive path refuses a
  // second writer in the claimed checkout exactly like the headless one.
  await refuseConflictingWriter(options.targetDir, plan)
  await executeRun(options, plan, route)
  return "continue"
}

/**
 * The launcher's reviewed preparation: the operator's explicit checkout and
 * ordered change selection (or the explicit no-change decision) resolve the
 * frozen plan. Exported for the selection-regression tests (the same pattern
 * as runHomeNavigationLoop).
 */
export async function prepareInteractiveRun(targetDir: string, selection: LaunchRunSelection): Promise<LaunchRunPreparation> {
  const parsed = parseArgs([])
  parsed.targetDir = selection.targetDir
  // Base detection and configuration resolve against the execution checkout
  // (work-context, D1): for a feature handoff that is the feature worktree,
  // so its configuration, history, and specs drive the plan; for a plain run
  // it is the launch checkout, exactly as before.
  parsed.baseDetectionDir = selection.targetDir
  parsed.prompt = selection.prompt
  parsed.pipeline = selection.pipeline
  parsed.humanReview = selection.humanReview
  parsed.tui = selection.tui
  parsed.includeDirty = selection.includeDirty
  parsed.keepRunDir = selection.keepRunDir
  parsed.yolo = selection.yolo
  parsed.smart = selection.smart
  parsed.gateway = selection.gateway
  parsed.worktree = Boolean(selection.isolateWorktree)
  if (selection.branchName) parsed.branch = selection.branchName
  // The operator's explicit ordered selection (each pick an acceptance) and
  // the explicit no-change decision ride into the plan verbatim: B then A
  // stays B then A, and nothing auto-attaches (run-launcher delta).
  parsed.changes = [...selection.changes]
  if (selection.manualNoChanges) parsed.manual = true
  // A worktree handoff uses its recorded intended base instead of re-detecting
  // one (work-context, D5).
  if (selection.baseRef) parsed.baseRef = selection.baseRef

  const options = { ...(await resolveRunOptions(parsed)), prompt: selection.prompt }
  // The branch was named and confirmed in the launcher's branch step, so the
  // plan the user reviews already names the branch the run will create.
  const plan = await buildReviewedPlan({
    ...options,
    ...(selection.worktreeDir ? { worktreeDir: selection.worktreeDir } : {}),
  })
  return { options, plan }
}

/** Asks the configured naming model for a branch name for the launcher's branch step. */
async function proposeInteractiveBranchName(targetDir: string, input: { prompt: string; guidance?: string }): Promise<LaunchBranchProposal> {
  const { defaultBranchNameModel, proposeBranchName } = await import("./worktree")
  const { helperAuth } = await import("./helper-routes")
  const config = await loadMergedConvoyConfig(targetDir)
  const model = helperModel("branchName", config?.defaults, defaultBranchNameModel)
  const proposal = await proposeBranchName({ ...input, targetDir, model, auth: helperAuth(config, model) })
  return { ...proposal, model }
}

/** Sanitizes a candidate branch name and reports the free name it would take, plus its worktree path. */
async function checkInteractiveBranchName(targetDir: string, name: string): Promise<LaunchBranchCheck> {
  const { cleanBranchName, ensureFreeBranchName, resolveWorktreeDir } = await import("./worktree")
  // A hand-written name keeps whatever prefix (or none) the user chose; only
  // the model's proposals are held to the conventional `type/` shape.
  const cleaned = cleanBranchName(name, { authored: true })
  if (!cleaned) return { branch: "", dir: "" }
  const free = await ensureFreeBranchName(cleaned, targetDir)
  // The preview must resolve the same way creation does, so what the user
  // confirms is the directory the worktree actually lands in.
  return { branch: free, dir: await resolveWorktreeDir(free, targetDir), ...(free === cleaned ? {} : { suffixed: true }) }
}

/**
 * @returns true when the browser left via a resume/retry (which started its
 *   own coordinator and owns the CLI's exit code), false when the user quit.
 */
async function openRunsBrowser(initialRunID?: string, route?: TuiRoute): Promise<boolean> {
  // The browser can open a run's dashboard and come back, so loop until the
  // user resumes (which hands off to a real run) or quits.
  let currentRunID = initialRunID
  for (;;) {
    const resolution = await browseRuns(currentRunID, route)
    if (resolution.type === "retry") {
      const options = await retryOptions(resolution.runID, resolution.targetDir)
      const plan = options.plan ?? (await buildReviewedPlan({ ...options, promptSource: "retry" }))
      if (!(await confirmRunPlan(plan))) return false
      await preflightRunPlan(plan, undefined, { reviewed: true })
      // A resumed/retried run is also a coordinator: same spawn + auto-attach path.
      await executeRun(options, plan, route)
      return true
    }
    if (resolution.type === "resume") {
      const options = await resumeOptions(resolution.runID, resolution.targetDir)
      const plan = options.plan ?? (await buildReviewedPlan({ ...options, promptSource: "resume" }))
      if (!(await confirmRunPlan(plan))) return false
      await preflightRunPlan(plan, undefined, { reviewed: true })
      await executeRun(options, plan, route)
      return true
    }
    if (resolution.type === "open") {
      // Lazily imported: attaching pulls in the dashboard + opencode client.
      // A menu attach is a controller (ctrlC detaches); observer while a
      // controller is already attached.
      const { openRunDashboard } = await import("./attach")
      await openRunDashboard(resolution.runID, { ctrlC: "detach" }, route)
      currentRunID = resolution.runID
      continue
    }
    return false
  }
}

async function openConfigEditor(targetDir: string, route?: TuiRoute) {
  // Imported lazily so normal runs never pull in the opentui editor.
  const { editConfigTui } = await import("./config-tui")
  await editConfigTui({ targetDir, route })
}

/**
 * Routes the specs browser's resolutions. apply-change hands off to the
 * interactive launcher with the change pinned (launchInteractiveRun's preset),
 * iterate-change opens a standalone OpenCode session rooted at the resolved
 * work context (the operator authors OpenSpec changes there — Convoy never
 * writes them), and exit simply ends. Feature-owned handoffs resolve the
 * verified execution checkout through the shared work-context projection
 * before any resource loads (capability work-context, design D1); an
 * unavailable association reports its reason and remediation instead of
 * silently launching in the launch directory. Each dispatch returns the
 * selection to restore, so the browser reopens on it with a refreshed
 * assessment after a cancelled launcher, a closed dashboard, or authoring
 * (tasks 1.2/1.4) — only an explicit exit ends the browser.
 */
export async function openSpecsBrowser(
  targetDir: string,
  route?: TuiRoute,
  initialResume?: SpecsResumeSelection,
  source?: import("./board-refresh").BoardSource,
): Promise<void> {
  // One repository-scoped source for this specs session (cache-first load plus
  // the browser's background refresh cadence); the home session shares its own.
  const boardSource = source ?? new (await import("./board-refresh")).BoardSource({ targetDir })
  let resume = initialResume
  for (;;) {
    const resolution = await browseSpecs(targetDir, route, resume, boardSource)
    resume = await dispatchSpecsResolution(targetDir, resolution, route)
    if (!resume) return
    // Archive/close mutated the checkout: invalidate its cached fingerprint and
    // refresh so the reopened board shows the changed artifacts, not a token
    // that a same-size, mtime-preserving edit could leave unchanged.
    if (resolution.type === "archive-change" || resolution.type === "close-change") {
      boardSource.invalidate(resume.checkout)
      await boardSource.refresh().catch(() => {})
    }
  }
}

/**
 * Performs one browser resolution and returns the selection the reopened
 * browser restores, or `undefined` to exit. The restored selection is
 * identity-keyed (change id / feature id) so a refreshed view lands on the
 * same subject regardless of list position.
 */
async function dispatchSpecsResolution(targetDir: string, resolution: SpecsResolution, route?: TuiRoute): Promise<SpecsResumeSelection | undefined> {
  switch (resolution.type) {
    case "exit":
      return undefined
    case "apply-change": {
      // The launcher keeps running in the launch checkout (no chdir); the
      // preset carries the change's own checkout, which resource loading and
      // preparation resolve against — never the launch directory by fallback.
      const preset = await checkoutPreset(resolution.checkout)
      if (!preset) {
        await reportHandoffBlocker(
          `the change's checkout (${resolution.checkout}) is no longer a valid target`,
          ["refresh the board and reselect the change"],
          route,
        )
        return { changeId: resolution.changeID, checkout: resolution.checkout }
      }
      await launchInteractiveRun(targetDir, [resolution.changeID], preset, route)
      return { changeId: resolution.changeID, checkout: resolution.checkout }
    }
    case "iterate-change": {
      if (resolution.presentation === "external" || !route) {
        // Explicit external presentation (or the standalone browser, whose
        // renderer this process no longer owns): the window flow.
        const view = await loadSpecsView(targetDir)
        const input = buildIterateSessionInput(targetDir, view, resolution.changeID)
        const authoring = await authoringRouteFor(targetDir)
        if (authoring.harness === "claude-code") {
          // The selected harness, under its reviewed auth; no OpenCode involved.
          const { openClaudeInteractiveWindow } = await import("./claude-code")
          await openClaudeInteractiveWindow({ targetDir: input.targetDir, prompt: input.prompt, label: "claude iterate", ...(authoring.auth ? { auth: authoring.auth } : {}) })
        } else {
          const { openIterateOpencodeWindow } = await import("./opencode")
          await openIterateOpencodeWindow(input)
        }
      } else {
        await openCheckoutConversation({ launchDir: targetDir, route, checkout: resolution.checkout, displayName: resolution.changeID })
      }
      return { changeId: resolution.changeID, checkout: resolution.checkout }
    }
    case "spin-change": {
      // Spin out reuses `convoy spin`'s whole flow verbatim: same refusals,
      // same worktree conventions, same /move handoff. Spin registers
      // nothing (capability feature-spin delta): the created checkout
      // appears through Git inventory like any other worktree.
      const { runSpin, printSpinHandoff } = await import("./spin")
      const result = await runSpin({ targetDir, changeID: resolution.changeID })
      printSpinHandoff(result)
      return { changeId: resolution.changeID }
    }
    case "continue-change": {
      // Fresh destination validation before the launcher opens: the row's
      // worktree was observed at view load; the handoff re-observes so a
      // moved/removed checkout reports instead of launching against the
      // stale path.
      const preset = await checkoutPreset(resolution.worktreeDir, resolution.branch)
      if (!preset) {
        await reportHandoffBlocker(
          `the reviewed checkout (${resolution.worktreeDir}) is no longer a valid target`,
          ["refresh the board and reselect the worktree"],
          route,
        )
        return { changeId: resolution.changeID, checkout: resolution.worktreeDir }
      }
      await launchInteractiveRun(targetDir, [resolution.changeID], preset, route)
      return { changeId: resolution.changeID, checkout: resolution.worktreeDir }
    }
    case "close-change": {
      // The board's handoff runs the same worktree close composite as the
      // CLI (capability feature-close, design D8): sync as needed, archive
      // the explicitly selected local change, squash the whole branch.
      const { runWorktreeClose } = await import("./worktree-commands")
      const { detectBaseRef } = await import("./git")
      const detected = await detectBaseRef(targetDir).catch(() => undefined)
      const base = detected?.ref
      if (!base) throw new Error("no base could be detected for close — pass an explicit base")
      // A refused close surfaces its blockers through the launching browser's
      // notice (task 7.9) rather than returning silently.
      await runMenuGuarded(route, () => runWorktreeClose({ checkout: resolution.worktreeDir, base, changes: [resolution.changeID] }, targetDir))
      return { changeId: resolution.changeID, checkout: resolution.worktreeDir }
    }
    case "archive-change": {
      // The board's handoff archives the selected change through the guarded
      // operation (task: archive change), with its outcome shown in a notice.
      const { runWorktreeArchive } = await import("./worktree-commands")
      await runMenuGuarded(route, () => runWorktreeArchive({ worktree: resolution.worktreeDir, changes: [resolution.changeID], route }))
      return { changeId: resolution.changeID, checkout: resolution.worktreeDir }
    }
  }
}

/**
 * The launcher preset for an explicit checkout: the observed branch, validated
 * before the launcher opens. `undefined` when the checkout is gone or no
 * longer a registered checkout of this repository — never a fallback to the
 * launch directory.
 */
async function checkoutPreset(checkout: string, requireBranch?: string): Promise<{ worktreeDir: string; branch: string } | undefined> {
  const { observeCheckoutTarget } = await import("./worktree-target")
  try {
    const target = await observeCheckoutTarget(checkout)
    if (requireBranch !== undefined && target.branch !== requireBranch) return undefined
    if (!target.branch) return undefined
    return { worktreeDir: target.checkoutPath, branch: target.branch }
  } catch {
    return undefined
  }
}

/**
 * Opens (or resumes) the authoring conversation for a validated checkout
 * (capability work-conversations delta): the checkout locator and harness
 * session reference are navigation metadata only — no feature registry, no
 * spec ownership. A verifiable linked session is resumed exactly; without
 * one a new conversation is created and its reference stored; the writer
 * claim is taken before any writer work and reconciled against actual
 * session activity on return. Exported for the conversation-resume tests.
 */
export async function openCheckoutConversation(input: { launchDir: string; route: TuiRoute; checkout: string; displayName: string }): Promise<void> {
  const { createAuthoringConversation, openConversationForeground, validateAuthoringSession } = await import("./conversations")

  // The configured authoring harness; a Claude one needs no server at all.
  const authoring = await authoringRouteFor(input.launchDir)
  let serviceHandle: { url: string; password?: string } | undefined
  const ensureServer = async (): Promise<boolean> => {
    if (serviceHandle) return true
    const server = await resolveAuthoringServer({ launchDir: input.launchDir, checkout: input.checkout, route: input.route })
    if (server.status === "blocked") return false
    if (server.status === "service") serviceHandle = { url: server.url, ...(server.password ? { password: server.password } : {}) }
    return true
  }

  // Resume the exactly linked session when a verifiable reference exists
  // (capability work-conversations): the stored reference is navigation
  // metadata, validated against live Git continuity and the harness before
  // any use. An unavailable linked session is reported — never silently
  // replaced — and the stale hint is dropped so the next explicit selection
  // starts a new conversation. Hints are keyed by the canonical checkout
  // path, so the lookup observes the target first.
  const { repoCommonDir } = await import("./repo-store")
  const { readVerifiableConversationRef, clearConversationRef, saveConversationRef } = await import("./session-hints")
  const { observeCheckoutTarget } = await import("./worktree-target")
  const commonDir = await repoCommonDir(input.launchDir).catch(() => undefined)
  const target = await observeCheckoutTarget(input.checkout).catch(() => undefined)
  const canonicalCheckout = target?.checkoutPath ?? input.checkout
  if (commonDir) {
    const linked = await readVerifiableConversationRef(commonDir, canonicalCheckout).catch(() => undefined)
    if (linked) {
      // An exact session reopens on its own harness, whatever the default is now.
      if (linked.ref.harness === "opencode" && !(await ensureServer())) return
      const validation = await validateAuthoringSession({ ref: linked.ref, checkout: input.checkout, ...(serviceHandle ? { server: serviceHandle } : {}) }).catch((error: unknown) => ({ status: "unavailable" as const, reason: error instanceof Error ? error.message : String(error) }))
      if (validation.status === "available") {
        await openLinkedConversation(input, linked.ref, authoring.auth)
        return
      }
      await clearConversationRef(commonDir, canonicalCheckout).catch(() => {})
      await reportHandoffBlocker(
        `the linked session could not be opened: ${validation.reason}`,
        ["select Open conversation again to start a new conversation in this checkout"],
        input.route,
      )
      return
    }
  }

  if (authoring.harness === "opencode" && !(await ensureServer())) return
  const ref = await createAuthoringConversation({ checkout: input.checkout, title: input.displayName, harness: authoring.harness, ...(serviceHandle ? { server: serviceHandle } : {}) })
  if (commonDir && target) await saveConversationRef(commonDir, target, ref).catch(() => {})
  const { currentBranch } = await import("./git")
  const branch = (await currentBranch(input.checkout).catch(() => undefined)) ?? ""

  if (!(await claimAuthoringWriter({ launchDir: input.launchDir, checkout: input.checkout, branch, sessionId: ref.sessionId, route: input.route }))) return
  // The shared foreground host owns the suspend/clear/resume lifecycle; the
  // conversation client owns the terminal until it exits (design D4).
  const renderer = input.route.session.renderer
  const exitCode = await openConversationForeground({ checkout: input.checkout, ref, ...(authoring.auth ? { auth: authoring.auth } : {}), suspend: () => renderer.suspend(), resume: () => renderer.resume() })
  await releaseAuthoringWriterIfIdle({ launchDir: input.launchDir, checkout: input.checkout, branch, ref, foregroundExited: true })
  if (exitCode !== 0) {
    await reportHandoffBlocker(
      `the conversation client exited with code ${exitCode}`,
      ["reopen the worktree to continue — its artifacts and observations refresh on return"],
      input.route,
    )
  }
}

/** Opens a verified linked session in the foreground and returns to the same checkout (shared by create and resume). */
async function openLinkedConversation(
  input: { launchDir: string; checkout: string; route: TuiRoute; displayName: string },
  ref: import("./conversations").AuthoringSessionRef,
  auth?: import("./runners/contracts").AuthenticationSelection,
): Promise<void> {
  const { openConversationForeground } = await import("./conversations")
  const { currentBranch } = await import("./git")
  const branch = (await currentBranch(input.checkout).catch(() => undefined)) ?? ""
  if (!(await claimAuthoringWriter({ launchDir: input.launchDir, checkout: input.checkout, branch, sessionId: ref.sessionId, route: input.route }))) return
  const renderer = input.route.session.renderer
  const exitCode = await openConversationForeground({ checkout: input.checkout, ref, ...(auth ? { auth } : {}), suspend: () => renderer.suspend(), resume: () => renderer.resume() })
  await releaseAuthoringWriterIfIdle({ launchDir: input.launchDir, checkout: input.checkout, branch, ref, foregroundExited: true })
  if (exitCode !== 0) {
    await reportHandoffBlocker(
      `the conversation client exited with code ${exitCode}`,
      ["reopen the worktree to continue — its artifacts and observations refresh on return"],
      input.route,
    )
  }
}

/**
 * Explicit external presentation of a checkout's authoring conversation: the
 * writer claim is taken before any pane is created, and a successful pane
 * whose harness session cannot be verified is never reported as a running
 * conversation. The claim is deliberately not released on return — the
 * external client may still be writing — and is reconciled later against
 * actual session activity.
 */
async function openCheckoutConversationExternal(input: { launchDir: string; checkout: string; branch: string; route?: TuiRoute }): Promise<void> {
  const { createAuthoringConversation, openConversationExternal, validateAuthoringSession } = await import("./conversations")

  const authoring = await authoringRouteFor(input.launchDir)
  let serviceHandle: { url: string; password?: string } | undefined
  if (authoring.harness === "opencode") {
    const serverResolution = await resolveAuthoringServer({ launchDir: input.launchDir, checkout: input.checkout, route: input.route })
    if (serverResolution.status === "blocked") return
    if (serverResolution.status === "service") serviceHandle = { url: serverResolution.url, ...(serverResolution.password ? { password: serverResolution.password } : {}) }
  }

  // The external pane presents the same exact session reference as the
  // foreground presentation: a verifiable linked session is reused, never
  // silently replaced with a new one.
  const { repoCommonDir } = await import("./repo-store")
  const { readVerifiableConversationRef, saveConversationRef } = await import("./session-hints")
  const commonDir = await repoCommonDir(input.launchDir).catch(() => undefined)
  let ref: import("./conversations").AuthoringSessionRef | undefined
  if (commonDir) {
    const linked = await readVerifiableConversationRef(commonDir, input.checkout).catch(() => undefined)
    // A linked session on another harness is not this flow's to reopen without its server.
    if (linked && linked.ref.harness === authoring.harness) {
      const validation = await validateAuthoringSession({ ref: linked.ref, checkout: input.checkout, ...(serviceHandle ? { server: serviceHandle } : {}) }).catch(() => ({ status: "unavailable" as const, reason: "probe failed" }))
      if (validation.status === "available") ref = linked.ref
    }
  }
  if (!ref) {
    ref = await createAuthoringConversation({
      checkout: input.checkout,
      title: input.branch,
      harness: authoring.harness,
      ...(serviceHandle ? { server: serviceHandle } : {}),
    })
    if (commonDir) {
      const { observeCheckoutTarget } = await import("./worktree-target")
      const target = await observeCheckoutTarget(input.checkout).catch(() => undefined)
      if (target) await saveConversationRef(commonDir, target, ref).catch(() => {})
    }
  }
  if (!(await claimAuthoringWriter({ launchDir: input.launchDir, checkout: input.checkout, branch: input.branch, sessionId: ref.sessionId, route: input.route }))) return
  const outcome = await openConversationExternal({
    checkout: input.checkout,
    ref,
    ...(serviceHandle ? { server: serviceHandle } : {}),
    ...(authoring.auth ? { auth: authoring.auth } : {}),
  })
  if (outcome.status === "failed") {
    // No pane was created, so no writer was started: release the claim this
    // path took instead of wedging the checkout.
    const { releaseWriterClaim } = await import("./writer-claims")
    if (commonDir) await releaseWriterClaim({ commonDir, branch: input.branch, owner: ref.sessionId }).catch(() => {})
    await reportHandoffBlocker(`the external window could not be opened: ${outcome.reason}`, ["open the conversation foreground from the worktree instead"], input.route)
  }
}

/**
 * Runs the project's authoring workflow in a validated checkout (capability
 * work-context delta): validates the project command through the supported
 * command API, creates the authoring conversation, invokes the command inside
 * it, and hands the terminal to the foreground client. New artifacts are
 * usable without association review or registry writes; a differing change id
 * never renames the worktree's branch.
 */
async function proposeInCheckout(input: { launchDir: string; route: TuiRoute; checkout: string; branch: string; displayName: string }): Promise<void> {
  const authoring = await authoringRouteFor(input.launchDir)
  if (authoring.harness === "claude-code") {
    await proposeInCheckoutWithClaude(input, authoring.auth)
    return
  }
  const { bootOpencodeServerFrom } = await import("./opencode")
  const { createAuthoringConversation, listAuthoringCommands, invokeAuthoringCommand, openConversationForeground } = await import("./conversations")
  const { startProposalCommand } = await import("./propose-service")

  const serverResolution = await resolveAuthoringServer({ launchDir: input.launchDir, checkout: input.checkout, route: input.route })
  if (serverResolution.status === "blocked") return
  let serviceHandle: { url: string; password?: string } | undefined
  let helper: { url: string; password?: string; close?(): void | Promise<unknown> } | undefined
  if (serverResolution.status === "service") {
    // An injected service URL conveys no shutdown right: the independent
    // service owner remains authoritative (design D1).
    serviceHandle = { url: serverResolution.url, ...(serverResolution.password ? { password: serverResolution.password } : {}) }
  } else {
    const booted = await bootOpencodeServerFrom(input.checkout).catch(() => undefined)
    if (booted) {
      serviceHandle = booted
      helper = booted
    }
  }
  if (!serviceHandle) {
    await reportHandoffBlocker(
      "the authoring workflow could not start: no server could be established for this checkout",
      ["open an ordinary conversation in the worktree instead"],
      input.route,
    )
    return
  }

  // The writer claim precedes any writer work (capability work-conversations:
  // a conflicting managed writer is refused before a second writer starts).
  const { repoCommonDir } = await import("./repo-store")
  const { acquireWriterClaim, writerConflictGuidance, releaseWriterClaim } = await import("./writer-claims")
  const commonDir = await repoCommonDir(input.launchDir).catch(() => undefined)
  let claimed = false

  // Discovery, ownership transfer, and command invocation live in one tested
  // helper (design D1/D6): the fallback helper is stopped on every early
  // return, and the independent service is established strictly before the
  // command runs, so no command ever executes under recoverable helper
  // ownership.
  const outcome = await startProposalCommand(helper ? { kind: "helper", url: serviceHandle.url, ...(serviceHandle.password ? { password: serviceHandle.password } : {}) } : { kind: "independent", url: serviceHandle.url, ...(serviceHandle.password ? { password: serviceHandle.password } : {}) }, {
    listCommands: (server) => listAuthoringCommands({ checkout: input.checkout, server }),
    transfer: async () => {
      if (!commonDir) return { status: "unavailable" as const, reason: "this checkout has no repository storage for an independent authoring service" }
      const { ensureConversationService } = await import("./conversation-service")
      return await ensureConversationService({ commonDir, checkout: input.checkout }).catch((error: unknown) => ({
        status: "unavailable" as const,
        reason: error instanceof Error ? error.message : String(error),
      }))
    },
    stopHelper: () => Promise.resolve(helper?.close?.()),
    // The claim is taken before any session exists, under the "convoy"
    // pre-session owner: the failure-path release and the post-session
    // re-own (`reconcileOwner: "convoy"`) match this owner, so a failed
    // propose always releases what it claimed.
    acquireClaim: async () => {
      if (!commonDir) return { ok: true as const }
      const acquired = await acquireWriterClaim({ commonDir, branch: input.branch, checkoutPath: input.checkout, kind: "authoring", owner: "convoy" })
      if (acquired.status === "acquired") {
        claimed = true
        return { ok: true as const }
      }
      const guidance =
        acquired.status === "conflict"
          ? writerConflictGuidance(acquired.existing)
          : ["a writer claim for this checkout is in an uncertain state — reconcile it before starting another writer"]
      return { ok: false as const, reason: guidance[0]!, remediation: guidance.slice(1) }
    },
    // Release by pid: the re-own to the session id only runs after success,
    // so on a failure path the claim is still this process's (a mismatched
    // owner release is a no-op and would wedge the checkout behind a claim).
    releaseClaim: async () => {
      if (claimed && commonDir) await releaseWriterClaim({ commonDir, branch: input.branch, ownerPid: process.pid }).catch(() => {})
    },
    createConversation: (server) => createAuthoringConversation({ checkout: input.checkout, title: input.displayName, server }) as Promise<{ harness: "opencode"; sessionId: string }>,
    invokeCommand: ({ ref, server, command }) => invokeAuthoringCommand({ ref, server, command }),
  })

  if (outcome.status === "blocked") {
    await reportHandoffBlocker(outcome.reason, outcome.remediation, input.route)
    return
  }

  // Re-own the claim by the session id so the idle release and conflict
  // guidance keep naming the actual writer.
  if (claimed && commonDir) {
    const { acquireWriterClaim } = await import("./writer-claims")
    await acquireWriterClaim({ commonDir, branch: input.branch, checkoutPath: input.checkout, kind: "authoring", owner: outcome.ref.sessionId, reconcileOwner: "convoy" }).catch(() => {})
  }

  const renderer = input.route.session.renderer
  const exitCode = await openConversationForeground({ checkout: input.checkout, ref: outcome.ref, suspend: () => renderer.suspend(), resume: () => renderer.resume() })
  await releaseAuthoringWriterIfIdle({ launchDir: input.launchDir, checkout: input.checkout, branch: input.branch, ref: outcome.ref })
  if (exitCode !== 0) {
    await reportHandoffBlocker(`the authoring client exited with code ${exitCode}`, ["reopen the worktree to continue"], input.route)
  }
}

/**
 * The proposal workflow through Claude: the project's own slash command
 * (`.claude/commands/`), found the way OpenCode's is, starts a fresh exact
 * session as its first message under the writer claim. No server is needed;
 * a project without the command reports that rather than imitating it.
 */
async function proposeInCheckoutWithClaude(
  input: { launchDir: string; route: TuiRoute; checkout: string; branch: string; displayName: string },
  auth: import("./runners/contracts").AuthenticationSelection | undefined,
): Promise<void> {
  const { createAuthoringConversation, listClaudeAuthoringCommands, openConversationForeground } = await import("./conversations")
  const { findProposalCommand } = await import("./propose-service")
  const command = findProposalCommand(await listClaudeAuthoringCommands(input.checkout))
  if (!command) {
    await reportHandoffBlocker(
      "this project has no supported proposal workflow command (looked for opsx:propose under .claude/commands/)",
      ["check the project's .claude/commands/ directory — Convoy does not install commands into it", "open an ordinary conversation in the worktree instead"],
      input.route,
    )
    return
  }
  const ref = await createAuthoringConversation({ checkout: input.checkout, harness: "claude-code" })
  if (!(await claimAuthoringWriter({ launchDir: input.launchDir, checkout: input.checkout, branch: input.branch, sessionId: ref.sessionId, route: input.route }))) return
  const { repoCommonDir } = await import("./repo-store")
  const { saveConversationRef } = await import("./session-hints")
  const { observeCheckoutTarget } = await import("./worktree-target")
  const commonDir = await repoCommonDir(input.launchDir).catch(() => undefined)
  const target = await observeCheckoutTarget(input.checkout).catch(() => undefined)
  if (commonDir && target) await saveConversationRef(commonDir, target, ref).catch(() => {})
  const renderer = input.route.session.renderer
  const exitCode = await openConversationForeground({ checkout: input.checkout, ref, ...(auth ? { auth } : {}), prompt: `/${command}`, suspend: () => renderer.suspend(), resume: () => renderer.resume() })
  await releaseAuthoringWriterIfIdle({ launchDir: input.launchDir, checkout: input.checkout, branch: input.branch, ref, foregroundExited: true })
  if (exitCode !== 0) await reportHandoffBlocker(`the authoring client exited with code ${exitCode}`, ["reopen the worktree to continue"], input.route)
}

/**
 * The harness authoring flows open (`defaults.authoring.runner`, else the
 * run-wide `defaults.runner` when it can host a conversation, else OpenCode)
 * and, for a runner that authenticates, the reviewed authentication:
 * `defaults.authoring.authMode` with that runner's credential reference,
 * else its configured auth.
 */
async function authoringRouteFor(launchDir: string): Promise<import("./conversations").AuthoringRoute> {
  const { runnerDescriptor } = await import("./runners/descriptors")
  const config = await loadMergedConvoyConfig(launchDir).catch(() => undefined)
  const defaults = config?.defaults
  const harness = authoringHarnessOf(config)
  if (!runnerDescriptor(harness).authenticates) return { harness: harness as import("./conversations").AuthoringHarness }
  const configuredAuth = runnerAuthOf(config)[harness]
  const mode = defaults?.authoring?.authMode
  const auth = mode === "api-key" ? { mode, ...(configuredAuth?.credentialRef ? { credentialRef: configuredAuth.credentialRef } : {}) } : mode ? { mode } : (configuredAuth ?? { mode: "subscription" as const })
  return { harness: harness as import("./conversations").AuthoringHarness, auth }
}

/** Reports an unavailable handoff without launching anything. */
async function reportHandoffBlocker(reason: string, remediation: readonly string[], route?: TuiRoute): Promise<void> {
  const message = [reason, ...remediation].join("\n")
  if (route) {
    const { showNoticeTui } = await import("./notice-tui")
    await showNoticeTui(route, { title: "work context unavailable", message })
    return
  }
  process.stderr.write(`${message}\n`)
}

/**
 * Resolves the authoring server for a CLI handoff (task 4.3): the repository's
 * conversation service — discovered, liveness-verified, and independent of run
 * servers and views — supplies one reused OpenCode server for every authoring
 * call in the flow. Outcomes:
 * - `service` — a live service URL to pass through as the handle (never
 *   closed by the caller; the service outlives the flow).
 * - `fallback` — the lifecycle store is absent or the service boot failed;
 *   the flow uses the previous bounded per-call boots.
 * - `blocked` — an existing service is in an unverified state (alive PID,
 *   unanswerable URL) or its discovery record is unreadable: fail closed and
 *   report, never boot a second server over unverified state.
 */
async function resolveAuthoringServer(input: { launchDir: string; checkout: string; route?: TuiRoute }): Promise<{ status: "service"; url: string; password?: string } | { status: "fallback" } | { status: "blocked"; reason: string }> {
  const { repoCommonDir } = await import("./repo-store")
  const commonDir = await repoCommonDir(input.launchDir).catch(() => undefined)
  if (!commonDir) return { status: "fallback" }
  const { ensureConversationService } = await import("./conversation-service")
  const service = await ensureConversationService({ commonDir, checkout: input.checkout }).catch((error: unknown) => ({ status: "unavailable" as const, reason: error instanceof Error ? error.message : String(error) }))
  if (service.status === "live") return { status: "service", url: service.url, ...(service.password ? { password: service.password } : {}) }
  if (service.status === "uncertain") {
    await reportHandoffBlocker(service.reason, ["the service is kept running and nothing was booted over it — resolve its state, then retry"], input.route)
    return { status: "blocked", reason: service.reason }
  }
  return { status: "fallback" }
}

/** The shared writer-claim acquisition for an authoring conversation in a checkout. */
async function claimAuthoringWriter(input: { launchDir: string; checkout: string; branch: string; sessionId: string; route?: TuiRoute }): Promise<boolean> {
  const { repoCommonDir } = await import("./repo-store")
  const { acquireWriterClaim, writerConflictGuidance } = await import("./writer-claims")
  const commonDir = await repoCommonDir(input.launchDir).catch(() => undefined)
  if (!commonDir) return true
  const acquired = await acquireWriterClaim({
    commonDir,
    branch: input.branch,
    checkoutPath: input.checkout,
    kind: "authoring",
    owner: input.sessionId,
    // Re-opening the conversation that already holds the claim is the same
    // writer continuing, not a takeover (design D5 reconciliation).
    reconcileOwner: input.sessionId,
  })
  if (acquired.status === "acquired") return true
  const guidance = acquired.status === "conflict" ? writerConflictGuidance(acquired.existing) : ["a writer claim for this checkout is in an uncertain state — reconcile it before starting another writer"]
  await reportHandoffBlocker(guidance[0], guidance.slice(1), input.route)
  return false
}

/** Releases the authoring claim when the session is provably quiescent (design D5). */
async function releaseAuthoringWriterIfIdle(input: { launchDir: string; checkout: string; branch: string; ref: import("./conversations").AuthoringSessionRef; foregroundExited?: boolean }): Promise<void> {
  const { repoCommonDir } = await import("./repo-store")
  const { releaseWriterClaim } = await import("./writer-claims")
  const { sessionActivity } = await import("./conversations")
  const commonDir = await repoCommonDir(input.launchDir).catch(() => undefined)
  if (!commonDir) return
  // A Claude conversation runs only inside its client: once the foreground
  // client exited, the session is provably quiescent. Anything else keeps
  // the claim for later reconciliation.
  if (input.ref.harness === "claude-code") {
    if (input.foregroundExited) await releaseWriterClaim({ commonDir, branch: input.branch, owner: input.ref.sessionId })
    return
  }
  // The activity query goes through the authoring service when one is live
  // (task 4.3) so the answer reflects the same server the work ran on; any
  // discovery failure falls back to the adapter's bounded boot, and either
  // failure reads as "unknown" — which keeps the claim. No blockers are
  // reported here: the release path is bookkeeping, not a user handoff.
  let serviceHandle: { url: string; password?: string } | undefined
  try {
    const { ensureConversationService } = await import("./conversation-service")
    const service = await ensureConversationService({ commonDir, checkout: input.checkout })
    if (service.status === "live") serviceHandle = { url: service.url, ...(service.password ? { password: service.password } : {}) }
  } catch {
    serviceHandle = undefined
  }
  const activity = await sessionActivity({ checkout: input.checkout, ref: input.ref, ...(serviceHandle ? { server: serviceHandle } : {}) }).catch(() => "unknown" as const)
  // A busy or unanswerable session keeps its claim: view detachment is not
  // evidence the agent stopped (design D5). The claim's staleness rules
  // reconcile it later if the process is gone.
  if (activity === "idle") await releaseWriterClaim({ commonDir, branch: input.branch, owner: input.ref.sessionId })
}

// The browser resumes with default flags; metadata recovers both the repo the
// run was launched against and the pipeline it was running.
async function resumeOptions(runID: string, targetDir?: string): Promise<RunOptions> {
  const parsed = parseArgs([])
  parsed.resumeRunID = runID
  if (targetDir) parsed.targetDir = targetDir
  const options: RunOptions = { ...(await resolveRunOptions(parsed)), prompt: "" }
  const workspace = await resumeWorkspace(runID)
  const metadata = await readRunMetadata(resolve(workspace.dir, "metadata.json"))
  assertResumableRun(metadata, runID)
  if (metadata?.pipeline) options.pipeline = metadata.pipeline
  options.gateway = metadata?.modelRouting?.gateway ?? "configured"
  try {
    options.prompt = await readFile(resolve(workspace.dir, "prd.md"), "utf8")
  } catch {
    // Legacy/incomplete workspace.
  }
  options.plan = await buildReviewedPlan({ ...options, promptSource: "resume" })
  return options
}

// Retry is a fresh run that reuses the selected run's original prompt and
// pipeline config: a new run dir from step 0, not a resume of the old one.
// Like resume, the prompt and pipeline come back from the run's metadata so the
// user doesn't have to retype or reconfigure anything.
async function retryOptions(runID: string, targetDir?: string): Promise<RunOptions> {
  // The recorded target may have been a worktree that's since been removed; a
  // retry starts a fresh run, so falling back to the current directory keeps it
  // runnable instead of failing on a missing path.
  const resolvedTarget = (targetDir && (await dirExists(targetDir))) ? targetDir : process.cwd()
  const parsed = parseArgs([])
  parsed.targetDir = resolvedTarget
  const options: RunOptions = { ...(await resolveRunOptions(parsed)), prompt: "" }
  const workspace = await resumeWorkspace(runID)
  const metadata = await readRunMetadata(resolve(workspace.dir, "metadata.json"))
  assertResumableRun(metadata, runID, { retry: true })
  if (metadata?.pipeline) options.pipeline = metadata.pipeline
  options.gateway = metadata?.modelRouting?.gateway ?? "configured"
  try {
    options.prompt = await readFile(resolve(workspace.dir, "prd.md"), "utf8")
  } catch {
    // Legacy/incomplete workspace.
  }
  options.plan = await buildReviewedPlan({ ...options, promptSource: "retry" })
  return options
}

/**
 * Refuses to resume or retry a legacy schema-v3 `goal-fix` record. Those runs
 * were recorded by the retired child-run host: their frozen pipeline is a plain
 * `goal-fix` pipeline with no terminal goal step, so replaying it would start
 * an unbriefed improvement flow — exactly what the reserved-name guard exists
 * to prevent. The record remains readable historically (the runs browser shows
 * it); only the "continue" surfaces reject it, before any plan is built.
 * Exported so the resume/retry refusal is covered by regression tests.
 */
export function assertResumableRun(metadata: RunMetadata | undefined, runID: string, options: { retry?: boolean } = {}): void {
  if (metadata?.pipeline?.name !== "goal-fix") return
  throw new Error(
    `run ${runID} is a legacy goal-fix run recorded by an earlier Convoy; ${options.retry ? "retrying" : "resuming"} it would start an unbriefed improvement flow. ` +
      "Goal fragments are now internal to a pipeline's terminal goal step — run a pipeline that declares one (e.g. convoy -p ship) instead.",
  )
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * The management key never touches convoy's argv, env, or disk: `security`
 * itself prompts for the value and the status report only says which sources
 * exist, never what they contain.
 */
async function runAuthCommand(action: "set" | "remove" | "status") {
  if (action === "status") {
    const sources = await openRouterKeySources()
    const lines = [
      "openrouter key sources (in precedence order):",
      `  keychain (convoy auth openrouter)  ${sources.keychain ? "configured — exact /credits balance" : "not set"}`,
      `  env OPENROUTER_API_KEY             ${sources.env ? "set" : "not set"}`,
      `  opencode auth.json                 ${sources.opencode ? "present" : "not found"}`,
    ]
    if (!sources.keychain) lines.push("  without a management key the header meter falls back to /key (key limit or monthly spend)")
    process.stdout.write(`${lines.join("\n")}\n`)
    return
  }
  if (action === "remove") {
    const removed = await deleteKeychainSecret("openrouter")
    process.stdout.write(removed ? "removed the openrouter key from the keychain\n" : "no openrouter key in the keychain\n")
    return
  }
  if (!keychainAvailable()) {
    throw new Error("the keychain is only available on macOS; set OPENROUTER_API_KEY in the environment instead")
  }
  process.stdout.write('storing the OpenRouter management key in the macOS Keychain (service "convoy"):\n')
  const stored = await storeKeychainSecret("openrouter")
  if (!stored) throw new Error("security add-generic-password failed; the key was not stored")
  process.stdout.write("openrouter key stored — the run header will show the exact credit balance\n")
}

export async function parseCommand(argv: string[]): Promise<CliCommand> {
  if (argv[0] === "--coordinate") {
    const launchPath = argv[1]
    if (launchPath === undefined || launchPath.startsWith("-")) {
      throw new Error("--coordinate requires a launch file path (internal use)")
    }
    return { type: "coordinate", launchPath }
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) return { type: "version" }
  if (argv[0] === "update") {
    if (argv.length === 1) return { type: "update", checkOnly: false }
    if (argv.length === 2 && argv[1] === "--check") return { type: "update", checkOnly: true }
    if (argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) return { type: "help", text: updateHelp() }
    throw new Error("usage: convoy update [--check]")
  }
  if (argv[0] === "auth") {
    const rest = argv.slice(1)
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "status")) {
      return { type: "auth", provider: "openrouter", action: "status" }
    }
    if (rest[0] === "openrouter") {
      if (rest.length === 1) return { type: "auth", provider: "openrouter", action: "set" }
      if (rest.length === 2 && rest[1] === "--remove") return { type: "auth", provider: "openrouter", action: "remove" }
    }
    throw new Error("usage: convoy auth [status] | convoy auth openrouter [--remove]")
  }
  if (argv[0] === "runs") {
    const rest = argv.slice(1)
    const { parseRunsArgs, runsHelp } = await import("./runs-command")
    if (rest.some((arg) => arg === "--help" || arg === "-h")) return { type: "help", text: runsHelp() }
    const parsed = parseRunsArgs(rest)
    // The bare and run-id forms keep the browser (plain text off a terminal);
    // --json, --wait, and the answers are the scripted surface.
    if (parsed.kind === "browse") return { type: "runs", runID: parsed.runID }
    return { type: "runs-query", command: parsed }
  }
  if (argv[0] === "pipelines") {
    const { parsePipelinesArgs } = await import("./pipelines-command")
    return parsePipelinesArgs(argv.slice(1))
  }
  if (argv[0] === "skill") {
    const { parseSkillArgs } = await import("./skill-install")
    return parseSkillArgs(argv.slice(1))
  }
  if (argv[0] === "specs") {
    // No positionals or flags yet — the viewer reads the whole OpenSpec state.
    if (argv.length > 1) throw new Error("usage: convoy specs")
    return { type: "specs", targetDir: process.cwd() }
  }
  if (argv[0] === "control") {
    // The compatibility alias opens the same worktree control board (design
    // D4): one board, every entry point — never a competing model.
    if (argv.length > 1) throw new Error("usage: convoy control")
    return { type: "worktrees", args: [] }
  }
  if (argv[0] === "spin") {
    if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
      const { spinHelp } = await import("./spin")
      return { type: "help", text: spinHelp() }
    }
    return { type: "spin", options: parseSpinArgs(argv.slice(1)) }
  }
  if (argv[0] === "close") {
    // `convoy close` delegates to the shared worktree composite (capability
    // feature-close, design D4/D8): one close implementation, every entry
    // point. Legacy branch selectors resolve uniquely through Git; feature-id
    // and cleanup spellings stop with migration guidance.
    if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
      const { closeCommandHelp } = await import("./worktree-commands")
      return { type: "help", text: closeCommandHelp() }
    }
    return { type: "close", args: argv.slice(1) }
  }
  if (argv[0] === "worktrees") {
    // The worktree control center's CLI surface (design D4): bare `convoy
    // worktrees` prints the inventory; subcommands are parsed and dispatched
    // by the worktree-commands module.
    return { type: "worktrees", args: argv.slice(1) }
  }
  if (argv[0] === "publish") {
    // The explicit headless publication request: effects require --yes; without
    // it (or with --dry-run) the command only prints the reviewed plan and text.
    if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) return { type: "help", text: publishHelp() }
    return { type: "publish", options: parsePublishArgs(argv.slice(1)) }
  }
  if (argv[0] === "feature") {
    // The feature lifecycle is retired (capability feature-lifecycle): the
    // command is recognized by spelling alone — before any subcommand or flag
    // parsing that could mistake it for a prompt — and fails non-zero with
    // worktree-selection guidance before any Git, registry, or pipeline
    // effect. No alias fabricates an association to keep it alive.
    return { type: "retired-feature", args: argv.slice(1) }
  }
  if (argv[0] === "config") {
    if (argv.length > 1) throw new Error("usage: convoy config")
    return { type: "config", targetDir: process.cwd() }
  }
  if (argv[0] === "init") {
    const parsed = parseInitArgs(argv.slice(1))
    if (parsed.help) return { type: "help", text: initHelp() }
    return { type: "init", options: parsed }
  }
  if (argv[0] === "agents") {
    const rest = argv.slice(1)
    if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") return { type: "help", text: agentsHelp() }
    if (rest[0] !== "eject") throw new Error("usage: convoy agents eject <agent> [--global] [--dir <path>] [--force]")
    // The agent name is positional; everything after it reuses init's flag
    // parser so --global/--dir/--force mean exactly what they mean for init.
    const name = rest[1]
    if (name === undefined || name.startsWith("-")) {
      if (name === "--help" || name === "-h") return { type: "help", text: agentsHelp() }
      throw new Error("usage: convoy agents eject <agent> [--global] [--dir <path>] [--force]")
    }
    const parsed = parseInitArgs(rest.slice(2))
    if (parsed.help) return { type: "help", text: agentsHelp() }
    return { type: "agents", action: "eject", agentName: name, options: parsed }
  }
  if (argv[0] === "finish") {
    // The retired command is recognized by spelling alone — before any option
    // parsing that could mistake it for a new prompt — and fails non-zero with
    // no repository or run side effects. It is not a compatibility command
    // (capability run-finalization: manual finish was removed).
    return { type: "retired-finish" }
  }
  if (argv[0] === "opencode") {
    const rest = argv.slice(1)
    if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
      const { opencodeInstallHelp } = await import("./opencode-install")
      return { type: "help", text: opencodeInstallHelp() }
    }
    if (rest[0] !== "install" || rest.length > 1) throw new Error("usage: convoy opencode install")
    return { type: "opencode-install" }
  }

  if (argv[0] === "hook") return { type: "hook" }
  if (argv[0] === "mcp") return { type: "mcp", args: argv.slice(1) }

  const parsed = parseArgs(argv)
  if (parsed.help) return { type: "help", text: help() }

  const hasInlinePrompt = parsed.prompt !== undefined
  const hasPromptFile = parsed.promptFile !== undefined
  const hasResume = parsed.resumeRunID !== undefined

  if (hasInlinePrompt && hasPromptFile) {
    throw new Error("use either a positional prompt or --prompt-file, not both")
  }
  if (hasResume && (hasInlinePrompt || hasPromptFile)) {
    throw new Error("--resume continues a previous run with its original PRD; it can't take a new prompt")
  }
  if (hasResume && !isValidRunID(parsed.resumeRunID!)) throw new Error(`invalid run id: ${parsed.resumeRunID}`)

  let prompt = parsed.prompt ?? ""
  if (hasPromptFile) {
    prompt = await readFile(resolve(process.cwd(), parsed.promptFile!), "utf8")
  }

  const missingPromptMessage =
    "need a prompt (positional or --prompt-file) or --resume <id>, or the selected pipeline must provide a defaultPrompt"
  // An explicit-but-empty source is still explicit: report it as empty rather
  // than silently replacing it with the selected pipeline's default.
  if (!prompt && !hasResume && (hasInlinePrompt || hasPromptFile)) throw new Error(missingPromptMessage)

  // Resolve once so the selected pipeline and its fallback prompt always come
  // from the same merged-config snapshot.
  const resolvedOptions = await resolveRunOptions(parsed)
  if (!prompt && !hasResume) {
    // A pinned OpenSpec change is the contract: inject a short canned prompt
    // so `convoy --change add-login -p implement` does not require a brief.
    if (parsed.changes.length > 0) {
      prompt = openSpecPromptFor(resolvedOptions.pipeline.name)
    } else if (!hasInlinePrompt && !hasPromptFile && resolvedOptions.pipeline.defaultPrompt) {
      // A concrete-action pipeline (review, ship, hunter, ...) may carry a
      // defaultPrompt so `convoy -p review` runs without typing one. Anything
      // that counts as an explicit prompt source (positional, --prompt-file)
      // was already read above, so only a genuinely empty invocation falls back.
      prompt = resolvedOptions.pipeline.defaultPrompt
    }
    if (!prompt) throw new Error(missingPromptMessage)
  }

  const options: RunOptions = { ...resolvedOptions, prompt }
  // The gateway the run froze at launch, for the review's resume-override banner.
  let resumeGateway: ModelGateway | undefined
  if (hasResume) {
    const workspace = await resumeWorkspace(parsed.resumeRunID!)
    const metadata = await readRunMetadata(resolve(workspace.dir, "metadata.json"))
    // The reserved-name guard runs here, before any plan is built: replaying a
    // legacy goal-fix record as a resume would start an unbriefed improvement
    // flow. The record stays readable in history, but never continuable.
    assertResumableRun(metadata, parsed.resumeRunID!)
    if (metadata?.pipeline) options.pipeline = metadata.pipeline
    if (parsed.gateway === undefined) options.gateway = metadata?.modelRouting?.gateway ?? "configured"
    else resumeGateway = metadata?.modelRouting?.gateway ?? "configured"
    try {
      options.prompt = await readFile(resolve(workspace.dir, "prd.md"), "utf8")
    } catch {
      // Legacy/incomplete workspaces retain the empty resume prompt.
    }
  }
  // Resume filters can only be checked after metadata has restored its frozen
  // pipeline. Validate them before building a potentially empty review plan.
  validateStepFilters(options.pipeline, options)
  const promptSource: RunPlan["prompt"]["source"] = hasResume ? "resume" : hasPromptFile ? "file" : hasInlinePrompt ? "inline" : "default"
  options.plan = await buildReviewedPlan({
    ...options,
    promptSource,
    ...(resumeGateway ? { resumeGateway } : {}),
  })
  return { type: "run", options }
}

type ParsedInitArgs = InitOptions & { help?: boolean }

/** `convoy spin [--change <id>] [--prefix <type>]` — no positionals. */
export function parseSpinArgs(argv: string[]): SpinOptions {
  const options: SpinOptions = { targetDir: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--change") {
      const value = argv[++i]
      if (!value || value.startsWith("-")) throw new Error("--change requires a change id")
      options.changeID = value
      continue
    }
    if (arg.startsWith("--change=")) {
      options.changeID = arg.slice("--change=".length)
      continue
    }
    if (arg === "--prefix") {
      const value = argv[++i]
      if (!value || value.startsWith("-")) throw new Error("--prefix requires a conventional type (feat, change, fix, …)")
      options.prefix = value
      continue
    }
    if (arg.startsWith("--prefix=")) {
      options.prefix = arg.slice("--prefix=".length)
      continue
    }
    throw new Error(`usage: convoy spin [--change <id>] [--prefix <type>] (unexpected argument: ${arg})`)
  }
  return options
}

/**
 * Parses `convoy publish`'s flags. `--yes` authorizes the push + PR effects and
 * `--dry-run` inspects without them; neither given is also safe (review only).
 * A run context is optional and accepts one of `--run-dir` or `--run`.
 */
export function parsePublishArgs(argv: string[]): PublishCommandOptions {
  const options: PublishCommandOptions = { yes: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const { flag, value } = splitFlag(argv[i]!)
    const takeValue = (): string => {
      if (value !== undefined) return value
      const next = argv[++i]
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new Error(`${flag} requires a value`)
      return next
    }

    switch (flag) {
      case "--worktree":
        options.worktree = takeValue()
        break
      case "--run-dir":
        options.runDir = takeValue()
        break
      case "--run": {
        const runId = takeValue()
        if (!isValidRunID(runId)) throw new Error(`invalid run id: ${runId}`)
        options.runId = runId
        break
      }
      case "--title":
        options.title = takeValue()
        break
      case "--body":
        options.body = takeValue()
        break
      case "--yes":
        if (value !== undefined) throw new Error("--yes does not take a value")
        options.yes = true
        break
      case "--dry-run":
        if (value !== undefined) throw new Error("--dry-run does not take a value")
        options.dryRun = true
        break
      default:
        throw new Error(`usage: convoy publish [--worktree <path>] [--run-dir <path> | --run <id>] [--title <text> --body <text>] [--yes] [--dry-run] (unexpected argument: ${argv[i]})`)
    }
  }

  if (options.yes && options.dryRun) throw new Error("use either --yes (publish) or --dry-run (inspect), not both")
  if ((options.title === undefined) !== (options.body === undefined)) throw new Error("--title and --body must be provided together")
  if (options.runDir !== undefined && options.runId !== undefined) throw new Error("use either --run-dir or --run, not both")
  return options
}

function parseInitArgs(argv: string[]): ParsedInitArgs {
  const parsed: ParsedInitArgs = {
    targetDir: process.cwd(),
    global: false,
    force: false,
    quiet: false,
  }
  let hasDir = false

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (!raw.startsWith("-")) throw new Error("usage: convoy init [--global] [--force] [--dir <path>]")

    const { flag, value } = splitFlag(raw)
    const noValue = () => {
      if (value !== undefined) throw new Error(`${flag} does not take a value`)
    }
    const takeValue = () => {
      if (value !== undefined) return value
      const next = argv[++i]
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new Error(`${flag} requires a value`)
      return next
    }

    switch (flag) {
      case "--help":
      case "-h":
        noValue()
        parsed.help = true
        return parsed
      case "--global":
        noValue()
        parsed.global = true
        break
      case "--force":
        noValue()
        parsed.force = true
        break
      case "--quiet":
        noValue()
        parsed.quiet = true
        break
      case "--dir":
        parsed.targetDir = resolve(process.cwd(), takeValue())
        hasDir = true
        break
      default:
        throw new Error(`unknown init flag: ${flag}`)
    }
  }

  if (parsed.global && hasDir) throw new Error("use either --global or --dir, not both")
  return parsed
}

/** Applies the precedence chain and resolves the pipeline the run will execute. */
export async function resolveRunOptions(parsed: ParsedArgs): Promise<Omit<RunOptions, "prompt">> {
  const config = await loadMergedConvoyConfig(parsed.targetDir)
  const defaults = config?.defaults ?? {}

  // A detached run has nobody at its gates, whatever the terminal says.
  const humanReview = parsed.humanReview ?? (!parsed.detach && Boolean(process.stdin.isTTY && process.stdout.isTTY))

  const agents = buildAgentRegistry(config)
  // A pipeline file is read before the try below: unlike a config that broke
  // since a resume's run started, a bad file is always the caller's error.
  const pipelineFile = parsed.pipelineFile ? await loadPipelineFile(resolve(process.cwd(), parsed.pipelineFile)) : undefined
  const pipelineName = pipelineFile?.name ?? parsed.pipeline ?? defaults.pipeline ?? defaultPipelineName
  let pipeline: Pipeline
  try {
    pipeline = resolvePipeline({
      name: pipelineName,
      spec: pipelineFile?.spec ?? selectPipelineSpec(config, pipelineName),
      agents,
      ...pipelineDefaultsOf(defaults),
    })
  } catch (error) {
    // A resumed run replays the pipeline frozen in its metadata; a config
    // that has since broken must not block it. New runs surface the error.
    if (!parsed.resumeRunID) throw error
    pipeline = defaultPipeline()
  }
  // --no-human-review / --no-human-step (and non-interactive defaults) drop manual gates from
  // the run entirely, so they never show up as steps.
  if (!humanReview) pipeline = { ...pipeline, steps: pipeline.steps.filter((step) => step.type !== "human") }

  if (parsed.modelOverride) parseModel(splitModelVariant(parsed.modelOverride).model)
  if (parsed.advisorOverride) parseModel(splitModelVariant(parsed.advisorOverride).model)
  if (parsed.smartModel) parseModel(splitModelVariant(parsed.smartModel).model)
  // Smart auto-accept always needs a concrete judge model; resolve the fallback
  // chain here so the runner can stay oblivious to config and built-in defaults.
  // A Claude-only plan inherits its own runner for the judge (a Claude-scoped
  // --model, else Haiku) instead of an OpenCode model it could not run.
  // A plan on one CLI runner inherits that runner for the judge (a
  // runner-scoped --model, else the runner's helper model) instead of an
  // OpenCode model it could not run.
  const scopedOverride = parseModelOverride(parsed.modelOverride)
  const soleRunner = soleCliRunner(pipeline)
  const smartJudgeModel =
    parsed.smartModel ||
    defaults.autoAcceptJudgeModel ||
    (soleRunner
      ? defaultHelperRoute(soleRunner, scopedOverride.scope === soleRunner && scopedOverride.model ? scopedOverride.model : undefined)
      : parsed.modelOverride || defaults.model || `${defaultGptModel}#${defaultGptVariant}`)

  // Goal execution is enabled exclusively by the pipeline's own terminal goal
  // step: `pipeline.goalPlan` was resolved and validated by resolvePipeline, and
  // travels with the reviewed plan. There is no goal flag and no separate
  // goal-fix pipeline to resolve.
  const options: Omit<RunOptions, "prompt"> = {
    files: [...(config?.attachments ?? []), ...parsed.files],
    onlySteps: parsed.onlySteps,
    skipSteps: parsed.skipSteps,
    resumeRunID: parsed.resumeRunID ?? "",
    prdHistory: defaults.prdHistory ?? true,
    ...(parsed.changes.length > 0 ? { changes: parsed.changes } : {}),
    ...(parsed.manual ? { manual: true } : {}),
    keepRunDir: parsed.keepRunDir ?? true,
    modelOverride: parsed.modelOverride ?? "",
    advisorOverride: parsed.advisorOverride ?? "",
    advisorDisabled: parsed.advisorDisabled ?? false,
    advisorAuditPolicy: defaults.advisorAuditPolicy ?? "summary",
    tui: parsed.detach ? false : (parsed.tui ?? Boolean(process.stdout.isTTY && process.stderr.isTTY)),
    notify: parsed.notify,
    notifications: config?.notifications ?? {},
    humanReview,
    maxConcurrentAgents: parsed.maxConcurrent ?? pipeline.maxConcurrentAgents ?? defaults.maxConcurrentAgents ?? defaultMaxConcurrentAgents,
    baseRef: await resolveBaseRef(parsed, defaults),
    targetDir: parsed.targetDir,
    // A resumed run continues in the directory its metadata recorded — which is
    // already the worktree, when the original run made one — so it never creates
    // another.
    worktree: parsed.resumeRunID ? false : await resolveWorktreeOption(parsed, defaults, featuresOf(config).worktrees),
    ...(parsed.branch ? { branch: parsed.branch } : {}),
    includeDirty: parsed.includeDirty ?? false,
    yolo: parsed.yolo ?? false,
    smart: parsed.smart ?? false,
    smartJudgeModel,
    commitMessageModel: helperModel("commitMessage", defaults, defaultCommitMessageModel, soleRunner),
    ...(advisorAuthOf(config) ? { advisorAuth: advisorAuthOf(config)! } : {}),
    ...(Object.keys(runnerAuthOf(config)).length > 0 ? { runnerAuth: runnerAuthOf(config) } : {}),
    gateway: parsed.gateway ?? config?.modelRouting?.gateway ?? "configured",
    gatewayExplicit: parsed.gateway !== undefined,
    modelRoutingOverrides: config?.modelRouting?.overrides ?? {},
    planOnly: parsed.planOnly ?? false,
    // Detaching is a decision to start now: there is no review screen to return to.
    noConfirm: Boolean(parsed.noConfirm || parsed.detach),
    ...(parsed.detach ? { detach: true } : {}),
    pipeline,
    agents,
    permissions: config?.permissions ?? { allow: [], deny: [] },
    hooks: config?.hooks ?? emptyHooksConfig(),
    ...(config?.loopGuard ? { loopGuard: config.loopGuard } : {}),
  }

  // Fast feedback for typos; a resumed run validates again in the runner
  // against the pipeline frozen in its metadata.
  if (!options.resumeRunID) validateStepFilters(pipeline, options)

  return options
}

// Worktree source: flag > config defaults.worktree > features.worktrees off >
// the current branch.
// An unset config means "decide per branch", not "always isolate": on a trunk a
// run should get its own worktree, but on a branch you're already where you
// want the work. The launcher applies the same default itself, so an interactive
// run reaches this with parsed.worktree already set.
async function resolveWorktreeOption(parsed: ParsedArgs, defaults: ConvoyDefaults, worktreesEnabled: boolean): Promise<boolean> {
  const explicit = parsed.worktree ?? defaults.worktree
  if (explicit !== undefined) return explicit
  const auto = await worktreeDefaultFor(parsed.targetDir, worktreesEnabled)
  log.info(`worktree: ${auto.isolate ? "on" : "off"} (${auto.reason})`)
  return auto.isolate
}

// Base source: flag > config defaults.baseRef > auto-detection (never persisted).
// An explicit base that doesn't exist stays a hard error in ensureRepoReady.
async function resolveBaseRef(parsed: ParsedArgs, defaults: ConvoyDefaults): Promise<string> {
  const explicit = parsed.baseRef ?? defaults.baseRef
  if (explicit) return explicit
  const detected = await detectBaseRef(parsed.baseDetectionDir ?? parsed.targetDir)
  if (!detected) return "HEAD" // non-repo / zero commits: ensureRepoReady reports the real problem
  log.info(`base ref: ${detected.ref} (auto-detected)`)
  return detected.ref
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    files: [],
    onlySteps: [],
    skipSteps: [],
    changes: [],
    targetDir: process.cwd(),
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
      // A following flag is not a value; catching it here beats silently
      // consuming it (e.g. `--prompt-file --only x`).
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new Error(`${flag} requires a value`)
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
      case "--pipeline":
      case "-p":
        parsed.pipeline = takeValue()
        break
      case "--pipeline-file":
        parsed.pipelineFile = takeValue()
        break
      case "--only":
        parsed.onlySteps.push(...listValue(takeValue()))
        break
      case "--skip":
        parsed.skipSteps.push(...listValue(takeValue()))
        break
      case "--resume":
        parsed.resumeRunID = takeValue()
        break
      case "--keep-run-dir":
        parsed.keepRunDir = true
        break
      case "--no-keep-run-dir":
        parsed.keepRunDir = false
        break
      case "--include-dirty":
        parsed.includeDirty = true
        break
      case "--yolo":
        parsed.yolo = true
        break
      case "--smart":
        parsed.smart = true
        break
      case "--smart-model":
        parsed.smartModel = takeValue()
        break
      case "--model":
        parsed.modelOverride = takeValue()
        break
      case "--advisor":
        parsed.advisorOverride = takeValue()
        parsed.advisorDisabled = false
        break
      case "--no-advisor":
        if (value !== undefined) throw new Error("--no-advisor does not take a value")
        parsed.advisorDisabled = true
        parsed.advisorOverride = undefined
        break
      case "--gateway": {
        const gateway = takeValue()
        if (!isModelGateway(gateway)) throw new Error(`--gateway must be ${modelGatewayChoices()}`)
        parsed.gateway = gateway
        break
      }
      case "--plan":
        if (value !== undefined) throw new Error("--plan does not take a value")
        parsed.planOnly = true
        break
      case "--no-confirm":
        if (value !== undefined) throw new Error("--no-confirm does not take a value")
        parsed.noConfirm = true
        break
      case "--detach":
        if (value !== undefined) throw new Error("--detach does not take a value")
        parsed.detach = true
        break
      case "--tui":
        parsed.tui = true
        break
      case "--no-tui":
        parsed.tui = false
        break
      case "--notify":
        if (value !== undefined) throw new Error("--notify does not take a value")
        parsed.notify = true
        break
      case "--no-notify":
        if (value !== undefined) throw new Error("--no-notify does not take a value")
        parsed.notify = false
        break
      case "--human-review":
      case "--human-step":
        parsed.humanReview = true
        break
      case "--no-human-review":
      case "--no-human-step":
        parsed.humanReview = false
        break
      case "--max-concurrent":
        parsed.maxConcurrent = parseInt(takeValue(), 10)
        if (!Number.isInteger(parsed.maxConcurrent) || parsed.maxConcurrent < 1) {
          throw new Error("--max-concurrent must be a positive integer")
        }
        break
      case "--worktree":
        if (value !== undefined) throw new Error("--worktree does not take a value")
        parsed.worktree = true
        break
      case "--no-worktree":
        if (value !== undefined) throw new Error("--no-worktree does not take a value")
        parsed.worktree = false
        break
      case "--branch":
        parsed.branch = takeValue()
        break
      case "--change":
        parsed.changes.push(takeValue())
        break
      case "--manual":
        parsed.manual = true
        break
      case "--feature": {
        // Retired with the feature registry (capability feature-lifecycle):
        // feature-ID selectors fail here — before plan review, worktree
        // creation, or any other side effect — and never become prompts.
        const value = takeValue()
        throw new Error(
          `retired flag: --feature (got "${value}")\n\nFeature identity is retired: worktrees are ordinary Git checkouts, not\nregistered features, and no association links a change to a branch.\n\nSelect the execution checkout and its local changes explicitly instead:\n\n  convoy worktrees run --worktree <path> --change <id> ...   # explicit selection\n  convoy worktrees                                           # inventory / control center\n\nInteractive runs pick the checkout and changes in the launcher's review.`,
        )
      }
      case "--base":
        parsed.baseRef = takeValue()
        break
      case "--goal":
      case "--goal-max-iterations":
      case "--goal-plateau": {
        // Retired with the embedded goal step: no run flag may create or alter
        // goal behavior, and the refusal happens here — before plan review,
        // worktree creation, or any other side effect.
        const value = takeValue()
        throw new Error(
          `retired flag: ${flag}\n\nGoal targets and stopping policy live exclusively in a pipeline's terminal \`goal\` step; CLI flags no longer create or alter goal behavior.\n\nMove the policy into the pipeline (the last step):\n\n  - goal:\n      target: 85          # 1–100\n      maxIterations: 3    # default 3\n      plateau: 3          # default 3\n      improve:            # writable directed-fix steps; briefStep receives the score brief\n        briefStep: fix\n        steps:\n          - agent: goal-fixer\n            name: fix\n      measure:            # read-only scoring steps ending in one quality-score deliverable\n        steps:\n          - ...\n\nSee \`convoy config\` or the README's pipeline section for the full embedded syntax.`,
        )
      }
      case "--dir":
        parsed.targetDir = resolve(process.cwd(), takeValue())
        break
      default:
        throw new Error(`unknown flag: ${flag}`)
    }
  }

  if (positional.length > 0) parsed.prompt = positional.join(" ")
  if (parsed.pipeline !== undefined && parsed.pipelineFile !== undefined) throw new Error("use either --pipeline or --pipeline-file, not both")
  if (parsed.resumeRunID !== undefined && parsed.pipelineFile !== undefined) {
    throw new Error("--resume replays the pipeline the run started with; it can't take --pipeline-file")
  }
  if (parsed.detach && parsed.tui) throw new Error("--detach runs without a dashboard; drop --tui")
  if (parsed.detach && parsed.planOnly) throw new Error("--plan never starts a run; drop --detach")
  return parsed
}

function parsePositiveInt(value: string, flag: string, max?: number): number {
  // Strict integer parsing: a goal of "90abc", "1.5", or "90 " must be
  // rejected instead of silently coerced by parseInt. When `max` is given,
  // both bounds share one message so the 0 and >max edges agree on the range.
  const outOfRange = max !== undefined ? `${flag} must be an integer from 1 to ${max}` : `${flag} must be a positive integer`
  if (!/^[0-9]+$/.test(value)) throw new Error(outOfRange)
  const parsed = parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) throw new Error(outOfRange)
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

/**
 * The retired-command diagnostic (capability run-finalization): `convoy finish`
 * fails non-zero before any prompt, repository, or run side effect, and points
 * at the replacements — automatic run compaction and close's squash landing.
 */
function retiredFinishDiagnostic(): string {
  return [
    "convoy finish was removed.",
    "",
    "Successful runs now compact their commits automatically: the run's work",
    "becomes one conventional operator-authored commit as part of completion,",
    "with no manual step and nothing to confirm.",
    "",
    "To land a whole feature's content as one commit on the base branch, run",
    "`convoy close`. To publish, use Create pull request on the run dashboard.",
  ].join("\n")
}

/**
 * The retired-command diagnostic (capability feature-lifecycle): every
 * `convoy feature` subcommand fails non-zero before any effect and points at
 * the worktree control center — checkouts are selected explicitly per action,
 * never adopted, bound, or registered.
 */
export function retiredFeatureDiagnostic(args: string[]): string {
  const attempted = args.length > 0 ? ` (you ran: convoy feature ${args.join(" ")})` : ""
  return [
    `convoy feature was removed.${attempted}`,
    "",
    "Worktrees are ordinary Git checkouts, not registered features: there is",
    "nothing to adopt, bind, revise, or recover. Select the checkout explicitly",
    "for each action instead:",
    "",
    "  convoy worktrees                 # inventory / control center",
    "  convoy worktrees sync --worktree <path> --base <ref>",
    "  convoy worktrees push --worktree <path>",
    "  convoy worktrees archive --worktree <path> --change <id>",
    "  convoy worktrees close --worktree <path> --base <local-branch>",
    "",
    "Run pipelines with an explicit execution checkout and explicitly selected",
    "local changes; browsing never registers or adopts work.",
  ].join("\n")
}

function help() {
  return `convoy [prompt]

Sequential agent pipeline for implementing features, on OpenCode, Claude Code, or Codex.

Usage:
  convoy
  convoy "Add onboarding"
  convoy --prompt-file prd.md --file lib/onboarding --file test/onboarding_test.dart
  convoy --pipeline bug-fix --prompt-file bug.md
  convoy --pipeline-file audit.yaml --prompt-file task.md --manual --smart --detach
  convoy init
  convoy agents eject <agent>
  convoy update [--check]
  convoy runs [run-id] [--json] [--wait]
  convoy runs <run-id> approve|deny <request-id> | abort
  convoy pipelines [show <name>] [--json]
  convoy skill install
  convoy specs
  convoy worktrees [--help]
  convoy publish [--yes] [--dry-run]
  convoy spin
  convoy close
  convoy opencode install
  convoy config
  convoy auth openrouter

Commands:
  convoy                   Open the home TUI: Pipelines, Specs, Runs, or Config
                           (Pipelines continues to the interactive run launcher)
  init                     Create .convoy/config.yaml in the target repo
  init --global            Create ~/.convoy/config.yaml
  agents eject <agent>     Copy one built-in agent prompt to agents/<agent>.md to
                           override it ("convoy agents" lists the available ones)
  update [--check]         Check GitHub Releases for a newer official binary, or install it
                           (source checkouts are never modified)
  runs [run-id]            Browse run history: resume a run, read its summary/reports,
                           or open a subshell in its run dir (under ~/.convoy/runs).
                           Off a terminal it prints plain text: the history, or for a
                           run id its "run <id>: <status>" line, phases, and summary.
                           --json prints it as data, --wait blocks until the run ends or
                           needs an answer, and approve/deny/abort answer a detached run
                           ("convoy runs --help" for the full surface)
  pipelines                List the runnable pipelines (built-in, global, project) and the agents
                           to compose with; "show <name>" prints one pipeline's resolved steps,
                           "show --pipeline-file <path>" validates a pipeline file
  skill install            Install the Convoy agent skill for Claude Code, OpenCode, and Codex, so
                           a session can compose, launch, and monitor pipelines itself
                           ("convoy skill --help"; "convoy skill show" prints it)
  worktrees                The worktree control center: every registered checkout with
                           its independent Git/OpenSpec facts, plus guarded fetch, sync,
                           push, archive, remove, delete-branch, and recover actions
                           ("convoy worktrees --help" for the full surface)
  specs                     The artifact-focused reader: each checkout's local active
                            changes, archives, and canonical specs, with read, apply,
                            iterate, archive, and close-review actions
                            ("convoy control" opens the worktree control board instead)
  spin                      Spin an uncommitted OpenSpec change out of the base checkout into
                            an isolated worktree on a conventionally named branch (feat/…, fix/…,
                            change/…) and print the /move handoff for the current OpenCode session
  close                     The optional composition of the worktree operations: review an
                             explicit checkout and base, sync as needed, archive the explicitly
                             selected local changes, then squash the whole branch onto the base
                             ("convoy close --help" for options)
  publish                  The explicit headless publication request: compose the run-aware PR
                             title/body, print the reviewed plan and text, and push + create the
                             PR only with --yes (--dry-run inspects without effect)
                             ("convoy publish --help" for options)
  opencode install          Install the global /convoy-spin OpenCode command — a thin wrapper at
                             ~/.config/opencode/commands/convoy-spin.md that runs convoy spin
                             from a session (opt-in, idempotent; touches no other command file)
  config                   Toggle the worktrees and specs features, list the global (~/.convoy) and
                           project config files, show whether each loads, and open one in $EDITOR
  auth openrouter          Store an OpenRouter management key in the macOS Keychain for the
                           header credits meter (--remove deletes it; "auth status" lists sources)

Flags:
  --version, -V            Print Convoy's version, commit, and build platform
  --prompt-file <path>     Read the PRD/prompt from a file
  --file, -f <path>        Attach a file or directory to all steps (repeatable)
   --pipeline, -p <name>    Pipeline to run (default: "full-cycle"), which writes,
                            audits, then measures and iterates on a terminal goal
                            step until the score clears 90
  --pipeline-file <path>   Run a pipeline defined in its own YAML file: the mapping a
                           pipelines.<name> entry takes, plus an optional name
                           (default: the file name). Nothing in your config changes
  --only <steps>           Run only these pipeline steps
  --skip <steps>           Skip these pipeline steps
  --resume <id>            Resume a previous run by its ID (steps with an existing report are
                           skipped; the run replays the pipeline it started with)
  --keep-run-dir           Keep the run dir when done (default)
  --no-keep-run-dir        Delete the run dir on successful completion
  --yolo                   Auto-allow ask-level permissions (hard denylist still applies; shift+tab cycles it live in the TUI)
  --smart                  Smart auto-accept: an AI judge auto-allows safe ask-level requests and escalates risky ones (shift+tab cycles)
  --smart-model <provider/model[#variant]> Model for the smart auto-accept judge (default: defaults.autoAcceptJudgeModel, else the run's model)
  --include-dirty          Include existing changes in the first commit
  --model <provider/model[#variant]> Force a model for OpenCode steps; <runner>/<model> (codex/gpt-5.5, claude-code/opus) forces one runner's steps
  --advisor <provider/model[#variant]> Force an advising model on every OpenCode step: a stronger model
                           consulted at decision points (before the first write, before declaring done,
                           and on demand) that reads the step's transcript but never runs tools
  --no-advisor             Run every step without an advisor, whatever the config sets
  --gateway <${modelGateways.join("|")}> Route all OpenCode models through the selected gateway
  --plan                   Print the complete resolved plan without creating or running anything
  --no-confirm             Show a compact plan and start without the interactive confirmation
  --detach                 Start the run in the background and return once it is up, printing
                           "run <id> started"; follow it with convoy runs <id> --wait.
                           Implies --no-tui, --no-confirm, and no human steps
  --tui                    Show visual phase progress (default in interactive terminals)
  --no-tui                 Disable visual phase progress
  --notify                 Enable desktop notifications for this run, overriding notifications.enabled in config
  --no-notify              Disable desktop notifications for this run (the terminal title still updates)
  --human-step             Enable human steps (alias: --human-review; default in interactive terminals)
  --no-human-step          Drop all human steps and failure decisions: a failed step fails the run
                           (alias: --no-human-review; default off a terminal)
  --max-concurrent <n>     Max agents running at once within a parallel group (default: ${defaultMaxConcurrentAgents}); smaller groups are unaffected
  --base <ref>             Branch/base for calculating diffs (default: auto-detected — origin's default branch, else main/master/develop/trunk, else the current branch)
  --worktree               Run on a fresh branch in its own worktree
                           (location: repo convention, then defaults.worktreeLocation, then ~/.convoy/worktrees)
  --no-worktree            Run in the current working tree instead
                           (default: worktree on a trunk branch, current tree on any other)
  --branch <name>          Name for the worktree branch, instead of asking the naming model
  --change <id>            OpenSpec change id to review/implement (openspec/changes/<id>).
                           Repeatable and order-significant: the reviewed plan freezes the
                           selected ids in the order given, and the spec bundle (current
                           specs + those changes) attaches to every step. Selection is
                           explicit only — the launcher lists active changes so you can
                           pick one instead of typing a prompt, and nothing is attached
                           automatically.
  --manual                 Explicit no-change run: valid with zero selected changes, without
                           inventing or importing a spec. A headless launch requires
                           --change or --manual.
  --dir <path>             Target repo (default: cwd)

Headless (scripts, CI, agents):
  Off a terminal, a launch prints the plan, then "coordinator <pid> running run <id>",
  streams the run's log, and exits with the run's own code (0 only on success).
  With --detach it returns as soon as the run is up instead. Pass --change or
  --manual (not needed with features.specs: false), plus --smart or --yolo: with
  interactive permissions a request waits (logged as "[permission] waiting for an
  answer") until someone answers it with "convoy runs <id> approve|deny <request>"
  or from the "convoy runs" dashboard. "convoy runs <id> --json" prints that run's
  status, and "convoy runs <id> --wait" blocks until it ends or needs an answer.
  "convoy skill install" teaches agent sessions this workflow.

Goal mode:
  Pipelines enter goal execution exclusively by declaring one terminal goal
  step (the pipeline's last step). There are no goal CLI flags; retired flags
  print a migration error. See the Quality scoring section.

Config files:
  ~/.convoy/config.yaml    user defaults, created by make install or convoy init --global
  .convoy/config.yaml      project-local overrides, created by convoy init
  agents/*.md              Markdown prompts loaded by matching the agent name; only
                           present once you eject one, and they shadow the built-in

Config keys:
  defaults:                model, baseRef, pipeline, worktree, worktreeLocation, prdHistory,
                           autoAcceptJudgeModel, branchNameModel, commitMessageModel,
                           runner, advisorRoute, helperRoutes, authoring (claudeAuth: legacy)
  runners:                 per-runner settings: runners.<claude-code|codex>.auth
  modelRouting:            gateway and explicit per-logical-model overrides (OpenCode)
  agents:                  project agents or built-in overrides; prompts live at agents/<name>.md
  pipelines:               named step lists mixing agents and human gates
  permissions:             allow/deny additions to the bash policy (deny always wins)
  hooks:                   pre/post shell commands, globally or per pipeline
  features:                worktrees and specs switches (each on unless set to false)
  attachments:             files attached to every step
  The same schema lives globally at ~/.convoy/config.yaml; project config merges on top.
  Precedence: CLI flags > project config > global config > built-in defaults.
`
}

function publishHelp() {
  return `convoy publish

The explicit headless publication request for a run (capability run-finalization):
compose the run-aware pull-request title and body, print the reviewed plan and
text, and push + create the PR only under explicit authorization. Run completion
alone never publishes.

Usage:
  convoy publish [--worktree <path>] [--run-dir <path> | --run <id>]
                 [--title <text> --body <text>] [--yes] [--dry-run]

Flags:
  --worktree <path>        Target checkout (default: the current directory)
  --run-dir <path>         Run workspace whose recap and metadata seed the PR body and
                           enable the run's current-target and recovery gates
  --run <id>               Run id under ~/.convoy/runs, when no --run-dir is given
  --title <text>           Explicit title, provided together with --body
  --body <text>            Explicit body, provided together with --title
  --yes                    Authorize the normal push and the PR creation
  --dry-run                Compose and print only; never a push or PR

Without --yes (or with --dry-run) the command only prints the disclosed branch,
remote, base, title, and body, so the default is safe. Unlike
\`convoy worktrees pr\`, it uses the run-aware composer: the branch's conventional
prefix and the OpenSpec proposal title, and a Why / What / How-tested body
grounded in the proposal, the run recap, and validation reports.
`
}

function updateHelp() {
  return `convoy update [--check]

Check the latest stable GitHub Release for a binary matching this platform.
Without --check, download, verify, and atomically install the newer binary.
Only official standalone release binaries can update themselves; source
checkouts are never modified.

Options:
  --check                  Report whether an update is available without changing files
`
}

function writeUpdateResult(result: UpdateResult) {
  switch (result.status) {
    case "source-install":
      process.stdout.write(`${result.message}\n`)
      return
    case "up-to-date":
      process.stdout.write(`convoy ${result.currentVersion} is up to date (latest: v${result.latestVersion})\n`)
      return
    case "update-available":
      process.stdout.write(`update available: ${result.currentVersion} → v${result.latestVersion} (${result.assets.binary.name})\n`)
      return
    case "updated":
      process.stdout.write(`updated convoy ${result.currentVersion} → v${result.latestVersion} (${result.assetName})\n`)
  }
}

function initHelp() {
  return `convoy init [--global] [--force] [--dir <path>]

Create Convoy's default config file. An existing config is not overwritten unless --force is set.

Writes no agent prompts: a prompt file under agents/ permanently overrides its
built-in, so copying them all would freeze every prompt at the installed version.
Use "convoy agents eject <agent>" to copy the one you actually want to change.

Options:
  --global                 Write ~/.convoy/config.yaml instead of a project config
  --dir <path>             Target repo for .convoy/config.yaml (default: cwd)
  --force                  Overwrite an existing config file
  --quiet                  Suppress status output
`
}

function agentsHelp() {
  return `convoy agents eject <agent> [--global] [--force] [--dir <path>]

Copy one built-in agent prompt to agents/<agent>.md so you can edit it.

The copy takes precedence over the built-in from then on, including across
upgrades -- "convoy update" ships new built-in prompts that an ejected file will
shadow. Eject only what you mean to own, and delete the file to return to the
built-in. Delete the file to return to the built-in.

Options:
  --global                 Write ~/.convoy/agents/<agent>.md instead of a project prompt
  --dir <path>             Target repo for .convoy/agents/<agent>.md (default: cwd)
  --force                  Overwrite an existing prompt file
  --quiet                  Suppress status output

Agents:
${builtInAgents
  .map((agent) => agent.name)
  .sort()
  .map((name) => `  ${name}`)
  .join("\n")}
`
}
