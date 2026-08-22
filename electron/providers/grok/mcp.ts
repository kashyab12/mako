import {
  scopedMcpWriteArgs,
  type ProviderMcpSource,
} from "../mcp-source.js"

export const grokMcpSource: ProviderMcpSource = {
  provider: "grok",
  command: () => "grok",
  userFiles: () => [],
  workspaceFiles: () => [],
  readsCli: true,
  write: { kind: "cli", scopes: "both", args: scopedMcpWriteArgs },
}
