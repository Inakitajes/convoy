import { execFile, isAncestor } from "../git"
import { boundedExec } from "./executor"

/**
 * Read-only remote publication verification (design D4, task 2.4). Before
 * automatic compaction rewrites commits, every configured remote's advertised
 * branch heads are queried with a bounded, non-interactive `git ls-remote`.
 * If any commit about to be replaced is reachable from an advertised head,
 * rewriting would require a force-push, so compaction is blocked. Remote state
 * that cannot be verified (missing remote objects locally, unreachable remote)
 * also blocks: Convoy never assumes "unpublished" and never fetches, pushes,
 * or modifies remote-tracking refs as a side effect.
 */

const remoteProbeTimeoutMs = 60_000

export type PublicationVerdict =
  | { ok: true; checkedRemotes: string[] }
  | {
      ok: false
      /**
       * `unverifiable`: the probe itself could not answer (timeout, transport,
       * auth lookup) — transient, so a bounded retry may succeed. `published`:
       * a replaced commit is advertised. `unknown-object`: a remote head is not
       * present locally, so reachability cannot be proven until a fetch.
       */
      kind: "unverifiable" | "published" | "unknown-object"
      reason: string
    }

/** The repository's configured remotes, in config order. */
export async function listRemotes(cwd: string): Promise<string[]> {
  const result = await execFile("git", ["remote"], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return []
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
}

/**
 * Verifies none of `commitShas` is present on any configured remote branch.
 * Local upstream configuration alone is neither proof of publication nor a
 * reason to block; only advertised heads are consulted.
 */
export async function verifyNotPublished(commitShas: readonly string[], cwd: string): Promise<PublicationVerdict> {
  if (commitShas.length === 0) return { ok: true, checkedRemotes: [] }
  const remotes = await listRemotes(cwd)
  if (remotes.length === 0) return { ok: true, checkedRemotes: [] }

  const checked: string[] = []
  for (const remote of remotes) {
    let advertised: Map<string, string>
    try {
      advertised = await lsRemoteHeads(remote, cwd)
    } catch (error) {
      return {
        ok: false,
        kind: "unverifiable",
        reason:
          `couldn't verify publication state on remote "${remote}": ${error instanceof Error ? error.message : String(error)}. ` +
          `Fetch or fix remote access, then retry; compacting without verification could require a force-push.`,
      }
    }

    for (const [headRef, headSha] of advertised) {
      if (commitShas.includes(headSha)) {
        return {
          ok: false,
          kind: "published",
          reason: `${headSha.slice(0, 8)} is published on ${remote} (${headRef}); rewriting it would need a force-push`,
        }
      }
      // A head descendant of a replaced commit carries it too. This needs the
      // head's object locally; if it is missing we cannot prove reachability,
      // so the conservative answer is to block with fetch guidance.
      const known = await objectExists(headSha, cwd)
      if (!known) {
        return {
          ok: false,
          kind: "unknown-object",
          reason: `remote "${remote}" advertises ${headRef} at ${headSha.slice(0, 8)}, which is not present locally; fetch first so publication can be verified`,
        }
      }
      for (const sha of commitShas) {
        if (await isAncestor(sha, headSha, cwd)) {
          return { ok: false, kind: "published", reason: `${sha.slice(0, 8)} is reachable from ${remote}/${headRef}; rewriting it would need a force-push` }
        }
      }
    }
    checked.push(remote)
  }
  return { ok: true, checkedRemotes: checked }
}

/** Advertised branch heads of one remote: `refs/heads/<name>` → SHA. */
async function lsRemoteHeads(remote: string, cwd: string): Promise<Map<string, string>> {
  // Bounded and read-only: no fetch, no push, no remote-tracking ref updates.
  const { stdout, stderr, exitCode } = await boundedExec(["ls-remote", "--heads", remote], cwd, remoteProbeTimeoutMs)
  if (exitCode !== 0) throw new Error((stderr || stdout).trim() || `exit ${exitCode}`)
  const heads = new Map<string, string>()
  for (const line of stdout.split("\n")) {
    const [sha = "", ref = ""] = line.split("\t")
    if (sha && ref) heads.set(ref, sha)
  }
  return heads
}

async function objectExists(sha: string, cwd: string): Promise<boolean> {
  const result = await execFile("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, allowFailure: true })
  return result.exitCode === 0
}
