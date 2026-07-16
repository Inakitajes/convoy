// Bun < 1.1 ships fetch/streams but not TextDecoderStream. The opencode SDK's
// SSE client needs it; without this shim every event subscription fails
// silently inside the SDK's retry loop and Convoy never sees a single event.
if (typeof globalThis.TextDecoderStream === "undefined") {
  class TextDecoderStreamPolyfill extends TransformStream<Uint8Array, string> {
    readonly encoding: string
    readonly fatal: boolean
    readonly ignoreBOM: boolean

    constructor(label = "utf-8", options: TextDecoderOptions = {}) {
      const decoder = new TextDecoder(label, options)
      super({
        transform(chunk, controller) {
          const text = decoder.decode(chunk, { stream: true })
          if (text) controller.enqueue(text)
        },
        flush(controller) {
          const text = decoder.decode()
          if (text) controller.enqueue(text)
        },
      })
      this.encoding = decoder.encoding
      this.fatal = decoder.fatal
      this.ignoreBOM = decoder.ignoreBOM
    }
  }

  Object.defineProperty(globalThis, "TextDecoderStream", {
    value: TextDecoderStreamPolyfill,
    writable: true,
    configurable: true,
  })
}

export {}
