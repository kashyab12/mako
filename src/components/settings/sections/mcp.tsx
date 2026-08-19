import { McpSection } from "@/components/settings/mcp-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "mcp",
  title: "MCP servers",
  group: "Extensions",
  keywords: [
    "mcp",
    "server",
    "tools",
    "external",
    "stdio",
    "http",
    "sync",
    "registry",
    "discovery",
  ],
  Component: McpSection,
} as const satisfies SettingsSection
