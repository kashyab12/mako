import assert from "node:assert/strict"
import {
  BoundedTerminalHistory,
  JsonLineDecoder,
  TERMINAL_HISTORY_BYTES,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_PROTOCOL_VERSION,
  clampTerminalSize,
  parseTerminalRequest,
  splitTerminalInput,
  splitTerminalOutput,
} from "../electron/terminal-protocol.js"

const size = clampTerminalSize(50_000, -2)
assert.deepEqual(size, { cols: TERMINAL_MAX_COLS, rows: 1 })
assert.equal(clampTerminalSize(80, 24).cols, 80)
assert.equal(clampTerminalSize(80, 24).rows, 24)
assert.equal(TERMINAL_MAX_ROWS, 200)

const accepted = parseTerminalRequest({
  protocol: TERMINAL_PROTOCOL_VERSION,
  id: 1,
  type: "write",
  sessionId: "session-1",
  data: "x".repeat(TERMINAL_MAX_INPUT_BYTES),
})
assert.equal(accepted?.type, "write")
assert.deepEqual(
  parseTerminalRequest({
    protocol: TERMINAL_PROTOCOL_VERSION,
    id: 3,
    type: "ack",
    sessionId: "session-1",
    sequence: 12,
  }),
  { id: 3, type: "ack", sessionId: "session-1", sequence: 12 }
)
assert.deepEqual(
  parseTerminalRequest({
    protocol: TERMINAL_PROTOCOL_VERSION,
    id: 4,
    type: "detach",
    sessionId: "session-1",
  }),
  { id: 4, type: "detach", sessionId: "session-1" }
)
assert.deepEqual(
  parseTerminalRequest({
    protocol: 99,
    id: 9,
    type: "hello",
    clientVersion: "99",
  }),
  {
    protocol: 99,
    id: 9,
    type: "hello",
    clientVersion: "99",
  }
)
assert.equal(
  parseTerminalRequest({
    protocol: TERMINAL_PROTOCOL_VERSION,
    id: 2,
    type: "write",
    sessionId: "session-1",
    data: "x".repeat(TERMINAL_MAX_INPUT_BYTES + 1),
  }),
  null
)

const history = new BoundedTerminalHistory()
history.append("a".repeat(TERMINAL_HISTORY_BYTES))
history.append("tail")
assert.equal(history.byteLength, TERMINAL_HISTORY_BYTES)
assert.ok(history.text().endsWith("tail"))
const restored = new BoundedTerminalHistory()
restored.restore(history.base64())
assert.equal(restored.text(), history.text())

const output = `${"界".repeat(40_000)}${"🙂".repeat(20_000)}`
const chunks = splitTerminalOutput(output)
assert.ok(chunks.length > 1)
assert.equal(chunks.join(""), output)
assert.ok(chunks.every((chunk) => !chunk.includes("�")))
assert.ok(
  splitTerminalInput(output).every(
    (chunk) => Buffer.byteLength(chunk) <= TERMINAL_MAX_INPUT_BYTES
  )
)

const decoder = new JsonLineDecoder()
assert.deepEqual(decoder.push(Buffer.from('{"one":1')), [])
assert.deepEqual(decoder.push(Buffer.from('}\n{"two":2}\n')), [
  { one: 1 },
  { two: 2 },
])

console.log("terminal protocol bounds passed")
