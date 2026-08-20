import { timingSafeEqual } from "node:crypto"
import type { AuthInfo } from "@modelcontextprotocol/server"
import { readServerEnv } from "../config/env"

const scopes = ["mako:read", "mako:tools"]

function matchesToken(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function verifyMcpToken(
  _request: Request,
  bearerToken?: string
): AuthInfo | undefined {
  if (!bearerToken) return undefined
  const environment = readServerEnv()
  if (!matchesToken(bearerToken, environment.MAKO_MCP_TOKEN)) return undefined
  return {
    token: bearerToken,
    clientId: "mako-desktop",
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  }
}
