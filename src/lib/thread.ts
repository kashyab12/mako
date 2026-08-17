import type { TreeNode } from "@/lib/types"

/**
 * Turning Pi's entry graph into something worth looking at.
 *
 * Pi stores a session as a parent-linked chain: every entry is a child of the
 * one before it. A real session is 281 entries with 5 user turns and 45
 * model/thinking changes, so rendering the graph as written produces a
 * staircase that runs off the right edge — and serializing it as a nested
 * structure produces one 334 levels deep, which the contextBridge refuses to
 * clone. The host therefore sends a flat list and this module indexes it.
 *
 * The useful unit is the user turn, because that is what you can rewind to.
 * Turns are collected from the whole tree rather than from the live path
 * only: navigating away leaves earlier turns on an abandoned branch, and
 * those are precisely the ones you want to get back to — a real session
 * exists whose live path holds no messages at all, and a history panel that
 * showed nothing for it would be accurate and useless.
 */

/** Entry types that are settings the agent recorded, not turns you took. */
const SETTING_TYPES = new Set(["model_change", "thinking_level_change", "session_info"])

export interface Checkpoint {
  /** Entry id to navigate to. */
  id: string
  /** The user's message text. */
  text: string
  timestamp?: string
  /** True when this turn sits on the branch the conversation is on now. */
  live: boolean
  /** True for the most recent turn on the live branch. */
  current: boolean
  /** Sibling turns that diverge from the same point, when there are any. */
  takes: Array<{ id: string; preview: string; live: boolean }>
  /** Settings in force for this turn, deduplicated to the ones that stuck. */
  settings: string[]
  /** Assistant reply preview, so a checkpoint reads as a turn not a fragment. */
  reply?: string
}

export function checkpointsOf(tree: TreeNode[]): Checkpoint[] {
  if (tree.length === 0) return []

  const byId = new Map(tree.map((node) => [node.id, node]))
  const turns = tree.filter((node) => node.type === "message" && node.role === "user")

  const checkpoints = turns.map((node) => ({
    id: node.id,
    text: node.preview,
    timestamp: node.timestamp,
    live: Boolean(node.onPath),
    current: false,
    takes: takesFor(node, byId),
    settings: settingsFor(node, byId),
    reply: replyOf(node, byId),
  }))

  // Chronological, so the panel reads top-to-bottom like the conversation.
  checkpoints.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""))

  const lastLive = checkpoints.map((entry) => entry.live).lastIndexOf(true)
  if (lastLive >= 0) checkpoints[lastLive].current = true

  return checkpoints
}

/**
 * A branch point is a parent with more than one child. Its children are the
 * alternate continuations of the same moment.
 */
function takesFor(node: TreeNode, byId: Map<string, TreeNode>): Checkpoint["takes"] {
  const parent = node.parentId ? byId.get(node.parentId) : undefined
  if (!parent || parent.childIds.length < 2) return []
  return parent.childIds
    .map((id) => byId.get(id))
    .filter((child): child is TreeNode => Boolean(child))
    .map((child) => ({ id: child.id, preview: child.preview, live: Boolean(child.onPath) }))
}

/**
 * Walk up from a turn, collecting settings until the previous message. Thirty
 * model changes in a row mean the user was cycling and only the last one
 * applied, so each kind keeps a single entry.
 */
function settingsFor(node: TreeNode, byId: Map<string, TreeNode>): string[] {
  const kinds = new Map<string, string>()
  let cursor = node.parentId ? byId.get(node.parentId) : undefined
  const guard = new Set<string>()

  while (cursor && cursor.type !== "message" && !guard.has(cursor.id)) {
    guard.add(cursor.id)
    if (SETTING_TYPES.has(cursor.type)) {
      const kind = cursor.type === "thinking_level_change" ? "thinking" : cursor.type
      // Walking upward means the first one seen is the closest, and therefore
      // the one that was actually in force.
      if (!kinds.has(kind)) kinds.set(kind, cursor.preview)
    }
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return [...kinds.values()].reverse()
}

/** The assistant's answer to this turn: the next message down the branch. */
function replyOf(node: TreeNode, byId: Map<string, TreeNode>): string | undefined {
  let cursor = descend(node, byId)
  let hops = 0
  while (cursor && hops < 60) {
    if (cursor.type === "message") {
      if (cursor.role === "user") return undefined
      if (cursor.role === "assistant" && cursor.preview) return cursor.preview
    }
    cursor = descend(cursor, byId)
    hops += 1
  }
  return undefined
}

/** Prefer the live branch when a node has more than one continuation. */
function descend(node: TreeNode, byId: Map<string, TreeNode>): TreeNode | undefined {
  const children = node.childIds
    .map((id) => byId.get(id))
    .filter((child): child is TreeNode => Boolean(child))
  return children.find((child) => child.onPath) ?? children[0]
}
