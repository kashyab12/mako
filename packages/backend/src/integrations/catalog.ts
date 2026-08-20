export type BackendIntegrationStatus =
  | { kind: "connected"; detail: string }
  | { kind: "available"; detail: string }
  | { kind: "planned"; detail: string }

export interface BackendIntegration {
  id: string
  label: string
  category: "communication" | "planning" | "development" | "productivity"
  capabilities: string[]
  status: BackendIntegrationStatus
}

export function integrationCatalog({
  slackConnected,
}: {
  slackConnected: boolean
}): BackendIntegration[] {
  return [
    {
      id: "slack",
      label: "Slack",
      category: "communication",
      capabilities: ["mentions", "direct messages", "threads", "approvals"],
      status: slackConnected
        ? { kind: "connected", detail: "Vercel Connect" }
        : { kind: "available", detail: "Connect Slack through Vercel Connect" },
    },
    {
      id: "github",
      label: "GitHub",
      category: "development",
      capabilities: ["repositories", "issues", "pull requests", "checks"],
      status: { kind: "planned", detail: "Connector not provisioned" },
    },
    {
      id: "linear",
      label: "Linear",
      category: "planning",
      capabilities: ["issues", "projects", "cycles", "comments"],
      status: { kind: "planned", detail: "Connector not provisioned" },
    },
    {
      id: "google-workspace",
      label: "Google Workspace",
      category: "productivity",
      capabilities: ["Gmail", "Calendar", "Drive", "Docs", "Sheets"],
      status: { kind: "planned", detail: "Connector not provisioned" },
    },
  ]
}
