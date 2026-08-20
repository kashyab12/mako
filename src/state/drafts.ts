import { createHook, createStore } from "@/state/store"

export interface SessionDraft {
  key: string
  text: string
  updatedAt: number
}

interface DraftState {
  drafts: SessionDraft[]
}

// Detached sessions retain drafts so reopening them restores the paragraph.
const MAX_DRAFTS = 64

export const draftsStore = createStore<DraftState>({ drafts: [] })
export const useDrafts = createHook(draftsStore)

export function draftText(key: string): string {
  return draftsStore.get().drafts.find((draft) => draft.key === key)?.text ?? ""
}

export function rememberDraft(key: string, text: string) {
  const remaining = draftsStore
    .get()
    .drafts.filter((draft) => draft.key !== key)
  draftsStore.set({
    drafts: text
      ? [...remaining, { key, text, updatedAt: Date.now() }].slice(-MAX_DRAFTS)
      : remaining,
  })
}
