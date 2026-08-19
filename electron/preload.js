import { contextBridge, ipcRenderer } from "electron"

const api = {
  ready: () => ipcRenderer.invoke("mako:ready"),
  listSessions: (cwd) => ipcRenderer.invoke("mako:list-sessions", cwd),
  openSession: (path) => ipcRenderer.invoke("mako:open-session", path),
  newSession: () => ipcRenderer.invoke("mako:new-session"),
  setCwd: (cwd) => ipcRenderer.invoke("mako:set-cwd", cwd),
  prompt: (text) => ipcRenderer.invoke("mako:prompt", text),
  abort: () => ipcRenderer.invoke("mako:abort"),
  navigateTree: (targetId) => ipcRenderer.invoke("mako:navigate-tree", targetId),
  setName: (name) => ipcRenderer.invoke("mako:set-name", name),
  listModels: () => ipcRenderer.invoke("mako:list-models"),
  setModel: (provider, id) => ipcRenderer.invoke("mako:set-model", provider, id),
  setThinking: (level) => ipcRenderer.invoke("mako:set-thinking", level),
  git: () => ipcRenderer.invoke("mako:git"),
  pickFolder: () => ipcRenderer.invoke("mako:pick-folder"),
  onEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload)
    ipcRenderer.on("mako:event", wrapped)
    return () => ipcRenderer.removeListener("mako:event", wrapped)
  },
}

contextBridge.exposeInMainWorld("mako", api)
