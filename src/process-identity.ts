/**
 * Process identity for Convoy-managed OpenCode servers (change
 * `fix-opencode-server-lifecycle`, design D1/D5).
 *
 * A PID alone is never enough to authorize a signal: PIDs are reused, and the
 * kernel tells us nothing durable about which incarnation a PID names. An
 * identity therefore pairs the PID with a *kernel-derived birth identity*
 * (start time plus a boot discriminator), the owning UID, and the executable
 * observed for that process. Any adapter that cannot produce every one of
 * those facts returns `unknown`; unknown is never a destructive target.
 *
 * Platform support is loaded lazily so an unsupported host pays nothing until
 * a managed launch actually needs identity — and never at import time.
 */

import { readFile, readlink } from "node:fs/promises"

/** How a Convoy-managed server's lifetime is owned (design D1). */
export type LifetimeClass = "run" | "helper" | "authoring-service"

/** Kernel-derived identity of one process incarnation. */
export type ProcessIdentity = {
  pid: number
  /** Opaque, comparable birth token: `<boot>:<start>` (never `Date.now()`). */
  birth: string
  /** Real UID observed for the process. */
  uid: number
  /** Basename of the observed executable, used as a role check. */
  executable: string
}

export type IdentityObservation =
  | { status: "alive"; identity: ProcessIdentity }
  | { status: "gone" }
  /** The PID exists but is demonstrably not the recorded incarnation. */
  | { status: "mismatch"; reason: string }
  /** The platform could not answer; never authorizes a signal. */
  | { status: "unknown"; reason: string }

export type IdentityProbe = {
  /** Observe the current incarnation of `pid`. Never throws. */
  observe(pid: number): Promise<IdentityObservation>
}

/** True when `observed` is the exact recorded incarnation of `expected`. */
export function sameIdentity(expected: ProcessIdentity, observed: ProcessIdentity): boolean {
  return expected.pid === observed.pid && expected.birth === observed.birth && expected.uid === observed.uid
}

/**
 * Why `observed` does not match `expected`, or undefined when it does. The
 * executable is a role hint: a kernel birth mismatch alone already
 * disqualifies the target.
 */
export function identityMismatchReason(expected: ProcessIdentity, observed: ProcessIdentity): string | undefined {
  if (observed.pid !== expected.pid) return `pid changed from ${expected.pid} to ${observed.pid}`
  if (observed.birth !== expected.birth) return `pid ${expected.pid} was reused (birth ${observed.birth} ≠ recorded ${expected.birth})`
  if (observed.uid !== expected.uid) return `uid changed from ${expected.uid} to ${observed.uid}`
  if (observed.executable !== expected.executable) return `executable changed from ${expected.executable} to ${observed.executable}`
  return undefined
}

/** Identity probe unavailable: every observation is `unknown`. */
export const unknownIdentityProbe: IdentityProbe = {
  async observe(pid) {
    return { status: "unknown", reason: `process identity probing is unavailable on this platform (pid ${pid})` }
  },
}

function executableBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  const index = trimmed.lastIndexOf("/")
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

/**
 * How `kill(pid, 0)` classifies a PID: ESRCH proves the process is absent;
 * success or EPERM proves it exists (unreadable or not).
 */
export type ExistenceCheck = (pid: number) => "absent" | "present"

/**
 * Distinguishes "no such process" from "exists but unreadable" via
 * `kill(pid, 0)`. Probe/permission failures must never become kill authority
 * (design D5): only kernel-level absence may report `gone`.
 */
function existenceByKill0(pid: number): "absent" | "present" {
  try {
    process.kill(pid, 0)
    return "present"
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "present"
  }
}

// ---------------------------------------------------------------------------
// Linux: /proc-derived identity.
// ---------------------------------------------------------------------------

/**
 * Parses `/proc/<pid>/stat`. The comm field is parenthesized and may contain
 * spaces and parentheses, so split on the *last* `)` and index the remaining
 * fields from there: `rest[0]` is field 3 (state), making starttime (field 22)
 * `rest[19]` and ppid (field 4) `rest[1]`.
 */
export function parseProcStat(stat: string): { ppid: number; startTicks: number } | undefined {
  const close = stat.lastIndexOf(")")
  if (close === -1) return undefined
  const rest = stat.slice(close + 1).trim().split(/\s+/)
  const startTicks = Number(rest[19])
  const ppid = Number(rest[1])
  if (!Number.isInteger(startTicks) || startTicks <= 0) return undefined
  if (!Number.isInteger(ppid)) return undefined
  return { ppid, startTicks }
}

/** Parses the first `Uid:` line of `/proc/<pid>/status` (real uid first). */
export function parseProcStatusUid(status: string): number | undefined {
  const match = status.match(/^Uid:\s+(\d+)/m)
  if (!match?.[1]) return undefined
  const uid = Number(match[1])
  return Number.isInteger(uid) ? uid : undefined
}

export async function linuxProcessIdentity(pid: number, exists: ExistenceCheck = existenceByKill0): Promise<IdentityObservation> {
  if (!Number.isInteger(pid) || pid <= 0) return { status: "unknown", reason: `invalid pid ${pid}` }
  const stat = await readText(`/proc/${pid}/stat`)
  if (stat === undefined) {
    // /proc being unmounted or unreadable means the platform cannot answer.
    if ((await readText("/proc/self/stat")) === undefined) {
      return { status: "unknown", reason: "/proc is not readable" }
    }
    // A missing /proc/<pid> usually means the process is gone, but a
    // permission failure (e.g. hidepid) looks identical. `kill(pid, 0)`
    // disambiguates: only ESRCH proves absence; anything else is uncertain.
    if (exists(pid) === "absent") return { status: "gone" }
    return { status: "unknown", reason: `/proc/${pid} could not be read` }
  }
  const parsed = parseProcStat(stat)
  if (!parsed) return { status: "unknown", reason: `could not parse /proc/${pid}/stat` }
  const [boot, status, exe] = await Promise.all([
    readText("/proc/sys/kernel/random/boot_id"),
    readText(`/proc/${pid}/status`),
    readSymlink(`/proc/${pid}/exe`),
  ])
  const uid = status === undefined ? undefined : parseProcStatusUid(status)
  if (!boot || uid === undefined || exe === undefined) {
    return { status: "unknown", reason: `incomplete /proc evidence for pid ${pid}` }
  }
  return {
    status: "alive",
    identity: { pid, birth: `${boot.trim()}:${parsed.startTicks}`, uid, executable: executableBasename(exe) },
  }
}

async function readSymlink(path: string): Promise<string | undefined> {
  try {
    return await readlink(path)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// macOS: libproc + kernel boot time.
// ---------------------------------------------------------------------------

/** Offsets into `struct proc_bsdinfo` (Darwin). Verified against the header. */
const BSDINFO_SIZE = 136
const BSDINFO_PID = 12
const BSDINFO_UID = 20
const BSDINFO_START_SEC = 120
const BSDINFO_START_USEC = 128
const PROC_PIDTBSDINFO = 3

type MacosLibproc = {
  proc_pidinfo(pid: number, flavor: number, arg: bigint, buffer: Uint8Array, size: number): number
  proc_pidpath(pid: number, buffer: Uint8Array, size: number): number
}

let macosLibprocPromise: Promise<MacosLibproc | undefined> | undefined

/**
 * Opens libproc on first use. Any failure (non-Bun host, missing library)
 * resolves to undefined so observations stay `unknown` rather than throwing.
 */
export async function loadMacosLibproc(): Promise<MacosLibproc | undefined> {
  macosLibprocPromise ??= (async () => {
    try {
      const { dlopen, FFIType } = await import("bun:ffi")
      const lib = dlopen("libproc.dylib", {
        proc_pidinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        proc_pidpath: {
          args: [FFIType.i32, FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
      })
      return {
        proc_pidinfo: (pid, flavor, arg, buffer, size) => lib.symbols.proc_pidinfo(pid, flavor, arg, buffer, size),
        proc_pidpath: (pid, buffer, size) => lib.symbols.proc_pidpath(pid, buffer, size),
      }
    } catch {
      return undefined
    }
  })()
  return macosLibprocPromise
}

/** Test seam: forget the loaded library and cached boot discriminator. */
export function resetMacosIdentityCaches(): void {
  macosLibprocPromise = undefined
  cachedBoottime = null
}

/** Parses `sysctl -n kern.boottime` output (`{ sec = 1, usec = 2 } …`). */
export function parseBoottime(output: string): string | undefined {
  const match = output.match(/sec\s*=\s*(\d+)[^}]*usec\s*=\s*(\d+)/)
  if (!match) return undefined
  return `${match[1]}.${match[2]}`
}

let cachedBoottime: string | undefined | null = null

async function macosBoottime(): Promise<string | undefined> {
  if (cachedBoottime !== null) return cachedBoottime
  try {
    const { spawnSync } = await import("node:child_process")
    const result = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" })
    cachedBoottime = parseBoottime(result.stdout ?? "") ?? undefined
  } catch {
    cachedBoottime = undefined
  }
  return cachedBoottime
}

export async function macosProcessIdentity(pid: number, libproc?: MacosLibproc, exists: ExistenceCheck = existenceByKill0): Promise<IdentityObservation> {
  if (!Number.isInteger(pid) || pid <= 0) return { status: "unknown", reason: `invalid pid ${pid}` }
  const lib = libproc ?? (await loadMacosLibproc())
  if (!lib) return { status: "unknown", reason: "libproc could not be loaded" }

  const buffer = new Uint8Array(BSDINFO_SIZE)
  const written = lib.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, buffer, BSDINFO_SIZE)
  if (written !== BSDINFO_SIZE) {
    // ESRCH (no such process) and EPERM (another user's process) both land
    // here, and neither alone proves a specific incarnation. Only
    // kernel-level absence (`kill(pid, 0)` → ESRCH) may report `gone`;
    // every other failure is uncertain and never kill authority (design D5).
    if (exists(pid) === "absent") return { status: "gone" }
    return { status: "unknown", reason: `proc_pidinfo could not read pid ${pid}` }
  }
  const view = new DataView(buffer.buffer)
  const observedPid = view.getUint32(BSDINFO_PID, true)
  if (observedPid !== pid) return { status: "unknown", reason: `libproc returned pid ${observedPid} for ${pid}` }
  const uid = view.getUint32(BSDINFO_UID, true)
  const startSec = view.getBigUint64(BSDINFO_START_SEC, true)
  const startUsec = view.getBigUint64(BSDINFO_START_USEC, true)
  if (startSec === 0n) return { status: "unknown", reason: `libproc returned no start time for pid ${pid}` }
  const boot = await macosBoottime()
  if (!boot) return { status: "unknown", reason: "kernel boot time is unavailable" }

  const pathBuffer = new Uint8Array(4096)
  const pathLength = lib.proc_pidpath(pid, pathBuffer, pathBuffer.length)
  if (pathLength <= 0) return { status: "unknown", reason: `libproc could not read the executable for pid ${pid}` }
  const executable = executableBasename(new TextDecoder().decode(pathBuffer.subarray(0, pathLength)))

  return { status: "alive", identity: { pid, birth: `${boot}:${startSec}.${startUsec}`, uid, executable } }
}

// ---------------------------------------------------------------------------
// Platform dispatch.
// ---------------------------------------------------------------------------

/**
 * Captures a just-spawned child's identity. macOS `proc_pidinfo` can lag the
 * spawn by a scheduling tick, so this retries briefly; giving up is always
 * non-destructive. `gone` is only retried while attempts remain.
 */
export async function captureIdentity(pid: number, probe: IdentityProbe, attempts = 20): Promise<ProcessIdentity | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const observation = await probe.observe(pid)
    if (observation.status === "alive") return observation.identity
    if (observation.status === "gone" && attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      continue
    }
    return undefined
  }
  return undefined
}

export function defaultIdentityProbe(platform: NodeJS.Platform = process.platform): IdentityProbe {
  if (platform === "linux") return { observe: (pid) => linuxProcessIdentity(pid) }
  if (platform === "darwin") return { observe: (pid) => macosProcessIdentity(pid) }
  return unknownIdentityProbe
}
