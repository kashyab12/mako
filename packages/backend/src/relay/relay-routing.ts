import type { RelayJobPayload, RemoteOrigin } from "./types"

export {
  applyRelayThreadMapping,
  deterministicRelayJobId,
} from "@mako/relay"

export function relayThreadPartition(payload: RelayJobPayload): string {
  const { provider, tenantId, conversationId } = payload.origin
  return `${provider}:${tenantId}:${conversationId}`
}

export function escapeRelayFilter(value: string): string {
  return value.replaceAll("'", "''")
}

export function relayOriginFilter(origin: RemoteOrigin): string {
  return [
    "PartitionKey eq 'jobs'",
    `originProvider eq '${escapeRelayFilter(origin.provider)}'`,
    `originTenantId eq '${escapeRelayFilter(origin.tenantId)}'`,
    `originConversationId eq '${escapeRelayFilter(origin.conversationId)}'`,
    `originThreadId eq '${escapeRelayFilter(origin.threadId)}'`,
  ].join(" and ")
}
