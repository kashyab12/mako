import type { ThreadPage } from "@mako/sessions"
import type {
  LivePermissionRequest,
  PromptAttachment,
  LiveSessionState,
  LiveUpdate,
} from "./providers-acp.js"
import type { LiveBlock } from "./live-content.js"

export interface LiveStartOptions {
  initialRequest?: { id: string; text: string; attachments: PromptAttachment[] }
  conversationId: string
  resume?: string
  title?: string
  threadPath?: string
  displayPrompt?: string
  tuning?: {
    model?: string
    effort?: string
    fast?: boolean
    options?: Record<string, string | boolean>
  }
}

export interface LiveRequest {
  id: string
  text: string
  attachments: PromptAttachment[]
  status:
    | "queued"
    | "dispatching"
    | "completed"
    | "failed"
    | "uncertain"
    | "interrupted"
  error?: string
}

export interface LiveSummary {
  session: LiveSessionState
  revision: number
  threadPath?: string
  createdAt: number
}

export interface LiveSnapshot extends LiveSummary {
  blocks: LiveBlock[]
  base: ThreadPage | null
  permissions: LivePermissionRequest[]
  requests: LiveRequest[]
}

export interface LiveBatch {
  base?: ThreadPage | null
  threadPath?: string
  id: string
  revision: number
  updates: LiveUpdate[]
  session?: LiveSessionState
  permissions?: LivePermissionRequest[]
  requests?: LiveRequest[]
}

export type LiveDriverEvent =
  | { type: "acp-session"; session: LiveSessionState }
  | { type: "acp-update"; id: string; update: LiveUpdate }
  | { type: "acp-updates"; id: string; updates: LiveUpdate[] }
  | { type: "acp-permission"; request: LivePermissionRequest }
