import { createHook, createStore } from "@/state/store"
import { getPi, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"
import type { AcpPermissionRequest, AcpSessionState, AcpUpdate, ThreadRef } from "@/lib/types"

/**
 * One interactive foreign agent, live.
 *
 * The host runs the agent over ACP and streams updates here; this store
 * reduces them into renderable blocks — chunks append to the open text or
 * thinking block, tool updates find their call by id, a plan replaces the
 * previous plan. Exactly one interactive session is on screen at a time,
 * which is not a protocol limit but a UI decision: this panel is a focused
 * conversation, not a fleet console.
 */

export type AcpBlock =
  | { type: "user"; text: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; title: string; toolKind?: string; status: string; output?: string }
  | { type: "plan"; entries: Array<{ content: string; status: string }> }

interface AcpState {
  session: AcpSessionState | null
  blocks: AcpBlock[]
  permission: AcpPermissionRequest | null
  starting: boolean
}

export const acpStore = createStore<AcpState>({
  session: null,
  blocks: [],
  permission: null,
  starting: false,
})
export const useAcp = createHook(acpStore)

export function applyAcpSession(session: AcpSessionState) {
  const current = acpStore.get().session
  if (!current || current.id !== session.id) return
  acpStore.set({ session })
  if (session.status === "failed" && session.error) toast.error(session.error)
}

export function applyAcpUpdate(id: string, update: AcpUpdate) {
  const { session, blocks } = acpStore.get()
  if (!session || session.id !== id) return
  acpStore.set({ blocks: reduce(blocks, update) })
}

export function applyAcpPermission(request: AcpPermissionRequest) {
  const { session } = acpStore.get()
  if (!session || session.id !== request.sessionId) {
    // Nobody is looking at this session; answering nothing cancels the tool,
    // which is the safe default for an unwatched agent.
    if (hasBridge()) void getPi().acpPermission(request.sessionId, request.id, null)
    return
  }
  acpStore.set({ permission: request })
}

function reduce(blocks: AcpBlock[], update: AcpUpdate): AcpBlock[] {
  const last = blocks[blocks.length - 1]
  switch (update.kind) {
    case "user":
      return [...blocks, { type: "user", text: update.text }]
    case "text":
      if (last?.type === "text") {
        return [...blocks.slice(0, -1), { type: "text", text: last.text + update.text }]
      }
      return [...blocks, { type: "text", text: update.text }]
    case "thinking":
      if (last?.type === "thinking") {
        return [...blocks.slice(0, -1), { type: "thinking", text: last.text + update.text }]
      }
      return [...blocks, { type: "thinking", text: update.text }]
    case "tool":
      return [
        ...blocks,
        { type: "tool", id: update.id, title: update.title, toolKind: update.toolKind, status: update.status },
      ]
    case "tool-update":
      return blocks.map((block) =>
        block.type === "tool" && block.id === update.id
          ? {
              ...block,
              title: update.title ?? block.title,
              status: update.status ?? block.status,
              output: update.output ?? block.output,
            }
          : block
      )
    case "plan": {
      const withoutPlan = blocks.filter((block) => block.type !== "plan")
      return [...withoutPlan, { type: "plan", entries: update.entries }]
    }
    default:
      return blocks
  }
}

export const acp = {
  /**
   * Open any thread's conversation, interactively.
   *
   * A Claude Code thread loads its *own* session over ACP — the same
   * session, live. A Cursor thread does the same through Cursor's native
   * ACP. Everything else is first written into Claude Code's store as a
   * native session — the emitter, not a handoff — and then loaded, so a
   * conversation that began on Codex or Grok or Devin is picked up by an
   * agent that remembers it.
   */
  async openInteractive(ref: ThreadRef) {
    if (!hasBridge()) return
    acpStore.set({ starting: true, blocks: [], permission: null })
    try {
      let harness = ref.harness
      let resume = ref.nativeId
      if (ref.harness !== "claude" && ref.harness !== "cursor") {
        const emitted = await getPi().emitThreadToClaude(ref.path)
        harness = "claude"
        resume = emitted.sessionId
      }
      const session = await getPi().acpStart(harness, ref.cwd ?? "", { resume, title: ref.title })
      acpStore.set({ session, starting: false })
    } catch (error) {
      acpStore.set({ starting: false })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  async send(text: string) {
    const { session } = acpStore.get()
    if (!session || !hasBridge()) return
    try {
      await getPi().acpPrompt(session.id, text)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  answerPermission(optionId: string | null) {
    const { session, permission } = acpStore.get()
    if (!session || !permission || !hasBridge()) return
    void getPi().acpPermission(session.id, permission.id, optionId)
    acpStore.set({ permission: null })
  },

  setMode(modeId: string) {
    const { session } = acpStore.get()
    if (!session || !hasBridge()) return
    void getPi().acpSetMode(session.id, modeId)
  },

  cancel() {
    const { session } = acpStore.get()
    if (!session || !hasBridge()) return
    void getPi().acpCancel(session.id)
  },

  close() {
    const { session } = acpStore.get()
    if (session && hasBridge()) void getPi().acpClose(session.id)
    acpStore.set({ session: null, blocks: [], permission: null })
  },
}
