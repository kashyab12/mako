import type { SessionConfigOption } from "@agentclientprotocol/sdk"

export function resolveAcpConfigValue(
  option: SessionConfigOption,
  requested: string
): string {
  if (option.type !== "select") return requested
  const values = option.options.flatMap((candidate) =>
    "value" in candidate ? [candidate] : candidate.options
  )
  return (
    values.find(
      (candidate) =>
        candidate.value === requested ||
        candidate.name === requested ||
        candidate.value.startsWith(`${requested}[`)
    )?.value ?? requested
  )
}
