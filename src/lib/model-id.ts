/**
 * Model ids arrive dirty. Harnesses encode tuning into the id itself:
 * Claude suffixes a context-window variant (`claude-fable-5[1m]`), Cursor
 * folds effort and fast mode into bracket parameters
 * (`sonnet-4.5[effort=high,fast=true]`), and Devin bakes both into the
 * dashes (`gpt-5-6-sol-high-priority`, `claude-opus-5-medium`).
 *
 * Decomposition splits an id into what it actually says — the model, the
 * reasoning effort, the speed lane, the context variant — so the UI can
 * show one clean name and light the effort gauge and fast bolt instead of
 * printing the whole encoded string. The original id is always kept: it is
 * what the harness wants back at launch.
 */

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"])

export interface DecomposedModel {
  /** The id exactly as the harness knows it — what launching needs. */
  id: string
  /** The model's clean name, tuning stripped. */
  base: string
  effort?: string
  fast?: boolean
  /** A context-window variant, e.g. "1m". */
  context?: string
}

export function decomposeModelId(harness: string, id: string): DecomposedModel {
  const out: DecomposedModel = { id, base: id }

  if (harness === "claude") {
    const marked = /^(.+?)\[([\w.]+)\]$/.exec(id)
    if (marked) {
      out.base = marked[1]!
      out.context = marked[2]!
    }
    return out
  }

  if (harness === "cursor") {
    const bracketed = /^(.+?)\[(.+)\]$/.exec(id)
    if (bracketed) {
      out.base = bracketed[1]!
      for (const param of bracketed[2]!.split(",")) {
        const [key, value] = param.split("=").map((part) => part.trim())
        if (key === "effort" && value) out.effort = value
        if (key === "fast") out.fast = value !== "false"
      }
    }
    return out
  }

  if (harness === "devin") {
    // Trailing tokens, outermost first: `-priority` (the fast lane), then
    // an effort level. `gpt-5-6-sol-high-priority` → gpt-5-6-sol / high / fast.
    let base = id
    if (base.endsWith("-priority")) {
      out.fast = true
      base = base.slice(0, -"-priority".length)
    }
    const lastDash = base.lastIndexOf("-")
    if (lastDash > 0) {
      const tail = base.slice(lastDash + 1)
      if (EFFORTS.has(tail)) {
        out.effort = tail
        base = base.slice(0, lastDash)
      }
    }
    out.base = base
    return out
  }

  return out
}

/** The pieces after the name, for a compact one-line accessory. */
export function decorations(dec: DecomposedModel): string[] {
  const parts: string[] = []
  if (dec.effort) parts.push(dec.effort)
  if (dec.context) parts.push(`${dec.context} context`)
  return parts
}
