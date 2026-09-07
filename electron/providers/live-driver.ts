import type {
  LivePermissionResponse,
  PromptAttachment,
  LiveSessionState,
} from "../shared.js"
import type { LiveStartOptions } from "../contracts/live-conversations.js"
import type { ProviderCapability } from "./registry.js"
import type { ControlCredentials } from "../control-service.js"

export interface ConversationTools {
  url: string
  token: string
  control?: ControlCredentials
}

/** Host-only launch credentials. Never included in the renderer wire contract or journals. */
export interface ProviderStartOptions extends LiveStartOptions {
  fork?: { nativeId: string; runId: string }
  conversationTools?: ConversationTools
}

export interface ProviderLiveDriver extends ProviderCapability {
  canForkAtRun?: boolean
  canResume: boolean
  available(appPath: string): boolean
  start(cwd: string, options: ProviderStartOptions): Promise<LiveSessionState>
  prompt(
    id: string,
    text: string,
    attachments: PromptAttachment[]
  ): Promise<void>
  permission(
    id: string,
    requestId: string,
    response: LivePermissionResponse
  ): Promise<void>
  cancel(id: string): Promise<void>
  close(id: string): void
  setMode(id: string, modeId: string): Promise<void>
}
