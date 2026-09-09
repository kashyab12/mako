import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, protocol, shell } from "electron"
import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, access } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { hostCallInputs } from "./contracts/host-call-inputs.js"
import { ensureRuntime, runtimeDataRoot } from "./runtime-service.js"
import { invokeRuntime, runtimeFile, subscribeRuntime } from "./runtime-connection.js"

const directory = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged && !process.env.MAKO_PROD
const dataRoot = runtimeDataRoot(app.getPath("appData"), process.env)
const flavor = process.env.MAKO_CLIENT_ID ?? (isDev ? `dev-${createHash("sha256").update(app.getAppPath()).digest("hex").slice(0, 12)}` : "desktop")
if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(flavor)) throw new Error("Invalid Mako client identity")
const uiRoot = `${dataRoot}-ui-${flavor}`
app.setPath("userData", uiRoot)
protocol.registerSchemesAsPrivileged([{ scheme: "mako-file", privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } }])

const launch = { dataRoot, executable: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()], cwd: app.getAppPath(), env: process.env }
const clients = new Map<number, { id: string; connected: boolean; dispose(): void }>()
let runtime: Awaited<ReturnType<typeof ensureRuntime>>
let shuttingDown = false

async function openWindow(preview = false) {
  const id = randomUUID()
  const window = new BrowserWindow({
    title: isDev ? "Mako Dev" : "Mako", width: 1440, height: 960, minWidth: 640, minHeight: 540,
    show: false, titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 },
    webPreferences: { preload: join(directory, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, additionalArguments: [`--mako-client=${id}`] },
  })
  let subscription: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let seen = false
  let closed = false
  const client = { id, connected: false, dispose() { closed = true; clearTimeout(timer); subscription?.() } }
  clients.set(window.webContents.id, client)
  const connect = () => {
    if (closed || shuttingDown) return
    subscription?.()
    subscription = subscribeRuntime(runtime.socket, id, (packet) => {
      if (window.isDestroyed()) return
      if (packet.channel === "ready") {
        client.connected = true
        if (seen) window.webContents.send("mako:event", { type: "host-reconnected" })
        seen = true
      } else window.webContents.send(packet.channel === "event" ? "mako:event" : "mako:terminal-event", packet.payload)
    }, () => {
      client.connected = false
      if (closed || window.isDestroyed()) return
      window.webContents.send("mako:event", { type: "host-disconnected", message: "Reconnecting to the shared Mako host. Unconfirmed messages will not be resent automatically." })
      timer = setTimeout(() => {
        void ensureRuntime(launch).then((next) => { runtime = next; connect() }).catch(() => { if (!closed) timer = setTimeout(connect, 2_000) })
      }, 500)
    })
  }
  connect()
  window.once("closed", () => { client.dispose(); clients.delete(window.webContents.id) })
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); return { action: "deny" } })
  const query = { runtime: "shared", ...(preview ? { preview: id } : {}) }
  if (isDev) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173")
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    await window.loadURL(url.href)
  } else await window.loadFile(join(directory, "../dist/index.html"), { query })
  if (!app.commandLine.hasSwitch("background")) { window.show(); window.maximize() }
  return window
}

async function start() {
  if (!app.requestSingleInstanceLock()) { app.exit(0); return }
  app.on("second-instance", () => { if (runtime) void openWindow() })
  runtime = await ensureRuntime(launch)
  if (!isDev) {
    const target = join(uiRoot, "Local Storage")
    const exists = await access(target).then(() => true, () => false)
    if (!exists) {
      await mkdir(uiRoot, { recursive: true })
      await cp(join(dataRoot, "Local Storage"), target, { recursive: true, errorOnExist: true, force: false }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
    }
  }
  await app.whenReady()
  protocol.handle("mako-file", (request) => runtimeFile(runtime.socket, request))
  for (const [channel, schema] of Object.entries(hostCallInputs)) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      const args = schema.parse(raw)
      const client = clients.get(event.sender.id)
      if (!client) throw new Error("This Mako client has closed")
      if (channel === "mako:open-preview-window") { await openWindow(true); return }
      if (channel === "mako:copy") { clipboard.writeText(z.string().parse(args[0])); return }
      if (channel === "mako:open-url") {
        const url = z.url({ protocol: /^https?$/ }).parse(args[0])
        await shell.openExternal(url)
        return
      }
      if (channel === "mako:pick-folder") {
        const parent = BrowserWindow.fromWebContents(event.sender)
        const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] }
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : result.filePaths[0]
      }
      if (!runtime.info.methods.includes(channel)) throw new Error("This action requires a newer shared host. Existing agents have not been restarted.")
      const result = await invokeRuntime(runtime.socket, client.id, channel, args)
      if (channel === "mako:boot") return { ...z.record(z.string(), z.json()).parse(result), sourceRoot: isDev ? app.getAppPath() : undefined }
      return result
    })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Mako", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]))
  await openWindow()
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) void openWindow() })
}

app.on("before-quit", () => { shuttingDown = true; for (const client of clients.values()) client.dispose() })
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit() })
void start().catch(async (error) => {
  await app.whenReady()
  dialog.showErrorBox("Mako could not attach to its shared host", error instanceof Error ? error.message : "Shared host startup failed")
  app.exit(1)
})
