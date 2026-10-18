import { describe, expect, test } from "bun:test"

import { assertAttachmentsSupported, baseAgentName, toAttachmentDescriptors } from "../src/runners/agent-source"

describe("runner-neutral agent source", () => {
  test("read-only variants share the base agent's prompt", () => {
    expect(baseAgentName("implementer__ro")).toBe("implementer")
    expect(baseAgentName("implementer")).toBe("implementer")
  })

  test("converts disk attachments to descriptors", () => {
    const descriptors = toAttachmentDescriptors([
      { path: "/a/prd.md", mime: "text/markdown", filename: "prd.md" },
      { path: "/a/src", mime: "application/x-directory", isDirectory: true },
    ])
    expect(descriptors).toEqual([
      { kind: "file", path: "/a/prd.md", mime: "text/markdown", filename: "prd.md" },
      { kind: "directory", path: "/a/src", mime: "application/x-directory" },
    ])
  })

  test("an unsupported attachment is an explicit error, not a silent omission", () => {
    const descriptors = toAttachmentDescriptors([
      { path: "/a/img.png", mime: "image/png" },
      { path: "/a/prd.md", mime: "text/markdown" },
    ])
    expect(() => assertAttachmentsSupported(descriptors, (descriptor) => descriptor.mime === "text/markdown")).toThrow(
      /unsupported attachments.*img\.png/,
    )
    expect(() => assertAttachmentsSupported(descriptors, () => true)).not.toThrow()
  })
})
