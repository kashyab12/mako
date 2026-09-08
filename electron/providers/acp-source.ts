import type { ProviderCapability } from "./registry.js"
import type {
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk"

export interface AcpTuning {
  model?: string
  effort?: string
  fast?: boolean
  options?: Record<string, string | boolean>
}

export interface AcpLaunchOptions {
  appPath: string
  execPath: string
  resume?: string
  tuning?: AcpTuning
}

export interface AcpLaunch {
  command: string
  args: string[]
  configureEnvironment(env: NodeJS.ProcessEnv): void
  notifications?: {
    permission(request: RequestPermissionRequest): void
    update(notification: SessionNotification): SessionNotification
  }
}

/** Provider-owned process launch and environment for an interactive ACP agent. */
export interface ProviderAcpSource extends ProviderCapability {
  canResume: boolean
  available(appPath: string): boolean
  launch(options: AcpLaunchOptions): Promise<AcpLaunch | null>
}
