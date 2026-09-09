import type { ProposedPlan } from "@mako/sessions/content"
import { getMako } from "@/lib/bridge"
import {
  proposedPlanFilename,
  proposedPlanMarkdown,
  proposedPlanReply,
} from "@/lib/proposed-plan"
import { activeAcp, acpStore } from "@/state/acp-state"
import { threadsStore } from "@/state/thread-store"
import { draftText, rememberDraft, rememberDraftPlan } from "@/state/drafts"

export function draftPlanReply(
  source: { liveId?: string; threadPath?: string },
  plan: ProposedPlan,
  intent: "implement" | "revise"
): string {
  if (plan.status !== "proposed" || plan.truncated)
    throw new Error("Wait for the complete plan before preparing a reply.")
  const live = activeAcp(acpStore.get())
  const viewing = threadsStore.get().viewing
  const key =
    source.liveId && live?.key === source.liveId
      ? live.draftKey
      : source.threadPath && viewing?.ref.path === source.threadPath && !live
        ? source.threadPath
        : undefined
  if (!key)
    throw new Error("Open the plan's conversation before preparing a reply.")
  rememberDraftPlan(key, plan)
  const prompt = proposedPlanReply(plan, intent)
  const current = draftText(key)
  const previous = proposedPlanReply(
    plan,
    intent === "implement" ? "revise" : "implement"
  )
  if (current === previous || current.endsWith(`\n\n${previous}`)) {
    rememberDraft(key, `${current.slice(0, -previous.length)}${prompt}`)
    return key
  }
  if (!current.endsWith(prompt))
    rememberDraft(key, current ? `${current}\n\n${prompt}` : prompt)
  return key
}

export function downloadPlan(plan: ProposedPlan): void {
  const url = URL.createObjectURL(
    new Blob([proposedPlanMarkdown(plan)], {
      type: "text/markdown;charset=utf-8",
    })
  )
  const link = document.createElement("a")
  link.href = url
  link.download = proposedPlanFilename(plan.text)
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function savePlan(
  cwd: string,
  path: string,
  plan: ProposedPlan
): Promise<string> {
  return getMako().createWorkspaceText(
    cwd,
    path.trim(),
    proposedPlanMarkdown(plan)
  )
}
