import { z } from "zod"
import { ProposedPlanSchema } from "@mako/sessions/content"
import {
  readDraftStorage,
  writeDraftStorage,
  savedAttachment,
  SavedAttachmentSchema,
} from "@/lib/draft-persistence"
import type { RejectedDraft } from "@/state/drafts"
import { createHook, createStore } from "@/state/store"

const KEY = "mako.pending-sends.v1"
const RecoverySchema = z.object({
  id: z.string(),
  key: z.string(),
  text: z.string(),
  attachments: z.array(SavedAttachmentSchema),
  plans: z.array(ProposedPlanSchema).optional(),
})

function loadPendingSends(): RejectedDraft[] {
  const raw = readDraftStorage(KEY)
  if (!raw) return []
  try {
    return z.array(RecoverySchema).parse(JSON.parse(raw))
  } catch {
    return []
  }
}

// Only receipts left by a previous renderer are exposed as interrupted sends.
// They are recovery copies, never an outbox that silently repeats delivery.
export const sendRecoveryStore = createStore({
  interrupted: loadPendingSends(),
  pending: new Map<string, RejectedDraft>(),
})
export const useSendRecovery = createHook(sendRecoveryStore)

export function preserveSendingDraft(
  draft: Omit<RejectedDraft, "id">
): string | null {
  const id = crypto.randomUUID()
  const pending = new Map(sendRecoveryStore.get().pending)
  pending.set(id, { ...draft, id })
  if (!updateRecovery({ pending }, true)) return null
  return id
}

export function settleSendingDraft(id: string): void {
  const pending = new Map(sendRecoveryStore.get().pending)
  pending.delete(id)
  updateRecovery({ pending })
}

export function interruptSendingDraft(id: string): void {
  const { pending, interrupted } = sendRecoveryStore.get()
  const draft = pending.get(id)
  if (!draft) return
  const remaining = new Map(pending)
  remaining.delete(id)
  updateRecovery({
    pending: remaining,
    interrupted: [...interrupted, draft],
  })
}

export function takeInterruptedSend(id: string): RejectedDraft | undefined {
  const { interrupted } = sendRecoveryStore.get()
  const draft = interrupted.find((item) => item.id === id)
  if (draft)
    updateRecovery({
      interrupted: interrupted.filter((item) => item.id !== id),
    })
  return draft
}

function updateRecovery(
  patch: Partial<ReturnType<typeof sendRecoveryStore.get>>,
  requireSaved = false
): boolean {
  const next = { ...sendRecoveryStore.get(), ...patch }
  const saved = writeDraftStorage(
    KEY,
    JSON.stringify(
      [...next.interrupted, ...next.pending.values()].map((draft) => ({
        ...draft,
        attachments: draft.attachments.map(savedAttachment),
      }))
    )
  )
  if (saved || !requireSaved) sendRecoveryStore.set(next)
  return saved
}
