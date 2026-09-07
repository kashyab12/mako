import type {
  PromptAttachment,
  LiveSnapshot,
  LiveBatch,
  LiveSessionState,
  LiveStartOptions,
  HostEvent,
} from "./shared.js"
import type { ThreadPage } from "@mako/sessions"
import type {
  ProviderBinding,
  ContextTransfer,
  ConversationControl,
} from "./contracts/conversation-control.js"
import type {
  ProviderLiveDriver,
  ConversationTools,
} from "./providers/live-driver.js"
import type { LiveJournal } from "./live-journal.js"
export interface ProviderConnection {
  driver: ProviderLiveDriver
  session: LiveSessionState
}

export interface Resident {
  connections: Map<string, ProviderConnection>
  transferring: boolean
  snapshot: LiveSnapshot
  journalSnapshot?: LiveSnapshot
  journal: LiveJournal
  driver: ProviderLiveDriver | null
  storageFault?: boolean
  generation: number
  opening: boolean
  pendingCharacters: number
  updates: LiveBatch["updates"]
  timer: ReturnType<typeof setTimeout> | null
  displayPrompt?: string
}

export interface Dependencies {
  appPath: string
  tools?(
    bindingId: string,
    conversationId: string
  ): ConversationTools | undefined
  providers?(): string[]
  root: string
  checkpoint?(path: string): Promise<string | undefined>
  canResume?(binding: ProviderBinding): Promise<boolean>
  driver(provider: string): ProviderLiveDriver | undefined
  history(path: string, before?: number): Promise<ThreadPage | null>
  emit(event: HostEvent): void
}

export interface LiveAccess {
  retainAttachments(attachments: PromptAttachment[]): PromptAttachment[]
  dependencies: Dependencies
  bindingOwners: Map<string, string>
  require(id: string): Resident
  load(id: string): Resident | undefined
  control(resident: Resident): ConversationControl
  flush(resident: Resident): void
  drain(resident: Resident): void
  close(id: string): void
  pending(resident: Resident): ContextTransfer | undefined
  storageFailed(resident: Resident, boundary: FailureBoundary): void
  open(
    provider: string,
    cwd: string,
    options: LiveStartOptions,
    ancestry?: ConversationControl["ancestry"]
  ): Promise<LiveSessionState>
}

export interface FailureBoundary {
  error: unknown
}
export function errorMessage({ error }: FailureBoundary): string {
  return error instanceof Error ? error.message : String(error)
}
