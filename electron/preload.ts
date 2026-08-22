import { contextBridge, ipcRenderer, webUtils } from "electron"
import type {
  Automation,
  BootPayload,
  Capabilities,
  ExternalEditor,
  FileContents,
  GitCommitEntry,
  GitDiff,
  GitHubStatus,
  IntegrationCatalogSnapshot,
  GitStatus,
  HostEvent,
  HarnessProfile,
  ModelInfo,
  MakoComputerPermissions,
  McpRegistrySnapshot,
  McpSyncPreview,
  McpSyncTarget,
  PullRequest,
  SearchOptions,
  SearchResults,
  SessionState,
  SessionSummary,
  SkillRegistrySnapshot,
  SkillSyncPreview,
  SkillSyncTarget,
  AcpPermissionResponse,
  AcpPromptAttachment,
  AcpSessionState,
  Thread,
  ThreadContextOptions,
  ThreadFileContext,
  ThreadInlineContext,
  ThreadRef,
  ThreadRunState,
  StagedFile,
  TabSnapshot,
  TerminalCreateOptions,
  TerminalEvent,
  TerminalSession,
  TerminalSnapshot,
  ThinkingLevel,
  UpdateState,
  UsageSummary,
  WorkspaceFile,
} from "./shared.js"

import type { CrashReport } from "./crash.js"
import type {
  AccountHarness,
  AccountProvider,
  AccountUsage,
  HarnessAccount,
} from "./accounts.js"

/**
 * Trusted IPC boundary: every exposed call below has a matching `bindIpc`
 * handler in the main process. Electron leaves invoke results untyped, so the
 * bridge method supplies the result contract shared with its renderer caller.
 */
function invokeTrustedHost<Result>(
  channel: string,
  ...args: unknown[]
): Promise<Result> {
  return ipcRenderer.invoke(channel, ...args)
}

function threadContexts(
  paths: string[]
): Promise<Array<ThreadFileContext | null>>
function threadContexts(
  paths: string[],
  options: ThreadContextOptions & { inline: true }
): Promise<Array<ThreadInlineContext | null>>
function threadContexts(
  paths: string[],
  options?: ThreadContextOptions
): Promise<Array<ThreadFileContext | ThreadInlineContext | null>> {
  return invokeTrustedHost("mako:thread-contexts", paths, options)
}

const api = {
  boot: () => invokeTrustedHost<BootPayload>("mako:boot"),

  /* Cross-harness threads: every coding agent's sessions on this machine. */
  threads: (filter?: { cwd?: string; harness?: string }) =>
    invokeTrustedHost<{ ready: boolean; threads: ThreadRef[] }>(
      "mako:threads",
      filter
    ),
  openThread: (path: string) =>
    invokeTrustedHost<Thread | null>("mako:thread-open", path),
  threadContexts,
  followThread: (path: string, fromByte: number) =>
    invokeTrustedHost<void>("mako:thread-follow", path, fromByte),
  unfollowThread: () => invokeTrustedHost<void>("mako:thread-unfollow"),
  resumableHarnesses: () =>
    invokeTrustedHost<string[]>("mako:thread-resumable"),
  continueTargets: () =>
    invokeTrustedHost<string[]>("mako:thread-continue-targets"),
  continueThreadWith: (
    path: string,
    harness: string,
    instruction?: string,
    mode?: "native" | "transcript"
  ) =>
    invokeTrustedHost<
      | { kind: "emitted"; path: string }
      | { kind: "prepared"; prompt: string; cwd: string }
    >("mako:thread-continue-with", path, harness, instruction, mode),
  forkThread: (path: string, upto: number, harness: string) =>
    invokeTrustedHost<{ prompt: string; cwd: string }>(
      "mako:thread-fork",
      path,
      upto,
      harness
    ),
  threadRun: (path: string) =>
    invokeTrustedHost<ThreadRunState | null>("mako:thread-run", path),
  startHarness: (
    harness: string,
    prompt: string,
    options?: {
      model?: string
      effort?: string
      fast?: boolean
      options?: Record<string, string | boolean>
    }
  ) =>
    invokeTrustedHost<{ run: ThreadRunState | null; cwd: string }>(
      "mako:harness-start",
      harness,
      prompt,
      options
    ),
  harnessTuning: (harness: string) =>
    invokeTrustedHost<HarnessProfile>("mako:harness-tuning", harness),
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
    invokeTrustedHost<ThreadRunState>(
      "mako:thread-resume",
      path,
      prompt,
      tuning
    ),
  abortThreadRun: (path: string) =>
    invokeTrustedHost<void>("mako:thread-abort-run", path),

  /* Interactive foreign agents (ACP). */
  acpHarnesses: () => invokeTrustedHost<string[]>("mako:acp-harnesses"),
  acpStart: (
    harness: string,
    cwd: string,
    options?: {
      resume?: string
      title?: string
      tuning?: {
        model?: string
        effort?: string
        fast?: boolean
        options?: Record<string, string | boolean>
      }
    }
  ) =>
    invokeTrustedHost<AcpSessionState>("mako:acp-start", harness, cwd, options),
  acpPrompt: (id: string, text: string, attachments?: AcpPromptAttachment[]) =>
    invokeTrustedHost<void>("mako:acp-prompt", id, text, attachments),
  acpPermission: (
    id: string,
    requestId: string,
    response: AcpPermissionResponse
  ) => invokeTrustedHost<void>("mako:acp-permission", id, requestId, response),
  acpSetMode: (id: string, modeId: string) =>
    invokeTrustedHost<void>("mako:acp-mode", id, modeId),
  acpCancel: (id: string) => invokeTrustedHost<void>("mako:acp-cancel", id),
  acpClose: (id: string) => invokeTrustedHost<void>("mako:acp-close", id),

  /* Harness accounts: several logins per CLI. */
  accounts: () => invokeTrustedHost<HarnessAccount[]>("mako:accounts"),
  captureAccount: (harness: AccountHarness, name: string) =>
    invokeTrustedHost<void>("mako:account-capture", harness, name),
  selectAccount: (harness: AccountHarness, name: string | null) =>
    invokeTrustedHost<void>("mako:account-select", harness, name),
  removeAccount: (harness: AccountHarness, name: string) =>
    invokeTrustedHost<void>("mako:account-remove", harness, name),
  accountUsage: (harness: AccountProvider, name: string) =>
    invokeTrustedHost<AccountUsage>("mako:account-usage", harness, name),

  /* The Agents settings section. */
  harnessProfiles: () =>
    invokeTrustedHost<HarnessProfile[]>("mako:harness-profiles"),
  harnessAvailability: () =>
    invokeTrustedHost<Record<string, boolean>>("mako:harness-availability"),
  daemonStatus: () =>
    invokeTrustedHost<{
      pid: number
      startedAt: number
      sessions: number
    } | null>("mako:daemon-status"),
  daemonLogin: () => invokeTrustedHost<boolean>("mako:daemon-login"),
  setDaemonLogin: (enabled: boolean) =>
    invokeTrustedHost<void>("mako:daemon-login-set", enabled),

  computerPermissions: () =>
    invokeTrustedHost<MakoComputerPermissions>("mako:computer-permissions"),
  requestComputerPermissions: () =>
    invokeTrustedHost<MakoComputerPermissions>(
      "mako:computer-permissions-request"
    ),

  /* MCP discovery is read-only; sync is always an explicit settings action. */
  integrations: () =>
    invokeTrustedHost<IntegrationCatalogSnapshot>("mako:integrations"),
  discoverMcp: () =>
    invokeTrustedHost<McpRegistrySnapshot>("mako:mcp-discover"),
  previewMcpSync: (serverId: string, target: McpSyncTarget) =>
    invokeTrustedHost<McpSyncPreview>(
      "mako:mcp-sync-preview",
      serverId,
      target
    ),
  applyMcpSync: (serverId: string, target: McpSyncTarget) =>
    invokeTrustedHost<McpRegistrySnapshot>(
      "mako:mcp-sync-apply",
      serverId,
      target
    ),

  discoverSkills: () =>
    invokeTrustedHost<SkillRegistrySnapshot>("mako:skills-discover"),
  previewSkillSync: (skillId: string, target: SkillSyncTarget) =>
    invokeTrustedHost<SkillSyncPreview>(
      "mako:skills-sync-preview",
      skillId,
      target
    ),
  previewSkillRemove: (skillId: string, target: SkillSyncTarget) =>
    invokeTrustedHost<SkillSyncPreview>(
      "mako:skills-remove-preview",
      skillId,
      target
    ),
  applySkillSync: (skillId: string, targets: SkillSyncTarget[]) =>
    invokeTrustedHost<SkillRegistrySnapshot>(
      "mako:skills-sync-apply",
      skillId,
      targets
    ),

  /* Tabs. Session-scoped calls below always address the active tab. */
  openTab: (options?: { cwd?: string; sessionPath?: string }) =>
    invokeTrustedHost<TabSnapshot>("mako:open-tab", options),
  closeTab: (id: string) =>
    invokeTrustedHost<{
      tabs: string[]
      activeId: string
      opened?: TabSnapshot
    }>("mako:close-tab", id),
  activateTab: (id: string) =>
    invokeTrustedHost<boolean>("mako:activate-tab", id),

  listSessions: (cwd?: string, scope?: "workspace" | "all") =>
    invokeTrustedHost<SessionSummary[]>("mako:list-sessions", cwd, scope),
  openSession: (path: string) =>
    invokeTrustedHost<SessionState>("mako:open-session", path),
  newSession: () => invokeTrustedHost<SessionState>("mako:new-session"),
  setCwd: (cwd: string) => invokeTrustedHost<SessionState>("mako:set-cwd", cwd),
  setName: (name: string) => invokeTrustedHost<void>("mako:set-name", name),

  prompt: (
    text: string,
    mode?: "steer" | "followUp",
    images?: Array<{ mimeType: string; data: string }>
  ) => invokeTrustedHost<void>("mako:prompt", text, mode, images),
  abort: () => invokeTrustedHost<void>("mako:abort"),
  clearQueue: () => invokeTrustedHost<void>("mako:clear-queue"),
  navigateTree: (targetId: string) =>
    invokeTrustedHost<SessionState>("mako:navigate-tree", targetId),
  fork: (entryId: string, position: "before" | "at" = "before") =>
    invokeTrustedHost<
      | { cancelled: true }
      | { cancelled: false; text?: string; tab: TabSnapshot }
    >("mako:fork", entryId, position),
  compact: (instructions?: string) =>
    invokeTrustedHost<void>("mako:compact", instructions),
  setAutoCompaction: (enabled: boolean) =>
    invokeTrustedHost<void>("mako:set-auto-compaction", enabled),

  listModels: () => invokeTrustedHost<ModelInfo[]>("mako:list-models"),
  setModel: (provider: string, id: string) =>
    invokeTrustedHost<void>("mako:set-model", provider, id),
  setThinking: (level: ThinkingLevel) =>
    invokeTrustedHost<void>("mako:set-thinking", level),

  capabilities: () => invokeTrustedHost<Capabilities>("mako:capabilities"),
  setActiveTools: (names: string[]) =>
    invokeTrustedHost<void>("mako:set-active-tools", names),
  runCommand: (name: string, args?: string) =>
    invokeTrustedHost<void>("mako:run-command", name, args),

  listFiles: () => invokeTrustedHost<WorkspaceFile[]>("mako:list-files"),
  readFile: (path: string) =>
    invokeTrustedHost<FileContents>("mako:read-file", path),
  watchFile: (path: string) => invokeTrustedHost<void>("mako:watch-file", path),
  unwatchFile: () => invokeTrustedHost<void>("mako:unwatch-file"),
  search: (query: string, options?: SearchOptions) =>
    invokeTrustedHost<SearchResults>("mako:search", query, options),

  gitStatus: () => invokeTrustedHost<GitStatus>("mako:git-status"),
  gitDiff: (path: string) => invokeTrustedHost<GitDiff>("mako:git-diff", path),
  gitDiffAll: () =>
    invokeTrustedHost<{ diffs: GitDiff[]; truncated: number }>(
      "mako:git-diff-all"
    ),
  gitStage: (paths: string[]) =>
    invokeTrustedHost<void>("mako:git-stage", paths),
  gitUnstage: (paths: string[]) =>
    invokeTrustedHost<void>("mako:git-unstage", paths),
  gitStageAll: () => invokeTrustedHost<void>("mako:git-stage-all"),
  gitUnstageAll: () => invokeTrustedHost<void>("mako:git-unstage-all"),
  gitCommit: (message: string, options?: { amend?: boolean }) =>
    invokeTrustedHost<void>("mako:git-commit", message, options),
  gitPush: () => invokeTrustedHost<void>("mako:git-push"),
  gitLog: (limit?: number) =>
    invokeTrustedHost<GitCommitEntry[]>("mako:git-log", limit),
  gitCommitFiles: (hash: string) =>
    invokeTrustedHost<
      Array<{
        path: string
        status: import("./shared.js").GitFileStatus
        insertions: number
        deletions: number
        binary: boolean
      }>
    >("mako:git-commit-files", hash),
  gitCommitFileDiff: (hash: string, path: string) =>
    invokeTrustedHost<GitDiff>("mako:git-commit-file-diff", hash, path),
  gitCommitDiffAll: (hash: string) =>
    invokeTrustedHost<{ diffs: GitDiff[]; truncated: number }>(
      "mako:git-commit-diff-all",
      hash
    ),
  generateCommitMessage: (options?: { prompt?: string; model?: string }) =>
    invokeTrustedHost<string>("mako:git-generate-message", options),
  stageFile: (name: string, base64: string) =>
    invokeTrustedHost<StagedFile>("mako:stage-file", name, base64),
  stageFilePath: (sourcePath: string) =>
    invokeTrustedHost<StagedFile>("mako:stage-file-path", sourcePath),
  /** The OS path behind a dropped/picked File — the fast lane for staging. */
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
  listPlugins: () =>
    invokeTrustedHost<Array<{ id: string; source: string; error?: string }>>(
      "mako:list-plugins"
    ),
  pluginsDir: () => invokeTrustedHost<string>("mako:plugins-dir"),
  writePlugin: (id: string, source: string) =>
    invokeTrustedHost<void>("mako:write-plugin", id, source),
  deletePlugin: (id: string) =>
    invokeTrustedHost<void>("mako:delete-plugin", id),
  revealPlugins: () => invokeTrustedHost<void>("mako:reveal-plugins"),

  defaultCommitPrompt: () =>
    invokeTrustedHost<string>("mako:default-commit-prompt"),

  /* GitHub, via the `gh` CLI. See electron/github.ts for why. */
  githubStatus: () => invokeTrustedHost<GitHubStatus>("mako:github-status"),
  pullRequest: () => invokeTrustedHost<PullRequest | null>("mako:pull-request"),
  pullRequests: (limit?: number) =>
    invokeTrustedHost<PullRequest[]>("mako:pull-requests", limit),
  pullBranches: () => invokeTrustedHost<string[]>("mako:pull-branches"),
  createPull: (options: {
    title: string
    body: string
    base?: string
    draft?: boolean
  }) => invokeTrustedHost<PullRequest | null>("mako:create-pull", options),
  mergePull: (strategy: "merge" | "squash" | "rebase") =>
    invokeTrustedHost<PullRequest | null>("mako:merge-pull", strategy),
  rerunChecks: () => invokeTrustedHost<void>("mako:rerun-checks"),
  repoAvatar: (repo: string) =>
    invokeTrustedHost<string | undefined>("mako:repo-avatar", repo),
  userAvatar: () => invokeTrustedHost<string | undefined>("mako:user-avatar"),

  usage: () => invokeTrustedHost<UsageSummary>("mako:usage"),
  automations: () => invokeTrustedHost<Automation[]>("mako:automations"),
  saveAutomations: (next: Automation[]) =>
    invokeTrustedHost<Automation[]>("mako:save-automations", next),
  setAutomationEnabled: (id: string, enabled: boolean) =>
    invokeTrustedHost<Automation[]>("mako:automation-enabled", id, enabled),
  runAutomation: (id: string) =>
    invokeTrustedHost<void>("mako:run-automation", id),
  reloadAutomations: () =>
    invokeTrustedHost<Automation[]>("mako:reload-automations"),

  terminalList: () =>
    invokeTrustedHost<TerminalSession[]>("mako:terminal-list"),
  terminalCreate: (options: TerminalCreateOptions) =>
    invokeTrustedHost<TerminalSession>("mako:terminal-create", options),
  terminalAttach: (sessionId: string) =>
    invokeTrustedHost<TerminalSnapshot>("mako:terminal-attach", sessionId),
  terminalDetach: (sessionId: string) =>
    invokeTrustedHost<void>("mako:terminal-detach", sessionId),
  terminalWrite: (sessionId: string, data: string) =>
    invokeTrustedHost<void>("mako:terminal-write", sessionId, data),
  terminalAcknowledge: (sessionId: string, sequence: number) =>
    invokeTrustedHost<void>("mako:terminal-acknowledge", sessionId, sequence),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    invokeTrustedHost<void>("mako:terminal-resize", sessionId, cols, rows),
  terminalKill: (sessionId: string) =>
    invokeTrustedHost<void>("mako:terminal-kill", sessionId),
  onTerminalEvent: (listener: (event: TerminalEvent) => void): (() => void) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalEvent
    ) => listener(payload)
    ipcRenderer.on("mako:terminal-event", wrapped)
    return () => {
      ipcRenderer.removeListener("mako:terminal-event", wrapped)
    }
  },

  updateState: () => invokeTrustedHost<UpdateState>("mako:update-state"),
  checkUpdates: () => invokeTrustedHost<UpdateState>("mako:check-updates"),
  installUpdate: () => invokeTrustedHost<void>("mako:install-update"),

  /* Crash reports. Local only — see electron/crash.ts. */
  crashes: () => invokeTrustedHost<CrashReport[]>("mako:crashes"),
  crashesDir: () => invokeTrustedHost<string>("mako:crashes-dir"),
  clearCrashes: () => invokeTrustedHost<void>("mako:clear-crashes"),
  reportCrash: (
    kind: "renderer-error" | "renderer-rejection",
    payload: { message: string; stack?: string; source?: string }
  ) => invokeTrustedHost<void>("mako:report-crash", kind, payload),

  pickFolder: () => invokeTrustedHost<string | null>("mako:pick-folder"),
  externalEditors: () =>
    invokeTrustedHost<ExternalEditor[]>("mako:external-editors"),
  openInEditor: (path: string, editor?: string) =>
    invokeTrustedHost<void>("mako:open-in-editor", path, editor),
  revealPath: (path: string) => invokeTrustedHost<void>("mako:reveal", path),
  openUrl: (url: string) => invokeTrustedHost<void>("mako:open-url", url),
  copy: (text: string) => invokeTrustedHost<void>("mako:copy", text),

  /** Subscribe to host events. Returns a disposer. */
  onEvent: (listener: (event: HostEvent) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: HostEvent) =>
      listener(payload)
    ipcRenderer.on("mako:event", wrapped)
    return () => {
      ipcRenderer.removeListener("mako:event", wrapped)
    }
  },
}

contextBridge.exposeInMainWorld("mako", api)

export type MakoBridge = typeof api
