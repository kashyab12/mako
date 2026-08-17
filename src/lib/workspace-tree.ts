import type { WorkspaceFile } from "@/lib/types"

/**
 * The workspace, as a flat list of visible rows.
 *
 * Flat rather than nested for the same reason every other list here is: one
 * array virtualizes and keyboard-navigates uniformly, and a repo can hold tens
 * of thousands of files.
 *
 * Two decisions worth stating, because they are the opposite of the changes
 * panel's:
 *
 *   * **Closed by default.** The changes list shows everything because a dirty
 *     tree is small and you want to see all of it. A project tree is not small,
 *     and opening one to twenty thousand rows is not a file browser.
 *   * **Single-child chains fold** (`src/components/rail` on one row). A deep
 *     project is mostly corridors; drawing each one costs a click and a line.
 */

export interface WorkspaceDir {
  kind: "dir"
  /** Full path of the folded chain, and the identity used for open/closed. */
  key: string
  /** What the row shows — the folded segment, e.g. `components/rail`. */
  label: string
  depth: number
  /** Files at or below here, for the count on the row. */
  files: number
  open: boolean
}

export interface WorkspaceFileRow {
  kind: "file"
  key: string
  label: string
  depth: number
  path: string
  changed: boolean
}

export type WorkspaceRow = WorkspaceDir | WorkspaceFileRow

interface Node {
  name: string
  children: Map<string, Node>
  files: WorkspaceFile[]
}

function insert(root: Node, file: WorkspaceFile) {
  const parts = file.path.split("/")
  parts.pop()
  let node = root
  for (const part of parts) {
    let next = node.children.get(part)
    if (!next) {
      next = { name: part, children: new Map(), files: [] }
      node.children.set(part, next)
    }
    node = next
  }
  node.files.push(file)
}

function countFiles(node: Node): number {
  let total = node.files.length
  for (const child of node.children.values()) total += countFiles(child)
  return total
}

/** Directories first, then files, each alphabetically — the ordering every file browser uses. */
function byName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name, undefined, { numeric: true })
}

export function buildWorkspaceTree(files: WorkspaceFile[], open: Set<string>): WorkspaceRow[] {
  const root: Node = { name: "", children: new Map(), files: [] }
  for (const file of files) insert(root, file)

  const rows: WorkspaceRow[] = []

  const walk = (node: Node, prefix: string, depth: number) => {
    for (const child of [...node.children.values()].sort(byName)) {
      // Fold a corridor of single-child directories into one row.
      let label = child.name
      let cursor = child
      while (cursor.files.length === 0 && cursor.children.size === 1) {
        const [only] = [...cursor.children.values()]
        if (!only) break
        label = `${label}/${only.name}`
        cursor = only
      }
      const key = prefix ? `${prefix}/${label}` : label
      const isOpen = open.has(key)
      rows.push({ kind: "dir", key, label, depth, files: countFiles(cursor), open: isOpen })
      if (isOpen) walk(cursor, key, depth + 1)
    }
    for (const file of [...node.files].sort((a, b) => byName(nameOf(a), nameOf(b)))) {
      rows.push({
        kind: "file",
        key: file.path,
        label: file.path.split("/").at(-1) ?? file.path,
        depth,
        path: file.path,
        changed: Boolean(file.changed),
      })
    }
  }

  walk(root, "", 0)
  return rows
}

function nameOf(file: WorkspaceFile) {
  return { name: file.path.split("/").at(-1) ?? file.path }
}

/**
 * Every folder that has to be open for `path` to be on screen.
 *
 * Used when something outside the tree asks to reveal a file — the agent
 * touching it, or the viewer opening one. Folded chains mean the keys are not
 * simply the path's prefixes, so this is derived from the rows rather than
 * guessed from the string.
 */
export function pathToOpenKeys(files: WorkspaceFile[], path: string): string[] {
  const keys: string[] = []
  let open = new Set<string>()
  // Walk down one level at a time, opening whichever folded row contains the
  // path, until the file itself appears.
  for (let guard = 0; guard < 64; guard += 1) {
    const rows = buildWorkspaceTree(files, open)
    if (rows.some((row) => row.kind === "file" && row.path === path)) return keys
    const next = rows.find(
      (row): row is WorkspaceDir => row.kind === "dir" && !row.open && path.startsWith(`${row.key}/`)
    )
    if (!next) return keys
    keys.push(next.key)
    open = new Set([...open, next.key])
  }
  return keys
}
