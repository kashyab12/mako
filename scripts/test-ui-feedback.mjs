// Run: node --import tsx scripts/test-ui-feedback.mjs
import assert from "node:assert/strict"
import { AudioFeedback } from "../src/lib/audio-feedback.ts"

function deferred() {
  const result = Promise.withResolvers()
  return result
}

class Parameter {
  value = 0
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
  linearRampToValueAtTime() {}
}

class Node {
  gain = new Parameter()
  frequency = new Parameter()
  onended = null
  starts = 0
  stops = 0
  disconnects = 0
  connect() {}
  disconnect() { this.disconnects++ }
  start() { this.starts++ }
  stop() { this.stops++ }
}

const contexts = []
class Context {
  currentTime = 0
  destination = new Node()
  gains = []
  voices = []
  decodes = []
  closes = 0
  resumeGate = Promise.resolve()
  constructor() { contexts.push(this) }
  resume() { return this.resumeGate }
  close() { this.closes++; return Promise.resolve() }
  createGain() { const node = new Node(); this.gains.push(node); return node }
  createOscillator() { return this.createBufferSource() }
  createBufferSource() { const node = new Node(); this.voices.push(node); return node }
  decodeAudioData() { const gate = deferred(); this.decodes.push(gate); return gate.promise }
}

let fetches = 0
const original = {
  context: Object.getOwnPropertyDescriptor(globalThis, "AudioContext"),
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
  fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
}
Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: Context })
Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } })
Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => {
  fetches++
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }
} })
const flush = () => new Promise((resolve) => setImmediate(resolve))

try {
  const audio = new AudioFeedback()
  await audio.play("copy")
  assert.equal(contexts.length, 0, "muted playback must not create a context")
  audio.configure(true, 0.25)
  await audio.play("copy")
  const context = contexts[0]
  assert.equal(context.voices[0].starts, 1)
  await audio.play("copy")
  assert.equal(contexts.length, 1, "synthesis reuses the same context")
  assert.equal(context.voices[0].disconnects, 1, "a replacement disconnects the previous voice")
  assert.equal(context.gains[1].disconnects, 1, "a replacement also disconnects its envelope")
  audio.configure(false, 0.25)
  assert.equal(context.voices[1].disconnects, 1, "mute stops the active voice")

  audio.configure(true, 0.25)
  const first = audio.play("complete")
  await flush()
  const second = audio.play("complete")
  await flush()
  assert.equal(fetches, 1, "overlapping requests share the fetch")
  assert.equal(context.decodes.length, 1, "overlapping requests share decoding")
  audio.configure(false, 0.25)
  context.decodes[0].resolve({ duration: 0.1 })
  await Promise.all([first, second])
  assert.equal(context.voices.length, 2, "mute during decode must not create a voice later")

  audio.configure(true, 0.4)
  await audio.play("complete")
  assert.equal(context.gains[0].gain.value, 0.4, "cached samples use current volume")
  assert.equal(fetches, 1)
  context.voices[2].onended()
  assert.equal(context.voices[2].disconnects, 1, "finished samples release their node")

  const resume = deferred()
  context.resumeGate = resume.promise
  const waiting = audio.play("copy")
  audio.dispose()
  assert.equal(context.closes, 1)
  // Disposing while resume is pending cannot block the next context.
  await audio.play("copy")
  assert.equal(contexts.length, 2)
  assert.equal(contexts[1].voices.length, 1)
  audio.dispose()
  resume.resolve()
  await waiting
  assert.equal(context.voices.length, 3, "a disposed resume must not create a stale voice")

  const retry = new AudioFeedback()
  retry.configure(true, 0.3)
  const obsolete = retry.play("complete")
  await flush()
  const oldContext = contexts.at(-1)
  retry.dispose()
  const fresh = retry.play("complete")
  await flush()
  const newContext = contexts.at(-1)
  oldContext.decodes[0].reject(new Error("old decode failed"))
  await obsolete
  const overlapping = retry.play("complete")
  await flush()
  assert.equal(newContext.decodes.length, 1, "an obsolete rejection cannot clear the new decode cache")
  newContext.decodes[0].resolve({ duration: 0.1 })
  await Promise.all([fresh, overlapping])
  assert.equal(newContext.voices.length, 1, "only the latest request survives async work")
  retry.dispose()
  console.log("UI feedback: mute, overlap, decode sharing, cleanup, current volume, and disposal races passed")
} finally {
  for (const [key, descriptor] of [["AudioContext", original.context], ["document", original.document], ["fetch", original.fetch]]) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
}
