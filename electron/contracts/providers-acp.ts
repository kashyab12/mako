export interface LiveCapability {
  provider: string
  canResume: boolean
}

export interface HarnessSelectValue {
  value: string
  label: string
  description?: string
  default?: boolean
}

export type HarnessModelOption =
  | {
      kind: "select"
      id: string
      label: string
      current?: string
      values: HarnessSelectValue[]
      presentation?: "select" | "toggle"
    }
  | {
      kind: "boolean"
      id: string
      label: string
      current: boolean
    }

export interface HarnessModelVariant {
  id: string
  label: string
  values: Record<string, string | boolean>
  contextWindow?: number
  maxOutputTokens?: number
  description?: string
}

export interface HarnessModel {
  /** Stable exact identity shown and persisted by Mako. */
  id: string
  /** Value the provider transport accepts when it differs from identity. */
  launchId?: string
  label: string
  description?: string
  aliases?: string[]
  contextWindow?: number
  maxOutputTokens?: number
  options: HarnessModelOption[]
  /** Flattened provider variants for transports that encode options in the model id. */
  variants?: HarnessModelVariant[]
}

export interface HarnessProfile {
  id: string
  label: string
  available: boolean
  transport: "acp" | "app-server" | "remote"
  models: HarnessModel[]
  defaultModel?: string
  configuredModel?: string
  capabilities: string[]
  error?: string
}

/* ------------------------------------------------------------------ */
/* Interactive foreign agents (ACP)                                    */
/* ------------------------------------------------------------------ */

export interface LiveSessionState {
  nativeRunId?: string
  connection: "starting" | "connected" | "disconnected"
  id: string
  nativeId?: string
  harness: string
  cwd: string
  title?: string
  status: "starting" | "ready" | "running" | "failed" | "closed"
  modes: Array<{ id: string; name: string }>
  currentMode: string | null
  configOptions: HarnessModelOption[]
  lastStop?: string
  error?: string
}

/** One streamed piece of an interactive turn, reduced for rendering. */
export type { LiveUpdate } from "./live-content.js"

export interface PromptAttachment {
  name: string
  mimeType: string
  size: number
  data?: string
  path?: string
}

export interface LiveInputQuestion {
  id: string
  header: string
  question: string
  isSecret: boolean
  allowOther: boolean
  required?: boolean
  valueType?: "string" | "number" | "integer" | "boolean" | "string-array"
  options: Array<{ label: string; description: string; value?: string }>
  defaultValues?: string[]
}

export interface LivePermissionRequest {
  id: string
  sessionId: string
  title: string
  kind?: string
  options: Array<{ optionId: string; name: string; kind?: string }>
  questions?: LiveInputQuestion[]
}

export type LivePermissionResponse =
  | { kind: "choice"; optionId: string | null }
  | { kind: "answers"; answers: Record<string, string[]> }
