/**
 * Runner-neutral agent source and attachments (change `runner-parity-opencode-v2`,
 * task 2.3).
 *
 * Both adapters must receive the same source context. Agent instructions are
 * resolved once, here, from the same precedence (project > global > built-in)
 * that the OpenCode config renderer uses, and attachments are normalised to
 * descriptors so an unsupported attachment fails explicitly instead of being
 * silently dropped.
 */


import type { AttachmentDescriptor } from "./contracts"

/** Synthesized read-only variants (`agent__ro`) share the base agent's prompt. */
export function baseAgentName(agentName: string): string {
  return agentName.endsWith("__ro") ? agentName.slice(0, -"__ro".length) : agentName
}

export type AttachmentInput = {
  /** Absolute path on disk. */
  path: string
  mime: string
  filename?: string
  isDirectory?: boolean
}

/** Converts disk attachments to neutral descriptors (path/kind/mime). */
export function toAttachmentDescriptors(inputs: readonly AttachmentInput[]): AttachmentDescriptor[] {
  return inputs.map((input) => ({
    kind: input.isDirectory ? "directory" : "file",
    path: input.path,
    mime: input.mime,
    ...(input.filename ? { filename: input.filename } : {}),
  }))
}

/**
 * Throws listing every attachment the adapter cannot deliver, so an unsupported
 * attachment is an explicit error rather than a silent omission.
 */
export function assertAttachmentsSupported(
  descriptors: readonly AttachmentDescriptor[],
  isSupported: (descriptor: AttachmentDescriptor) => boolean,
): void {
  const unsupported = descriptors.filter((descriptor) => !isSupported(descriptor))
  if (unsupported.length > 0) {
    const names = unsupported.map((descriptor) => descriptor.filename ?? descriptor.path ?? descriptor.kind).join(", ")
    throw new Error(`unsupported attachments for this runner: ${names}`)
  }
}

/** Absolute paths of file attachments (for a CLI that reads them from disk). */
export function attachmentPaths(descriptors: readonly AttachmentDescriptor[]): string[] {
  return descriptors
    .filter((descriptor) => descriptor.kind === "file" && typeof descriptor.path === "string")
    .map((descriptor) => descriptor.path!)
}

/** Directories that must be granted (external to the checkout) for reading. */
export function externalAttachmentDirectories(
  descriptors: readonly AttachmentDescriptor[],
  within: (path: string) => boolean,
): string[] {
  return [
    ...new Set(
      descriptors
        .filter((descriptor) => descriptor.kind === "directory" && typeof descriptor.path === "string" && !within(descriptor.path!))
        .map((descriptor) => descriptor.path!),
    ),
  ]
}

/**
 * Appends a section listing attachment paths so a CLI runner that receives the
 * prompt on stdin can read them from disk, mirroring the OpenCode file parts.
 */
export function withAttachmentSection(prompt: string, descriptors: readonly AttachmentDescriptor[]): string {
  const files = descriptors.filter(
    (descriptor) => typeof descriptor.path === "string" && (descriptor.kind === "file" || descriptor.kind === "directory"),
  )
  if (files.length === 0) return prompt
  const lines = files.map((descriptor) => `- ${descriptor.path}${descriptor.filename ? ` (${descriptor.filename})` : ""}`)
  return [prompt, "", "## Attached files", "Read each of these before acting:", ...lines].join("\n")
}
