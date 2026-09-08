import { getMako } from "@/lib/bridge"
import type { ControlActivity, ControlPreview } from "@/lib/types"
import { createHook, createStore } from "@/state/store"

interface PreviewState {
  previews: Record<string, ControlPreview | null>
  activities: Record<string, ControlActivity>
  errors: Record<string, string | null>
}
export const controlPreviewStore = createStore<PreviewState>({
  previews: {},
  activities: {},
  errors: {},
})
export const useControlPreview = createHook(controlPreviewStore)

const consumers = new Map<string, number>()

export function watchControlPreview(conversationId: string): () => void {
  consumers.set(conversationId, (consumers.get(conversationId) ?? 0) + 1)
  const watcher = crypto.randomUUID()
  let closed = false
  let pending = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const poll = async () => {
    timer = undefined
    if (closed || pending || document.hidden) return
    pending = true
    try {
      const preview = await getMako().controlPreview(
        conversationId,
        true,
        watcher
      )
      if (!closed) {
        const previous = controlPreviewStore.get().previews[conversationId]
        if (
          previous?.frame?.id !== preview?.frame?.id ||
          previous?.activity.updatedAt !== preview?.activity.updatedAt ||
          previous?.window?.windowId !== preview?.window?.windowId ||
          previous?.window?.pid !== preview?.window?.pid ||
          controlPreviewStore.get().errors[conversationId]
        )
          controlPreviewStore.set((state) => ({
            previews: { ...state.previews, [conversationId]: preview },
            errors: { ...state.errors, [conversationId]: null },
          }))
      }
    } catch {
      if (!closed)
        controlPreviewStore.set((state) => ({
          errors: {
            ...state.errors,
            [conversationId]: "The control preview is unavailable.",
          },
        }))
    } finally {
      pending = false
      if (closed || document.hidden) release()
      else timer = setTimeout(() => void poll(), 500)
    }
  }
  const release = () => {
    void getMako()
      .controlPreview(conversationId, false, watcher)
      .catch(() => {})
  }
  const visibility = () => {
    if (timer) clearTimeout(timer)
    if (document.hidden) release()
    else void poll()
  }
  document.addEventListener("visibilitychange", visibility)
  void poll()
  return () => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    document.removeEventListener("visibilitychange", visibility)
    release()
    const remaining = (consumers.get(conversationId) ?? 1) - 1
    if (remaining > 0) consumers.set(conversationId, remaining)
    else {
      consumers.delete(conversationId)
      controlPreviewStore.set((state) => ({
        previews: Object.fromEntries(
          Object.entries(state.previews).filter(([id]) => id !== conversationId)
        ),
        errors: Object.fromEntries(
          Object.entries(state.errors).filter(([id]) => id !== conversationId)
        ),
      }))
    }
  }
}

export function receiveControlActivity(activity: ControlActivity) {
  controlPreviewStore.set((state) => {
    const entries = Object.entries(state.activities)
      .filter(([id]) => id !== activity.conversationId)
      .slice(-63)
    return {
      activities: Object.fromEntries([
        ...entries,
        [activity.conversationId, activity],
      ]),
    }
  })
}
export async function stopControlTask(id: string): Promise<void> {
  try {
    await getMako().liveCancel(id)
  } catch {
    controlPreviewStore.set((state) => ({
      errors: {
        ...state.errors,
        [id]: "The task could not be stopped. Try Stop again.",
      },
    }))
  }
}

/** Electron captures only the already-authorized native window. No AX query or input is involved. */
export async function controlPreviewStream(
  id: string
): Promise<MediaStream | null> {
  if (!getMako().nativeWindowVideo) return null
  const source = await getMako().controlPreviewSource(id)
  if (!source) return null
  const video: MediaTrackConstraints & {
    mandatory: {
      chromeMediaSource: string
      chromeMediaSourceId: string
      maxWidth: number
      maxHeight: number
      maxFrameRate: number
    }
  } = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: source,
      maxWidth: 960,
      maxHeight: 720,
      maxFrameRate: 4,
    },
  }
  return navigator.mediaDevices.getUserMedia({ audio: false, video })
}
