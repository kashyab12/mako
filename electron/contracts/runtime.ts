import { z } from "zod"

export const RuntimeCallSchema = z.object({
  channel: z.string().regex(/^mako:[a-z0-9-]+$/),
  args: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("absent") }),
    z.object({ kind: z.literal("value"), value: z.json() }),
  ])).max(32),
}).strict()
export type RuntimeCall = z.infer<typeof RuntimeCallSchema>
export const RUNTIME_PROTOCOL = 1
export const RuntimeInfoSchema = z.object({
  protocol: z.literal(RUNTIME_PROTOCOL),
  instanceId: z.string().uuid(),
  pid: z.number().int().positive(),
  version: z.string(),
  methods: z.array(z.string()),
})
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>
export const RuntimePacketSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("ready"), runtime: RuntimeInfoSchema.optional() }),
  z.object({ channel: z.literal("event"), payload: z.json() }),
  z.object({ channel: z.literal("terminal"), payload: z.json() }),
])
export const RuntimeReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
