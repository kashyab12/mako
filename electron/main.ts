import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { COMMIT_PROMPT, PiHost, defaultWorkspace } from "./host.js"
import type { BootPayload, HostEvent, ThinkingLevel } from "./shared.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged && !process.env.PI_UI_PROD

let window: BrowserWindow | null = null
let host: PiHost | null = null
let starting: Promise<PiHost> | null = null

function emit(event: HostEvent) {
  if (window?.isDestroyed()) return
  window?.webContents.send("pi:event", event)
}

async function ensureHost(): Promise<PiHost> {
  if (host) return host
  starting ??= (async () => {
    const next = new PiHost(emit)
    await next.start(defaultWorkspace())
    host = next
    return next
  })().finally(() => {
    starting = null
  })
  return starting
}

/** Every mutating handler needs a live host; this keeps the call sites honest. */
async function withHost<T>(run: (host: PiHost) => T | Promise<T>): Promise<T> {
  return run(await ensureHost())
}

async function createWindow() {
  nativeTheme.themeSource = "dark"
  window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 900,
    minHeight: 620,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 18 },
    backgroundColor: "#111110",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The transcript is long-lived; keep the renderer warm when hidden.
      backgroundThrottling: false,
    },
  })

  window.once("ready-to-show", () => window?.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  if (isDev) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173")
  } else {
    await window.loadFile(join(__dirname, "../dist/index.html"))
  }
}

function bindIpc() {
  ipcMain.handle("pi:boot", async (): Promise<BootPayload> => {
    const ready = await ensureHost()
    const [git, models] = await Promise.all([ready.gitStatus(), ready.listModels()])
    return {
      session: ready.state(),
      git,
      models,
      capabilities: ready.capabilities(),
      platform: process.platform,
    }
  })

  ipcMain.handle("pi:list-sessions", (_e, cwd?: string, scope?: "workspace" | "all") =>
    withHost((h) => h.listSessions(cwd, scope))
  )
  ipcMain.handle("pi:open-session", (_e, path: string) =>
    withHost(async (h) => {
      await h.openSession(path)
      return h.state()
    })
  )
  ipcMain.handle("pi:new-session", () =>
    withHost(async (h) => {
      await h.newSession()
      return h.state()
    })
  )
  ipcMain.handle("pi:set-cwd", (_e, cwd: string) =>
    withHost(async (h) => {
      await h.setCwd(cwd)
      return h.state()
    })
  )
  ipcMain.handle("pi:set-name", (_e, name: string) => withHost((h) => h.setName(name)))

  ipcMain.handle(
    "pi:prompt",
    (
      _e,
      text: string,
      mode?: "steer" | "followUp",
      images?: Array<{ mimeType: string; data: string }>
    ) => withHost((h) => h.prompt(text, mode, images))
  )
  ipcMain.handle("pi:abort", () => withHost((h) => h.abort()))
  ipcMain.handle("pi:clear-queue", () => withHost((h) => h.clearQueue()))
  ipcMain.handle("pi:navigate-tree", (_e, targetId: string) =>
    withHost(async (h) => {
      await h.navigateTree(targetId)
      return h.state()
    })
  )
  ipcMain.handle("pi:compact", (_e, instructions?: string) => withHost((h) => h.compact(instructions)))
  ipcMain.handle("pi:set-auto-compaction", (_e, enabled: boolean) =>
    withHost((h) => h.setAutoCompaction(enabled))
  )

  ipcMain.handle("pi:list-models", () => withHost((h) => h.listModels()))
  ipcMain.handle("pi:set-model", (_e, provider: string, id: string) =>
    withHost((h) => h.setModel(provider, id))
  )
  ipcMain.handle("pi:set-thinking", (_e, level: ThinkingLevel) => withHost((h) => h.setThinking(level)))

  ipcMain.handle("pi:capabilities", () => withHost((h) => h.capabilities()))
  ipcMain.handle("pi:set-active-tools", (_e, names: string[]) => withHost((h) => h.setActiveTools(names)))
  ipcMain.handle("pi:run-command", (_e, name: string, args?: string) =>
    withHost((h) => h.runCommand(name, args))
  )

  ipcMain.handle("pi:list-files", () => withHost((h) => h.listFiles()))

  ipcMain.handle("pi:git-status", () => withHost((h) => h.gitStatus()))
  ipcMain.handle("pi:git-diff", (_e, path: string) => withHost((h) => h.gitDiff(path)))
  ipcMain.handle("pi:git-stage", (_e, paths: string[]) => withHost((h) => h.gitStage(paths)))
  ipcMain.handle("pi:git-unstage", (_e, paths: string[]) => withHost((h) => h.gitUnstage(paths)))
  ipcMain.handle("pi:git-stage-all", () => withHost((h) => h.gitStageAll()))
  ipcMain.handle("pi:git-unstage-all", () => withHost((h) => h.gitUnstageAll()))
  ipcMain.handle("pi:git-commit", (_e, message: string, options?: { amend?: boolean }) =>
    withHost((h) => h.gitCommit(message, options))
  )
  ipcMain.handle("pi:git-push", () => withHost((h) => h.gitPush()))
  ipcMain.handle("pi:git-log", (_e, limit?: number) => withHost((h) => h.gitLog(limit)))
  ipcMain.handle("pi:git-generate-message", (_e, prompt?: string) =>
    withHost((h) => h.generateCommitMessage(prompt))
  )
  ipcMain.handle("pi:stage-file", (_e, name: string, base64: string) =>
    withHost((h) => h.stageFile(name, base64))
  )
  ipcMain.handle("pi:default-commit-prompt", () => COMMIT_PROMPT)

  ipcMain.handle("pi:pick-folder", async () => {
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle("pi:reveal", (_e, path: string) =>
    withHost(async (h) => {
      // Paths from the UI are workspace-relative; open with the user's default
      // editor rather than only revealing the file in Finder.
      const absolute = await h.resolvePath(path)
      const failure = await shell.openPath(absolute)
      if (failure) shell.showItemInFolder(absolute)
    })
  )
  ipcMain.handle("pi:copy", (_e, text: string) => {
    clipboard.writeText(text)
  })
}

app.whenReady().then(async () => {
  bindIpc()
  await createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  void host?.dispose()
})
