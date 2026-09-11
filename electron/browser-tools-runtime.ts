import { Worker } from "node:worker_threads"
import { existsSync } from "node:fs"
import { z } from "zod"
import {
  BrowserCommandSchema,
  BrowserFault,
  type BrowserCommand,
} from "./contracts/browser-control.js"
import type { JsonValue } from "./codex-app-json.js"

export type BrowserCall = (
  command: BrowserCommand,
  signal: AbortSignal
) => Promise<JsonValue>
const imageSchema = z.object({
  data: z.string().max(24 * 1024 * 1024),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  target: z.json(),
  coordinates: z.json().optional(),
  clip: z.json().optional(),
})
const messageSchema = z.discriminatedUnion("kind", [
  z.object({
    runId: z.number(),
    kind: z.literal("call"),
    id: z.number(),
    command: BrowserCommandSchema,
  }),
  z.object({ runId: z.number(), kind: z.literal("output"), value: z.json() }),
  z.object({ runId: z.number(), kind: z.literal("image"), value: imageSchema }),
  z.object({ runId: z.number(), kind: z.literal("done"), value: z.json() }),
  z.object({
    runId: z.number(),
    kind: z.literal("error"),
    message: z.string(),
  }),
])
/** Matches the direct tool budget so a script cannot smuggle a larger result. */
const TEXT_BLOCK_BUDGET = 200_000
export type BrowserOutput =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

/** One bounded script worker per MCP client; approved transport lives in the host. */
export class BrowserToolsRuntime {
  private sequence = 0
  private worker?: Worker
  private tail: Promise<void> = Promise.resolve()
  private readonly stopping = new AbortController()
  private readonly call: BrowserCall
  constructor(call: BrowserCall) {
    this.call = call
  }

  run(source: string, signal: AbortSignal): Promise<BrowserOutput[]> {
    const active = AbortSignal.any([signal, this.stopping.signal])
    const result = this.tail.then(() => {
      active.throwIfAborted()
      return this.execute(source, active)
    })
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private execute(
    source: string,
    signal: AbortSignal
  ): Promise<BrowserOutput[]> {
    const compiled = new URL("./browser-script-worker.js", import.meta.url)
    this.worker ??= new Worker(
      existsSync(compiled)
        ? compiled
        : new URL("./browser-script-worker.ts", import.meta.url),
      { env: {}, resourceLimits: { maxOldGenerationSizeMb: 128 } }
    )
    const worker = this.worker
    const runId = ++this.sequence
    const controller = new AbortController()
    const active = AbortSignal.any([signal, controller.signal])
    return new Promise((resolve, reject) => {
      const output: BrowserOutput[] = []
      let bytes = 0
      let finished = false
      const finish = (error?: Error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        worker.removeListener("message", message)
        worker.removeListener("error", failed)
        worker.removeListener("exit", exited)
        controller.abort()
        if (error) {
          this.worker = undefined
          void worker.terminate()
          reject(error)
        } else resolve(output)
      }
      const append = (block: BrowserOutput) => {
        bytes +=
          block.type === "text"
            ? Buffer.byteLength(block.text)
            : Buffer.byteLength(block.data)
        if (
          bytes > 28 * 1024 * 1024 ||
          (block.type === "text" &&
            Buffer.byteLength(block.text) > TEXT_BLOCK_BUDGET)
        )
          finish(
            new BrowserFault({
              code: "output-limit",
              message:
                "Script output exceeded its limit (200 KB per text value, 28 MB in total). Return a smaller result: select fields, slice arrays, or use a compressed screenshot.",
              outcome: "unknown",
            })
          )
        else output.push(block)
      }
      const failed = (error: Error) => finish(error)
      const exited = () =>
        finish(
          new Error(
            "Browser script worker exited. Its last action may have completed."
          )
        )
      const message = (raw: JsonValue) => {
        const parsed = messageSchema.safeParse(raw)
        if (!parsed.success) {
          finish(new Error("Browser script returned an invalid message"))
          return
        }
        const value = parsed.data
        if (value.runId !== runId || finished) return
        if (value.kind === "call") {
          void this.call(value.command, active).then(
            (result) => {
              if (!finished)
                worker.postMessage({
                  kind: "reply",
                  id: value.id,
                  value: result,
                })
            },
            (error) => {
              if (!finished)
                worker.postMessage({
                  kind: "reply",
                  id: value.id,
                  error: error instanceof Error ? error.message : String(error),
                })
            }
          )
        } else if (value.kind === "output")
          append({ type: "text", text: JSON.stringify(value.value) })
        else if (value.kind === "image") {
          append({
            type: "text",
            text: JSON.stringify({
              target: value.value.target,
              coordinates: value.value.coordinates,
              clip: value.value.clip,
            }),
          })
          append({
            type: "image",
            data: value.value.data,
            mimeType: value.value.mimeType,
          })
        } else if (value.kind === "error") finish(new Error(value.message))
        else {
          if (value.value !== null)
            append({ type: "text", text: JSON.stringify(value.value) })
          finish()
        }
      }
      const abort = () =>
        finish(
          new BrowserFault({
            code: "cancelled",
            message:
              "Script cancelled. The worker was stopped; observe any dispatched browser action before retrying.",
            outcome: "unknown",
          })
        )
      const timer = setTimeout(
        () =>
          finish(
            new BrowserFault({
              code: "timed-out",
              message:
                "Script exceeded 60 seconds. Observe before retrying; script state was reset.",
              outcome: "unknown",
            })
          ),
        60_000
      )
      signal.addEventListener("abort", abort, { once: true })
      worker.on("message", message)
      worker.once("error", failed)
      worker.once("exit", exited)
      worker.postMessage({ kind: "run", runId, source })
    })
  }

  async close(): Promise<void> {
    this.stopping.abort()
    await this.tail
    await this.worker?.terminate()
    this.worker = undefined
  }
}
