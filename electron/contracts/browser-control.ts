import { z } from "zod"

export const BrowserStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("connecting") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("awaiting-approval"), startedAt: z.number() }),
  z.object({ status: z.literal("connected"), generation: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
])
export type BrowserConnectionState = z.infer<typeof BrowserStateSchema>
export interface BrowserControlStatus {
  id: string
  name: string
  connection: BrowserConnectionState
}

export const BrowserTargetSchema = z
  .object({
    browser: z.string(),
    tab: z.string(),
    generation: z.string(),
    lease: z.string(),
  })
  .strict()
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>
export const BrowserFaultCodeSchema = z.enum([
  "unavailable",
  "approval-required",
  "disconnected",
  "target-closed",
  "target-busy",
  "stale-target",
  "invalid-request",
  "protocol-error",
  "cancelled",
  "timed-out",
  "outcome-unknown",
  "output-limit",
])
export const BrowserFaultSchema = z.object({
  code: BrowserFaultCodeSchema,
  message: z.string(),
  outcome: z.enum(["not-dispatched", "rejected", "unknown"]),
})
export type BrowserFaultData = z.infer<typeof BrowserFaultSchema>
export class BrowserFault extends Error {
  readonly detail: BrowserFaultData
  constructor(detail: BrowserFaultData) {
    super(detail.message)
    this.detail = detail
  }
}

export const BrowserCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("connect"), browser: z.string() }).strict(),
  z.object({ action: z.literal("tabs"), browser: z.string() }).strict(),
  z
    .object({
      action: z.literal("open"),
      browser: z.string(),
      url: z.string().default("about:blank"),
      background: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("select"),
      browser: z.string(),
      tab: z.string(),
      takeover: z.boolean().default(false),
    })
    .strict(),
  z
    .object({ action: z.literal("release"), target: BrowserTargetSchema })
    .strict(),
  z
    .object({
      action: z.literal("observe"),
      target: BrowserTargetSchema,
      maxNodes: z.number().int().min(1).max(1000).default(250),
    })
    .strict(),
  z
    .object({
      action: z.literal("screenshot"),
      target: BrowserTargetSchema,
      format: z.enum(["png", "jpeg"]).default("jpeg"),
      quality: z.number().int().min(1).max(100).default(80),
      fullPage: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal("evaluate"),
      target: BrowserTargetSchema,
      expression: z.string().min(1).max(100_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("cdp"),
      target: BrowserTargetSchema,
      method: z.string().regex(/^[A-Za-z]+\.[A-Za-z]+$/),
      params: z.record(z.string(), z.json()).default({}),
      concurrent: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("events"),
      target: BrowserTargetSchema,
      after: z.number().int().min(0).default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal("navigate"),
      target: BrowserTargetSchema,
      url: z.string(),
      waitUntil: z.enum(["load", "commit"]).optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("close"), target: BrowserTargetSchema })
    .strict(),
  z
    .object({
      action: z.literal("click"),
      target: BrowserTargetSchema,
      at: z.union([
        z.object({ ref: z.string() }).strict(),
        z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
      ]),
      button: z.enum(["left", "right", "middle"]).default("left"),
      count: z.number().int().min(1).max(3).default(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("type"),
      target: BrowserTargetSchema,
      text: z.string().max(100_000),
      ref: z.string().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("upload"),
      target: BrowserTargetSchema,
      ref: z.string(),
      files: z.array(z.string().max(4096)).max(100),
    })
    .strict(),
])
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>
