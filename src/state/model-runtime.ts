import { getMako } from "@/lib/bridge"
import type { ModelInfo } from "@/lib/types"

export function listUtilityModels(): Promise<ModelInfo[]> {
  return getMako().listModels()
}
