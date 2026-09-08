import { getMako } from "@/lib/bridge"
import type { ControlActivity, ControlPreview } from "@/lib/types"
import { createHook, createStore } from "@/state/store"

interface PreviewState {
  conversationId: string | null
  preview: ControlPreview | null
  latestActivity: ControlActivity | null
  error: string | null
}
export const controlPreviewStore = createStore<PreviewState>({
  conversationId: null,
  preview: null,
  latestActivity: null,
  error: null,
})
export const useControlPreview = createHook(controlPreviewStore)

export function watchControlPreview(conversationId: string): () => void {
  const watcher = crypto.randomUUID()
  let closed = false
  let pending = false
  let timer: ReturnType<typeof setTimeout> | undefined
  controlPreviewStore.set({ conversationId, preview: null, error: null })
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
      if (
        !closed &&
        controlPreviewStore.get().conversationId === conversationId
      ) {
        const previous = controlPreviewStore.get().preview
        if (
          previous?.frame?.id !== preview?.frame?.id ||
          previous?.activity.updatedAt !== preview?.activity.updatedAt
        )
          controlPreviewStore.set({ preview, error: null })
      }
    } catch {
      if (
        !closed &&
        controlPreviewStore.get().conversationId === conversationId
      )
        controlPreviewStore.set({
          error: "The control preview is unavailable.",
        })
    } finally {
      pending = false
      if (!closed && !document.hidden)
        timer = setTimeout(() => void poll(), 500)
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
    closed = true
    if (timer) clearTimeout(timer)
    document.removeEventListener("visibilitychange", visibility)
    release()
    if (controlPreviewStore.get().conversationId === conversationId)
      controlPreviewStore.set({
        conversationId: null,
        preview: null,
        error: null,
      })
  }
}

export function observeControlPreview(): () => void {
  return getMako().onEvent((event) => {
    if (event.type === "control-activity")
      controlPreviewStore.set({ latestActivity: event.activity })
  })
}
export function hideControlPreview(): Promise<void> {
  return getMako().hideControlPreview()
}
export async function stopControlTask(id: string): Promise<void> {
  await getMako().liveCancel(id)
  await hideControlPreview()
}

/** Electron captures only the already-authorized native window. No AX query or input is involved. */
export async function controlPreviewStream(
  id: string
): Promise<MediaStream | null> {
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
