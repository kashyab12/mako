type OutputScalar = boolean | number | string | null
type OutputValue = OutputScalar | OutputObject | OutputValue[]

interface OutputObject {
  [key: string]: OutputValue | undefined
}

function isOutputObject(value: OutputValue): value is OutputObject {
  return (
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function stringValue(value: OutputValue | undefined): string | undefined {
  return Object.prototype.toString.call(value) === "[object String]"
    ? String(value)
    : undefined
}

function decodedOutput(
  content: OutputValue,
  depth: number
): string | undefined {
  const text = stringValue(content)
  if (text !== undefined) {
    const trimmed = text.trim()
    if (
      depth < 4 &&
      text.length <= 1024 * 1024 &&
      (trimmed.startsWith("[") || trimmed.startsWith("{"))
    ) {
      try {
        const parsed: OutputValue = JSON.parse(trimmed)
        return decodedOutput(parsed, depth + 1) ?? text
      } catch {
        return text
      }
    }
    return text
  }
  if (Array.isArray(content)) {
    const parts = content.flatMap((part) => {
      const decoded = decodedOutput(part, depth + 1)
      return decoded ? [decoded] : []
    })
    return parts.length > 0 ? parts.join("\n") : undefined
  }
  if (!isOutputObject(content)) return undefined
  const type = stringValue(content.type)?.toLowerCase()
  if (["input_text", "output_text", "text"].includes(type ?? "")) {
    const value = content.text
    return value === undefined ? undefined : decodedOutput(value, depth + 1)
  }
  if (
    content.output !== undefined &&
    (content.chunk_id !== undefined ||
      content.wall_time_seconds !== undefined ||
      content.session_id !== undefined)
  ) {
    return decodedOutput(content.output, depth + 1)
  }
  if (content.content !== undefined && type) {
    return decodedOutput(content.content, depth + 1)
  }
  return undefined
}

export function normalizeToolOutput(text: string | undefined): string {
  if (!text) return ""
  return decodedOutput(text, 0) ?? text
}
