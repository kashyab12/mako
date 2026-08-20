import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../electron/codex-app-json.js"
import {
  registerPreview,
  startPreviewControl,
  stopPreviewControl,
  unregisterPreview,
  type PreviewContents,
} from "../electron/preview-control.js"

function request(
  path: string,
  payload: JsonObject,
  token = process.env.MAKO_PREVIEW_TOKEN
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let output = ""
    socket.setEncoding("utf8")
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ token, request: payload })}\n`
      )
    )
    socket.on("data", (chunk: string) => {
      output += chunk
    })
    socket.on("end", () => {
      try {
        resolve(z.record(z.string(), z.json()).parse(JSON.parse(output)))
      } catch (error) {
        reject(error)
      }
    })
    socket.on("error", reject)
  })
}

const commands: Array<{ method: string; params?: JsonObject }> = []
const lifecycle: string[] = []
let attached = false
let destroyed: (() => void) | undefined
const preview = {
  id: 42,
  debugger: {
    isAttached: () => attached,
    attach: (protocolVersion: string) => {
      lifecycle.push(`attach:${protocolVersion}`)
      attached = true
    },
    sendCommand: async (
      method: string,
      params?: JsonObject
    ): Promise<JsonValue> => {
      commands.push({ method, params })
      return { method, params: params ?? null }
    },
    detach: () => {
      lifecycle.push("detach")
      attached = false
    },
  },
  getURL: () => "http://127.0.0.1:5173/",
  getTitle: () => "Mako fixture",
  isLoading: () => false,
  isDestroyed: () => false,
  once: (_event: "destroyed", listener: () => void) => {
    destroyed = listener
  },
} satisfies PreviewContents

const directory = await mkdtemp(join(tmpdir(), "mako-preview-control-"))
try {
  const path = await startPreviewControl(directory)
  const id = registerPreview(preview)
  assert.equal(id, "preview-42")

  const denied = await request(
    path,
    { action: "list" },
    "0".repeat(64)
  )
  assert.equal(denied.ok, false)
  assert.match(JSON.stringify(denied), /authorization failed/)

  const listed = await request(path, { action: "list" })
  assert.equal(listed.ok, true)
  assert.match(JSON.stringify(listed), /Mako fixture/)

  const snapshot = await request(path, { action: "snapshot", id })
  assert.equal(snapshot.ok, true)
  assert.equal(commands.at(-1)?.method, "Runtime.evaluate")
  assert.deepEqual(lifecycle.slice(-2), ["attach:1.3", "detach"])
  assert.equal(attached, false)
  const lifecycleLength = lifecycle.length
  attached = true
  await request(path, { action: "snapshot", id })
  assert.equal(lifecycle.length, lifecycleLength)
  assert.equal(attached, true)
  attached = false

  await request(path, {
    action: "navigate",
    id,
    url: "https://example.test/path",
  })
  assert.equal(commands.at(-1)?.method, "Page.navigate")

  await request(path, { action: "click", id, x: 20, y: 30 })
  assert.deepEqual(
    commands.slice(-2).map((entry) => entry.params?.type),
    ["mousePressed", "mouseReleased"]
  )

  await request(path, { action: "type", id, text: "hello" })
  assert.equal(commands.at(-1)?.method, "Input.insertText")

  await request(path, { action: "press", id, key: "Enter" })
  assert.deepEqual(
    commands.slice(-2).map((entry) => entry.params?.type),
    ["keyDown", "keyUp"]
  )

  await request(path, { action: "evaluate", id, expression: "2 + 2" })
  assert.equal(commands.at(-1)?.method, "Runtime.evaluate")

  unregisterPreview(id)
  const missing = await request(path, { action: "state", id })
  assert.equal(missing.ok, false)
  destroyed?.()
} finally {
  stopPreviewControl()
  await rm(directory, { recursive: true, force: true })
}

console.log("Preview CDP control checks passed")
