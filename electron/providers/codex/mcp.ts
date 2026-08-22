import type { ProviderMcpSource } from "../mcp-source.js"

export const codexMcpSource: ProviderMcpSource = {
  provider: "codex",
  command: () => "codex",
  userFiles: () => [],
  workspaceFiles: () => [],
  readsCli: true,
  write: {
    kind: "cli",
    args(definition, _scope, environment) {
      if (definition.transport === "stdio") {
        const envArgs = Object.entries(environment).flatMap(([name, value]) => [
          "--env",
          `${name}=${value}`,
        ])
        return [
          "mcp",
          "add",
          ...envArgs,
          definition.name,
          "--",
          definition.command ?? "",
          ...(definition.args ?? []),
        ]
      }
      return ["mcp", "add", definition.name, "--url", definition.url ?? ""]
    },
  },
}
