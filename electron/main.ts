import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { COMMIT_PROMPT, type AgentHost } from "./host.js"
import { breadcrumb, clearCrashes, crashesDir, installCrashReporting, listCrashes, record } from "./crash.js"
import { HostPool } from "./pool.js"
import { listPlugins, pluginsDir, watchPlugins, writePlugin } from "./plugins.js"
import type { BootPayload, HostEvent, SearchOptions, ThinkingLevel } from "./shared.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged && !process.env.MAKO_PROD

/**
 * The Dock and window icon.
 *
 * A raw square PNG is not a macOS icon: the system draws it exactly as given,
 * so it renders with hard corners and no margin — visibly larger and squarer
 * than everything beside it. `build/Mako.icns` carries Apple's icon grid
 * (824 of 1024, 185.4pt corner radius, transparent margin) and is preferred
 * wherever it is present; the PNG is only a fallback.
 */
function appIcon() {
  const candidates = [
    join(__dirname, "../build/Mako.icns"),
    isDev
      ? join(__dirname, "../public/icons/app-icon.png")
      : join(__dirname, "../dist/icons/app-icon.png"),
  ]
  for (const file of candidates) {
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) return image
  }
  return undefined
}

let window: BrowserWindow | null = null
const pool = new HostPool(emit)
let starting: Promise<unknown> | null = null

function emit(event: HostEvent) {
  if (window?.isDestroyed()) return
  window?.webContents.send("pi:event", event)
}

/** Start the first tab once, however many callers race for it. */
async function ready(): Promise<HostPool> {
  starting ??= pool.ensure().finally(() => {
    starting = null
  })
  await starting
  return pool
}

/**
 * Run against the tab in front.
 *
 * Every command from the UI is aimed at the conversation on screen — that is
 * the only one with a composer pointed at it — so tab routing does not need to
 * reach the handlers. Background tabs keep streaming; they just take no orders.
 */
async function withHost<T>(run: (host: AgentHost) => T | Promise<T>): Promise<T> {
  const live = await ready()
  return run(live.active)
}

async function createWindow() {
  nativeTheme.themeSource = "dark"
  const icon = appIcon()
  if (icon && process.platform === "darwin") app.dock?.setIcon(icon)

  window = new BrowserWindow({
    title: "Mako",
    ...(icon ? { icon } : {}),
    width: 1480,
    height: 940,
    minWidth: 900,
    minHeight: 620,
    titleBarStyle: "hiddenInset",
    // Centred in the 38px title strip, not eyeballed: the button group is 12px
    // tall, so (38 - 12) / 2 puts it on the same line as the panel toggles
    // beside it. At y:18 it sat five pixels low and the whole row read as
    // broken.
    trafficLightPosition: { x: 14, y: 13 },
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

  // Renderer console output, in the terminal you started the app from.
  //
  // Without this the window is a black box: a component that throws leaves no
  // trace anywhere you are looking, which is exactly how a crash-on-boot went
  // unnoticed through a passing typecheck. Dev only — in a packaged build this
  // becomes the crash reporter's job, not stdout's.
  if (isDev) {
    window.webContents.on("console-message", (details) => {
      const where = details.lineNumber ? ` (${details.sourceId}:${details.lineNumber})` : ""
      console.log(`[renderer:${details.level}] ${details.message}${where}`)
    })
  }

  // A dead renderer is a blank window with no way back. Record it, then reload
  // once — the agent's runtimes live in this process and survived, so the
  // conversation is still there on the other side of a reload.
  window.webContents.on("render-process-gone", (_event, details) => {
    record("renderer-gone", new Error(`renderer exited: ${details.reason}`))
    if (details.reason === "clean-exit" || window?.isDestroyed()) return
    setTimeout(() => {
      if (!window || window.isDestroyed()) return
      window.reload()
    }, 400)
  })

  // The agent writes a plugin with its ordinary file tools and the window
  // re-evaluates it — no IPC for it to learn, no command for the user to run.
  const watcher = watchPlugins(() => emit({ type: "plugins-changed" }))
  window.once("closed", () => watcher?.close())
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

/**
 * Every IPC call, wrapped once.
 *
 * Two things fall out of doing this in one place rather than at forty call
 * sites: a breadcrumb per call, so a crash report says what the app was doing;
 * and a recorded report for any handler that throws, which until now surfaced
 * only as a toast and left nothing behind to read afterwards.
 *
 * The breadcrumb is the channel name and nothing else. Arguments would mean
 * keeping the user's prompts and source on disk, which the crash file promises
 * not to do.
 */
function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]) {
  ipcMain.handle(channel, async (event, ...args) => {
    breadcrumb(channel)
    try {
      return await listener(event, ...args)
    } catch (error) {
      record("main-uncaught", error, channel)
      throw error
    }
  })
}

function bindIpc() {
  handle("pi:boot", async (): Promise<BootPayload> => {
    const live = await ready()
    const [tabs, models] = await Promise.all([live.snapshots(), live.active.listModels()])
    return {
      tabs,
      activeTabId: live.activeId,
      models,
      platform: process.platform,
      // Only when the renderer is coming from Vite: that is exactly the
      // condition under which an edit here shows up without a restart.
      sourceRoot: isDev ? app.getAppPath() : undefined,
    }
  })

  handle("pi:open-tab", async (_e, options?: { cwd?: string; sessionPath?: string }) => {
    const live = await ready()
    return live.open(options ?? {})
  })
  handle("pi:close-tab", async (_e, id: string) => {
    const live = await ready()
    return live.close(id)
  })
  handle("pi:activate-tab", async (_e, id: string) => {
    const live = await ready()
    return live.activate(id)
  })

  handle("pi:list-sessions", (_e, cwd?: string, scope?: "workspace" | "all") =>
    withHost((h) => h.listSessions(cwd, scope))
  )
  handle("pi:open-session", (_e, path: string) =>
    withHost(async (h) => {
      await h.openSession(path)
      return h.state()
    })
  )
  handle("pi:new-session", () =>
    withHost(async (h) => {
      await h.newSession()
      return h.state()
    })
  )
  handle("pi:set-cwd", (_e, cwd: string) =>
    withHost(async (h) => {
      await h.setCwd(cwd)
      return h.state()
    })
  )
  handle("pi:set-name", (_e, name: string) => withHost((h) => h.setName(name)))

  ipcMain.handle(
    "pi:prompt",
    (
      _e,
      text: string,
      mode?: "steer" | "followUp",
      images?: Array<{ mimeType: string; data: string }>
    ) => withHost((h) => h.prompt(text, mode, images))
  )
  handle("pi:abort", () => withHost((h) => h.abort()))
  handle("pi:clear-queue", () => withHost((h) => h.clearQueue()))
  // Branching opens a tab rather than replacing this one. Exploring the same
  // question two ways only works if both answers stay on screen.
  handle("pi:fork", async (_e, entryId: string) => {
    const live = await ready()
    return live.forkIntoTab(entryId)
  })
  handle("pi:navigate-tree", (_e, targetId: string) =>
    withHost(async (h) => {
      await h.navigateTree(targetId)
      return h.state()
    })
  )
  handle("pi:compact", (_e, instructions?: string) => withHost((h) => h.compact(instructions)))
  handle("pi:set-auto-compaction", (_e, enabled: boolean) =>
    withHost((h) => h.setAutoCompaction(enabled))
  )

  handle("pi:list-models", () => withHost((h) => h.listModels()))
  handle("pi:set-model", (_e, provider: string, id: string) =>
    withHost((h) => h.setModel(provider, id))
  )
  handle("pi:set-thinking", (_e, level: ThinkingLevel) => withHost((h) => h.setThinking(level)))

  handle("pi:capabilities", () => withHost((h) => h.capabilities()))
  handle("pi:set-active-tools", (_e, names: string[]) => withHost((h) => h.setActiveTools(names)))
  handle("pi:run-command", (_e, name: string, args?: string) =>
    withHost((h) => h.runCommand(name, args))
  )

  handle("pi:list-files", () => withHost((h) => h.listFiles()))
  handle("pi:read-file", (_e, path: string) => withHost((h) => h.readWorkspaceFile(path)))
  handle("pi:search", (_e, query: string, options?: SearchOptions) =>
    withHost((h) => h.search(query, options))
  )

  handle("pi:git-status", () => withHost((h) => h.gitStatus()))
  handle("pi:git-diff", (_e, path: string) => withHost((h) => h.gitDiff(path)))
  handle("pi:git-stage", (_e, paths: string[]) => withHost((h) => h.gitStage(paths)))
  handle("pi:git-unstage", (_e, paths: string[]) => withHost((h) => h.gitUnstage(paths)))
  handle("pi:git-stage-all", () => withHost((h) => h.gitStageAll()))
  handle("pi:git-unstage-all", () => withHost((h) => h.gitUnstageAll()))
  handle("pi:git-commit", (_e, message: string, options?: { amend?: boolean }) =>
    withHost((h) => h.gitCommit(message, options))
  )
  handle("pi:git-push", () => withHost((h) => h.gitPush()))
  handle("pi:git-log", (_e, limit?: number) => withHost((h) => h.gitLog(limit)))
  handle("pi:git-generate-message", (_e, prompt?: string) =>
    withHost((h) => h.generateCommitMessage(prompt))
  )
  handle("pi:stage-file", (_e, name: string, base64: string) =>
    withHost((h) => h.stageFile(name, base64))
  )
  handle("pi:default-commit-prompt", () => COMMIT_PROMPT)

  handle("pi:list-plugins", () => listPlugins())
  handle("pi:plugins-dir", () => pluginsDir())
  handle("pi:write-plugin", (_e, id: string, source: string) => writePlugin(id, source))

  handle("pi:pick-folder", async () => {
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  handle("pi:reveal", (_e, path: string) =>
    withHost(async (h) => {
      // Paths from the UI are workspace-relative; open with the user's default
      // editor rather than only revealing the file in Finder.
      const absolute = await h.resolvePath(path)
      const failure = await shell.openPath(absolute)
      if (failure) shell.showItemInFolder(absolute)
    })
  )
  handle("pi:crashes", () => listCrashes())
  handle("pi:crashes-dir", () => crashesDir())
  handle("pi:clear-crashes", () => clearCrashes())
  ipcMain.handle(
    "pi:report-crash",
    (
      _e,
      kind: "renderer-error" | "renderer-rejection",
      payload: { message: string; stack?: string; source?: string }
    ) => {
      const error = new Error(payload.message)
      error.stack = payload.stack
      record(kind, error, payload.source)
    }
  )

  handle("pi:copy", (_e, text: string) => {
    clipboard.writeText(text)
  })
}

installCrashReporting()

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
  void pool.dispose()
})
