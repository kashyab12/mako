import { getMako, hasBridge } from "@/lib/bridge"

export const pluginFiles = {
  available(): boolean {
    return hasBridge()
  },

  directory(): Promise<string> {
    return getMako().pluginsDir()
  },

  write(id: string, source: string): Promise<void> {
    return getMako().writePlugin(id, source)
  },

  remove(id: string): Promise<void> {
    return getMako().deletePlugin(id)
  },

  reveal(): Promise<void> {
    return getMako().revealPlugins()
  },
}
