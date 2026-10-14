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

import { loadAgentPrompt } from "../agents"

import type { AttachmentDescriptor } from "./contracts"

/** Synthesized read-only variants (`agent__ro`) share the base agent's prompt. */
export function baseAgentName(agentName: string): string {
  return agentName.endsWith("__ro") ? agentName.slice(0, -"__ro".length) : agentName
}

/** Resolves an agent's full instructions exactly as the config renderer does. */
export function resolveAgentInstructions(input: { agentName: string; targetDir: string; advisor?: boolean }): string {
  return loadAgentPrompt(baseAgentName(input.agentName), input.targetDir, input.advisor ? { advisor: true } : {})
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
