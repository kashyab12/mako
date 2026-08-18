import { contextBridge, ipcRenderer } from "electron"
import type {
  Automation,
  BootPayload,
  Capabilities,
  DevServerState,
  FileContents,
  GitCommitEntry,
  GitDiff,
  GitHubStatus,
  ListeningPort,
  GitStatus,
  HostEvent,
  ModelInfo,
  PullRequest,
  SearchOptions,
  SearchResults,
  SessionState,
  SessionSummary,
  AcpSessionState,
  Thread,
  ThreadRef,
  ThreadRunState,
  StagedFile,
  TabSnapshot,
  ThinkingLevel,
  UpdateState,
  UsageSummary,
  WorkspaceFile,
} from "./shared.js"

import type { CrashReport } from "./crash.js"
import type { AccountUsage, HarnessAccount } from "./accounts.js"

const invoke = <T>(channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api = {
  boot: () => invoke<BootPayload>("pi:boot"),

  /* Cross-harness threads: every coding agent's sessions on this machine. */
  threads: (filter?: { cwd?: string; harness?: string }) =>
    invoke<{ ready: boolean; threads: ThreadRef[] }>("pi:threads", filter),
  openThread: (path: string) => invoke<Thread | null>("pi:thread-open", path),
  continueThread: (path: string) => invoke<TabSnapshot>("pi:thread-continue", path),
  emitThreadToClaude: (path: string) => invoke<{ sessionId: string }>("pi:thread-emit-claude", path),
  followThread: (path: string, fromByte: number) => invoke<void>("pi:thread-follow", path, fromByte),
  unfollowThread: () => invoke<void>("pi:thread-unfollow"),
  resumableHarnesses: () => invoke<string[]>("pi:thread-resumable"),
  continueTargets: () => invoke<string[]>("pi:thread-continue-targets"),
  continueThreadWith: (path: string, harness: string, instruction?: string) =>
    invoke<
      { kind: "emitted"; path: string } | { kind: "spawned"; run: ThreadRunState }
    >("pi:thread-continue-with", path, harness, instruction),
  threadRun: (path: string) => invoke<ThreadRunState | null>("pi:thread-run", path),
  resumeThread: (path: string, prompt: string) => invoke<ThreadRunState>("pi:thread-resume", path, prompt),
  abortThreadRun: (path: string) => invoke<void>("pi:thread-abort-run", path),

  /* Interactive foreign agents (ACP). */
  acpHarnesses: () => invoke<string[]>("pi:acp-harnesses"),
  acpStart: (harness: string, cwd: string, options?: { resume?: string; title?: string }) =>
    invoke<AcpSessionState>("pi:acp-start", harness, cwd, options),
  acpPrompt: (id: string, text: string) => invoke<void>("pi:acp-prompt", id, text),
  acpPermission: (id: string, requestId: string, optionId: string | null) =>
    invoke<void>("pi:acp-permission", id, requestId, optionId),
  acpSetMode: (id: string, modeId: string) => invoke<void>("pi:acp-mode", id, modeId),
  acpCancel: (id: string) => invoke<void>("pi:acp-cancel", id),
  acpClose: (id: string) => invoke<void>("pi:acp-close", id),

  /* Harness accounts: several logins per CLI. */
  accounts: () => invoke<HarnessAccount[]>("pi:accounts"),
  captureAccount: (harness: "claude" | "codex", name: string) =>
    invoke<void>("pi:account-capture", harness, name),
  selectAccount: (harness: "claude" | "codex", name: string | null) =>
    invoke<void>("pi:account-select", harness, name),
  removeAccount: (harness: "claude" | "codex", name: string) =>
    invoke<void>("pi:account-remove", harness, name),
  accountUsage: (harness: "claude" | "codex", name: string) =>
    invoke<AccountUsage>("pi:account-usage", harness, name),

  /* The Agents settings section. */
  devinAccounts: () => invoke<Array<{ name: string; key: string }>>("pi:devin-accounts"),
  saveDevinAccounts: (accounts: Array<{ name: string; apiKey: string }>) =>
    invoke<void>("pi:devin-accounts-save", accounts),
  harnessAvailability: () => invoke<Record<string, boolean>>("pi:harness-availability"),
  daemonStatus: () =>
    invoke<{ pid: number; startedAt: number; sessions: number } | null>("pi:daemon-status"),

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
  readFile: (path: string) => invoke<FileContents>("pi:read-file", path),
  search: (query: string, options?: SearchOptions) =>
    invoke<SearchResults>("pi:search", query, options),

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
  gitCommitFiles: (hash: string) =>
    invoke<Array<{ path: string; status: import("./shared.js").GitFileStatus; insertions: number; deletions: number; binary: boolean }>>("pi:git-commit-files", hash),
  gitCommitFileDiff: (hash: string, path: string) =>
    invoke<GitDiff>("pi:git-commit-file-diff", hash, path),
  generateCommitMessage: (prompt?: string) =>
    invoke<string>("pi:git-generate-message", prompt),
  stageFile: (name: string, base64: string) =>
    invoke<StagedFile>("pi:stage-file", name, base64),
  listPlugins: () => invoke<Array<{ id: string; source: string }>>("pi:list-plugins"),
  pluginsDir: () => invoke<string>("pi:plugins-dir"),
  writePlugin: (id: string, source: string) => invoke<void>("pi:write-plugin", id, source),
  deletePlugin: (id: string) => invoke<void>("pi:delete-plugin", id),
  revealPlugins: () => invoke<void>("pi:reveal-plugins"),

  defaultCommitPrompt: () => invoke<string>("pi:default-commit-prompt"),

  /* GitHub, via the `gh` CLI. See electron/github.ts for why. */
  githubStatus: () => invoke<GitHubStatus>("pi:github-status"),
  pullRequest: () => invoke<PullRequest | null>("pi:pull-request"),
  pullRequests: (limit?: number) => invoke<PullRequest[]>("pi:pull-requests", limit),
  createPull: (options: { title: string; body: string; base?: string; draft?: boolean }) =>
    invoke<PullRequest | null>("pi:create-pull", options),
  rerunChecks: () => invoke<void>("pi:rerun-checks"),
  repoAvatar: (repo: string) => invoke<string | undefined>("pi:repo-avatar", repo),

  usage: () => invoke<UsageSummary>("pi:usage"),
  automations: () => invoke<Automation[]>("pi:automations"),
  saveAutomations: (next: Automation[]) => invoke<Automation[]>("pi:save-automations", next),
  setAutomationEnabled: (id: string, enabled: boolean) =>
    invoke<Automation[]>("pi:automation-enabled", id, enabled),
  runAutomation: (id: string) => invoke<void>("pi:run-automation", id),
  reloadAutomations: () => invoke<Automation[]>("pi:reload-automations"),

  ports: () => invoke<ListeningPort[]>("pi:ports"),
  devScripts: () => invoke<string[]>("pi:dev-scripts"),
  devState: () => invoke<DevServerState>("pi:dev-state"),
  devStart: (script: string) => invoke<DevServerState>("pi:dev-start", script),
  devStop: () => invoke<DevServerState>("pi:dev-stop"),
  devAttach: (url: string) => invoke<DevServerState>("pi:dev-attach", url),

  updateState: () => invoke<UpdateState>("pi:update-state"),
  checkUpdates: () => invoke<UpdateState>("pi:check-updates"),
  installUpdate: () => invoke<void>("pi:install-update"),

  /* Crash reports. Local only — see electron/crash.ts. */
  crashes: () => invoke<CrashReport[]>("pi:crashes"),
  crashesDir: () => invoke<string>("pi:crashes-dir"),
  clearCrashes: () => invoke<void>("pi:clear-crashes"),
  reportCrash: (
    kind: "renderer-error" | "renderer-rejection",
    payload: { message: string; stack?: string; source?: string }
  ) => invoke<void>("pi:report-crash", kind, payload),

  pickFolder: () => invoke<string | null>("pi:pick-folder"),
  revealPath: (path: string) => invoke<void>("pi:reveal", path),
  openUrl: (url: string) => invoke<void>("pi:open-url", url),
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
