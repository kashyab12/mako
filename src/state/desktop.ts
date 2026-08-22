import { getMako, hasBridge } from "@/lib/bridge"
import type { ExternalEditor } from "@/lib/types"

export const desktop = {
  available(): boolean {
    return hasBridge()
  },

  openUrl(url: string): Promise<void> {
    return getMako().openUrl(url)
  },

  revealPath(path: string): Promise<void> {
    return getMako().revealPath(path)
  },

  externalEditors(): Promise<ExternalEditor[]> {
    return getMako().externalEditors()
  },

  openInEditor(path: string, editor?: string): Promise<void> {
    return getMako().openInEditor(path, editor)
  },
}
