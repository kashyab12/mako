import { z } from "zod"

export const PromptAttachmentSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  size: z.number().nonnegative(),
  data: z.string().optional(),
  path: z.string().optional(),
})
export const ProviderSelectionSchema = z.object({
  model: z.string().optional(),
  effort: z.string().optional(),
  fast: z.boolean().optional(),
  options: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
})
export const TransferInputSchema = z.object({
  id: z.string().uuid(),
  provider: z.string().min(1),
  text: z.string().max(1_000_000),
  attachments: z.array(PromptAttachmentSchema).max(100),
  tuning: ProviderSelectionSchema.optional(),
})
export type TransferInput = z.infer<typeof TransferInputSchema>
export const ProviderBindingSchema = z.object({
  checkpoint: z.string().optional(),
  id: z.string().uuid(),
  provider: z.string(),
  nativeId: z.string().optional(),
  path: z.string().optional(),
  tuning: ProviderSelectionSchema.optional(),
  coveredBlocks: z.number().int().nonnegative(),
  includesBase: z.boolean(),
})
export type ProviderBinding = z.infer<typeof ProviderBindingSchema>
export const ContextManifestSchema = z.object({
  file: z.string(),
  resources: z.array(z.string()).optional(),
  digest: z.string(),
  sourceRevision: z.number().int().nonnegative(),
  fromBlock: z.number().int().nonnegative(),
  toBlock: z.number().int().nonnegative(),
  includesBase: z.boolean(),
  losses: z.array(z.string()),
})
export type ContextManifest = z.infer<typeof ContextManifestSchema>
export const TransferStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queued") }),
  z.object({ kind: z.literal("preparing") }),
  z.object({
    kind: z.literal("accepted"),
    bindingId: z.string().uuid(),
    manifest: ContextManifestSchema,
  }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
  z.object({ kind: z.literal("uncertain"), error: z.string() }),
])
export const ContextTransferSchema = z.object({
  inputDigest: z.string().optional(),
  input: TransferInputSchema,
  createdAt: z.number(),
  state: TransferStateSchema,
})
export type ContextTransfer = z.infer<typeof ContextTransferSchema>
export const ChildWorkspaceSchema = z.object({
  kind: z.enum(["git-worktree", "copy"]),
  path: z.string(),
  source: z.string(),
  revision: z.string().optional(),
})
export const ChildTaskSchema = z.object({
  id: z.string().uuid(),
  parentRequestId: z.string().uuid(),
  workspace: ChildWorkspaceSchema.optional(),
  provider: z.string(),
  task: z.string(),
  status: z.enum([
    "starting",
    "working",
    "needs-permission",
    "completed",
    "failed",
    "canceled",
  ]),
  delivery: z.enum(["pending", "queued", "delivered", "dismissed"]),
  deliveryId: z.string().uuid(),
})
export type ChildTask = z.infer<typeof ChildTaskSchema>
export const DelegateInputSchema = z.object({
  id: z.string().uuid(),
  provider: z.string().min(1),
  task: z.string().min(1).max(100_000),
})
export type DelegateInput = z.infer<typeof DelegateInputSchema>
export const ConversationControlSchema = z.object({
  merges: z
    .array(
      z.object({
        id: z.string().uuid(),
        sourceId: z.string().uuid(),
        sourceRevision: z.number(),
        manifest: ContextManifestSchema,
        status: z.enum(["pending", "consumed"]),
      })
    )
    .default([]),
  children: z.array(ChildTaskSchema).default([]),
  ancestry: z
    .object({
      kind: z.enum(["fork", "delegation"]),
      nativeFork: z
        .object({
          provider: z.string(),
          nativeId: z.string(),
          runId: z.string(),
        })
        .optional(),
      provider: z.string().optional(),
      parentId: z.string().uuid(),
      sourceRevision: z.number().int().nonnegative(),
      point: z.string(),
    })
    .optional(),
  activeBindingId: z.string().uuid(),
  bindings: z.array(ProviderBindingSchema),
  transfers: z.array(ContextTransferSchema),
})
export type ConversationControl = z.infer<typeof ConversationControlSchema>

export const ForkInputSchema = z.object({
  id: z.string().uuid(),
  provider: z.string().min(1),
  point: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("run"), requestId: z.string().uuid() }),
    z.object({
      kind: z.literal("native"),
      index: z.number().int().nonnegative(),
      revision: z.string(),
    }),
  ]),
})
export type ForkInput = z.infer<typeof ForkInputSchema>
