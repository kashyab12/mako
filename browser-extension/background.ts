import { z } from "zod"
import { ExtensionHostMessageSchema } from "../electron/browser-extension-protocol.js"
import { ExtensionRouter } from "./router.js"

const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  profileId: z.string().uuid().optional(),
})
const toggleSchema = z.object({
  kind: z.literal("set-enabled"),
  enabled: z.boolean(),
})
let port: chrome.runtime.Port | null = null
let router: ExtensionRouter | null = null
let connecting = false

async function status(value: string) {
  await chrome.storage.local.set({ status: value })
}

async function connect(): Promise<void> {
  if (port || connecting) return
  connecting = true
  try {
    const settings = settingsSchema.parse(
      await chrome.storage.local.get(["enabled", "profileId"])
    )
    if (!settings.enabled) return
    const profileId = settings.profileId ?? crypto.randomUUID()
    await chrome.storage.local.set({ profileId })
    await status("Connecting to Mako…")
    const next = chrome.runtime.connectNative("dev.mako.browser")
    port = next
    const activeRouter = new ExtensionRouter(chrome, (message) => {
      if (port === next) next.postMessage(message)
    })
    router = activeRouter
    next.onMessage.addListener((value) => {
      const parsed = ExtensionHostMessageSchema.safeParse(value)
      if (!parsed.success) {
        next.disconnect()
        return
      }
      const message = parsed.data
      if (message.kind === "ready") void status("Connected to Mako")
      else if (message.kind === "request")
        void activeRouter.request(message.client, message.command)
      else void activeRouter.disconnect(message.client)
    })
    next.onDisconnect.addListener(() => {
      const failed = Boolean(chrome.runtime.lastError)
      if (port !== next) return
      port = null
      router = null
      void activeRouter.close()
      void status(
        failed
          ? "Open Mako and finish browser setup, then reconnect."
          : "Disconnected from Mako"
      )
      chrome.alarms.create("reconnect", { delayInMinutes: 1 })
    })
    const browser = navigator.userAgent.includes("Edg/") ? "edge" : "chrome"
    next.postMessage({
      kind: "hello",
      profileId,
      browser,
      label: `${browser === "edge" ? "Edge" : "Chrome"} profile ${profileId.slice(0, 6)}`,
    })
  } catch {
    await status("Browser connection could not start. Reconnect to try again.")
  } finally {
    connecting = false
  }
}

chrome.debugger.onEvent.addListener((source, method, params) =>
  router?.event(source, method, params)
)
chrome.debugger.onDetach.addListener((source) => router?.detached(source))
chrome.runtime.onInstalled.addListener(() => void connect())
chrome.runtime.onStartup.addListener(() => void connect())
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect") void connect()
})
chrome.runtime.onMessage.addListener((value, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return
  const parsed = toggleSchema.safeParse(value)
  if (!parsed.success) return
  void (async () => {
    await chrome.storage.local.set({ enabled: parsed.data.enabled })
    if (parsed.data.enabled) await connect()
    else {
      const current = port
      port = null
      await router?.close()
      router = null
      current?.disconnect()
      await chrome.alarms.clear("reconnect")
      await status("Paused")
    }
    respond({ ok: true })
  })()
  return true
})
void connect()
