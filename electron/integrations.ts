import type { BackendConnectionStatus } from "./backend-connection.js"
import type {
  IntegrationCatalogSnapshot,
  IntegrationCategory,
  IntegrationConnection,
  IntegrationRecord,
  MakoComputerPermissions,
  McpProvider,
  McpRegistrySnapshot,
  McpServerRecord,
} from "./shared.js"

interface Definition {
  id: string
  label: string
  description: string
  category: IntegrationCategory
  trust: IntegrationRecord["trust"]
  auth: IntegrationRecord["auth"]
  capabilities: string[]
  events: string[]
  patterns: RegExp[]
  setupUrl?: string
}

const DEFINITIONS: Definition[] = [
  {
    id: "linear",
    label: "Linear",
    description: "Find, create, and update issues and projects.",
    category: "Planning",
    trust: "official",
    auth: "provider-oauth",
    capabilities: ["Issues", "Projects", "Comments"],
    events: [],
    patterns: [/linear/i],
    setupUrl: "https://linear.app/docs/mcp",
  },
  {
    id: "github",
    label: "GitHub",
    description: "Work with repositories, issues, pull requests, and actions.",
    category: "Development",
    trust: "official",
    auth: "provider-cli",
    capabilities: ["Repositories", "Issues", "Pull requests", "Actions"],
    events: [],
    patterns: [/github/i],
    setupUrl: "https://github.com/github/github-mcp-server",
  },
  {
    id: "slack",
    label: "Slack",
    description: "Read and send messages through Mako’s Vercel Connect backend.",
    category: "Communication",
    trust: "mako",
    auth: "mako-backend",
    capabilities: ["Channels", "Messages", "Threads", "Send"],
    events: [],
    patterns: [/slack/i],
  },
  {
    id: "notion",
    label: "Notion",
    description: "Read and update pages, databases, and comments.",
    category: "Productivity",
    trust: "official",
    auth: "provider-oauth",
    capabilities: ["Pages", "Databases", "Comments"],
    events: [],
    patterns: [/notion/i],
  },
  {
    id: "teams",
    label: "Microsoft Teams",
    description: "Read channels and work with team conversations.",
    category: "Communication",
    trust: "official",
    auth: "provider-oauth",
    capabilities: ["Channels", "Messages", "Members"],
    events: [],
    patterns: [/teams|microsoft.*graph/i],
  },
  {
    id: "sentry",
    label: "Sentry",
    description: "Investigate issues, events, releases, and traces.",
    category: "Development",
    trust: "official",
    auth: "provider-oauth",
    capabilities: ["Issues", "Events", "Releases", "Traces"],
    events: [],
    patterns: [/sentry/i],
  },
  {
    id: "google",
    label: "Google Workspace",
    description: "Use signed-in Google apps through a local browser session.",
    category: "Productivity",
    trust: "official",
    auth: "local-browser",
    capabilities: ["Gmail", "Calendar", "Drive", "Docs", "Sheets"],
    events: [],
    patterns: [/gmail|google|gdrive|calendar/i],
  },
  {
    id: "atlassian",
    label: "Atlassian",
    description: "Search and update Jira, Confluence, and Bitbucket.",
    category: "Planning",
    trust: "official",
    auth: "provider-oauth",
    capabilities: ["Jira", "Confluence", "Bitbucket"],
    events: [],
    patterns: [/atlassian|jira|confluence/i],
    setupUrl: "https://www.atlassian.com/platform/remote-mcp-server",
  },
]

function haystack(server: McpServerRecord): string {
  return [server.name, server.url, server.command].filter(Boolean).join(" ")
}

function providers(servers: McpServerRecord[]): McpProvider[] {
  return [
    ...new Set(
      servers.flatMap((server) =>
        server.origins.flatMap((origin) =>
          origin.provider === "mako" ? [] : [origin.provider]
        )
      )
    ),
  ].sort()
}

function serviceConnection(
  definition: Definition,
  servers: McpServerRecord[],
  githubConnected: boolean
): IntegrationConnection {
  const matches = servers.filter((server) =>
    definition.patterns.some((pattern) => pattern.test(haystack(server)))
  )
  if (matches.some((server) => server.conflict)) {
    return {
      kind: "conflict",
      detail: "Conflicting MCP definitions need review",
    }
  }
  const connected = providers(matches)
  if (connected.length > 0) {
    return {
      kind: "connected",
      detail: connected.join(", "),
      providers: connected,
    }
  }
  if (definition.id === "github" && githubConnected) {
    return { kind: "ready", detail: "Signed in with GitHub CLI" }
  }
  return {
    kind: "setup",
    detail: "Connect through an agent’s provider-owned sign-in",
  }
}

function localBrowserConnection(
  server: McpServerRecord | undefined
): IntegrationConnection {
  if (!server || server.availability === "unavailable") {
    return {
      kind: "unavailable",
      detail: server?.detail ?? "Local browser control is not installed",
    }
  }
  return { kind: "ready", detail: "Isolated and running on this Mac" }
}

function localConnection(
  server: McpServerRecord | undefined,
  permissions: MakoComputerPermissions
): IntegrationConnection {
  if (!server || server.availability === "unavailable") {
    return {
      kind: "unavailable",
      detail: server?.detail ?? "Local control is not installed",
    }
  }
  if (
    !permissions.accessibility ||
    permissions.screenRecording !== "granted"
  ) {
    return {
      kind: "needs-permission",
      detail: "Grant Accessibility and Screen Recording",
    }
  }
  return {
    kind: "ready",
    detail: "Runs locally under Mako permissions",
  }
}

function backendConnection(
  status: BackendConnectionStatus
): IntegrationConnection {
  if (status.kind === "connected") {
    return {
      kind: "ready",
      detail: `${status.environment} · ${status.version}`,
    }
  }
  if (status.kind === "missing-token") {
    return { kind: "setup", detail: "Backend access is not paired" }
  }
  return { kind: "unavailable", detail: status.detail }
}

export function integrationCatalog(
  snapshot: McpRegistrySnapshot,
  permissions: MakoComputerPermissions,
  githubConnected: boolean,
  backendStatus: BackendConnectionStatus
): IntegrationCatalogSnapshot {
  const localControl = snapshot.servers.find(
    (server) => server.name === "mako-local-control"
  )
  const services: IntegrationRecord[] = DEFINITIONS.map((definition) => ({
    ...definition,
    connection:
      definition.auth === "mako-backend"
        ? backendConnection(backendStatus)
        : definition.auth === "local-browser"
          ? localBrowserConnection(localControl)
          : serviceConnection(definition, snapshot.servers, githubConnected),
  }))
  const local: IntegrationRecord[] = [
    {
      id: "mako-backend",
      label: "Mako Backend",
      description: "Remote MCP, skills, integrations, and communication channels.",
      category: "Development",
      trust: "mako",
      auth: "mako-backend",
      capabilities: ["MCP", "Skills", "Slack", "Durable agent"],
      events: [],
      connection: backendConnection(backendStatus),
    },
    {
      id: "local-browser",
      label: "Mako Browser",
      description: "An isolated browser that runs only on this Mac.",
      category: "Local",
      trust: "mako",
      auth: "local-permission",
      capabilities: ["Isolated profile", "Inspect", "Interact", "Capture"],
      events: [],
      connection: localBrowserConnection(localControl),
    },
    {
      id: "computer-use",
      label: "Computer use",
      description: "Operate local applications without moving your pointer.",
      category: "Local",
      trust: "mako",
      auth: "local-permission",
      capabilities: ["Read UI", "Click", "Type", "Capture"],
      events: [],
      connection: localConnection(localControl, permissions),
    },
    {
      id: "apple-mail",
      label: "Apple Mail",
      description: "Use Mail through Mako’s local application controls.",
      category: "Local",
      trust: "mako",
      auth: "local-permission",
      capabilities: ["Read UI", "Draft", "App automation"],
      events: [],
      connection: localConnection(localControl, permissions),
    },
    {
      id: "apple-messages",
      label: "Apple Messages",
      description: "Use Messages through Mako’s local application controls.",
      category: "Local",
      trust: "mako",
      auth: "local-permission",
      capabilities: ["Read UI", "Draft", "App automation"],
      events: [],
      connection: localConnection(localControl, permissions),
    },
  ]
  return {
    generatedAt: Date.now(),
    integrations: [...services, ...local],
  }
}
