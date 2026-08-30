/* ------------------------------------------------------------------ */
/* MCP servers                                                         */
/* ------------------------------------------------------------------ */

export interface ToolSummary {
  name: string
  description?: string
  active: boolean
  source?: string
}

export interface CommandSummary {
  name: string
  description?: string
  source?: string
}

export interface SkillSummary {
  name: string
  description: string
  source?: string
}

export type SkillProvider = McpProvider | "agents"
export type SkillScope = "user" | "workspace"

export interface SkillOrigin {
  provider: SkillProvider
  account: string
  scope: SkillScope
  provenance: string
}

export interface SkillRecord {
  id: string
  name: string
  description: string
  hash: string
  bytes: number
  files: number
  portable: boolean
  origins: SkillOrigin[]
  license?: string
  compatibility?: string
  allowedTools?: string[]
  blockReason?: string
  conflict?: "name" | "drift"
}

export interface SkillProviderStatus {
  id: Exclude<SkillProvider, "agents">
  label: string
  account: string
  available: boolean
}

export interface SkillRegistrySnapshot {
  cwd: string
  generatedAt: number
  skills: SkillRecord[]
  providers: SkillProviderStatus[]
}

export interface SkillSyncTarget {
  provider: Exclude<SkillProvider, "agents">
  account: string
  scope: SkillScope
}

export interface SkillSyncPreview {
  skillId: string
  target: SkillSyncTarget
  action: "add" | "replace" | "remove" | "unchanged" | "blocked"
  summary: string
  blockReason?: string
}

export interface Capabilities {
  tools: ToolSummary[]
  commands: CommandSummary[]
  skills: SkillSummary[]
}

/** Open provider id; MCP-capable harnesses register at host composition. */
export type McpProvider = string & {}
export type McpTransport = "stdio" | "http" | "sse"
export type McpScope = "user" | "workspace" | "effective" | "managed"

export interface McpRegistryProviderStatus {
  id: McpProvider
  label: string
  account: string
  available: boolean
  source: string
  detail?: string
}

export interface McpServerDefinition {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  envNames: string[]
  headerNames: string[]
  portable: boolean
  blockReason?: string
}

export interface McpServerOrigin {
  provider: McpProvider | "mako"
  account: string
  scope: McpScope
  provenance: string
}

export interface McpServerRecord extends McpServerDefinition {
  id: string
  origins: McpServerOrigin[]
  conflict?: "name" | "drift"
  availability?: "available" | "unavailable" | "unknown"
  detail?: string
  managed?: boolean
}

export interface McpRegistrySnapshot {
  cwd: string
  generatedAt: number
  servers: McpServerRecord[]
  providers: McpRegistryProviderStatus[]
}

export interface MakoComputerPermissions {
  supported: boolean
  persistentAcrossUpdates: boolean
  accessibility: boolean
  screenRecording: "not-determined" | "denied" | "restricted" | "granted" | "unknown"
}

export type IntegrationCategory =
  | "Communication"
  | "Planning"
  | "Development"
  | "Productivity"
  | "Local"

export type IntegrationConnection =
  | { kind: "connected"; detail: string; providers: McpProvider[] }
  | { kind: "ready"; detail: string }
  | { kind: "needs-permission"; detail: string }
  | { kind: "setup"; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "conflict"; detail: string }

export interface IntegrationRecord {
  id: string
  label: string
  description: string
  category: IntegrationCategory
  trust: "official" | "mako" | "community"
  auth:
    | "provider-oauth"
    | "provider-cli"
    | "local-browser"
    | "local-permission"
    | "mako-backend"
  capabilities: string[]
  events: string[]
  connection: IntegrationConnection
  setupUrl?: string
}

export interface IntegrationCatalogSnapshot {
  generatedAt: number
  integrations: IntegrationRecord[]
}

export interface McpSyncTarget {
  provider: McpProvider
  account: string
  scope: "user" | "workspace"
}

export interface McpSyncPreview {
  serverId: string
  target: McpSyncTarget
  action: "add" | "replace" | "unchanged" | "blocked"
  summary: string
  blockReason?: string
}
