import type { McpServer } from "@agentclientprotocol/sdk"
import { projectRuntimeDefinitions } from "./mcp-registry.js"
import type {
  McpProvider,
  McpRegistrySnapshot,
  McpServerDefinition,
  McpTransport,
} from "./shared.js"
import type { JsonObject } from "./codex-app-json.js"

function localEnvironment(definition: McpServerDefinition): Array<{
  name: string
  value: string
}> {
  return definition.name === "mako-local-tools"
    ? [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }]
    : []
}

export function acpMcpServers(
  snapshot: McpRegistrySnapshot,
  provider: Exclude<McpProvider, "mako">,
  transports: readonly McpTransport[]
): McpServer[] {
  return projectRuntimeDefinitions(snapshot, provider, transports).flatMap(
    (definition): McpServer[] => {
      if (definition.transport === "stdio" && definition.command) {
        return [
          {
            name: definition.name,
            command: definition.command,
            args: definition.args ?? [],
            env: localEnvironment(definition),
          },
        ]
      }
      if (
        (definition.transport === "http" || definition.transport === "sse") &&
        definition.url &&
        definition.headerNames.length === 0
      ) {
        return [
          {
            type: definition.transport,
            name: definition.name,
            url: definition.url,
            headers: [],
          },
        ]
      }
      return []
    }
  )
}

function codexDefinition(definition: McpServerDefinition): JsonObject | null {
  if (definition.transport === "stdio" && definition.command) {
    const result: JsonObject = {
      command: definition.command,
      args: definition.args ?? [],
    }
    if (definition.name === "mako-local-tools")
      result.env = { ELECTRON_RUN_AS_NODE: "1" }
    return result
  }
  if (
    definition.transport === "http" &&
    definition.url &&
    definition.headerNames.length === 0
  ) {
    return { url: definition.url }
  }
  return null
}

export function codexMcpConfig(snapshot: McpRegistrySnapshot): JsonObject {
  const servers: JsonObject = {}
  for (const definition of projectRuntimeDefinitions(snapshot, "codex", [
    "stdio",
    "http",
  ])) {
    const projected = codexDefinition(definition)
    if (projected) servers[definition.name] = projected
  }
  return Object.keys(servers).length > 0 ? { mcp_servers: servers } : {}
}

export function mergeCodexConfig(
  base: JsonObject | undefined,
  injected: JsonObject
): JsonObject | undefined {
  if (!base && Object.keys(injected).length === 0) return undefined
  return base ? { ...injected, ...base } : { ...injected }
}
