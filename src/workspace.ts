import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

export type Workspace = {
  dir: string
  runID: string
}

const runIDPattern = /^\d{8}-\d{6}-[a-z0-9]{4}$/

export async function createWorkspace(prompt: string): Promise<Workspace> {
  const runID = newRunID()
  const dir = runDir(runID)

  for (const sub of ["logs", "reports", "diffs"]) {
    await mkdir(join(dir, sub), { recursive: true })
  }
  await writeFile(join(dir, "prd.md"), prompt)

  return { dir, runID }
}

export async function resumeWorkspace(runID: string): Promise<Workspace> {
  const dir = runDir(runID)
  try {
    await stat(dir)
  } catch {
    throw new Error(`run ${runID} doesn't exist at ${dir}`)
  }
  return { dir, runID }
}

export async function cleanupWorkspace(workspace: Workspace) {
  assertInsideRunsRoot(workspace.dir)
  await rm(workspace.dir, { recursive: true, force: true })
}

export async function writeSummary(workspace: Workspace, phaseNames: string[]) {
  const chunks: string[] = [`# archer run ${workspace.runID} - summary`, ""]

  for (const name of phaseNames) {
    chunks.push(`## ${name}`, "")
    try {
      chunks.push(await readFile(join(workspace.dir, "reports", `${name}.md`), "utf8"))
    } catch {
      chunks.push("_(no report)_")
    }
    chunks.push("")
  }

  await writeFile(join(workspace.dir, "SUMMARY.md"), chunks.join("\n"))
}

export function runDir(runID: string) {
  validateRunID(runID)
  return childPath(runsRoot(), runID)
}

export function runsRoot() {
  return join(homedir(), ".archer", "runs")
}

export function isValidRunID(runID: string) {
  return runIDPattern.test(runID)
}

function validateRunID(runID: string) {
  if (!isValidRunID(runID)) throw new Error(`invalid run id: ${runID}`)
}

function newRunID() {
  const now = new Date()
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/T/, "-")
    .slice(0, 15)
  return `${stamp}-${randomSlug(4)}`
}

function randomSlug(size: number) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  for (const byte of bytes) out += chars[byte % chars.length]
  return out
}

function childPath(root: string, child: string) {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(resolvedRoot, child)
  const pathFromRoot = relative(resolvedRoot, resolvedPath)
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`path outside ${resolvedRoot}: ${resolvedPath}`)
  }
  return resolvedPath
}

function assertInsideRunsRoot(path: string) {
  const pathFromRoot = relative(resolve(runsRoot()), resolve(path))
  if (!pathFromRoot) throw new Error(`path outside a specific run: ${path}`)
  childPath(runsRoot(), pathFromRoot)
}
