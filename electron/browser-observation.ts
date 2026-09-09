import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { BrowserTarget } from "./contracts/browser-control.js"
import type { JsonValue } from "./codex-app-json.js"

const accessibilityText = z
  .union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.json()).transform((value) => JSON.stringify(value)),
    z.record(z.string(), z.json()).transform((value) => JSON.stringify(value)),
  ])
  .transform((value) => String(value))
  .nullish()

export const AccessibilityNodeSchema = z.object({
  nodeId: z.string(),
  parentId: z.string().optional(),
  ignored: z.boolean(),
  backendDOMNodeId: z.number().optional(),
  role: z.object({ value: accessibilityText }).optional(),
  name: z.object({ value: accessibilityText }).optional(),
  value: z.object({ value: accessibilityText }).optional(),
})
const ObservationInfoSchema = z.object({
  targetInfo: z.object({
    targetId: z.string(),
    type: z.string(),
    title: z.string(),
    url: z.string(),
  }),
})

/** Bound the serialized result, not just node count: page-controlled names can
 * contain entire documents. Keep usable refs and explicitly report omissions. */
export function browserObservation(input: {
  target: BrowserTarget
  info: JsonValue
  nodes: z.infer<typeof AccessibilityNodeSchema>[]
  maxNodes: number
}) {
  let truncatedTextFields = 0
  function text(
    value: string | null | undefined,
    limit: number
  ): string | null {
    if (value === undefined || value === null) return null
    const source = value
    if (source.length <= limit) return source
    truncatedTextFields++
    return source.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "") + "…"
  }
  const sourceInfo = ObservationInfoSchema.parse(input.info).targetInfo
  const info = {
    targetInfo: {
      ...sourceInfo,
      title: text(sourceInfo.title, 500),
      url: text(sourceInfo.url, 2048),
    },
  }
  const visible = input.nodes.filter((node) => !node.ignored)
  const refs = new Map<string, number>()
  const nodes: {
    id: string
    parent: string | null
    ref: string | null
    role: JsonValue
    name: JsonValue
    value: JsonValue
  }[] = []
  // Leave room for counters, separators and protocol metadata in the final JSON.
  let bytes =
    Buffer.byteLength(JSON.stringify({ target: input.target, info })) + 256
  for (const node of visible.slice(0, input.maxNodes)) {
    const ref = node.backendDOMNodeId ? randomUUID() : null
    const row = {
      id: node.nodeId,
      parent: node.parentId ?? null,
      ref,
      role: text(node.role?.value, 100),
      name: text(node.name?.value, 500),
      value: text(node.value?.value, 1000),
    }
    const size = Buffer.byteLength(JSON.stringify(row)) + 1
    if (bytes + size > 60_000) break
    bytes += size
    nodes.push(row)
    if (ref && node.backendDOMNodeId) refs.set(ref, node.backendDOMNodeId)
  }
  return {
    refs,
    value: {
      target: { ...input.target },
      info,
      nodes,
      omitted: visible.length - nodes.length,
      truncatedTextFields,
    },
  }
}
