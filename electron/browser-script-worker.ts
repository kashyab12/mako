import { parentPort } from "node:worker_threads"
import { z } from "zod"
import type { JsonValue } from "./codex-app-json.js"

const port = parentPort
if (!port) throw new Error("Browser scripts run in a worker")
const incoming = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), source: z.string(), runId: z.number() }),
  z.object({
    kind: z.literal("reply"),
    id: z.number(),
    value: z.json().optional(),
    error: z.string().optional(),
  }),
])
const pending = new Map<
  number,
  { resolve: (value: JsonValue) => void; reject: (error: Error) => void }
>()
let sequence = 0
const state: Record<string, JsonValue> = {}
const names = [
  "status",
  "connect",
  "tabs",
  "open",
  "select",
  "release",
  "observe",
  "screenshot",
  "evaluate",
  "cdp",
  "events",
  "navigate",
  "close",
  "click",
  "hover",
  "scroll",
  "type",
  "press",
  "dialog",
  "download",
  "pdf",
  "cookies",
  "frames",
  "wait",
  "history",
  "selectOption",
  "upload",
]
port.on("message", (raw) => {
  const message = incoming.parse(raw)
  if (message.kind === "reply") {
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) request?.reject(new Error(message.error))
    else request?.resolve(message.value ?? null)
    return
  }
  const runId = message.runId
  let active = true
  const requests = new Set<number>()
  const browser = Object.fromEntries(
    names.map((action) => [
      action,
      (args: Record<string, JsonValue> = {}) => {
        if (!active)
          throw new Error(
            "This script has already finished; late browser actions are refused"
          )
        return new Promise<JsonValue>((resolve, reject) => {
          const id = ++sequence
          requests.add(id)
          pending.set(id, {
            resolve: (value) => {
              requests.delete(id)
              resolve(value)
            },
            reject: (error) => {
              requests.delete(id)
              reject(error)
            },
          })
          port.postMessage({
            kind: "call",
            runId,
            id,
            command: { ...args, action },
          })
        })
      },
    ])
  )
  const output = (kind: "output" | "image", value: JsonValue) => {
    if (active) port.postMessage({ kind, runId, value })
  }
  // Trusted local JavaScript. Worker isolation bounds scheduling, not OS authority.
  void Promise.resolve()
    .then(() => {
      const run = new Function(
        "browser",
        "state",
        "console",
        "emitImage",
        `return (async () => {${message.source}\n})()`
      )
      return run(
        browser,
        state,
        {
          log: (...values: JsonValue[]) =>
            output("output", values.length === 1 ? values[0] : values),
        },
        (value: JsonValue) => output("image", value)
      )
    })
    .then(
      (value) => {
        active = false
        if (requests.size)
          port.postMessage({
            kind: "error",
            runId,
            message:
              "Script returned with unawaited browser actions. Their outcome may be unknown; observe before retrying.",
          })
        else port.postMessage({ kind: "done", runId, value: value ?? null })
      },
      (error) => {
        active = false
        port.postMessage({
          kind: "error",
          runId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    )
})
