import { getMako, hasBridge } from "@/lib/bridge"
import type { IntegrationCatalogSnapshot } from "@/lib/types"
import { createHook, createStore } from "@/state/store"

interface IntegrationsState {
  status: "idle" | "loading" | "ready" | "error"
  snapshot: IntegrationCatalogSnapshot | null
  error?: string
}

export const integrationsStore = createStore<IntegrationsState>({
  status: "idle",
  snapshot: null,
})
export const useIntegrations = createHook(integrationsStore)

export const integrations = {
  async load() {
    if (!hasBridge()) return
    integrationsStore.set({ status: "loading", error: undefined })
    try {
      integrationsStore.set({
        status: "ready",
        snapshot: await getMako().integrations(),
      })
    } catch (error) {
      integrationsStore.set({
        status: "error",
        error:
          error instanceof Error
            ? `Integrations could not be loaded: ${error.message}`
            : "Integrations could not be loaded",
      })
    }
  },

  async requestComputerPermissions() {
    if (!hasBridge()) return
    await getMako().requestComputerPermissions()
    await integrations.load()
  },

  async openSetup(url: string) {
    if (!hasBridge()) return
    await getMako().openUrl(url)
  },
}
