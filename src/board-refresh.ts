import { createHash } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { boardCacheKey, boardCacheSchemaVersion, loadBoardSnapshot, normalizeCommonDir, saveBoardSnapshot, snapshotMateriallyChanged, type BoardSnapshot, type CheckoutFingerprints } from "./board-cache"
import { mapBounded } from "./concurrency"
import { assembleControlBoard, defaultBoardConcurrency, type ControlBoard } from "./control-board"
import { openspecDirName } from "./openspec"
import { repoCommonDir } from "./repo-store"
import { listRuns, type RunEntry } from "./runs"
import { listWorktrees, type WorktreeInventory } from "./worktree-inventory"
import { runsRoot } from "./workspace"

/**
 * Fingerprint-gated background refresh (change `live-board-cache-and-refresh`,
 * design D3/D4): a cheap fingerprint over the Git worktree listing, each
 * checkout's change-relevant mtimes, and the run-history state decides what a
 * cycle recomputes. `BoardSource` owns the hot snapshot; a home surface owns
 * the timer that calls `refresh()`.
 *
 * The refresh is two-tiered: the cheap Git/writer probes always run, while the
 * OpenSpec artifact/task readers and the full run-history scan are skipped
 * whenever their fingerprints are unchanged.
 */

/** The default poll cadence while a board is displayed (no slower than 5s). */
export const defaultRefreshCadenceMs = 5_000
/** Evidence older than three missed cycles is marked stale. */
export const defaultFreshnessBoundMs = 15_000

const fingerprintWalkLimit = 5_000

/** A serializable token for one checkout's change-relevant mtimes (`openspec/`). */
export async function fingerprintCheckout(checkout: string): Promise<string | undefined> {
  const root = join(checkout, openspecDirName)
  const tokens: string[] = []
  let truncated = false
  const walk = async (dir: string, relative: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // An absent openspec dir is a stable, known-empty fingerprint.
      tokens.push(`${relative || "."}:absent`)
      return
    }
    for (const entry of entries) {
      if (tokens.length >= fingerprintWalkLimit) {
        truncated = true
        return
      }
      const child = join(dir, entry.name)
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      let info
      try {
        info = await stat(child)
      } catch {
        continue
      }
      tokens.push(`${rel}:${info.mtimeMs}:${info.size}`)
      if (entry.isDirectory()) await walk(child, rel)
    }
  }
  try {
    await walk(root, "")
  } catch {
    return undefined
  }
  const hash = createHash("sha256")
  hash.update(tokens.sort().join("\n"))
  if (truncated) hash.update(":truncated")
  return hash.digest("hex").slice(0, 32)
}

/**
 * A token for the shared run history: the runs root listing, each run's
 * metadata file, and the surviving run-record index. Unchanged means the
 * full `listRuns()` scan can be skipped for the cycle.
 */
export async function fingerprintRunHistory(root: string = runsRoot()): Promise<string> {
  const tokens: string[] = []
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    names = []
  }
  for (const name of names.sort()) {
    const dir = join(root, name)
    try {
      const info = await stat(dir)
      tokens.push(`${name}:${info.mtimeMs}`)
    } catch {
      tokens.push(`${name}:gone`)
      continue
    }
    try {
      const meta = await stat(join(dir, "metadata.json"))
      tokens.push(`${name}/metadata.json:${meta.mtimeMs}:${meta.size}`)
    } catch {
      // No metadata yet — the directory listing above already changed the token.
    }
  }
  const recordsDir = join(root, "..", "run-records")
  let recordNames: string[] = []
  try {
    recordNames = await readdir(recordsDir)
  } catch {
    recordNames = []
  }
  for (const name of recordNames.sort()) {
    if (!name.endsWith(".json")) continue
    try {
      const info = await stat(join(recordsDir, name))
      tokens.push(`record:${name}:${info.mtimeMs}:${info.size}`)
    } catch {
      continue
    }
  }
  return createHash("sha256").update(tokens.join("\n")).digest("hex").slice(0, 32)
}

/** A cycle's refresh result: the snapshot in hand and whether it changed. */
export type RefreshResult = {
  snapshot: BoardSnapshot
  /** True when this cycle assembled fresh evidence (false on a retained failure). */
  refreshed: boolean
  /** Disclosed when a refresh failed and the previous snapshot was retained. */
  error?: string
  /** The cycle's shared run-history read, when one happened (for an open detail). */
  runs?: RunEntry[]
}

/** Injected seams so tests stay hermetic; production defaults are the real readers. */
export type BoardSourceOptions = {
  targetDir: string
  now?: () => number
  commonDir?: (dir: string) => Promise<string | undefined>
  inventory?: (dir: string) => Promise<WorktreeInventory>
  assemble?: typeof assembleControlBoard
  /** Computes a checkout's change-content fingerprint (defaults to the OpenSpec tree). */
  fingerprintCheckout?: (checkout: string) => Promise<string | undefined>
  fingerprintRuns?: (root?: string) => Promise<string>
  listRuns?: (root?: string) => Promise<RunEntry[]>
  load?: (commonDir: string) => Promise<BoardSnapshot | undefined>
  save?: (snapshot: BoardSnapshot, prior?: BoardSnapshot) => Promise<boolean>
}

/**
 * Owns the hot board snapshot for one Home session: `cached()` reads memory,
 * then disk, and never assembles; `refresh()` fingerprints, recomputes only
 * what changed, and persists on material change. A refresh generation guard
 * prevents a slow older cycle from overwriting a newer snapshot.
 */
export class BoardSource {
  private readonly options: Required<Pick<BoardSourceOptions, "targetDir">> & BoardSourceOptions
  private snapshot?: BoardSnapshot
  private lastRuns?: RunEntry[]
  private failure?: string
  private generation = 0

  constructor(options: BoardSourceOptions) {
    this.options = options
  }

  private get targetDir(): string {
    return this.options.targetDir
  }

  /** The in-memory snapshot, if one has been read or refreshed this session. */
  current(): BoardSnapshot | undefined {
    return this.snapshot
  }

  /** The most recent refresh failure, when the retained snapshot is stale. */
  lastError(): string | undefined {
    return this.failure
  }

  /**
   * Invalidates cached evidence after a known mutation (change
   * `live-board-cache-and-refresh`): the affected checkout's change-content
   * fingerprint (or the run-history token when no checkout is named) is
   * dropped, so the next ordinary gated refresh recomputes exactly that part
   * instead of trusting a fingerprint that a same-size, mtime-restored edit
   * could leave unchanged. Bounded to the named checkout — unrelated
   * checkouts keep reusing their evidence. No-op before the first snapshot.
   */
  invalidate(checkoutPath?: string, options: { runs?: boolean } = {}): void {
    if (!this.snapshot) return
    if (checkoutPath !== undefined) this.snapshot.fingerprints[checkoutPath] = undefined
    if (options.runs === true || checkoutPath === undefined) delete this.snapshot.runsFingerprint
  }

  /**
   * Memory → disk → none. Never assembles, never triggers subprocess work
   * beyond resolving the repository's common dir on the first read.
   */
  async cached(): Promise<BoardSnapshot | undefined> {
    if (this.snapshot) return this.snapshot
    const commonDir = await (this.options.commonDir ?? repoCommonDir)(this.targetDir)
    if (!commonDir) return undefined
    const load = this.options.load ?? loadBoardSnapshot
    const disk = await load(await normalizeCommonDir(commonDir))
    if (disk) this.snapshot = disk
    return this.snapshot
  }

  /**
   * One fingerprint-gated refresh. Each call is a generation: a slow cycle
   * that finishes after a newer one keeps the newer snapshot and does not
   * persist. `force` invalidates the fingerprint gate and recomputes every
   * part (an explicit operator refresh), while a background poll stays gated.
   */
  refresh(options: { force?: boolean } = {}): Promise<RefreshResult> {
    return this.runRefresh(options.force === true)
  }

  private async runRefresh(force: boolean): Promise<RefreshResult> {
    const generation = ++this.generation
    const prior = this.snapshot
    const commonDir = await (this.options.commonDir ?? repoCommonDir)(this.targetDir)
    if (!commonDir) throw new Error("the repository's common directory could not be resolved")
    const normalized = await normalizeCommonDir(commonDir)
    try {
      const inventory = await (this.options.inventory ?? listWorktrees)(this.targetDir)
      const checkouts = inventory.entries.filter((entry) => entry.accessible && !entry.bare)
      const fingerprintFor = this.options.fingerprintCheckout ?? fingerprintCheckout
      const computed = await mapBounded(checkouts, defaultBoardConcurrency, (entry) => fingerprintFor(entry.path))
      const fingerprints: CheckoutFingerprints = {}
      checkouts.forEach((entry, index) => {
        fingerprints[entry.path] = computed[index]
      })

      const runsFingerprint = await (this.options.fingerprintRuns ?? fingerprintRunHistory)()
      const runsUnchanged = !force && prior !== undefined && runsFingerprint === prior.runsFingerprint
      const priorForReuse = !force && prior ? { board: prior.board, fingerprints: prior.fingerprints } : undefined
      const runReader = this.options.listRuns ?? listRuns
      // One shared read for the cycle: the same promise serves both the
      // assembly's activity probes and an open detail's recent runs.
      let sharedRuns: Promise<RunEntry[]> | undefined
      const onceRuns = () => (sharedRuns ??= runReader())
      const board: ControlBoard = await (this.options.assemble ?? assembleControlBoard)(this.targetDir, {
        inventory,
        fingerprints,
        ...(priorForReuse ? { reuse: priorForReuse } : {}),
        ...(runsUnchanged ? { skipRunHistory: true } : { listRuns: onceRuns }),
      })
      if (!runsUnchanged) {
        // Read once and share the same entries with the detail surface.
        this.lastRuns = await onceRuns()
      }

      const snapshot: BoardSnapshot = {
        schemaVersion: boardCacheSchemaVersion,
        repoKey: boardCacheKey(normalized),
        commonDir: normalized,
        builtAt: (this.options.now ?? Date.now)(),
        board,
        fingerprints,
        ...(runsFingerprint ? { runsFingerprint } : {}),
      }

      // A newer cycle already landed: keep its snapshot, discard this one.
      if (generation !== this.generation) {
        return { snapshot: this.snapshot ?? snapshot, refreshed: false }
      }
      // The prior on disk is what we compare against for material change.
      const save = this.options.save ?? saveBoardSnapshot
      const changed = !this.snapshot || snapshotMateriallyChanged(snapshot, this.snapshot)
      this.snapshot = snapshot
      this.failure = undefined
      if (changed) {
        await save(snapshot, prior).catch(() => {
          // The cache is disposable: a failed write never fails the refresh.
        })
      }
      return { snapshot, refreshed: true, ...(this.lastRuns ? { runs: this.lastRuns } : {}) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failure = message
      if (prior) return { snapshot: prior, refreshed: false, error: message }
      throw error
    }
  }
}
