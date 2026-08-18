import { createHook, createStore } from "@/state/store"
import { getPi, hasBridge } from "@/lib/bridge"
import type { Automation, AutomationRun } from "@/lib/types"

/**
 * Saved prompts and their triggers.
 *
 * The definitions live in the project so they can be committed; whether one is
 * switched on is a local decision, held here and in the host, and never
 * written back. Cloning a repository must not start running an agent.
 */
export const automationsStore = createStore<{ list: Automation[]; recent: AutomationRun[] }>({
  list: [],
  recent: [],
})

export const useAutomations = createHook(automationsStore)

export function applyAutomations(list: Automation[]) {
  automationsStore.set({ list })
}

export function noteAutomationRun(run: AutomationRun) {
  // Newest first, and only a handful: this is a reassurance that something
  // fired, not a log.
  automationsStore.set({ recent: [run, ...automationsStore.get().recent].slice(0, 8) })
}

export const automations = {
  async load() {
    if (!hasBridge()) return
    const list = await getPi().automations().catch(() => [])
    automationsStore.set({ list })
  },

  async reload() {
    if (!hasBridge()) return
    const list = await getPi().reloadAutomations().catch(() => [])
    automationsStore.set({ list })
  },

  async setEnabled(id: string, enabled: boolean) {
    const list = await getPi().setAutomationEnabled(id, enabled).catch(() => null)
    if (list) automationsStore.set({ list })
  },

  run(id: string) {
    void getPi().runAutomation(id)
  },

  async save(next: Automation[]) {
    const list = await getPi().saveAutomations(next).catch(() => null)
    if (list) automationsStore.set({ list })
  },
}
