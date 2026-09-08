import type { RequestPermissionRequest } from "@agentclientprotocol/sdk"

/** Devin names MCP calls in its session-choice label when toolCall has no title. */
export function devinPermissionTitle(request: RequestPermissionRequest) {
  const choice = request.options.find(
    (option) => option.optionId === "allow_session"
  )
  const match = choice?.name.match(
    /^Yes, allow calling ([a-zA-Z0-9_.:-]+) on the ([a-zA-Z0-9_.:-]+) MCP server \(this session\)$/
  )
  return match?.[1] && match[2] ? `${match[2]}: ${match[1]}` : undefined
}
