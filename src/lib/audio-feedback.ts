export type FeedbackCue = "copy" | "complete"

/** Owns every voice and decode. A preference change invalidates pending work. */
export class AudioFeedback {
  private context: AudioContext | undefined
  private master: GainNode | undefined
  private decode: Promise<AudioBuffer> | undefined
  private voices = new Map<AudioScheduledSourceNode, () => void>()
  private generation = 0
  private enabled = false
  private volume = 0.25

  configure(enabled: boolean, volume: number) {
    this.enabled = enabled
    this.volume = Math.max(0, Math.min(1, volume))
    this.stop()
    if (this.master) this.master.gain.value = this.volume
  }

  stop() {
    this.generation++
    for (const [voice, release] of this.voices) {
      voice.stop()
      release()
    }
    this.voices.clear()
  }

  async play(cue: FeedbackCue) {
    if (!this.enabled || document.hidden) return
    this.stop()
    const generation = this.generation
    try {
      const context = this.context ??= new AudioContext()
      if (!this.master) {
        this.master = context.createGain()
        this.master.gain.value = this.volume
        this.master.connect(context.destination)
      }
      await context.resume()
      if (generation !== this.generation || document.hidden) return
      if (cue === "complete") {
        this.decode ??= fetch(new URL("../assets/sounds/confirmation.ogg", import.meta.url))
          .then((response) => {
            if (!response.ok) throw new Error("Sound unavailable")
            return response.arrayBuffer()
          })
          .then((bytes) => context.decodeAudioData(bytes))
          .catch(() => {
            if (this.context === context) this.decode = undefined
            throw new Error("Sound unavailable")
          })
        const buffer = await this.decode
        if (generation !== this.generation || document.hidden) return
        const voice = context.createBufferSource()
        voice.buffer = buffer
        this.own(voice)
        voice.connect(this.master)
        voice.start()
        return
      }
      const voice = context.createOscillator()
      const envelope = context.createGain()
      voice.type = "sine"
      voice.frequency.setValueAtTime(880, context.currentTime)
      voice.frequency.exponentialRampToValueAtTime(1320, context.currentTime + 0.055)
      envelope.gain.setValueAtTime(0, context.currentTime)
      envelope.gain.linearRampToValueAtTime(0.12, context.currentTime + 0.008)
      envelope.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.09)
      voice.connect(envelope)
      envelope.connect(this.master)
      this.own(voice, () => envelope.disconnect())
      voice.start()
      voice.stop(context.currentTime + 0.1)
    } catch {
      // Audio is optional feedback. The visual result remains authoritative.
    }
  }

  private own(voice: AudioScheduledSourceNode, cleanup?: () => void) {
    const release = () => {
      voice.onended = null
      this.voices.delete(voice)
      voice.disconnect()
      cleanup?.()
    }
    this.voices.set(voice, release)
    voice.onended = release
  }

  dispose() {
    this.stop()
    void this.context?.close()
    this.context = undefined
    this.master = undefined
    this.decode = undefined
  }
}
