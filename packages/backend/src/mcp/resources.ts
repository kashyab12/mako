import type { McpServer } from "@modelcontextprotocol/server"
import { listSkills, readSkill } from "../skills/catalog"

export function registerSkillResources(server: McpServer): void {
  server.registerResource(
    "mako-skills-index",
    "mako://skills",
    {
      title: "Mako skills",
      description: "Index of trusted skills published by the Mako backend.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "mako://skills",
          mimeType: "application/json",
          text: JSON.stringify(listSkills(), null, 2),
        },
      ],
    })
  )

  server.registerResource(
    "mako-operations-skill",
    "mako://skills/mako-operations",
    {
      title: "Mako operations skill",
      description:
        "Trusted procedures for Mako coordination, MCP, Slack, and approvals.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "mako://skills/mako-operations",
          mimeType: "text/markdown",
          text: await readSkill("mako-operations"),
        },
      ],
    })
  )
}
