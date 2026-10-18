import { chmod, copyFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"

import { versionInfo } from "./version"

export const githubLatestReleaseUrl = "https://api.github.com/repos/Inakitajes/convoy/releases/latest"
export const releasesUrl = "https://github.com/Inakitajes/convoy/releases"

const latestReleaseTimeoutMs = 15_000
const assetDownloadTimeoutMs = 300_000
const candidateValidationTimeoutMs = 10_000
const candidateKillGraceMs = 2_000

/**
 * GitHub release asset URLs are served from `github.com` and redirect to
 * `objects.githubusercontent.com`. Restricting downloads to these hosts keeps a
 * tampered release metadata payload from directing the updater's HTTP request
 * (which carries the user's IP and `convoy-updater` User-Agent) at an arbitrary
 * external host, even though the bytes would fail hash verification afterwards.
 */
const githubAssetHosts = new Set(["github.com", "objects.githubusercontent.com"])

function isGithubAssetUrl(raw: string) {
  if (!raw.startsWith("https://")) return false
  try {
    return githubAssetHosts.has(new URL(raw).host)
  } catch {
    return false
  }
}

type RecordValue = Record<string, unknown>

export type SemVer = {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export type ReleaseAsset = {
  name: string
  browserDownloadUrl: string
  digest?: string
}

export type PublishedRelease = {
  tagName: string
  version: SemVer
  publishedAt: string
  assets: ReleaseAsset[]
}

export type SelectedReleaseAssets = {
  binary: ReleaseAsset
  checksumFile: ReleaseAsset
}

export type UpdateCheck = {
  status: "up-to-date" | "update-available"
  currentVersion: string
  latestVersion: string
  release: PublishedRelease
  assets: SelectedReleaseAssets
}

export type UpdateResult =
  | { status: "source-install"; message: string }
  | UpdateCheck
  | { status: "updated"; currentVersion: string; latestVersion: string; assetName: string }

export type UpdateFileOps = {
  chmod: typeof chmod
  copyFile: typeof copyFile
  rename: typeof rename
  rm: typeof rm
  stat: typeof stat
  writeFile: typeof writeFile
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type BunStandaloneRuntime = {
  isStandaloneExecutable?: unknown
  embeddedFiles?: ReadonlyArray<unknown>
  main?: unknown
}

export type UpdateOptions = {
  checkOnly?: boolean
  currentVersion?: string
  platform?: string
  architecture?: string
  executablePath?: string
  standalone?: boolean
  fetch?: FetchLike
  validateCandidate?: (path: string, expectedVersion: string) => Promise<boolean>
  fileOps?: UpdateFileOps
  randomSuffix?: () => string
}

const defaultFileOps: UpdateFileOps = { chmod, copyFile, rename, rm, stat, writeFile }

export class UpdateError extends Error {
  override name = "UpdateError"
}

/**
 * Convoy's own entry script in a source checkout. Re-invoking Convoy must run
 * this, never `process.argv[1]`: that is whatever script imported Convoy, and
 * re-running it from a hook or helper repeats that script instead.
 */
export const convoySourceEntry = join(import.meta.dir, "main.ts")

/**
 * Bun 1.4 exposes a zero-cost standalone flag. Bun 1.3 does not expose that
 * API, so use its compiled-entrypoint path as a compatibility fallback.
 */
export function isOfficialStandaloneExecutable(runtime: BunStandaloneRuntime = Bun) {
  if (typeof runtime.isStandaloneExecutable === "boolean") return runtime.isStandaloneExecutable
  if (typeof runtime.main === "string" && (runtime.main.startsWith("/$bunfs/") || runtime.main.includes("\\$bunfs\\"))) {
    return true
  }
  try {
    return (runtime.embeddedFiles?.length ?? 0) > 0
  } catch {
    return false
  }
}

/** Parses a SemVer value, accepting the conventional leading `v` used by Git tags. */
export function parseSemVer(value: string): SemVer | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value)
  if (!match) return undefined

  const numeric = match.slice(1, 4)
  if (numeric.some((part) => !/^(0|[1-9]\d*)$/.test(part!))) return undefined

  const prerelease = match[4] ? match[4].split(".") : []
  if (
    prerelease.some(
      (part) => !part || !/^[0-9A-Za-z-]+$/.test(part) || (/^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part)),
    )
  ) {
    return undefined
  }

  // Build metadata does not affect precedence, but still must be syntactically valid.
  if (match[5]?.split(".").some((part) => !part || !/^[0-9A-Za-z-]+$/.test(part))) return undefined

  return {
    major: Number(numeric[0]),
    minor: Number(numeric[1]),
    patch: Number(numeric[2]),
    prerelease,
  }
}

export function formatSemVer(version: SemVer) {
  const base = `${version.major}.${version.minor}.${version.patch}`
  return version.prerelease.length > 0 ? `${base}-${version.prerelease.join(".")}` : base
}

/** Returns a positive value when `left` is newer than `right`. */
export function compareSemVer(left: SemVer | string, right: SemVer | string) {
  const a = typeof left === "string" ? parseSemVer(left) : left
  const b = typeof right === "string" ? parseSemVer(right) : right
  if (!a || !b) throw new UpdateError("cannot compare an invalid semantic version")

  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] !== b[field]) return a[field] > b[field] ? 1 : -1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    const aPart = a.prerelease[index]
    const bPart = b.prerelease[index]
    if (aPart === undefined) return -1
    if (bPart === undefined) return 1
    if (aPart === bPart) continue
    const aNumeric = /^\d+$/.test(aPart)
    const bNumeric = /^\d+$/.test(bPart)
    if (aNumeric && bNumeric) return Number(aPart) > Number(bPart) ? 1 : -1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return aPart > bPart ? 1 : -1
  }
  return 0
}

export function assetNameForPlatform(platform: string, architecture: string) {
  const names: Record<string, string> = {
    "darwin-arm64": "convoy-darwin-arm64",
    "darwin-x64": "convoy-darwin-x64",
    "linux-arm64": "convoy-linux-arm64",
    "linux-x64": "convoy-linux-x64",
  }
  return names[`${platform}-${architecture}`]
}

/** Validates that the API payload represents a published stable SemVer release. */
export function validateLatestRelease(value: unknown): PublishedRelease {
  const release = record(value, "latest release")
  const tagName = stringProperty(release, "tag_name", "latest release")
  if (!tagName.startsWith("v")) throw new UpdateError(`release tag must start with "v": ${tagName}`)
  const version = parseSemVer(tagName)
  if (!version || version.prerelease.length > 0) throw new UpdateError(`release tag is not a stable semantic version: ${tagName}`)
  if (release.draft !== false) throw new UpdateError("latest release is not published")
  if (release.prerelease !== false) throw new UpdateError("latest release is a prerelease")

  const publishedAt = stringProperty(release, "published_at", "latest release")
  if (Number.isNaN(Date.parse(publishedAt))) throw new UpdateError("latest release has an invalid publication date")
  if (!Array.isArray(release.assets)) throw new UpdateError("latest release has no assets")

  const assets = release.assets.map((asset, index) => {
    const parsed = record(asset, `release asset ${index + 1}`)
    const name = stringProperty(parsed, "name", `release asset ${index + 1}`)
    const browserDownloadUrl = stringProperty(parsed, "browser_download_url", `release asset ${name}`)
    if (!isGithubAssetUrl(browserDownloadUrl)) {
      throw new UpdateError(`release asset ${name} has an unsafe download URL`)
    }
    const digest = parsed.digest
    if (digest !== undefined && digest !== null && typeof digest !== "string") {
      throw new UpdateError(`release asset ${name} has an invalid digest`)
    }
    return { name, browserDownloadUrl, ...(typeof digest === "string" ? { digest } : {}) }
  })

  return { tagName, version, publishedAt, assets }
}

export function selectReleaseAssets(release: PublishedRelease, platform: string, architecture: string): SelectedReleaseAssets {
  const assetName = assetNameForPlatform(platform, architecture)
  if (!assetName) throw new UpdateError(`updates are not available for ${platform}-${architecture}`)
  const binary = exactAsset(release, assetName)
  // GitHub has exposed release asset digests since 2024. Requiring it prevents a
  // legacy or malformed release from silently weakening update verification.
  parseGitHubSha256(binary.digest, assetName)
  return { binary, checksumFile: exactAsset(release, "SHA256SUMS") }
}

/** Accepts GitHub's `sha256:<hex>` format and bare hex from early API responses. */
export function parseGitHubSha256(digest: string | undefined, assetName = "asset") {
  const match = /^(?:sha256:)?([a-fA-F0-9]{64})$/.exec(digest?.trim() ?? "")
  if (!match) throw new UpdateError(`release asset ${assetName} is missing a SHA-256 digest`)
  return match[1]!.toLowerCase()
}

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Reads an exact filename from standard `sha256sum`/`shasum` output. */
export function checksumForAsset(contents: string, assetName: string) {
  let checksum: string | undefined
  for (const rawLine of contents.replace(/\r\n/g, "\n").split("\n")) {
    if (!rawLine.trim()) continue
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(rawLine)
    if (!match) throw new UpdateError("SHA256SUMS contains an invalid checksum entry")
    if (match[2] !== assetName) continue
    const parsed = match[1]!.toLowerCase()
    if (checksum && checksum !== parsed) throw new UpdateError(`SHA256SUMS contains conflicting entries for ${assetName}`)
    checksum = parsed
  }
  if (!checksum) throw new UpdateError(`SHA256SUMS does not contain ${assetName}`)
  return checksum
}

export function verifyAssetBytes(bytes: Uint8Array, binary: ReleaseAsset, checksumContents: string) {
  const actual = sha256(bytes)
  const githubDigest = parseGitHubSha256(binary.digest, binary.name)
  if (actual !== githubDigest) throw new UpdateError(`GitHub digest verification failed for ${binary.name}`)

  const publishedChecksum = checksumForAsset(checksumContents, binary.name)
  if (actual !== publishedChecksum) throw new UpdateError(`SHA256SUMS verification failed for ${binary.name}`)
}

export async function fetchLatestRelease(fetchImpl: FetchLike = globalThis.fetch) {
  try {
    return await withTimeout(latestReleaseTimeoutMs, "GitHub Releases request", async (signal) => {
      const response = await fetchImpl(githubLatestReleaseUrl, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "convoy-updater" },
        signal,
      })
      if (!response.ok) throw new UpdateError(`GitHub Releases responded with ${response.status} ${response.statusText}`.trim())
      try {
        return validateLatestRelease(await response.json())
      } catch (error) {
        if (error instanceof UpdateError) throw error
        throw new UpdateError(`could not parse the latest GitHub release: ${message(error)}`)
      }
    })
  } catch (error) {
    if (error instanceof UpdateError) throw error
    throw new UpdateError(`could not contact GitHub Releases: ${message(error)}`)
  }
}

export async function checkForUpdate(options: Omit<UpdateOptions, "checkOnly" | "executablePath" | "standalone" | "validateCandidate" | "fileOps" | "randomSuffix"> = {}) {
  const current = parseSemVer(options.currentVersion ?? versionInfo.version)
  if (!current) throw new UpdateError(`installed version is not valid SemVer: ${options.currentVersion ?? versionInfo.version}`)
  const release = await fetchLatestRelease(options.fetch)
  const assets = selectReleaseAssets(release, options.platform ?? process.platform, options.architecture ?? process.arch)
  const currentVersion = formatSemVer(current)
  const latestVersion = formatSemVer(release.version)
  return {
    status: compareSemVer(release.version, current) > 0 ? "update-available" : "up-to-date",
    currentVersion,
    latestVersion,
    release,
    assets,
  } satisfies UpdateCheck
}

/** Runs the explicit update flow; source checkouts are deliberately never modified. */
export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const standalone = options.standalone ?? isOfficialStandaloneExecutable()
  if (options.checkOnly) return checkForUpdate(options)
  if (!standalone) {
    return {
      status: "source-install",
      message: `convoy update only supports official release binaries; install one from ${releasesUrl} instead of modifying this source checkout`,
    }
  }

  const check = await checkForUpdate(options)
  if (check.status === "up-to-date") return check

  const fetchImpl = options.fetch ?? globalThis.fetch
  const [binaryBytes, checksumContents] = await Promise.all([
    downloadBytes(check.assets.binary, fetchImpl),
    downloadText(check.assets.checksumFile, fetchImpl),
  ])
  verifyAssetBytes(binaryBytes, check.assets.binary, checksumContents)

  const executablePath = options.executablePath ?? process.execPath
  const fileOps = options.fileOps ?? defaultFileOps
  const suffix = options.randomSuffix ?? randomUUID
  const candidatePath = temporaryPath(executablePath, "candidate", suffix())
  try {
    await fileOps.writeFile(candidatePath, binaryBytes, { mode: 0o755 })
    await fileOps.chmod(candidatePath, 0o755)
    const valid = await (options.validateCandidate ?? validateCandidateExecutable)(candidatePath, check.latestVersion)
    if (!valid) throw new UpdateError("downloaded binary did not report the expected version")

    const existing = await fileOps.stat(executablePath)
    await fileOps.chmod(candidatePath, existing.mode & 0o777)
    await replaceExecutableAtomically(executablePath, candidatePath, { fileOps, randomSuffix: suffix })
  } catch (error) {
    await removeIfPresent(candidatePath, fileOps)
    if (error instanceof UpdateError) throw error
    throw new UpdateError(`could not install the update: ${message(error)}`)
  }

  return {
    status: "updated",
    currentVersion: check.currentVersion,
    latestVersion: check.latestVersion,
    assetName: check.assets.binary.name,
  }
}

/**
 * Makes a same-directory backup before atomically renaming the verified
 * candidate over the executable. If replacement reports an error, restore the
 * backup so callers never continue with a partial install.
 */
export async function replaceExecutableAtomically(
  executablePath: string,
  candidatePath: string,
  options: { fileOps?: UpdateFileOps; randomSuffix?: () => string } = {},
) {
  const fileOps = options.fileOps ?? defaultFileOps
  const backupPath = temporaryPath(executablePath, "backup", (options.randomSuffix ?? randomUUID)())
  let backupCreated = false
  try {
    await fileOps.copyFile(executablePath, backupPath)
    backupCreated = true
    // POSIX rename replaces the destination atomically when both paths share a
    // directory (which temporaryPath guarantees).
    await fileOps.rename(candidatePath, executablePath)
  } catch (error) {
    if (backupCreated) {
      try {
        await fileOps.rename(backupPath, executablePath)
        backupCreated = false
      } catch {
        // A failed POSIX rename leaves the original destination intact. The
        // temporary backup is cleaned up below once that invariant holds.
      }
    }
    throw error
  } finally {
    if (backupCreated) await removeIfPresent(backupPath, fileOps)
  }
}

export function candidateDeclaresVersion(output: string, expectedVersion: string) {
  const match = /^convoy\s+([^\s(]+)/m.exec(output)
  const candidate = match ? parseSemVer(match[1]!) : undefined
  const expected = parseSemVer(expectedVersion)
  return Boolean(candidate && expected && formatSemVer(candidate) === formatSemVer(expected))
}

async function validateCandidateExecutable(path: string, expectedVersion: string) {
  let child: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined
  let exited = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" })
    const kill = (signal: NodeJS.Signals) => {
      try {
        child?.kill(signal)
      } catch {
        // The candidate may have exited while the timeout was firing.
      }
    }
    timeout = setTimeout(() => {
      timedOut = true
      kill("SIGTERM")
      killTimer = setTimeout(() => kill("SIGKILL"), candidateKillGraceMs)
      killTimer.unref?.()
    }, candidateValidationTimeoutMs)
    timeout.unref?.()

    const stdoutPromise = new Response(child.stdout).text()
    const exitCode = await child.exited
    exited = true
    const stdout = await stdoutPromise
    return !timedOut && exitCode === 0 && candidateDeclaresVersion(stdout, expectedVersion)
  } catch {
    return false
  } finally {
    if (timeout) clearTimeout(timeout)
    if (killTimer) clearTimeout(killTimer)
    if (child && !exited) {
      try {
        child.kill("SIGKILL")
      } catch {
        // The candidate may have exited after the read failed.
      }
      await child.exited
    }
  }
}

async function downloadBytes(asset: ReleaseAsset, fetchImpl: FetchLike) {
  return new Uint8Array(await fetchAsset(asset, fetchImpl, (response) => response.arrayBuffer()))
}

async function downloadText(asset: ReleaseAsset, fetchImpl: FetchLike) {
  return fetchAsset(asset, fetchImpl, (response) => response.text())
}

async function fetchAsset<T>(asset: ReleaseAsset, fetchImpl: FetchLike, consume: (response: Response) => Promise<T>) {
  try {
    return await withTimeout(assetDownloadTimeoutMs, `download of ${asset.name}`, async (signal) => {
      const response = await fetchImpl(asset.browserDownloadUrl, { headers: { Accept: "application/octet-stream" }, signal })
      if (!response.ok) throw new UpdateError(`could not download ${asset.name}: HTTP ${response.status}`)
      return consume(response)
    })
  } catch (error) {
    if (error instanceof UpdateError) throw error
    throw new UpdateError(`could not download ${asset.name}: ${message(error)}`)
  }
}

function exactAsset(release: PublishedRelease, name: string) {
  const matches = release.assets.filter((asset) => asset.name === name)
  if (matches.length !== 1) throw new UpdateError(`release ${release.tagName} does not contain exactly one ${name} asset`)
  return matches[0]!
}

function temporaryPath(executablePath: string, label: string, suffix: string) {
  return join(dirname(executablePath), `.${basename(executablePath)}.${label}-${suffix}`)
}

async function removeIfPresent(path: string, fileOps: UpdateFileOps) {
  try {
    await fileOps.rm(path, { force: true })
  } catch {
    // A failed cleanup cannot make the installed executable less safe.
  }
}

async function withTimeout<T>(timeoutMs: number, operation: string, callback: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await callback(controller.signal)
  } catch (error) {
    if (timedOut) throw new UpdateError(`${operation} timed out after ${timeoutMs / 1_000}s`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function record(value: unknown, name: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UpdateError(`${name} is malformed`)
  return value as RecordValue
}

function stringProperty(value: RecordValue, property: string, name: string) {
  const result = value[property]
  if (typeof result !== "string" || !result) throw new UpdateError(`${name} is missing ${property}`)
  return result
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
