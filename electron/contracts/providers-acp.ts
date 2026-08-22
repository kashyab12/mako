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

export interface AcpSessionState {
  id: string
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
export type AcpUpdate =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool"
      id: string
      title: string
      toolKind?: string
      status: string
      input?: string
    }
  | {
      kind: "tool-update"
      id: string
      title?: string
      status?: string
      input?: string
      output?: string
    }
  | { kind: "plan"; entries: Array<{ content: string; status: string }> }

export interface AcpPromptAttachment {
  name: string
  mimeType: string
  size: number
  data?: string
  path?: string
}

export interface AcpInputQuestion {
  id: string
  header: string
  question: string
  isSecret: boolean
  allowOther: boolean
  options: Array<{ label: string; description: string }>
}

export interface AcpPermissionRequest {
  id: string
  sessionId: string
  title: string
  kind?: string
  options: Array<{ optionId: string; name: string; kind?: string }>
  questions?: AcpInputQuestion[]
}

export type AcpPermissionResponse =
  | { kind: "choice"; optionId: string | null }
  | { kind: "answers"; answers: Record<string, string[]> }
