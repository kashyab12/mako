import type { ProviderCapability } from "./registry.js"

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
}

/** Provider-owned process launch and environment for an interactive ACP agent. */
export interface ProviderAcpSource extends ProviderCapability {
  available(appPath: string): boolean
  launch(options: AcpLaunchOptions): Promise<AcpLaunch | null>
}
