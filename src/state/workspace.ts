import { getMako } from "@/lib/bridge"

export function stageFile(
  name: string,
  data: string
): Promise<{ path: string }> {
  return getMako().stageFile(name, data)
}
