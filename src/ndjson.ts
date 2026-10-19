/** Newline-delimited JSON framing shared by the CLI runners' stdout readers. */

/** Yields each non-empty, trimmed line of a byte stream. */
export async function* ndjsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) yield trimmed
    }
  }
  const tail = (buffer + decoder.decode()).trim()
  if (tail) yield tail
}
