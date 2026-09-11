import {
  MAKO_CONVERSATIONS_SERVER,
  MAKO_RUNTIME_SERVERS,
  isMakoManagedServer,
  reachableMcpServers,
} from "../../electron/contracts/mcp-reach"
import { fuzzy } from "./fuzzy"
import type {
  McpRegistrySnapshot,
  McpServerRecord,
  McpTransport,
  SkillRecord,
  SkillRegistrySnapshot,
} from "./types"

/**
 * What the composer offers behind `/` and `$`: the skills and MCP servers the
 * selected provider will actually have when it answers. Skills come from that
 * provider's own roots plus the universal `.agents/skills` roots; servers come
 * from the same reach predicate the host projects into a launch. Everything
 * else lives in Settings, where syncing it is a deliberate act.
 */

export type CapabilityKind = "skill" | "mcp"

export interface CapabilityItem {
  kind: CapabilityKind
  name: string
  description: string
  /** Mako ships it; it wears the fin instead of a generic glyph. */
  builtIn: boolean
  /** Short provenance, shown only when it says something the name does not. */
  badge?: string
  /** Provider id whose portable configuration the host projects into this launch. */
  from?: string
  /** Set when the provider cannot use it as-is; the row is still listed, but dim. */
  blocked?: string
}

export interface CapabilityMatch {
  item: CapabilityItem
  /** Positions in `item.name` the query matched, for highlighting. */
  indices: number[]
}

export interface CapabilityGroup {
  kind: CapabilityKind
  label: string
  matches: CapabilityMatch[]
  /** How many the provider has in all; larger than `matches` when the browse list is capped. */
  total: number
}

export interface CapabilityCatalog {
  groups: CapabilityGroup[]
  /** Skills installed for other providers only; a hint towards Settings. */
  elsewhere: number
}

export interface SkillReach {
  items: CapabilityItem[]
  /** Skills installed for other providers only. */
  elsewhere: number
}

const UNIVERSAL_PROVIDER = "agents"

/** Product copy for Mako's own servers; the registry's detail is operational. */
const BUILT_IN_DESCRIPTIONS = new Map<string, string>([
  ["mako-backend", "Mako skills, integrations, and Slack"],
  ["mako-browser-use", "Drive a browser tab Mako controls"],
  ["mako-local-control", "Native apps, windows, and input on this Mac"],
  ["mako-local-tools", "macOS app control through the local harness"],
  [MAKO_CONVERSATIONS_SERVER, "Delegate bounded tasks to other agents"],
])

export function isMakoServerName(name: string): boolean {
  return MAKO_RUNTIME_SERVERS.has(name) || name === MAKO_CONVERSATIONS_SERVER
}

function skillReaches(skill: SkillRecord, harness: string): boolean {
  return skill.origins.some(
    (origin) =>
      origin.provider === harness || origin.provider === UNIVERSAL_PROVIDER
  )
}

/** Only provenance the name cannot carry: a skill that lives in this checkout. */
function skillBadge(skill: SkillRecord, harness: string): string | undefined {
  return skill.origins.some(
    (origin) =>
      origin.scope === "workspace" &&
      (origin.provider === harness || origin.provider === UNIVERSAL_PROVIDER)
  )
    ? "project"
    : undefined
}

export function skillItems(
  snapshot: SkillRegistrySnapshot | null,
  harness: string
): SkillReach {
  if (!snapshot) return { items: [], elsewhere: 0 }
  const items: CapabilityItem[] = []
  let elsewhere = 0
  for (const skill of snapshot.skills) {
    if (!skillReaches(skill, harness)) {
      elsewhere += 1
      continue
    }
    const item: CapabilityItem = {
      kind: "skill",
      name: skill.name,
      description: skill.description,
      builtIn: false,
    }
    const badge = skillBadge(skill, harness)
    if (badge) item.badge = badge
    if (skill.blockReason) item.blocked = skill.blockReason
    items.push(item)
  }
  return { items, elsewhere }
}

function serverDescription(server: McpServerRecord): string {
  const builtIn = BUILT_IN_DESCRIPTIONS.get(server.name)
  if (builtIn) return builtIn
  if (server.detail) return server.detail
  if (server.transport === "stdio")
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
  if (server.url) {
    try {
      return new URL(server.url).host
    } catch {
      return server.url
    }
  }
  return server.transport
}

function serverBadge(
  server: McpServerRecord,
  harness: string
): string | undefined {
  if (isMakoManagedServer(server)) return "built in"
  const own = server.origins.filter((origin) => origin.provider === harness)
  if (own.some((origin) => origin.scope === "workspace")) return "project"
  return undefined
}

/** The provider whose portable definition reaches this harness, when it is not the harness's own. */
function serverSource(
  server: McpServerRecord,
  harness: string
): string | undefined {
  if (isMakoManagedServer(server)) return undefined
  if (server.origins.some((origin) => origin.provider === harness)) return undefined
  return server.origins[0]?.provider
}

export function mcpItems(
  snapshot: McpRegistrySnapshot | null,
  harness: string,
  transports: readonly McpTransport[]
): CapabilityItem[] {
  const items: CapabilityItem[] = []
  if (snapshot) {
    for (const server of reachableMcpServers(snapshot, harness, transports)) {
      const item: CapabilityItem = {
        kind: "mcp",
        name: server.name,
        description: serverDescription(server),
        builtIn: isMakoManagedServer(server),
      }
      const badge = serverBadge(server, harness)
      if (badge) item.badge = badge
      const from = serverSource(server, harness)
      if (from) item.from = from
      if (server.blockReason) item.blocked = server.blockReason
      items.push(item)
    }
  }
  // The conversation tools are attached at launch rather than discovered, so
  // the registry never lists them; every provider still gets them.
  items.push({
    kind: "mcp",
    name: MAKO_CONVERSATIONS_SERVER,
    description: BUILT_IN_DESCRIPTIONS.get(MAKO_CONVERSATIONS_SERVER) ?? "",
    builtIn: true,
    badge: "built in",
  })
  // Mako's own servers lead: they are the ones a user new to the menu is
  // least likely to know are there.
  return items.sort(
    (left, right) =>
      Number(right.builtIn) - Number(left.builtIn) ||
      left.name.localeCompare(right.name)
  )
}

/** Browsing shows both groups at a glance; typing narrows within all of them. */
const LIMITS = { browse: { skill: 6, mcp: 6 }, search: { skill: 8, mcp: 6 } }

interface ScoredMatch extends CapabilityMatch {
  score: number
}

function rank(
  items: CapabilityItem[],
  query: string,
  limit: number
): ScoredMatch[] {
  if (!query) return items.slice(0, limit).map((item) => ({ item, indices: [], score: 0 }))
  const top: ScoredMatch[] = []
  for (const item of items) {
    const onName = fuzzy(query, item.name)
    // A description hit keeps the row reachable but never outranks a name hit.
    const onText = onName ? null : fuzzy(query, item.description)
    if (!onName && !onText) continue
    const score = onName ? onName.score + 500 : (onText?.score ?? 0)
    const entry = { item, indices: onName?.indices ?? [], score }
    const at = top.findIndex((candidate) => score > candidate.score)
    if (at === -1) top.push(entry)
    else top.splice(at, 0, entry)
    if (top.length > limit) top.pop()
  }
  return top
}

/** `mcp:` narrows to servers, so the typed token and the filter agree. */
const MCP_QUERY = /^mcp:/i

export function capabilityCatalog(
  skills: SkillRegistrySnapshot | null,
  servers: McpRegistrySnapshot | null,
  harness: string,
  transports: readonly McpTransport[],
  query: string
): CapabilityCatalog {
  const typed = query.trim()
  const serversOnly = MCP_QUERY.test(typed)
  const term = serversOnly ? typed.replace(MCP_QUERY, "") : typed
  const limits = typed ? LIMITS.search : LIMITS.browse
  const found = skillItems(skills, harness)
  const reachable = mcpItems(servers, harness, transports)
  const ranked = [
    { kind: "skill" as const, label: "Skills", matches: serversOnly ? [] : rank(found.items, term, limits.skill), total: found.items.length },
    { kind: "mcp" as const, label: "MCP servers", matches: rank(reachable, term, limits.mcp), total: reachable.length },
  ].filter((group) => group.matches.length > 0)
  // While typing, the group holding the best hit leads; a name hit on a
  // server should not sit under skills that only matched in a description.
  if (term) ranked.sort((left, right) => (right.matches[0]?.score ?? 0) - (left.matches[0]?.score ?? 0))
  const groups: CapabilityGroup[] = ranked.map((group) => ({
    ...group,
    matches: group.matches.map(({ item, indices }) => ({ item, indices })),
  }))
  return { groups, elsewhere: found.elsewhere }
}
