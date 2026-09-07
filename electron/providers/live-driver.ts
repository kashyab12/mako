import type {
  LivePermissionResponse,
  PromptAttachment,
  LiveSessionState,
} from "../shared.js"
import type { LiveStartOptions } from "../contracts/live-conversations.js"
import type { ProviderCapability } from "./registry.js"

export interface ProviderLiveDriver extends ProviderCapability {
  canResume: boolean
  available(appPath: string): boolean
  start(cwd: string, options: LiveStartOptions): Promise<LiveSessionState>
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
