import { lstat, readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { observeCheckoutTaskCounts, type LocalActiveChange, type LocalArchiveEntry, type LocalCanonicalSpec, type ReadActiveChangesOptions, type ReadResult } from "./checkout-openspec"
import { isTextAttachment } from "./attachments"
import { collectDirRelativeFiles, collectDirRelativeMarkdown, stripYamlFrontmatter } from "./openspec"
import type { SpecBundle } from "./spec-tools"
import { countCheckboxTasks, type BoardTasks } from "./task-counts"

/** Spec Kit files are checkout-local evidence; discovery never invokes its CLI. */
async function featureIds(checkout: string): Promise<string[]> {
  const root = join(checkout, "specs")
  try {
    if (!(await lstat(root)).isDirectory()) return []
  } catch (error) {
    if (isErrno(error, "ENOENT")) return []
    throw error
  }
  const entries = await readdir(root, { withFileTypes: true })
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    try {
      if ((await lstat(join(root, entry.name, "spec.md"))).isFile()) ids.push(entry.name)
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error
    }
  }
  return ids.sort()
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
}

type FileRead = ReadResult<string> | { kind: "missing" }

/** lstat prevents even file symlinks from being read. */
async function readLocalFile(path: string): Promise<FileRead> {
  try {
    if (!(await lstat(path)).isFile()) return { kind: "unknown", reason: `${path} is not a regular file` }
    return { kind: "known", value: await readFile(path, "utf8") }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "missing" }
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) }
  }
}

export function titleFromSpec(body: string, fallback: string): string {
  const heading = stripYamlFrontmatter(body).match(/^#[ \t]+([^\r\n]*)/m)?.[1]?.trim()
  return heading?.replace(/^Feature Specification:\s*/, "").trim() || fallback
}

export function whyFromSpec(body: string): string | undefined {
  const input = stripYamlFrontmatter(body).match(/^\*\*Input\*\*:[ \t]*(?:User description:[ \t]*)?([^\r\n]*)/m)?.[1]?.trim()
  if (!input) return undefined
  const unquoted = input.replace(/^(["'])([\s\S]*)\1$/, "$2").trim()
  return unquoted || undefined
}

/**
 * A feature's documents, relative to `relativeRoot` and sorted: every markdown
 * file, plus every text file under `contracts/`, where `/speckit.plan` may
 * write OpenAPI, JSON Schema, GraphQL or protobuf instead of markdown.
 */
export async function collectFeatureFiles(featureDir: string, relativeRoot: string): Promise<string[]> {
  const markdown = await collectDirRelativeMarkdown(featureDir, relativeRoot)
  const contracts = await collectDirRelativeFiles(join(featureDir, "contracts"), join(relativeRoot, "contracts"), (name) => !name.endsWith(".md") && isTextAttachment(name))
  return [...markdown, ...contracts].sort()
}

async function describeFeature(checkout: string, changeId: string): Promise<LocalActiveChange> {
  const sourcePath = join(checkout, "specs", changeId)
  const files = await collectFeatureFiles(sourcePath, ".")
  const spec = await readLocalFile(join(sourcePath, "spec.md"))
  const tasks = await readLocalFile(join(sourcePath, "tasks.md"))
  return {
    checkout, changeId, sourcePath, hasMarkdown: files.length > 0,
    ...(spec.kind === "known" ? { title: titleFromSpec(spec.value, changeId) } : {}),
    artifacts: {
      proposal: spec.kind === "known", design: files.includes("plan.md"), tasks: tasks.kind === "known", deltaSpecs: [],
      other: files.filter((file) => !["spec.md", "plan.md", "tasks.md"].includes(file)),
    },
    ...(tasks.kind === "known" ? { tasks: countCheckboxTasks(tasks.value) } : tasks.kind === "unknown" ? { tasks: "unknown" as const } : {}),
  }
}

function completed(change: LocalActiveChange): boolean {
  return typeof change.tasks === "object" && change.tasks.total > 0 && change.tasks.done === change.tasks.total
}

async function readFeatures(checkout: string, options: ReadActiveChangesOptions = {}): Promise<ReadResult<LocalActiveChange[]>> {
  try {
    const ids = await featureIds(checkout)
    const changes = await Promise.all(ids.map((id) => describeFeature(checkout, id)))
    if (options.taskCounts && changes.some((change) => change.tasks !== undefined)) {
      // An unreadable count read leaves every feature "unknown", never completed.
      const countsRead = await observeCheckoutTaskCounts(checkout, options.taskCounts)
      const counts = countsRead.kind === "known" ? countsRead.value : undefined
      for (const change of changes) if (change.tasks !== undefined) change.tasks = counts?.get(change.changeId) ?? "unknown"
    }
    return { kind: "known", value: changes }
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function readSpecKitActiveChanges(checkout: string, options: ReadActiveChangesOptions = {}): Promise<ReadResult<LocalActiveChange[]>> {
  const read = await readFeatures(checkout, options)
  return read.kind === "unknown" ? read : { kind: "known", value: read.value.filter((change) => !completed(change)) }
}

export async function readSpecKitCompleted(checkout: string): Promise<ReadResult<LocalArchiveEntry[]>> {
  const read = await readFeatures(checkout)
  return read.kind === "unknown" ? read : { kind: "known", value: read.value.filter(completed).map(({ checkout, changeId, sourcePath, hasMarkdown }) => ({ checkout, changeId, sourcePath, hasMarkdown })) }
}

export async function specKitTaskCounts(checkout: string): Promise<ReadonlyMap<string, BoardTasks>> {
  const read = await readFeatures(checkout)
  if (read.kind === "unknown") throw new Error(read.reason)
  return new Map(read.value.flatMap((change) => typeof change.tasks === "object" ? [[change.changeId, change.tasks] as const] : []))
}

/** Check every managed ancestor so a linked .specify or memory root cannot leak files. */
export async function readSpecKitConstitution(checkout: string): Promise<ReadResult<LocalCanonicalSpec[]>> {
  const sourcePath = join(checkout, ".specify", "memory", "constitution.md")
  try {
    for (const path of [join(checkout, ".specify"), join(checkout, ".specify", "memory")]) {
      if (!(await lstat(path)).isDirectory()) return { kind: "known", value: [] }
    }
    if (!(await lstat(sourcePath)).isFile()) return { kind: "known", value: [] }
    const body = await readLocalFile(sourcePath)
    if (body.kind === "unknown") return body
    return { kind: "known", value: body.kind === "missing" ? [] : [{ checkout, capability: "constitution", sourcePath }] }
  } catch (error) {
    return isErrno(error, "ENOENT") ? { kind: "known", value: [] } : { kind: "unknown", reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function listSpecKitChanges(checkout: string): Promise<{ id: string; title: string }[]> {
  const read = await readSpecKitActiveChanges(checkout)
  if (read.kind === "unknown") throw new Error(read.reason)
  return read.value.map((change) => ({ id: change.changeId, title: change.title ?? change.changeId }))
}

export async function loadSpecKitBundle(input: { targetDir: string; explicitIds?: readonly string[] }): Promise<SpecBundle | undefined> {
  try {
    if (!(await lstat(join(input.targetDir, "specs"))).isDirectory()) return undefined
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  }
  const active = await listSpecKitChanges(input.targetDir)
  const activeIds = new Set(active.map((change) => change.id))
  const changeIds = [...new Set(input.explicitIds?.map((id) => id.trim()).filter((id) => activeIds.has(id)) ?? [])]
  const canonical = await readSpecKitConstitution(input.targetDir)
  if (canonical.kind === "unknown") throw new Error(canonical.reason)
  const specFiles = canonical.value.map(() => ".specify/memory/constitution.md")
  for (const id of changeIds) {
    specFiles.push(...await collectFeatureFiles(join(input.targetDir, "specs", id), join("specs", id)))
  }
  return { tool: "speckit", changeIds, specFiles, rootDir: resolve(input.targetDir) }
}

export function specKitStepEnv(checkout: string, changeIds: readonly string[]): Record<string, string> {
  return changeIds.length === 1 ? { SPECIFY_FEATURE_DIRECTORY: resolve(checkout, "specs", changeIds[0]!), SPECIFY_FEATURE_NO_PERSIST: "1" } : {}
}
