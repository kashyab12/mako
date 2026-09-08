import type { SessionSettings } from "@mako/sessions/settings"
import type {
  ContextManifest,
  ConversationControl,
} from "./conversation-control.js"
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
  tuning?: SessionSettings
}

export interface LiveRequest {
  tuning?: SessionSettings
  inputDigest?: string
  nativeRun?: { bindingId: string; runId: string }
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
  displayText?: string
  context?: ContextManifest[]
}

export interface LiveSummary {
  nativePaths?: string[]
  session: LiveSessionState
  revision: number
  threadPath?: string
  createdAt: number
}

export interface LiveSnapshot extends LiveSummary {
  control?: ConversationControl
  blocks: LiveBlock[]
  base: ThreadPage | null
  permissions: LivePermissionRequest[]
  requests: LiveRequest[]
}

export interface LiveBatch {
  control?: ConversationControl
  base?: ThreadPage | null
  threadPath?: string | null
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
