import { contextBridge, ipcRenderer, webUtils } from "electron"
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
  HarnessProfile,
  ModelInfo,
  PullRequest,
  SearchOptions,
  SearchResults,
  SessionState,
  SessionSummary,
  AcpPromptAttachment,
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

/**
 * Trusted IPC boundary: every exposed call below has a matching `bindIpc`
 * handler in the main process. Electron leaves invoke results untyped, so the
 * bridge method supplies the result contract shared with its renderer caller.
 */
function invokeTrustedHost<Result>(channel: string, ...args: unknown[]): Promise<Result> {
  return ipcRenderer.invoke(channel, ...args)
}

const api = {
  boot: () => invokeTrustedHost<BootPayload>("pi:boot"),

  /* Cross-harness threads: every coding agent's sessions on this machine. */
  threads: (filter?: { cwd?: string; harness?: string }) =>
    invokeTrustedHost<{ ready: boolean; threads: ThreadRef[] }>("pi:threads", filter),
  openThread: (path: string) => invokeTrustedHost<Thread | null>("pi:thread-open", path),
  threadContexts: (paths: string[]) =>
    invokeTrustedHost<Array<{ file: string; title?: string; harness: string } | null>>("pi:thread-contexts", paths),
  continueThread: (path: string) => invokeTrustedHost<TabSnapshot>("pi:thread-continue", path),
  emitThreadToClaude: (path: string) => invokeTrustedHost<{ sessionId: string }>("pi:thread-emit-claude", path),
  followThread: (path: string, fromByte: number) => invokeTrustedHost<void>("pi:thread-follow", path, fromByte),
  unfollowThread: () => invokeTrustedHost<void>("pi:thread-unfollow"),
  resumableHarnesses: () => invokeTrustedHost<string[]>("pi:thread-resumable"),
  continueTargets: () => invokeTrustedHost<string[]>("pi:thread-continue-targets"),
  continueThreadWith: (
    path: string,
    harness: string,
    instruction?: string,
    mode?: "native" | "transcript"
  ) =>
    invokeTrustedHost<
      { kind: "emitted"; path: string } | { kind: "prepared"; prompt: string; cwd: string }
    >("pi:thread-continue-with", path, harness, instruction, mode),
  forkThread: (path: string, upto: number, harness: string) =>
    invokeTrustedHost<{ prompt: string; cwd: string }>("pi:thread-fork", path, upto, harness),
  threadRun: (path: string) => invokeTrustedHost<ThreadRunState | null>("pi:thread-run", path),
  startHarness: (
    harness: string,
    prompt: string,
    options?: {
      model?: string
      effort?: string
      fast?: boolean
      options?: Record<string, string | boolean>
    }
  ) => invokeTrustedHost<{ run: ThreadRunState | null; cwd: string }>("pi:harness-start", harness, prompt, options),
  harnessTuning: (harness: string) => invokeTrustedHost<HarnessProfile>("pi:harness-tuning", harness),
  resumeThread: (
    path: string,
    prompt: string,
    tuning?: {
      model?: string
      effort?: string
      fast?: boolean
      options?: Record<string, string | boolean>
    }
  ) =>
    invokeTrustedHost<ThreadRunState>("pi:thread-resume", path, prompt, tuning),
  abortThreadRun: (path: string) => invokeTrustedHost<void>("pi:thread-abort-run", path),

  /* Interactive foreign agents (ACP). */
  acpHarnesses: () => invokeTrustedHost<string[]>("pi:acp-harnesses"),
  acpStart: (
    harness: string,
    cwd: string,
    options?: {
      resume?: string
      title?: string
      tuning?: { model?: string; effort?: string; fast?: boolean; options?: Record<string, string | boolean> }
    }
  ) => invokeTrustedHost<AcpSessionState>("pi:acp-start", harness, cwd, options),
  acpPrompt: (id: string, text: string, attachments?: AcpPromptAttachment[]) =>
    invokeTrustedHost<void>("pi:acp-prompt", id, text, attachments),
  acpPermission: (id: string, requestId: string, optionId: string | null) =>
    invokeTrustedHost<void>("pi:acp-permission", id, requestId, optionId),
  acpSetMode: (id: string, modeId: string) => invokeTrustedHost<void>("pi:acp-mode", id, modeId),
  acpCancel: (id: string) => invokeTrustedHost<void>("pi:acp-cancel", id),
  acpClose: (id: string) => invokeTrustedHost<void>("pi:acp-close", id),

  /* Harness accounts: several logins per CLI. */
  accounts: () => invokeTrustedHost<HarnessAccount[]>("pi:accounts"),
  captureAccount: (harness: "claude" | "codex", name: string) =>
    invokeTrustedHost<void>("pi:account-capture", harness, name),
  selectAccount: (harness: "claude" | "codex", name: string | null) =>
    invokeTrustedHost<void>("pi:account-select", harness, name),
  removeAccount: (harness: "claude" | "codex", name: string) =>
    invokeTrustedHost<void>("pi:account-remove", harness, name),
  accountUsage: (harness: "claude" | "codex", name: string) =>
    invokeTrustedHost<AccountUsage>("pi:account-usage", harness, name),

  /* The Agents settings section. */
  devinAccounts: () => invokeTrustedHost<Array<{ name: string; key: string }>>("pi:devin-accounts"),
  saveDevinAccounts: (accounts: Array<{ name: string; apiKey: string }>) =>
    invokeTrustedHost<void>("pi:devin-accounts-save", accounts),
  harnessProfiles: () => invokeTrustedHost<HarnessProfile[]>("pi:harness-profiles"),
  harnessAvailability: () => invokeTrustedHost<Record<string, boolean>>("pi:harness-availability"),
  daemonStatus: () =>
    invokeTrustedHost<{ pid: number; startedAt: number; sessions: number } | null>("pi:daemon-status"),
  daemonLogin: () => invokeTrustedHost<boolean>("pi:daemon-login"),
  setDaemonLogin: (enabled: boolean) => invokeTrustedHost<void>("pi:daemon-login-set", enabled),

  /* Tabs. Session-scoped calls below always address the active tab. */
  openTab: (options?: { cwd?: string; sessionPath?: string }) =>
    invokeTrustedHost<TabSnapshot>("pi:open-tab", options),
  closeTab: (id: string) =>
    invokeTrustedHost<{ tabs: string[]; activeId: string; opened?: TabSnapshot }>("pi:close-tab", id),
  activateTab: (id: string) => invokeTrustedHost<boolean>("pi:activate-tab", id),

  listSessions: (cwd?: string, scope?: "workspace" | "all") =>
    invokeTrustedHost<SessionSummary[]>("pi:list-sessions", cwd, scope),
  openSession: (path: string) => invokeTrustedHost<SessionState>("pi:open-session", path),
  newSession: () => invokeTrustedHost<SessionState>("pi:new-session"),
  setCwd: (cwd: string) => invokeTrustedHost<SessionState>("pi:set-cwd", cwd),
  setName: (name: string) => invokeTrustedHost<void>("pi:set-name", name),

  prompt: (
    text: string,
    mode?: "steer" | "followUp",
    images?: Array<{ mimeType: string; data: string }>
  ) => invokeTrustedHost<void>("pi:prompt", text, mode, images),
  abort: () => invokeTrustedHost<void>("pi:abort"),
  clearQueue: () => invokeTrustedHost<void>("pi:clear-queue"),
  navigateTree: (targetId: string) => invokeTrustedHost<SessionState>("pi:navigate-tree", targetId),
  fork: (entryId: string, position: "before" | "at" = "before") =>
    invokeTrustedHost<{ cancelled: true } | { cancelled: false; text?: string; tab: TabSnapshot }>(
      "pi:fork",
      entryId,
      position
    ),
  compact: (instructions?: string) => invokeTrustedHost<void>("pi:compact", instructions),
  setAutoCompaction: (enabled: boolean) => invokeTrustedHost<void>("pi:set-auto-compaction", enabled),

  listModels: () => invokeTrustedHost<ModelInfo[]>("pi:list-models"),
  setModel: (provider: string, id: string) => invokeTrustedHost<void>("pi:set-model", provider, id),
  setThinking: (level: ThinkingLevel) => invokeTrustedHost<void>("pi:set-thinking", level),

  capabilities: () => invokeTrustedHost<Capabilities>("pi:capabilities"),
  setActiveTools: (names: string[]) => invokeTrustedHost<void>("pi:set-active-tools", names),
  runCommand: (name: string, args?: string) => invokeTrustedHost<void>("pi:run-command", name, args),

  listFiles: () => invokeTrustedHost<WorkspaceFile[]>("pi:list-files"),
  readFile: (path: string) => invokeTrustedHost<FileContents>("pi:read-file", path),
  watchFile: (path: string) => invokeTrustedHost<void>("pi:watch-file", path),
  unwatchFile: () => invokeTrustedHost<void>("pi:unwatch-file"),
  search: (query: string, options?: SearchOptions) =>
    invokeTrustedHost<SearchResults>("pi:search", query, options),

  gitStatus: () => invokeTrustedHost<GitStatus>("pi:git-status"),
  gitDiff: (path: string) => invokeTrustedHost<GitDiff>("pi:git-diff", path),
  gitStage: (paths: string[]) => invokeTrustedHost<void>("pi:git-stage", paths),
  gitUnstage: (paths: string[]) => invokeTrustedHost<void>("pi:git-unstage", paths),
  gitStageAll: () => invokeTrustedHost<void>("pi:git-stage-all"),
  gitUnstageAll: () => invokeTrustedHost<void>("pi:git-unstage-all"),
  gitCommit: (message: string, options?: { amend?: boolean }) =>
    invokeTrustedHost<void>("pi:git-commit", message, options),
  gitPush: () => invokeTrustedHost<void>("pi:git-push"),
  gitLog: (limit?: number) => invokeTrustedHost<GitCommitEntry[]>("pi:git-log", limit),
  gitCommitFiles: (hash: string) =>
    invokeTrustedHost<Array<{ path: string; status: import("./shared.js").GitFileStatus; insertions: number; deletions: number; binary: boolean }>>("pi:git-commit-files", hash),
  gitCommitFileDiff: (hash: string, path: string) =>
    invokeTrustedHost<GitDiff>("pi:git-commit-file-diff", hash, path),
  gitCommitDiffAll: (hash: string) =>
    invokeTrustedHost<{ diffs: GitDiff[]; truncated: number }>("pi:git-commit-diff-all", hash),
  generateCommitMessage: (prompt?: string) =>
    invokeTrustedHost<string>("pi:git-generate-message", prompt),
  stageFile: (name: string, base64: string) =>
    invokeTrustedHost<StagedFile>("pi:stage-file", name, base64),
  stageFilePath: (sourcePath: string) => invokeTrustedHost<StagedFile>("pi:stage-file-path", sourcePath),
  /** The OS path behind a dropped/picked File — the fast lane for staging. */
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
  listPlugins: () => invokeTrustedHost<Array<{ id: string; source: string }>>("pi:list-plugins"),
  pluginsDir: () => invokeTrustedHost<string>("pi:plugins-dir"),
  writePlugin: (id: string, source: string) => invokeTrustedHost<void>("pi:write-plugin", id, source),
  deletePlugin: (id: string) => invokeTrustedHost<void>("pi:delete-plugin", id),
  revealPlugins: () => invokeTrustedHost<void>("pi:reveal-plugins"),

  defaultCommitPrompt: () => invokeTrustedHost<string>("pi:default-commit-prompt"),

  /* GitHub, via the `gh` CLI. See electron/github.ts for why. */
  githubStatus: () => invokeTrustedHost<GitHubStatus>("pi:github-status"),
  pullRequest: () => invokeTrustedHost<PullRequest | null>("pi:pull-request"),
  pullRequests: (limit?: number) => invokeTrustedHost<PullRequest[]>("pi:pull-requests", limit),
  createPull: (options: { title: string; body: string; base?: string; draft?: boolean }) =>
    invokeTrustedHost<PullRequest | null>("pi:create-pull", options),
  rerunChecks: () => invokeTrustedHost<void>("pi:rerun-checks"),
  repoAvatar: (repo: string) => invokeTrustedHost<string | undefined>("pi:repo-avatar", repo),

  usage: () => invokeTrustedHost<UsageSummary>("pi:usage"),
  automations: () => invokeTrustedHost<Automation[]>("pi:automations"),
  saveAutomations: (next: Automation[]) => invokeTrustedHost<Automation[]>("pi:save-automations", next),
  setAutomationEnabled: (id: string, enabled: boolean) =>
    invokeTrustedHost<Automation[]>("pi:automation-enabled", id, enabled),
  runAutomation: (id: string) => invokeTrustedHost<void>("pi:run-automation", id),
  reloadAutomations: () => invokeTrustedHost<Automation[]>("pi:reload-automations"),

  ports: () => invokeTrustedHost<ListeningPort[]>("pi:ports"),
  devScripts: () => invokeTrustedHost<string[]>("pi:dev-scripts"),
  devState: () => invokeTrustedHost<DevServerState>("pi:dev-state"),
  devStart: (script: string) => invokeTrustedHost<DevServerState>("pi:dev-start", script),
  devStop: () => invokeTrustedHost<DevServerState>("pi:dev-stop"),
  devAttach: (url: string) => invokeTrustedHost<DevServerState>("pi:dev-attach", url),

  updateState: () => invokeTrustedHost<UpdateState>("pi:update-state"),
  checkUpdates: () => invokeTrustedHost<UpdateState>("pi:check-updates"),
  installUpdate: () => invokeTrustedHost<void>("pi:install-update"),

  /* Crash reports. Local only — see electron/crash.ts. */
  crashes: () => invokeTrustedHost<CrashReport[]>("pi:crashes"),
  crashesDir: () => invokeTrustedHost<string>("pi:crashes-dir"),
  clearCrashes: () => invokeTrustedHost<void>("pi:clear-crashes"),
  reportCrash: (
    kind: "renderer-error" | "renderer-rejection",
    payload: { message: string; stack?: string; source?: string }
  ) => invokeTrustedHost<void>("pi:report-crash", kind, payload),

  pickFolder: () => invokeTrustedHost<string | null>("pi:pick-folder"),
  revealPath: (path: string) => invokeTrustedHost<void>("pi:reveal", path),
  openUrl: (url: string) => invokeTrustedHost<void>("pi:open-url", url),
  copy: (text: string) => invokeTrustedHost<void>("pi:copy", text),

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
