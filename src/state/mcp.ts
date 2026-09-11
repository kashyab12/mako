import { getMako, hasBridge } from "@/lib/bridge"
import type {
  MakoComputerPermissions,
  BrowserControlStatus,
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
  browsers: BrowserControlStatus[]
  browserSetup?: Awaited<ReturnType<ReturnType<typeof getMako>["prepareBrowserExtension"]>>
  preparingBrowser: boolean
}

export const mcpStore = createStore<McpState>({
  status: "idle",
  snapshot: null,
  previews: {},
  browsers: [],
  preparingBrowser: false,
})
export const useMcp = createHook(mcpStore)

export const mcp = {
  /** Load once per workspace; the composer calls this when its menu opens. */
  ensure(cwd: string) {
    const state = mcpStore.get()
    if (state.status === "loading" || state.status === "syncing") return
    if (state.snapshot && (!cwd || state.snapshot.cwd === cwd)) return
    void mcp.load()
  },

  async prepareBrowser() {
    if (mcpStore.get().preparingBrowser) return
    mcpStore.set({ preparingBrowser: true, error: undefined })
    try { mcpStore.set({ browserSetup: await getMako().prepareBrowserExtension() }) }
    catch (error) { mcpStore.set({ error: error instanceof Error ? error.message : "Browser setup failed" }) }
    finally { mcpStore.set({ preparingBrowser: false }) }
  },
  async refreshBrowsers() {
    try { mcpStore.set({ browsers: await getMako().browserControlStatus() }) }
    catch (error) { mcpStore.set({ error: error instanceof Error ? error.message : "Browser profiles could not be loaded" }) }
  },
  async load() {
    if (!hasBridge()) return
    mcpStore.set({ status: "loading", error: undefined })
    try {
      const [snapshot, permissions, browsers] = await Promise.all([
        getMako().discoverMcp(),
        getMako().computerPermissions(),
        getMako().browserControlStatus(),
      ])
      mcpStore.set({
        status: "ready",
        snapshot,
        permissions,
        browsers,
        previews: {},
      })
    } catch {
      mcpStore.set({
        status: "error",
        error: "MCP configuration could not be loaded",
      })
    }
  },

  async connectBrowser(browser: string) {
    try { mcpStore.set({ error: undefined, browsers: await getMako().connectBrowser(browser) }) }
    catch (error) { mcpStore.set({ error: error instanceof Error ? error.message : "Browser connection failed" }) }
  },
  async disconnectBrowser(browser: string) {
    try { mcpStore.set({ browsers: await getMako().disconnectBrowser(browser) }) }
    catch (error) { mcpStore.set({ error: error instanceof Error ? error.message : "Browser disconnect failed" }) }
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
