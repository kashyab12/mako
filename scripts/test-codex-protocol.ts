import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { boundedText, numberValue, type JsonObject } from "../electron/codex-app-json.ts"
import {
  parseJsonRpcEnvelope,
  parseNotification,
  parseThreadResponse,
} from "../electron/codex-app-parse.ts"
import {
  consumeStdout,
  type ProtocolContext,
} from "../electron/codex-app-protocol.ts"
import type { AcpSessionState, AcpUpdate } from "../electron/shared.ts"

assert.deepEqual(parseJsonRpcEnvelope("not-json"), { kind: "invalid" })
assert.deepEqual(parseJsonRpcEnvelope("[]"), { kind: "ignored" })
assert.deepEqual(
  parseJsonRpcEnvelope(
    JSON.stringify({ jsonrpc: "2.0", id: 7, method: "account/read", params: { fresh: true } })
  ),
  {
    kind: "request",
    id: 7,
    method: "account/read",
    params: { fresh: true },
  }
)
assert.deepEqual(
  parseJsonRpcEnvelope(JSON.stringify({ jsonrpc: "2.0", id: "7", result: { ok: true } })),
  { kind: "response", id: "7", result: { ok: true }, error: null }
)
assert.equal(numberValue(Number.NaN), undefined)
assert.equal(boundedText("short", 20), "short")
assert.ok(boundedText("x".repeat(100), 64).includes("output truncated"))

const parsedThread = parseThreadResponse({
  thread: {
    id: "thread-1",
    cwd: "/tmp/project",
    turns: [
      {
        id: "turn-1",
        status: "completed",
        error: null,
        items: [
          { type: "userMessage", id: "user-1", content: [{ type: "text", text: "hello" }] },
          { type: "agentMessage", id: "agent-1", text: "world" },
        ],
      },
    ],
  },
  model: "gpt-5",
})
assert.equal(parsedThread.valid, true)
assert.equal(parseThreadResponse({ thread: { cwd: "/tmp/project" } }).valid, false)
assert.equal(parseNotification("item/agentMessage/delta", { threadId: "thread-1" }), null)

const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
  stdio: ["pipe", "pipe", "pipe"],
})
const state: AcpSessionState = {
  id: "session-1",
  harness: "codex",
  cwd: "/tmp/project",
  status: "ready",
  modes: [],
  currentMode: null,
  configOptions: [],
}
const updates: AcpUpdate[] = []
const requests: Array<{ id: string | number; method: string; params: JsonObject }> = []
const context: ProtocolContext = {
  child,
  threadId: "thread-1",
  currentTurnId: null,
  state,
  nextRequestId: 0,
  pending: new Map(),
  items: new Map(),
  stdoutBuffer: "",
  decoder: new StringDecoder("utf8"),
  exited: false,
  protocol: {
    handleFatal(message) {
      throw new Error(message)
    },
    updateState(patch) {
      Object.assign(state, patch)
    },
    emitUpdate(update) {
      updates.push(update)
    },
    handleServerRequest(id, method, params) {
      requests.push({ id, method, params })
    },
    resolveServerRequest() {},
    clearTurnServerRequests() {},
  },
}

const request = `${JSON.stringify({ id: 4, method: "approval/request", params: { reason: "test" } })}\n`
consumeStdout(context, Buffer.from(request.slice(0, 12)))
assert.equal(requests.length, 0)
consumeStdout(context, Buffer.from(request.slice(12)))
assert.equal(requests[0]?.method, "approval/request")

consumeStdout(
  context,
  Buffer.from(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } })}\n`)
)
assert.equal(context.currentTurnId, "turn-1")
assert.equal(state.status, "running")

consumeStdout(
  context,
  Buffer.from(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "hello" } })}\n`)
)
assert.deepEqual(updates.at(-1), { kind: "text", text: "hello" })

child.kill("SIGTERM")
console.log("Codex JSON-RPC parsing, framing, and streaming checks passed")
