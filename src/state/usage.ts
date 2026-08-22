import { getMako, hasBridge } from "@/lib/bridge"
import type { UsageSummary } from "@/lib/types"

export function loadUsage(): Promise<UsageSummary | null> {
  return hasBridge() ? getMako().usage() : Promise.resolve(null)
}
