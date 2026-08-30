import { integrationCatalog } from "./integrations/catalog"
import type { ServerEnv } from "./config/env"

export interface BackendStatus {
  service: "mako-backend"
  version: string
  environment: "development" | "preview" | "production"
  commit: string | null
  mcp: {
    protocol: "streamable-http"
    endpoint: "/api/mcp"
    authenticated: true
  }
  integrations: ReturnType<typeof integrationCatalog>
  relay: {
    execution: "local-harness"
    persistence: "azure-storage"
    offlineQueue: true
  }
}

export function backendStatus(environment: Partial<ServerEnv>): BackendStatus {
  return {
    service: "mako-backend",
    version: "0.1.0",
    environment: environment.VERCEL_ENV ?? "development",
    commit: environment.VERCEL_GIT_COMMIT_SHA ?? null,
    mcp: {
      protocol: "streamable-http",
      endpoint: "/api/mcp",
      authenticated: true,
    },
    integrations: integrationCatalog({
      slackConnected: Boolean(
        environment.SLACK_CONNECTOR || environment.SLACK_BOT_TOKEN
      ),
    }),
    relay: {
      execution: "local-harness",
      persistence: "azure-storage",
      offlineQueue: true,
    },
  }
}
