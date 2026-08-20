import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type Server, type Socket } from "node:net"
import { chmod, mkdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { JsonObject, JsonValue } from "./codex-app-json.js"

export interface PreviewContents {
  id: number
  debugger: {
    isAttached(): boolean
    attach(protocolVersion: string): void
    sendCommand(method: string, params?: JsonObject): Promise<JsonValue>
    detach(): void
  }
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  isDestroyed(): boolean
  once(event: "destroyed", listener: () => void): void
}

const MAX_LINE = 256 * 1024
const RequestPayloadSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("state"), id: z.string() }).strict(),
  z
    .object({
      action: z.literal("navigate"),
      id: z.string(),
      url: z.url(),
    })
    .strict(),
  z.object({ action: z.literal("snapshot"), id: z.string() }).strict(),
  z
    .object({
      action: z.literal("evaluate"),
      id: z.string(),
      expression: z.string().min(1).max(100_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("click"),
      id: z.string(),
      x: z.number().finite(),
      y: z.number().finite(),
    })
    .strict(),
  z
    .object({
      action: z.literal("type"),
      id: z.string(),
      text: z.string().max(100_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("press"),
      id: z.string(),
      key: z.string().min(1).max(64),
    })
    .strict(),
])
const RequestSchema = z
  .object({
    token: z.string().length(64),
    request: RequestPayloadSchema,
  })
  .strict()

type Request = z.infer<typeof RequestPayloadSchema>

let server: Server | null = null
let socketPath: string | null = null
let accessToken: string | null = null
const previews = new Map<string, PreviewContents>()

function previewId(contents: PreviewContents): string {
  return `preview-${contents.id}`
}

function state(contents: PreviewContents) {
  return {
    id: previewId(contents),
    url: contents.getURL(),
    title: contents.getTitle(),
    loading: contents.isLoading(),
  }
}

function getPreview(id: string): PreviewContents {
  const contents = previews.get(id)
  if (!contents || contents.isDestroyed()) {
    previews.delete(id)
    throw new Error(`No live Mako Preview named ${id}`)
  }
  return contents
}

async function command(
  contents: PreviewContents,
  method: string,
  params: JsonObject = {}
): Promise<JsonValue> {
  const attached = contents.debugger.isAttached()
  if (!attached) contents.debugger.attach("1.3")
  try {
    return await contents.debugger.sendCommand(method, params)
  } finally {
    if (!attached && contents.debugger.isAttached()) contents.debugger.detach()
  }
}

async function execute(request: Request): Promise<JsonValue> {
  if (request.action === "list") {
    return [...previews.values()]
      .filter((contents) => !contents.isDestroyed())
      .map(state)
  }
  const contents = getPreview(request.id)
  switch (request.action) {
    case "state":
      return state(contents)
    case "navigate": {
      const url = new URL(request.url)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Mako Preview navigation allows only HTTP and HTTPS")
      }
      await command(contents, "Page.navigate", { url: url.toString() })
      return state(contents)
    }
    case "snapshot":
      return command(contents, "Runtime.evaluate", {
        expression: `(() => ({
          url: location.href,
          title: document.title,
          text: (document.body?.innerText ?? "").slice(0, 100000),
          elements: [...document.querySelectorAll("a,button,input,textarea,select,[role]")].slice(0, 300).map((element, index) => {
            const box = element.getBoundingClientRect()
            return {
              index,
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              name: element.getAttribute("aria-label") || element.getAttribute("name") || element.textContent?.trim().slice(0, 200) || "",
              type: element.getAttribute("type"),
              disabled: "disabled" in element && Boolean(element.disabled),
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
            }
          })
        }))()`,
        returnByValue: true,
        awaitPromise: true,
      })
    case "evaluate":
      return command(contents, "Runtime.evaluate", {
        expression: request.expression,
        returnByValue: true,
        awaitPromise: true,
      })
    case "click":
      await command(contents, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: request.x,
        y: request.y,
        button: "left",
        clickCount: 1,
      })
      await command(contents, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: request.x,
        y: request.y,
        button: "left",
        clickCount: 1,
      })
      return { ok: true }
    case "type":
      await command(contents, "Input.insertText", { text: request.text })
      return { ok: true }
    case "press":
      await command(contents, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: request.key,
      })
      await command(contents, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: request.key,
      })
      return { ok: true }
  }
}

type PreviewResponse =
  | { ok: true; result: JsonValue }
  | { ok: false; error: string }

function authorized(candidate: string): boolean {
  if (!accessToken) return false
  const left = Buffer.from(candidate)
  const right = Buffer.from(accessToken)
  return left.length === right.length && timingSafeEqual(left, right)
}

function respond(socket: Socket, response: PreviewResponse): void {
  socket.end(`${JSON.stringify(response)}\n`)
}

function accept(socket: Socket): void {
  let input = ""
  let handled = false
  socket.setEncoding("utf8")
  socket.on("data", (chunk: string) => {
    if (handled) return
    input += chunk
    if (input.length > MAX_LINE) {
      handled = true
      respond(socket, { ok: false, error: "Preview request is too large" })
      return
    }
    const newline = input.indexOf("\n")
    if (newline < 0) return
    handled = true
    const line = input.slice(0, newline)
    void Promise.resolve()
      .then(() => RequestSchema.parse(JSON.parse(line)))
      .then((envelope) => {
        if (!authorized(envelope.token)) {
          throw new Error("Mako Preview authorization failed")
        }
        return execute(envelope.request)
      })
      .then((result) => respond(socket, { ok: true, result }))
      .catch((error: Error) =>
        respond(socket, { ok: false, error: error.message })
      )
  })
}

export async function startPreviewControl(stateDir: string): Promise<string> {
  if (server && socketPath) return socketPath
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\mako-preview-${process.pid}`
      : join(stateDir, `preview-${process.pid}.sock`)
  if (process.platform !== "win32") {
    await unlink(path).catch(() => undefined)
  }
  const next = createServer(accept)
  await new Promise<void>((resolve, reject) => {
    next.once("error", reject)
    next.listen(path, resolve)
  })
  server = next
  socketPath = path
  accessToken = randomBytes(32).toString("hex")
  process.env.MAKO_PREVIEW_SOCKET = path
  process.env.MAKO_PREVIEW_TOKEN = accessToken
  return path
}

export function registerPreview(contents: PreviewContents): string {
  const id = previewId(contents)
  previews.set(id, contents)
  contents.once("destroyed", () => previews.delete(id))
  return id
}

export function unregisterPreview(id: string): void {
  previews.delete(id)
}

export function stopPreviewControl(): void {
  const running = server
  const path = socketPath
  server = null
  socketPath = null
  accessToken = null
  previews.clear()
  delete process.env.MAKO_PREVIEW_SOCKET
  delete process.env.MAKO_PREVIEW_TOKEN
  running?.close()
  if (path && process.platform !== "win32") {
    void unlink(path).catch(() => undefined)
  }
}
