import { AudioFeedback, type FeedbackCue } from "@/lib/audio-feedback"
import { prefsStore } from "@/state/prefs"

const audio = new AudioFeedback()

export function playFeedback(cue: FeedbackCue) {
  void audio.play(cue)
}

export function bindFeedback() {
  let enabled: boolean | undefined
  let volume: number | undefined
  const update = () => {
    const prefs = prefsStore.get()
    if (enabled === prefs.soundEnabled && volume === prefs.soundVolume) return
    enabled = prefs.soundEnabled
    volume = prefs.soundVolume
    audio.configure(enabled, volume)
  }
  const hide = () => { if (document.hidden) audio.stop() }
  update()
  const off = prefsStore.subscribe(update)
  document.addEventListener("visibilitychange", hide)
  return () => {
    off()
    document.removeEventListener("visibilitychange", hide)
    audio.dispose()
  }
}
