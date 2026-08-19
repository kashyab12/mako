import { getMako, hasBridge } from "@/lib/bridge"
import type {
  MakoComputerPermissions,
  McpRegistrySnapshot,
  McpSyncPreview,
  McpSyncTarget,
} from "@/lib/types"
import { createHook, createStore } from "@/state/store"

interface McpState {
  status: "idle" | "loading" | "ready" | "syncing" | "error"
  snapshot: McpRegistrySnapshot | null
  previews: Record<string, McpSyncPreview[]>
  permissions?: MakoComputerPermissions
  error?: string
}

export const mcpStore = createStore<McpState>({
  status: "idle",
  snapshot: null,
  previews: {},
})
export const useMcp = createHook(mcpStore)

export const mcp = {
  async load() {
    if (!hasBridge()) return
    mcpStore.set({ status: "loading", error: undefined })
    try {
      const [snapshot, permissions] = await Promise.all([
        getMako().discoverMcp(),
        getMako().computerPermissions(),
      ])
      mcpStore.set({
        status: "ready",
        snapshot,
        permissions,
        previews: {},
      })
    } catch {
      mcpStore.set({
        status: "error",
        error: "MCP configuration could not be loaded",
      })
    }
  },

  async requestComputerPermissions() {
    if (!hasBridge()) return
    try {
      const permissions = await getMako().requestComputerPermissions()
      mcpStore.set({ permissions })
    } catch (error) {
      mcpStore.set({
        error:
          error instanceof Error
            ? `Computer-use permission request failed: ${error.message}`
            : "Computer-use permission request failed",
      })
    }
  },

  async preview(serverId: string, targets: McpSyncTarget[]) {
    if (!hasBridge() || targets.length === 0) return
    mcpStore.set({ status: "syncing", error: undefined })
    try {
      const previews = await Promise.all(
        targets.map((target) => getMako().previewMcpSync(serverId, target))
      )
      mcpStore.set((state) => ({
        status: "ready",
        previews: { ...state.previews, [serverId]: previews },
      }))
    } catch (error) {
      mcpStore.set({
        status: "error",
        error:
          error instanceof Error
            ? `MCP sync preview failed: ${error.message}`
            : "MCP sync preview failed",
      })
    }
  },

  async apply(serverId: string) {
    if (!hasBridge()) return
    const previews = mcpStore.get().previews[serverId] ?? []
    const actionable = previews.filter(
      (preview) => preview.action === "add" || preview.action === "replace"
    )
    if (actionable.length === 0) return
    mcpStore.set({ status: "syncing", error: undefined })
    try {
      let snapshot = mcpStore.get().snapshot
      for (const preview of actionable) {
        snapshot = await getMako().applyMcpSync(serverId, preview.target)
      }
      mcpStore.set((state) => ({
        status: "ready",
        snapshot,
        previews: { ...state.previews, [serverId]: [] },
      }))
    } catch (error) {
      mcpStore.set({
        status: "error",
        error:
          error instanceof Error
            ? `MCP sync failed: ${error.message}`
            : "MCP sync failed",
      })
    }
  },
}
