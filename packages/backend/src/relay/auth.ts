import { verifyMcpToken } from "../mcp/auth"

export function relayAuthorized(request: Request): boolean {
  const authorization = request.headers.get("Authorization")
  const match = /^Bearer (.+)$/.exec(authorization ?? "")
  return Boolean(match?.[1] && verifyMcpToken(request, match[1]))
}

export function relayUnauthorized(): Response {
  return Response.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    }
  )
}
