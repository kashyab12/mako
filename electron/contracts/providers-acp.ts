export interface LiveCapability {
  provider: string
  canResume: boolean
  observesNativeAgents?: boolean
  canSteer?: boolean
  canCompact?: boolean
}

import type { SessionModel, SessionSettings } from "@mako/sessions/settings"
export type {
  ModelChoice as HarnessSelectValue,
  ModelOption as HarnessModelOption,
  ModelVariant as HarnessModelVariant,
  SessionModel as HarnessModel,
} from "@mako/sessions/settings"

export interface HarnessProfile {
  id: string
  label: string
  available: boolean
  transport: "acp" | "app-server" | "sdk" | "remote"
  models: SessionModel[]
  defaultModel?: string
  configuredModel?: string
  /** Provider-resolved defaults in the requested workspace. Never saved as user choices. */
  settings?: SessionSettings
  configurationError?: string
  capabilities: string[]
  error?: string
  /** Discovery is still running; nothing here is known yet. */
  pending?: boolean
}

/* ------------------------------------------------------------------ */
/* Interactive foreign agents (ACP)                                    */
/* ------------------------------------------------------------------ */

export interface LiveSessionState {
  nativeRunId?: string
  nativeForkId?: string
  nativePath?: string
  connection: "starting" | "connected" | "disconnected"
  id: string
  nativeId?: string
  harness: string
  cwd: string
  title?: string
  status: "starting" | "ready" | "running" | "failed" | "closed"
  modes: Array<{ id: string; name: string }>
  currentMode: string | null
  configOptions: import("@mako/sessions/settings").ModelOption[]
  settings?: SessionSettings
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
