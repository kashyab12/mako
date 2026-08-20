const MAX_TEXT_BYTES = 1024 * 1024

export function textResult(text: string) {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new Error("MCP text result exceeded the 1 MB response limit")
  }
  return {
    content: [{ type: "text" as const, text }],
  }
}
