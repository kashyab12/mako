import { z } from "zod"
import {
  SavedAttachmentSchema,
  savedAttachment,
  readDraftStorage,
  writeDraftStorage,
} from "@/lib/draft-persistence"
import type { Attachment } from "@/lib/attachments"
import { createHook, createStore } from "@/state/store"

export interface SessionDraft {
  key: string
  text: string
  updatedAt: number
}

export interface RejectedDraft {
  id: string
  key: string
  text: string
  attachments: Attachment[]
}

interface DraftState {
  rejected: RejectedDraft[]
  drafts: SessionDraft[]
}

const KEY = "mako.session-drafts.v1"
function restoredDrafts(): DraftState {
  const raw = readDraftStorage(KEY)
  if (!raw) return { drafts: [], rejected: [] }
  try {
    return z
      .object({
        drafts: z.array(
          z.object({ key: z.string(), text: z.string(), updatedAt: z.number() })
        ),
        rejected: z.array(
          z.object({
            id: z.string(),
            key: z.string(),
            text: z.string(),
            attachments: z.array(SavedAttachmentSchema),
          })
        ),
      })
      .parse(JSON.parse(raw))
  } catch {
    return { drafts: [], rejected: [] }
  }
}

export const draftsStore = createStore<DraftState>(restoredDrafts())
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
      ? [...remaining, { key, text, updatedAt: Date.now() }]
      : remaining,
  })
}

export function retainRejectedDraft(
  key: string,
  text: string,
  attachments: Attachment[]
): void {
  draftsStore.set({
    rejected: [
      ...draftsStore.get().rejected,
      { id: crypto.randomUUID(), key, text, attachments },
    ],
  })
}

export function takeRejectedDraft(id: string): RejectedDraft | undefined {
  const found = draftsStore.get().rejected.find((draft) => draft.id === id)
  if (found)
    draftsStore.set({
      rejected: draftsStore.get().rejected.filter((draft) => draft.id !== id),
    })
  return found
}

draftsStore.subscribe(() => {
  const state = draftsStore.get()
  writeDraftStorage(
    KEY,
    JSON.stringify({
      drafts: state.drafts,
      rejected: state.rejected.map((draft) => ({
        ...draft,
        attachments: draft.attachments.map(savedAttachment),
      })),
    })
  )
})
