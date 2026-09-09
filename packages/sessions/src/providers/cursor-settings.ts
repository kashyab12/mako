import type { SessionSettings } from "../settings.js"

export function cursorModelSettings(
  identity: string | undefined
): SessionSettings {
  if (!identity) return {}
  const bracket = identity.indexOf("[")
  const model = bracket < 0 ? identity : identity.slice(0, bracket)
  const options: NonNullable<SessionSettings["options"]> = {}
  if (bracket >= 0 && identity.endsWith("]")) {
    for (const entry of identity.slice(bracket + 1, -1).split(",")) {
      const separator = entry.indexOf("=")
      if (separator < 1) continue
      const wire = entry.slice(0, separator)
      options[
        wire === "reasoning" || wire === "reasoning_effort" ? "effort" : wire
      ] = entry.slice(separator + 1)
    }
  }
  return { model, options }
}
