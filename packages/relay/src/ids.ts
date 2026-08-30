import { createHash } from "node:crypto"

export function deterministicRelayJobId(eventId: string): string {
  const value = createHash("sha256").update(eventId).digest("hex").slice(0, 32)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`
}
