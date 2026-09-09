import { ProposedPlanSchema, type ProposedPlan } from "@mako/sessions/content"
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
  plans?: ProposedPlan[]
  updatedAt: number
}

export interface RejectedDraft {
  id: string
  key: string
  text: string
  attachments: Attachment[]
  plans?: ProposedPlan[]
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
          z.object({
            key: z.string(),
            text: z.string(),
            plans: z.array(ProposedPlanSchema).optional(),
            updatedAt: z.number(),
          })
        ),
        rejected: z.array(
          z.object({
            id: z.string(),
            key: z.string(),
            text: z.string(),
            attachments: z.array(SavedAttachmentSchema),
            plans: z.array(ProposedPlanSchema).optional(),
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

export function projectDraftKey(cwd: string): string {
  return `project:${cwd.replace(/\/+$/, "") || "/"}`
}

export function draftText(key: string): string {
  return draftsStore.get().drafts.find((draft) => draft.key === key)?.text ?? ""
}

export function rememberDraft(key: string, text: string) {
  const plans = draftsStore
    .get()
    .drafts.find((draft) => draft.key === key)?.plans
  putDraft(key, text, plans)
}

function putDraft(key: string, text: string, plans?: ProposedPlan[]) {
  const remaining = draftsStore
    .get()
    .drafts.filter((draft) => draft.key !== key)
  draftsStore.set({
    drafts:
      text || plans?.length
        ? [...remaining, { key, text, plans, updatedAt: Date.now() }]
        : remaining,
  })
}

export function replaceDraftPlans(key: string, plans: ProposedPlan[]): void {
  putDraft(key, draftText(key), plans.length ? plans : undefined)
}

export function rememberDraftPlan(key: string, plan: ProposedPlan): void {
  const draft = draftsStore.get().drafts.find((draft) => draft.key === key)
  const plans = draft?.plans ?? []
  if (
    plans.some(
      (current) => current.id === plan.id && current.text === plan.text
    )
  )
    return
  putDraft(key, draft?.text ?? "", [
    ...plans.filter((current) => current.id !== plan.id),
    plan,
  ])
}

export function removeDraftPlan(key: string, plan: ProposedPlan): void {
  const draft = draftsStore.get().drafts.find((draft) => draft.key === key)
  putDraft(
    key,
    draft?.text ?? "",
    draft?.plans?.filter((current) => current !== plan)
  )
}

/** Clear only the exact draft captured by send; staging may have awaited newer edits. */
export function clearCapturedDraft(
  key: string,
  text: string,
  plans?: ProposedPlan[]
): void {
  const draft = draftsStore.get().drafts.find((draft) => draft.key === key)
  if (draft?.text === text && draft.plans === plans) putDraft(key, "")
}

export function restoreEmptyDraft(
  key: string,
  text: string,
  plans?: ProposedPlan[]
): boolean {
  const draft = draftsStore.get().drafts.find((draft) => draft.key === key)
  if (draft?.text || draft?.plans?.length) return false
  putDraft(key, text, plans)
  return true
}

export function appendRecoveredDraft(
  key: string,
  recovered: RejectedDraft
): void {
  const draft = draftsStore.get().drafts.find((draft) => draft.key === key)
  const plans = [...(draft?.plans ?? [])]
  for (const plan of recovered.plans ?? [])
    if (
      !plans.some(
        (current) => current.id === plan.id && current.text === plan.text
      )
    )
      plans.push(plan)
  putDraft(
    key,
    [draft?.text, recovered.text].filter(Boolean).join("\n\n"),
    plans
  )
}

/** An accepted send must not erase text entered while it was pending. */
export function clearSubmittedDraft(key: string, submitted: string) {
  if (draftText(key) === submitted) rememberDraft(key, "")
}

export function retainRejectedDraft(
  key: string,
  text: string,
  attachments: Attachment[],
  plans?: ProposedPlan[]
): void {
  draftsStore.set({
    rejected: [
      ...draftsStore.get().rejected,
      { id: crypto.randomUUID(), key, text, attachments, plans },
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
