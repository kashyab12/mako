import type { Block, PiMessage } from "@/lib/types"

/**
 * Keep message identity stable across host re-serializations.
 *
 * The host rebuilds the whole message array whenever a turn ends or a tool
 * returns, so every object arrives new. `Turn` is memoized on identity, which
 * means without this step a single tool result re-renders — and re-parses the
 * markdown of — every turn in the session.
 *
 * Reconciling by content lets the unchanged tail of a long conversation keep
 * its previous objects and skip rendering entirely. The comparison is
 * deliberately structural rather than a deep equality or a hash: it allocates
 * nothing and touches only lengths and discriminators, so it stays cheap on
 * the exact sessions where it matters most.
 */
export function reconcileMessages(previous: PiMessage[], next: PiMessage[]): PiMessage[] {
  if (previous.length === 0) return next

  let reused = 0
  const out = next.map((message, index) => {
    const old = previous[index]
    if (old && sameMessage(old, message)) {
      reused += 1
      return old
    }
    return message
  })

  // Nothing was reusable (a compaction, a branch switch): take the new array
  // wholesale rather than handing back a copy with identical contents.
  return reused === 0 ? next : out
}

function sameMessage(a: PiMessage, b: PiMessage): boolean {
  if (a.id !== b.id) return false
  if (a.role !== b.role) return false
  if (a.timestamp !== b.timestamp) return false
  if (a.error !== b.error) return false
  if (a.isError !== b.isError) return false
  if (a.streaming !== b.streaming) return false
  if (a.toolCallId !== b.toolCallId) return false
  if (a.blocks.length !== b.blocks.length) return false
  for (let i = 0; i < a.blocks.length; i += 1) {
    if (!sameBlock(a.blocks[i], b.blocks[i])) return false
  }
  return true
}

function sameBlock(a: Block, b: Block): boolean {
  if (a.type !== b.type) return false
  if (a.id !== b.id) return false
  if (a.name !== b.name) return false
  if (a.isError !== b.isError) return false
  // Length is a sound proxy here: a block's text only ever grows by append
  // during a turn, and a settled block never changes at all.
  if ((a.text?.length ?? 0) !== (b.text?.length ?? 0)) return false
  if ((a.thinking?.length ?? 0) !== (b.thinking?.length ?? 0)) return false
  return true
}
