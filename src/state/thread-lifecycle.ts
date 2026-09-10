import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { acpForThread, acpStore } from "@/state/acp-state"
import type { AcpPresence } from "@/state/acp-presence"
import { threadArchiveKey, type ThreadTarget, type ThreadArchiveSnapshot, type StopTarget, type ThreadRef } from "../../electron/shared"
import { toast } from "sonner"

export const threadArchiveStore = createStore({ revision: -1, keys: new Set<string>() })
export const useThreadArchives = createHook(threadArchiveStore)
export type { ThreadTarget, ThreadControls } from "../../electron/shared"

export function applyThreadArchives(snapshot: ThreadArchiveSnapshot) {
  if (snapshot.revision < threadArchiveStore.get().revision) return
  threadArchiveStore.set({ revision: snapshot.revision, keys: new Set(snapshot.keys) })
}

export function nativeThreadTarget(ref: ThreadRef): ThreadTarget {
  const owner = acpForThread(acpStore.get(), ref)
  if (owner?.kind === "live") return { kind: "live", id: owner.key }
  return ref.nativeId ? { kind: "native", provider: ref.harness, nativeId: ref.nativeId } : { kind: "file", path: ref.path }
}

export function archivedThread(ref: ThreadRef, keys: ReadonlySet<string>): boolean {
  return keys.has(threadArchiveKey(nativeThreadTarget(ref))) || keys.has(threadArchiveKey({ kind: "file", path: ref.path })) || (ref.nativeId ? keys.has(threadArchiveKey({ kind: "native", provider: ref.harness, nativeId: ref.nativeId })) : false)
}

export function archivedLive(presence: AcpPresence, keys: ReadonlySet<string>): boolean {
  return keys.has(threadArchiveKey({ kind: "live", id: presence.key })) || (presence.nativeId ? keys.has(threadArchiveKey({ kind: "native", provider: presence.harness, nativeId: presence.nativeId })) : false) || (presence.threadPath ? keys.has(threadArchiveKey({ kind: "file", path: presence.threadPath })) : false)
}

export const threadLifecycle = {
  async load() {
    if (!hasBridge()) return
    try { applyThreadArchives(await getMako().threadArchives()) }
    catch (error) { toast.error("Archived threads could not be loaded", { description: error instanceof Error ? error.message : String(error) }) }
  },
  controls(target: ThreadTarget) { return getMako().threadControls(target) },
  async archive(target: ThreadTarget, archived: boolean) {
    try {
      applyThreadArchives(await getMako().archiveThread({ id: crypto.randomUUID(), target, archived }))
      toast(archived ? "Thread archived. Running work is not stopped." : "Thread restored", { duration: Infinity, action: { label: "Undo", onClick: () => { void threadLifecycle.archive(target, !archived) } } })
    } catch (error) { toast.error("The thread was not changed", { description: error instanceof Error ? error.message : String(error) }) }
  },
  async stop(target: StopTarget) {
    try {
      const accepted = await getMako().stopThread(target)
      toast(accepted ? "Stop requested. Queued messages are paused." : "That run already finished. No other run was stopped.")
    } catch (error) { toast.error("The run could not be stopped", { description: error instanceof Error ? error.message : String(error) }) }
  },
}
