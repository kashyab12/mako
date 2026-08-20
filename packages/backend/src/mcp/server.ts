import type { McpServer } from "@modelcontextprotocol/server"
import { createMcpHandler, withMcpAuth } from "mcp-handler"
import { verifyMcpToken } from "./auth"
import { registerSkillResources } from "./resources"
import { registerIntegrationsTool } from "./tools/integrations"
import { registerSkillTools } from "./tools/skills"
import { registerSlackTools } from "./tools/slack"
import { registerStatusTool } from "./tools/status"

function registerTools(server: McpServer): void {
  registerStatusTool(server)
  registerIntegrationsTool(server)
  registerSkillTools(server)
  registerSlackTools(server)
  registerSkillResources(server)
}

const handler = createMcpHandler(registerTools, {
  serverInfo: {
    name: "mako-backend",
    version: "0.1.0",
  },
  instructions:
    "Use Mako backend tools to discover trusted skills and integration state. Never request or expose connector credentials.",
  onEvent(event) {
    if (event.type === "REQUEST_COMPLETED") {
      console.info("mcp_request_completed", {
        duration: event.duration,
        method: event.method,
        status: event.status,
      })
    }
    if (event.type === "ERROR") {
      console.error("mcp_request_error", {
        context: event.context,
        severity: event.severity,
        source: event.source,
      })
    }
  },
})

export const makoMcpHandler = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  requiredScopes: ["mako:read"],
})
