/**
 * Spec tool descriptors (change `add-speckit-backend`, design D1).
 *
 * Each spec tool is described once, here: its layout, labels, archive
 * capability, authoring commands, and the readers that turn its files into
 * board, bundle, and title facts. Callers read these descriptors instead of
 * comparing tool names, so adding a tool means adding a descriptor and its
 * reader module.
 */

import { join, relative } from "node:path"

import type { ConvoyConfig } from "./config"
import { readCheckoutActiveChanges, readCheckoutArchives, readCheckoutCanonicalSpecs, type LocalActiveChange, type LocalArchiveEntry, type LocalCanonicalSpec, type ReadActiveChangesOptions, type ReadResult } from "./checkout-openspec"
import { collectDirRelativeMarkdown, isOpenSpecChangeId, listOpenSpecChanges, loadOpenSpecBundle, openSpecBranchPrefix, openSpecPromptFor, titleFromProposal, whyFromProposal } from "./openspec"
import { collectFeatureFiles, listSpecKitChanges, loadSpecKitBundle, readSpecKitActiveChanges, readSpecKitCompleted, readSpecKitConstitution, specKitStepEnv, specKitTaskCounts, titleFromSpec, whyFromSpec } from "./speckit"
import { openspecTaskCounts, type BoardTasks } from "./task-counts"

export const specToolIds = Object.freeze(["openspec", "speckit"] as const)
export type SpecToolId = (typeof specToolIds)[number]

/** Frozen run contract; its tool stays authoritative even if config changes. */
export type SpecBundle = {
  tool: SpecToolId
  changeIds: readonly string[]
  specFiles: readonly string[]
  rootDir?: string
}

/** Every reader group kind across the descriptors below. */
export type SpecArtifactSection = "proposal" | "design" | "tasks" | "delta" | "spec" | "plan" | "design-docs" | "other"

/** Ordered artifact groups; the final `other` group receives unmatched files. */
export type SpecReaderGroup = {
  readonly kind: SpecArtifactSection
  readonly label: string
  readonly files: readonly string[]
  readonly prefixes?: readonly string[]
  readonly headings?: boolean
}

export type SpecToolDescriptor = {
  readonly id: SpecToolId
  readonly label: string
  /** What one unit of work is called in plan reviews and prompts. */
  readonly changeNoun: string
  /** The indefinite article `changeNoun` takes in running text. */
  readonly changeArticle: "a" | "an"
  /** Checkout-relative directory holding one directory per change. */
  readonly changeRoot: string
  /** The only path prefix spin, archive, and recovery may leave dirty. */
  readonly dirtyRoot: string
  /** The change file whose heading titles it and whose rationale is its Why. */
  readonly proposalFile: string
  /** True when a missing Why falls back to the run prompt's opening paragraph. */
  readonly promptWhyFallback: boolean
  /** True when a title equal to the change id still names the run. */
  readonly fallbackTitleIsUsable: boolean
  readonly isChangeId: (id: string) => boolean
  /** False when the tool has no archive; completion then stands in for it (design D3). */
  readonly archives: boolean
  /** Why archive is refused, quoted by close and the board; set when `archives` is false. */
  readonly archiveDisabledReason?: string
  /** The board's label for archived or completed changes. */
  readonly settledLabel: string
  readonly canonicalLabel: string
  /** The specs browser's lowercase section header for canonical documents. */
  readonly canonicalHeader: string
  /** Authoring command names in lookup order (design D5). */
  readonly proposalCommands: readonly string[]
  /** Checkout-relative roots that mark the tool present and refresh the live board. */
  readonly fingerprintRoots: readonly string[]
  readonly groups: readonly SpecReaderGroup[]
  /** A change directory's reader and bundle documents, relative to `relativeRoot`, sorted. */
  readonly changeFiles: (changeDir: string, relativeRoot: string) => Promise<string[]>
  readonly readActiveChanges: (checkout: string, options?: ReadActiveChangesOptions) => Promise<ReadResult<LocalActiveChange[]>>
  readonly readSettled: (checkout: string) => Promise<ReadResult<LocalArchiveEntry[]>>
  readonly readCanonical: (checkout: string) => Promise<ReadResult<LocalCanonicalSpec[]>>
  /** Reader documents, distinct from the board's capability inventory. */
  readonly readCanonicalFiles: (checkout: string) => Promise<ReadResult<string[]>>
  readonly loadBundle: (input: { targetDir: string; explicitIds?: readonly string[] }) => Promise<SpecBundle | undefined>
  readonly titleOf: (body: string, fallback: string) => string
  readonly whyOf: (body: string) => string | undefined
  readonly taskCounts: (checkout: string) => Promise<ReadonlyMap<string, BoardTasks>>
  readonly branchPrefix: (changeDir: string) => Promise<string>
  readonly stepEnv: (checkout: string, changeIds: readonly string[]) => Record<string, string>
  readonly listChanges: (checkout: string) => Promise<{ id: string; title: string }[]>
}

/** All consumers share these values; freeze nested reader metadata as well. */
function freezeSpecTool(descriptor: SpecToolDescriptor): SpecToolDescriptor {
  Object.freeze(descriptor.proposalCommands)
  Object.freeze(descriptor.fingerprintRoots)
  for (const group of descriptor.groups) {
    Object.freeze(group.files)
    if (group.prefixes) Object.freeze(group.prefixes)
    Object.freeze(group)
  }
  Object.freeze(descriptor.groups)
  return Object.freeze(descriptor)
}

export const specTools: Readonly<Record<SpecToolId, SpecToolDescriptor>> = Object.freeze({
  openspec: freezeSpecTool({
    id: "openspec",
    label: "OpenSpec",
    changeNoun: "OpenSpec change",
    changeArticle: "an",
    changeRoot: "openspec/changes",
    dirtyRoot: "openspec/",
    proposalFile: "proposal.md",
    promptWhyFallback: true,
    fallbackTitleIsUsable: false,
    isChangeId: (id) => isSpecDirectoryId(id) && isOpenSpecChangeId(id),
    archives: true,
    settledLabel: "archives",
    canonicalLabel: "Canonical Specs",
    canonicalHeader: "specs",
    proposalCommands: ["opsx-propose", "*propose"],
    fingerprintRoots: ["openspec/"],
    groups: [
      { kind: "proposal", label: "Proposal", files: ["proposal.md"] },
      { kind: "design", label: "Design", files: ["design.md"] },
      { kind: "tasks", label: "Tasks", files: ["tasks.md"] },
      { kind: "delta", label: "Delta Specs", files: [], prefixes: ["specs/"], headings: true },
      { kind: "other", label: "Other", files: [] },
    ],
    changeFiles: collectDirRelativeMarkdown,
    readActiveChanges: readCheckoutActiveChanges,
    readSettled: readCheckoutArchives,
    readCanonical: readCheckoutCanonicalSpecs,
    readCanonicalFiles: async (checkout) => ({ kind: "known", value: await collectDirRelativeMarkdown(join(checkout, "openspec/specs"), "openspec/specs") }),
    loadBundle: async (input) => {
      const bundle = await loadOpenSpecBundle(input)
      return bundle ? { ...bundle, tool: "openspec" as const } : undefined
    },
    titleOf: titleFromProposal,
    whyOf: whyFromProposal,
    taskCounts: openspecTaskCounts,
    branchPrefix: openSpecBranchPrefix,
    stepEnv: () => ({}),
    listChanges: listOpenSpecChanges,
  }),
  speckit: freezeSpecTool({
    id: "speckit",
    label: "Spec Kit",
    changeNoun: "Spec Kit feature",
    changeArticle: "a",
    changeRoot: "specs",
    dirtyRoot: "specs/",
    proposalFile: "spec.md",
    promptWhyFallback: false,
    fallbackTitleIsUsable: true,
    isChangeId: isSpecDirectoryId,
    archives: false,
    archiveDisabledReason: "Spec Kit has no archive",
    settledLabel: "completed",
    canonicalLabel: "Constitution",
    canonicalHeader: "constitution",
    proposalCommands: ["speckit.specify", "speckit-specify"],
    fingerprintRoots: ["specs/", ".specify/"],
    groups: [
      { kind: "spec", label: "Spec", files: ["spec.md"] },
      { kind: "plan", label: "Plan", files: ["plan.md"] },
      { kind: "tasks", label: "Tasks", files: ["tasks.md"] },
      { kind: "design-docs", label: "Design Docs", files: ["research.md", "data-model.md", "quickstart.md"], prefixes: ["contracts/"], headings: true },
      { kind: "other", label: "Other", files: [] },
    ],
    changeFiles: collectFeatureFiles,
    readActiveChanges: readSpecKitActiveChanges,
    readSettled: readSpecKitCompleted,
    readCanonical: readSpecKitConstitution,
    readCanonicalFiles: async (checkout) => {
      const read = await readSpecKitConstitution(checkout)
      return read.kind === "unknown" ? read : { kind: "known", value: read.value.map((spec) => relative(checkout, spec.sourcePath)) }
    },
    loadBundle: loadSpecKitBundle,
    titleOf: titleFromSpec,
    whyOf: whyFromSpec,
    taskCounts: specKitTaskCounts,
    branchPrefix: async () => "feat",
    stepEnv: specKitStepEnv,
    listChanges: listSpecKitChanges,
  }),
})

/** A checkout-local directory name, never a path or hidden entry. */
function isSpecDirectoryId(id: string): boolean {
  return id.length > 0 && !id.startsWith(".") && !/[\/\\\u0000]/.test(id)
}

export function specToolById(id: SpecToolId): SpecToolDescriptor {
  return specTools[id]
}

export function isSpecToolId(value: unknown): value is SpecToolId {
  return typeof value === "string" && (specToolIds as readonly string[]).includes(value)
}

/** A `features.specs` value's descriptor: false turns specs off, absent means OpenSpec. */
export function specToolOf(specs: SpecToolId | false | undefined): SpecToolDescriptor | undefined {
  return specs === false ? undefined : specTools[specs ?? "openspec"]
}

/** Config selects the one tool; filesystem contents never select or change it. */
export function specToolFor(config?: Pick<ConvoyConfig, "features">): SpecToolDescriptor | undefined {
  return specToolOf(config?.features?.specs)
}

/** Keep one pipeline-to-verb rule while naming the actual contract. */
export function specPromptFor(pipelineName: string, tool: SpecToolDescriptor): string {
  return openSpecPromptFor(pipelineName).replace("OpenSpec change", tool.changeNoun)
}
