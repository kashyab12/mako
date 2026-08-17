import { contextBridge, ipcRenderer } from "electron"

const api = {
  ready: () => ipcRenderer.invoke("pi:ready"),
  listSessions: (cwd) => ipcRenderer.invoke("pi:list-sessions", cwd),
  openSession: (path) => ipcRenderer.invoke("pi:open-session", path),
  newSession: () => ipcRenderer.invoke("pi:new-session"),
  setCwd: (cwd) => ipcRenderer.invoke("pi:set-cwd", cwd),
  prompt: (text) => ipcRenderer.invoke("pi:prompt", text),
  abort: () => ipcRenderer.invoke("pi:abort"),
  navigateTree: (targetId) => ipcRenderer.invoke("pi:navigate-tree", targetId),
  setName: (name) => ipcRenderer.invoke("pi:set-name", name),
  listModels: () => ipcRenderer.invoke("pi:list-models"),
  setModel: (provider, id) => ipcRenderer.invoke("pi:set-model", provider, id),
  setThinking: (level) => ipcRenderer.invoke("pi:set-thinking", level),
  git: () => ipcRenderer.invoke("pi:git"),
  pickFolder: () => ipcRenderer.invoke("pi:pick-folder"),
  onEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload)
    ipcRenderer.on("pi:event", wrapped)
    return () => ipcRenderer.removeListener("pi:event", wrapped)
  },
}

contextBridge.exposeInMainWorld("pi", api)
