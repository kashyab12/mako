import assert from "node:assert/strict"
import { createTerminalWriter } from "../src/lib/terminal-writer.ts"

const scheduled: Array<() => void> = []
const writes: string[] = []
const replacements: string[] = []
const rendered: number[] = []
const completions: Array<() => void> = []
const errors: string[] = []
const writer = createTerminalWriter({
  write: (data, done) => {
    writes.push(data)
    completions.push(done)
  },
  replace: (data, done) => {
    replacements.push(data)
    completions.push(done)
  },
  onRendered: (sequence) => rendered.push(sequence),
  onError: (error) => errors.push(error.message),
  schedule: (flush) => scheduled.push(flush),
})

writer.push({ data: "a", sequence: 1 })
writer.push({ data: "b", sequence: 2 })
assert.equal(scheduled.length, 1)
scheduled.shift()?.()
assert.deepEqual(writes, ["ab"])
writer.push({ data: "c", sequence: 3 })
writer.replace({ data: "snapshot", sequence: 8 })
completions.shift()?.()
assert.deepEqual(rendered, [2])
assert.equal(scheduled.length, 1)
scheduled.shift()?.()
assert.deepEqual(replacements, ["snapshot"])
completions.shift()?.()
assert.deepEqual(rendered, [2, 8])
assert.deepEqual(writes, ["ab"])

writer.push({ data: "tail", sequence: 9 })
scheduled.shift()?.()
completions.shift()?.()
assert.deepEqual(writes, ["ab", "tail"])
assert.deepEqual(rendered, [2, 8, 9])
assert.deepEqual(errors, [])
writer.dispose()

const stallErrors: string[] = []
const stalled = createTerminalWriter({
  write: () => {},
  replace: () => {},
  onRendered: () => {},
  onError: (error) => stallErrors.push(error.message),
  stallTimeoutMs: 10,
})
stalled.push({ data: "stalled", sequence: 1 })
await new Promise((resolve) => setTimeout(resolve, 30))
assert.deepEqual(stallErrors, ["Terminal renderer stopped acknowledging output"])
stalled.dispose()

console.log("terminal writer checks passed")
