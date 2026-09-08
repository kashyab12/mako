import { z } from "zod"
import type { ToolDetail } from "./content.js"

const TodoPayload = z.object({todos: z.array(z.object({content: z.string(), status: z.string()}))})
const CodexPlanPayload = z.object({plan: z.array(z.object({step: z.string(), status: z.string()}))})

export function todoDetails(input: string | undefined): ToolDetail[] | undefined {
  if (!input) return undefined
  try {
    const payload = TodoPayload.safeParse(JSON.parse(input))
    return payload.success ? [{type: "plan", entries: payload.data.todos}] : undefined
  } catch { return undefined }
}

export function codexPlanDetails(input: string | undefined): ToolDetail[] | undefined {
  if (!input) return undefined
  try {
    const payload = CodexPlanPayload.safeParse(JSON.parse(input))
    return payload.success ? [{type: "plan", entries: payload.data.plan.map((entry) => ({content: entry.step, status: entry.status}))}] : undefined
  } catch { return undefined }
}
