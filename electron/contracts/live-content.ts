import { z } from "zod"
import {
  AttachmentContentSchema,
  ToolDetailSchema,
  ProposedPlanSchema,
  MAX_PROPOSED_PLAN_LENGTH,
} from "@mako/sessions/content"

const plan = z.array(z.object({ content: z.string(), status: z.string() }))
export const LiveUpdateSchema = z.discriminatedUnion("kind", [
  ProposedPlanSchema.omit({ type: true }).extend({
    kind: z.literal("proposed-plan"),
    text: z.string(),
    replace: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("user"),
    steeringFor: z.string().optional(),
    provider: z.string().optional(),
    requestId: z.string().optional(),
    contextFiles: z.array(z.string()).optional(),
    text: z.string(),
    attachments: z.array(AttachmentContentSchema).optional(),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    id: z.string().optional(),
    replace: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("thinking"),
    text: z.string(),
    id: z.string().optional(),
    replace: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("attachment"),
    attachment: AttachmentContentSchema,
  }),
  z.object({
    kind: z.literal("tool"),
    id: z.string(),
    title: z.string(),
    toolKind: z.string().optional(),
    status: z.string(),
    input: z.string().optional(),
    output: z.string().optional(),
    details: z.array(ToolDetailSchema).optional(),
    attachments: z.array(AttachmentContentSchema).optional(),
  }),
  z.object({
    kind: z.literal("tool-update"),
    id: z.string(),
    title: z.string().optional(),
    status: z.string().optional(),
    input: z.string().optional(),
    output: z.string().optional(),
    details: z.array(ToolDetailSchema).optional(),
    attachments: z.array(AttachmentContentSchema).optional(),
  }),
  z.object({ kind: z.literal("plan"), entries: plan }),
])
export type LiveUpdate = z.infer<typeof LiveUpdateSchema>
export const LiveBlockSchema = z.discriminatedUnion("type", [
  ProposedPlanSchema,
  z.object({
    type: z.literal("user"),
    steeringFor: z.string().optional(),
    provider: z.string().optional(),
    requestId: z.string().optional(),
    contextFiles: z.array(z.string()).optional(),
    text: z.string(),
    attachments: z.array(AttachmentContentSchema).optional(),
  }),
  z.object({
    type: z.literal("text"),
    text: z.string(),
    id: z.string().optional(),
  }),
  z.object({
    type: z.literal("thinking"),
    text: z.string(),
    id: z.string().optional(),
  }),
  z.object({
    type: z.literal("attachment"),
    attachment: AttachmentContentSchema,
  }),
  z.object({
    type: z.literal("tool"),
    id: z.string(),
    title: z.string(),
    toolKind: z.string().optional(),
    status: z.string(),
    input: z.string().optional(),
    output: z.string().optional(),
    details: z.array(ToolDetailSchema).optional(),
    attachments: z.array(AttachmentContentSchema).optional(),
  }),
  z.object({ type: z.literal("plan"), entries: plan }),
])
export type LiveBlock = z.infer<typeof LiveBlockSchema>

/** The host and renderer use the same pure projection. One allocation per delivered batch. */
export function reduceLiveUpdates(
  blocks: LiveBlock[],
  updates: LiveUpdate[]
): LiveBlock[] {
  if (!updates.length) return blocks
  const next = [...blocks]
  const tools = new Map<string, number>()
  let turnStart = -1
  for (let index = 0; index < next.length; index++) {
    const block = next[index]!
    if (block.type === "user" && !block.steeringFor) {
      tools.clear()
      turnStart = index
    }
    if (block.type === "tool") tools.set(block.id, index)
  }
  for (const update of updates) {
    const last = next.at(-1)
    switch (update.kind) {
      case "user": {
        if (!update.steeringFor) {
          tools.clear()
          turnStart = next.length
        }
        const user: LiveBlock = {
          type: "user",
          provider: update.provider,
          requestId: update.requestId,
          contextFiles: update.contextFiles,
          text: update.text,
          attachments: update.attachments,
        }
        if (update.steeringFor) user.steeringFor = update.steeringFor
        next.push(user)
        break
      }
      case "text":
      case "thinking": {
        const index = update.id
          ? next.findIndex(
              (block, index) =>
                index > turnStart &&
                block.type === update.kind &&
                block.id === update.id
            )
          : last?.type === update.kind
            ? next.length - 1
            : -1
        const previous = next[index]
        const text =
          previous?.type === update.kind && !update.replace
            ? previous.text + update.text
            : update.text
        const block: LiveBlock = { type: update.kind, text, id: update.id }
        if (index >= 0) next[index] = block
        else next.push(block)
        break
      }
      case "proposed-plan": {
        const index = next.findIndex(
          (block, index) =>
            index > turnStart &&
            block.type === "proposed-plan" &&
            block.id === update.id
        )
        const previous = next[index]
        const text =
          previous?.type === "proposed-plan" && !update.replace
            ? previous.text + update.text
            : update.text
        const block: LiveBlock = {
          type: "proposed-plan",
          id: update.id,
          status: update.status,
          text: text.slice(0, MAX_PROPOSED_PLAN_LENGTH),
          truncated: Boolean(
            update.truncated ||
            text.length > MAX_PROPOSED_PLAN_LENGTH ||
            (!update.replace &&
              previous?.type === "proposed-plan" &&
              previous.truncated)
          ),
        }
        if (index >= 0) next[index] = block
        else next.push(block)
        break
      }
      case "attachment":
        next.push({ type: "attachment", attachment: update.attachment })
        break
      case "tool": {
        const index = tools.get(update.id) ?? -1
        const block: LiveBlock = {
          type: "tool",
          id: update.id,
          title: update.title,
          status: update.status,
          toolKind: update.toolKind,
          input: update.input,
          output: update.output,
          details: update.details,
          attachments: update.attachments,
        }
        tools.set(update.id, index >= 0 ? index : next.length)
        if (index >= 0) next[index] = block
        else next.push(block)
        break
      }
      case "tool-update": {
        const index = tools.get(update.id) ?? -1
        const block = next[index]
        if (block?.type !== "tool") break
        next[index] = {
          ...block,
          title: update.title ?? block.title,
          status: update.status ?? block.status,
          input: update.input ?? block.input,
          output: update.output ?? block.output,
          details: update.details ?? block.details,
          attachments: update.attachments ?? block.attachments,
        }
        break
      }
      case "plan": {
        const index = next.findIndex(
          (block, index) => index > turnStart && block.type === "plan"
        )
        const block: LiveBlock = { type: "plan", entries: update.entries }
        if (index >= 0) next[index] = block
        else next.push(block)
        break
      }
    }
  }
  return next
}
