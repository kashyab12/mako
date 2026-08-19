import { getMako, hasBridge } from "@/lib/bridge"
import type {
  SkillRegistrySnapshot,
  SkillSyncPreview,
  SkillSyncTarget,
} from "@/lib/types"
import { createHook, createStore } from "@/state/store"

interface SkillsState {
  status: "idle" | "loading" | "ready" | "syncing" | "error"
  snapshot: SkillRegistrySnapshot | null
  previews: Record<string, SkillSyncPreview[]>
  error?: string
}

export const skillsStore = createStore<SkillsState>({
  status: "idle",
  snapshot: null,
  previews: {},
})
export const useSkills = createHook(skillsStore)

export const skills = {
  async load() {
    if (!hasBridge()) return
    skillsStore.set({ status: "loading", error: undefined })
    try {
      const snapshot = await getMako().discoverSkills()
      skillsStore.set({ status: "ready", snapshot, previews: {} })
    } catch (error) {
      skillsStore.set({
        status: "error",
        error:
          error instanceof Error
            ? `Skills could not be loaded: ${error.message}`
            : "Skills could not be loaded",
      })
    }
  },

  async preview(
    skillId: string,
    targets: SkillSyncTarget[],
    action: "sync" | "remove"
  ) {
    if (!hasBridge() || targets.length === 0) return
    skillsStore.set({ status: "syncing", error: undefined })
    try {
      const previews = await Promise.all(
        targets.map((target) =>
          action === "remove"
            ? getMako().previewSkillRemove(skillId, target)
            : getMako().previewSkillSync(skillId, target)
        )
      )
      skillsStore.set((state) => ({
        status: "ready",
        previews: { ...state.previews, [skillId]: previews },
      }))
    } catch (error) {
      skillsStore.set({
        status: "error",
        error:
          error instanceof Error
            ? `Skill preview failed: ${error.message}`
            : "Skill preview failed",
      })
    }
  },

  async apply(skillId: string) {
    if (!hasBridge()) return
    const previews = skillsStore.get().previews[skillId] ?? []
    const actionable = previews.filter((preview) =>
      ["add", "replace", "remove"].includes(preview.action)
    )
    if (actionable.length === 0) return
    skillsStore.set({ status: "syncing", error: undefined })
    try {
      const snapshot = await getMako().applySkillSync(
        skillId,
        actionable.map((preview) => preview.target)
      )
      skillsStore.set((state) => ({
        status: "ready",
        snapshot,
        previews: { ...state.previews, [skillId]: [] },
      }))
    } catch (error) {
      skillsStore.set({
        status: "error",
        error:
          error instanceof Error
            ? `Skill sync failed: ${error.message}`
            : "Skill sync failed",
      })
    }
  },
}
