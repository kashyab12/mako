import type { NativeRequest, NativeRequestInput } from "../shared.js"
import type {
  DelegateInput,
  ForkInput,
  TransferInput,
  LiveCapability,
} from "../shared.js"
import type { LiveStartOptions, LiveSnapshot, LiveRequest } from "../shared.js"
import type {
  Automation,
  BootPayload,
  Capabilities,
  ExternalEditor,
  ExternalThreadActivity,
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
  LivePermissionResponse,
  PromptAttachment,
  Thread,
  ThreadContextOptions,
  ThreadFileContext,
  ThreadInlineContext,
  ThreadPage,
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
} from "../shared.js"

import type { CrashReport } from "../crash.js"
import type {
  AccountHarness,
  AccountProvider,
  AccountUsage,
  HarnessAccount,
} from "../accounts.js"

export interface BridgeTransport {
  invoke<Result>(channel: string, ...args: unknown[]): Promise<Result>
  onEvent(listener: (event: HostEvent) => void): () => void
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void
  pathForFile(file: File): string | null
  resolveFileUrl(url: string): string
}

/** The same wire methods are used by Electron preload and the local web desk. */
export function createMakoBridge(transport: BridgeTransport) {
  const invokeTrustedHost = transport.invoke

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
      invokeTrustedHost<{
        ready: boolean
        threads: ThreadRef[]
        activity: Record<string, ExternalThreadActivity>
      }>("mako:threads", filter),
    openThread: (path: string) =>
      invokeTrustedHost<Thread | null>("mako:thread-open", path),
    readThreadFile: (threadPath: string, filePath: string) =>
      invokeTrustedHost<FileContents>("mako:thread-file", threadPath, filePath),
    pageThread: (path: string, before?: number, limit?: number) =>
      invokeTrustedHost<ThreadPage | null>(
        "mako:thread-page",
        path,
        before,
        limit
      ),
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
    abortThreadRun: (path: string) =>
      invokeTrustedHost<void>("mako:thread-abort-run", path),

    /* Interactive foreign agents (ACP). */
    liveCapabilities: () =>
      invokeTrustedHost<LiveCapability[]>("mako:live-capabilities"),
    liveStart: (harness: string, cwd: string, options: LiveStartOptions) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-start", harness, cwd, options),
    nativeReceipt: (id: string) =>
      invokeTrustedHost<NativeRequest | null>("mako:native-receipt", id),
    nativeDismiss: (id: string) =>
      invokeTrustedHost<void>("mako:native-dismiss", id),
    nativeRequests: () =>
      invokeTrustedHost<NativeRequest[]>("mako:native-requests"),
    nativeSubmit: (input: NativeRequestInput) =>
      invokeTrustedHost<NativeRequest>("mako:native-submit", input),
    liveDelegate: (id: string, input: DelegateInput) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-delegate", id, input),
    liveCancelChild: (id: string, childId: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-child-cancel", id, childId),
    liveMergeFork: (id: string, mergeId: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-merge-fork", id, mergeId),
    liveFork: (id: string, input: ForkInput) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-fork", id, input),
    liveCapture: (id: string, path: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-capture", id, path),
    liveTransfer: (id: string, input: TransferInput) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-transfer", id, input),
    liveClearQueue: (id: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-clear-queue", id),
    liveEarlier: (id: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-earlier", id),
    liveBind: (id: string, path: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-bind", id, path),
    readLiveFile: (id: string, path: string) =>
      invokeTrustedHost<FileContents>("mako:read-live-file", id, path),
    liveSnapshot: (id: string) =>
      invokeTrustedHost<LiveSnapshot | null>("mako:live-snapshot", id),
    livePrompt: (
      id: string,
      requestId: string,
      text: string,
      attachments?: PromptAttachment[]
    ) =>
      invokeTrustedHost<LiveRequest>(
        "mako:live-prompt",
        id,
        requestId,
        text,
        attachments
      ),
    livePermission: (
      id: string,
      requestId: string,
      response: LivePermissionResponse
    ) =>
      invokeTrustedHost<void>("mako:live-permission", id, requestId, response),
    liveSetMode: (id: string, modeId: string) =>
      invokeTrustedHost<void>("mako:live-mode", id, modeId),
    liveCancel: (id: string) => invokeTrustedHost<void>("mako:live-cancel", id),
    liveClose: (id: string) => invokeTrustedHost<void>("mako:live-close", id),

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
    harnessProfiles: (force?: boolean) =>
      invokeTrustedHost<HarnessProfile[]>("mako:harness-profiles", force),
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

    controlPreviewSource: (conversationId: string) =>
      invokeTrustedHost<string | null>(
        "mako:control-preview-source",
        conversationId
      ),
    hideControlPreview: () =>
      invokeTrustedHost<void>("mako:control-preview-hide"),
    appshotWindows: () =>
      invokeTrustedHost<import("../shared.js").AppshotWindow[]>(
        "mako:appshot-windows"
      ),
    captureAppshot: (target: import("../shared.js").AppshotTarget) =>
      invokeTrustedHost<import("../shared.js").Appshot>(
        "mako:appshot-capture",
        target
      ),
    controlPreview: (
      conversationId: string,
      watching: boolean,
      watcher = "panel"
    ) =>
      invokeTrustedHost<import("../shared.js").ControlPreview | null>(
        "mako:control-preview",
        conversationId,
        watching,
        watcher
      ),
    computerPermissions: () =>
      invokeTrustedHost<MakoComputerPermissions>("mako:computer-permissions"),
    browserControlStatus: () =>
      invokeTrustedHost<import("../shared.js").BrowserControlStatus[]>(
        "mako:browser-control-status"
      ),
    connectBrowser: (browser: string) =>
      invokeTrustedHost<import("../shared.js").BrowserControlStatus[]>(
        "mako:browser-control-connect",
        browser
      ),
    disconnectBrowser: (browser: string) =>
      invokeTrustedHost<import("../shared.js").BrowserControlStatus[]>(
        "mako:browser-control-disconnect",
        browser
      ),
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
    setCwd: (cwd: string) =>
      invokeTrustedHost<TabSnapshot>("mako:set-cwd", cwd),
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
    watchFile: (path: string) =>
      invokeTrustedHost<void>("mako:watch-file", path),
    unwatchFile: () => invokeTrustedHost<void>("mako:unwatch-file"),
    search: (query: string, options?: SearchOptions) =>
      invokeTrustedHost<SearchResults>("mako:search", query, options),

    gitStatus: () => invokeTrustedHost<GitStatus>("mako:git-status"),
    gitDiff: (path: string) =>
      invokeTrustedHost<GitDiff>("mako:git-diff", path),
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
          status: import("../shared.js").GitFileStatus
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
    pathForFile: transport.pathForFile,
    resolveFileUrl: transport.resolveFileUrl,
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
    pullRequest: () =>
      invokeTrustedHost<PullRequest | null>("mako:pull-request"),
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
    onTerminalEvent: transport.onTerminalEvent,

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
    onEvent: transport.onEvent,
  }
  return api
}

export type MakoBridge = ReturnType<typeof createMakoBridge>
