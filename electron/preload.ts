import { contextBridge, ipcRenderer, webUtils } from "electron"
import {
  createMakoBridge,
  type HostEvent,
  type TerminalEvent,
} from "./shared.js"

const api = createMakoBridge({
  nativeWindowVideo: true,
  // Electron owns and types this trusted local transport's return value.
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, payload: HostEvent) =>
      listener(payload)
    ipcRenderer.on("mako:event", receive)
    return () => {
      ipcRenderer.removeListener("mako:event", receive)
    }
  },
  onTerminalEvent: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalEvent
    ) => listener(payload)
    ipcRenderer.on("mako:terminal-event", receive)
    return () => {
      ipcRenderer.removeListener("mako:terminal-event", receive)
    }
  },
  resolveFileUrl: (url) => url,
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
})
contextBridge.exposeInMainWorld("mako", api)
