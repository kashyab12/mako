import { WebSocketServer, type WebSocket } from "ws"
import { z } from "zod"
import type { JsonObject } from "../electron/codex-app-json.js"

const commandSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.json()),
  sessionId: z.string().optional(),
})
export async function browserFixture() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const { port } = z.object({ port: z.number() }).parse(server.address())
  let connections = 0
  let sequence = 0
  const targets = new Map<string, { title: string; url: string }>()
  const sessions = new Map<string, string>()
  const calls: z.infer<typeof commandSchema>[] = []
  const sockets = new Set<WebSocket>()
  const axNodes: JsonObject[] = [
    {
      nodeId: "1",
      ignored: false,
      backendDOMNodeId: 1,
      role: { value: "textbox" },
      name: { value: "Proof" },
    },
  ]
  let delayed: (() => void) | undefined
  server.on("connection", (socket) => {
    connections++
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("message", (raw) => {
      const command = commandSchema.parse(JSON.parse(raw.toString()))
      calls.push(command)
      const reply = (result: JsonObject) =>
        socket.send(JSON.stringify({ id: command.id, result }))
      const fail = (message: string) =>
        socket.send(
          JSON.stringify({ id: command.id, error: { code: -32000, message } })
        )
      const tab = command.sessionId
        ? sessions.get(command.sessionId)
        : undefined
      if (command.sessionId && (!tab || !targets.has(tab))) {
        fail("Session with given id not found")
        return
      }
      switch (command.method) {
        case "Target.createTarget": {
          const targetId = `tab-${++sequence}`
          targets.set(targetId, { title: targetId, url: "about:blank" })
          reply({ targetId })
          break
        }
        case "Target.getTargets":
          reply({
            targetInfos: Array.from(targets, ([targetId, info]) => ({
              targetId,
              type: "page",
              ...info,
            })),
          })
          break
        case "Target.getTargetInfo": {
          const id = z.string().parse(command.params.targetId)
          const info = targets.get(id)
          if (!info) fail("No target with given id")
          else reply({ targetInfo: { targetId: id, type: "page", ...info } })
          break
        }
        case "Target.attachToTarget": {
          const sessionId = `session-${++sequence}`
          sessions.set(sessionId, z.string().parse(command.params.targetId))
          reply({ sessionId })
          break
        }
        case "Target.detachFromTarget":
          sessions.delete(z.string().parse(command.params.sessionId))
          reply({})
          break
        case "Target.closeTarget":
          targets.delete(z.string().parse(command.params.targetId))
          reply({ success: true })
          break
        case "Runtime.evaluate":
          reply({
            result: {
              value:
                command.params.expression === "window.devicePixelRatio"
                  ? 2
                  : tab,
            },
          })
          break
        case "Accessibility.getFullAXTree":
          reply({ nodes: axNodes })
          break
        case "Page.getLayoutMetrics":
          reply({
            cssContentSize: { x: 0, y: 0, width: 800, height: 2000 },
            cssVisualViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: 800,
              clientHeight: 600,
            },
          })
          break
        case "Page.navigate":
          reply({ frameId: "frame", loaderId: "loader" })
          socket.send(
            JSON.stringify({
              method: "Page.lifecycleEvent",
              sessionId: command.sessionId,
              params: { frameId: "frame", loaderId: "loader", name: "load" },
            })
          )
          break
        case "Page.captureScreenshot":
          reply({
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=",
          })
          break
        case "Input.insertText":
          if (command.params.text === "delay") delayed = () => reply({})
          else reply({})
          break
        default:
          reply({})
      }
    })
  })
  return {
    definition: {
      id: "fixture",
      name: "Fixture Chrome",
      endpoint: async () => `ws://127.0.0.1:${port}/devtools/browser/fixture`,
    },
    connections: () => connections,
    calls,
    axNodes,
    targets,
    completeDelayed: () => {
      delayed?.()
      delayed = undefined
    },
    disconnect: () => {
      for (const socket of sockets) socket.terminate()
    },
    async close() {
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
