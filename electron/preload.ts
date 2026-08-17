import { contextBridge, ipcRenderer } from "electron"
import type {
  BootPayload,
  Capabilities,
  GitCommitEntry,
  GitDiff,
  GitStatus,
  HostEvent,
  ModelInfo,
  SessionState,
  SessionSummary,
  StagedFile,
  TabSnapshot,
  ThinkingLevel,
  WorkspaceFile,
} from "./shared.js"

const invoke = <T>(channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api = {
  boot: () => invoke<BootPayload>("pi:boot"),

  /* Tabs. Session-scoped calls below always address the active tab. */
  openTab: (options?: { cwd?: string; sessionPath?: string }) =>
    invoke<TabSnapshot>("pi:open-tab", options),
  closeTab: (id: string) =>
    invoke<{ tabs: string[]; activeId: string; opened?: TabSnapshot }>("pi:close-tab", id),
  activateTab: (id: string) => invoke<boolean>("pi:activate-tab", id),

  listSessions: (cwd?: string, scope?: "workspace" | "all") =>
    invoke<SessionSummary[]>("pi:list-sessions", cwd, scope),
  openSession: (path: string) => invoke<SessionState>("pi:open-session", path),
  newSession: () => invoke<SessionState>("pi:new-session"),
  setCwd: (cwd: string) => invoke<SessionState>("pi:set-cwd", cwd),
  setName: (name: string) => invoke<void>("pi:set-name", name),

  prompt: (
    text: string,
    mode?: "steer" | "followUp",
    images?: Array<{ mimeType: string; data: string }>
  ) => invoke<void>("pi:prompt", text, mode, images),
  abort: () => invoke<void>("pi:abort"),
  clearQueue: () => invoke<void>("pi:clear-queue"),
  navigateTree: (targetId: string) => invoke<SessionState>("pi:navigate-tree", targetId),
  fork: (entryId: string) =>
    invoke<{ cancelled: true } | { cancelled: false; text?: string; tab: TabSnapshot }>(
      "pi:fork",
      entryId
    ),
  compact: (instructions?: string) => invoke<void>("pi:compact", instructions),
  setAutoCompaction: (enabled: boolean) => invoke<void>("pi:set-auto-compaction", enabled),

  listModels: () => invoke<ModelInfo[]>("pi:list-models"),
  setModel: (provider: string, id: string) => invoke<void>("pi:set-model", provider, id),
  setThinking: (level: ThinkingLevel) => invoke<void>("pi:set-thinking", level),

  capabilities: () => invoke<Capabilities>("pi:capabilities"),
  setActiveTools: (names: string[]) => invoke<void>("pi:set-active-tools", names),
  runCommand: (name: string, args?: string) => invoke<void>("pi:run-command", name, args),

  listFiles: () => invoke<WorkspaceFile[]>("pi:list-files"),

  gitStatus: () => invoke<GitStatus>("pi:git-status"),
  gitDiff: (path: string) => invoke<GitDiff>("pi:git-diff", path),
  gitStage: (paths: string[]) => invoke<void>("pi:git-stage", paths),
  gitUnstage: (paths: string[]) => invoke<void>("pi:git-unstage", paths),
  gitStageAll: () => invoke<void>("pi:git-stage-all"),
  gitUnstageAll: () => invoke<void>("pi:git-unstage-all"),
  gitCommit: (message: string, options?: { amend?: boolean }) =>
    invoke<void>("pi:git-commit", message, options),
  gitPush: () => invoke<void>("pi:git-push"),
  gitLog: (limit?: number) => invoke<GitCommitEntry[]>("pi:git-log", limit),
  generateCommitMessage: (prompt?: string) =>
    invoke<string>("pi:git-generate-message", prompt),
  stageFile: (name: string, base64: string) =>
    invoke<StagedFile>("pi:stage-file", name, base64),
  listPlugins: () => invoke<Array<{ id: string; source: string }>>("pi:list-plugins"),
  pluginsDir: () => invoke<string>("pi:plugins-dir"),
  writePlugin: (id: string, source: string) => invoke<void>("pi:write-plugin", id, source),

  defaultCommitPrompt: () => invoke<string>("pi:default-commit-prompt"),

  pickFolder: () => invoke<string | null>("pi:pick-folder"),
  revealPath: (path: string) => invoke<void>("pi:reveal", path),
  copy: (text: string) => invoke<void>("pi:copy", text),

  /** Subscribe to host events. Returns a disposer. */
  onEvent: (listener: (event: HostEvent) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: HostEvent) => listener(payload)
    ipcRenderer.on("pi:event", wrapped)
    return () => {
      ipcRenderer.removeListener("pi:event", wrapped)
    }
  },
}

contextBridge.exposeInMainWorld("pi", api)

export type PiBridge = typeof api
