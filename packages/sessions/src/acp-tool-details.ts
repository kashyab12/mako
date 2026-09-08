import { z } from "zod"
import { ToolDetailSchema, type ToolDetail } from "./content.js"

type AcpContentValue =
  | string
  | number
  | boolean
  | null
  | AcpContentValue[]
  | { [key: string]: AcpContentValue | undefined }

const acpDetail = z.union([
  ToolDetailSchema,
  z
    .object({
      type: z.literal("diff"),
      path: z.string(),
      oldText: z.string().nullish(),
      newText: z.string(),
    })
    .transform((diff) => ({ ...diff, oldText: diff.oldText ?? null })),
])

/** Native ACP journals carry the same structured tool content as live updates. */
export function acpToolDetails(
  content: AcpContentValue | undefined
): ToolDetail[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    const parsed = acpDetail.safeParse(part)
    return parsed.success ? [parsed.data] : []
  })
}
