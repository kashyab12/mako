import { BrowserWindow, screen } from "electron"
import { join } from "node:path"
import type { ControlActivity } from "./contracts/control-preview.js"
import type { ControlPreviews } from "./control-previews.js"

/** A single nonactivating picture-in-picture window, independent of the desk layout. */
export class ControlPreviewWindow {
  private window: BrowserWindow | undefined
  private current: string | undefined
  private suppressed: string | undefined
  private pulse: NodeJS.Timeout | undefined
  private readonly previews: ControlPreviews
  private readonly root: string
  private readonly developmentUrl: string | undefined
  constructor(
    previews: ControlPreviews,
    root: string,
    developmentUrl?: string
  ) {
    this.previews = previews
    this.root = root
    this.developmentUrl = developmentUrl
  }

  observe(activity: ControlActivity) {
    if (activity.conversationId === this.suppressed) return
    this.current = activity.conversationId
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("mako:event", {
        type: "control-activity",
        activity,
      })
    }
    if (!this.pulse) {
      this.pulse = setInterval(() => this.refresh(), 500)
      this.pulse.unref()
    }
    this.refresh()
  }

  private refresh() {
    const id = this.current
    if (!id) return
    const preview = this.previews.read(id, true, "native-overlay")
    if (!preview) return
    const idle =
      preview.activity.status !== "running" &&
      Date.now() - preview.activity.updatedAt > 10_000
    if (idle) {
      this.hide(false)
      return
    }
    // Show actual work, never an empty floating box during discovery.
    if ((!preview.frame && !preview.window) || this.window) return
    const work = screen.getPrimaryDisplay().workArea
    const window = new BrowserWindow({
      title: "Mako control preview",
      width: 336,
      height: 242,
      x: work.x + work.width - 360,
      y: work.y + 32,
      minWidth: 280,
      minHeight: 200,
      maxWidth: 680,
      maxHeight: 520,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: join(this.root, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    this.window = window
    window.setContentProtection(true)
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.showInactive()
    })
    window.on("closed", () => {
      if (this.window === window) this.window = undefined
    })
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.webContents.on("will-navigate", (event) => event.preventDefault())
    if (this.developmentUrl) {
      const url = new URL(this.developmentUrl)
      url.searchParams.set("control-preview", id)
      void window.loadURL(url.href)
    } else {
      void window.loadFile(join(this.root, "../dist/index.html"), {
        query: { "control-preview": id },
      })
    }
  }

  hide(suppress = true) {
    if (suppress) this.suppressed = this.current
    if (this.current) this.previews.read(this.current, false, "native-overlay")
    this.current = undefined
    if (this.pulse) clearInterval(this.pulse)
    this.pulse = undefined
    const window = this.window
    this.window = undefined
    window?.destroy()
  }

  close() {
    this.hide(false)
  }
}
