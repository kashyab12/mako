import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  type BrowserWindowConstructorOptions,
} from "electron"
import { watch } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { COMMIT_PROMPT, type AgentHost } from "./host.js"
import {
  breadcrumb,
  clearCrashes,
  crashesDir,
  installCrashReporting,
  listCrashes,
  record,
} from "./crash.js"
import { installAutomation } from "./automation.js"
import { check, installNow, installUpdates, updateState } from "./updates.js"
import { listPorts } from "./ports.js"
import { usageSummary } from "./usage.js"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import {
  automationList,
  bindAutomations,
  fireAutomation,
  loadAutomations,
  noticeHead,
  saveAutomations,
  setEnabled,
  stopWatching,
  watchWorkspace,
} from "./automations.js"
import {
  attachDevServer,
  bindDevServer,
  devScripts,
  devServerState,
  startDevServer,
  stopDevServer,
} from "./devserver.js"
import {
  createPull,
  githubStatus,
  listPulls,
  listRemoteBranches,
  mergePull,
  pullForBranch,
  repoAvatar,
  rerunChecks,
  type CreatePullOptions,
  userAvatar,
} from "./github.js"
import { HostPool } from "./pool.js"
import {
  daemonStatus,
  devinAccountsMasked,
  startDevin,
  emitThreadAs,
  followThread,
  threadsReady,
  installThreads,
  listThreads,
  openThread,
  remoteHarnesses,
  saveDevinAccounts,
  sendRemote,
  stopThreads,
  transcriptArtifactFor,
  transcriptInlineFor,
  unfollowThread,
} from "./threads.js"
import {
  abortNative,
  bindDrivers,
  resumableHarnesses,
  resumeNative,
  startFresh,
  stopDrivers,
  threadRun,
} from "./drivers.js"
import {
  harnessProfile,
  harnessProfiles,
  resolveHarnessTuning,
} from "./harnesses.js"
import { bindLineageDirect, chainOf, expectLineage } from "./lineage.js"
import {
  accountUsage,
  captureAccount,
  listAccounts,
  removeAccount,
  selectAccount,
} from "./accounts.js"
import { daemonLoginEnabled, setDaemonLogin } from "./daemon-login.js"
import { TerminalDaemonClient } from "./terminal-client.js"
import {
  acpCancel,
  acpClose,
  acpHarnesses,
  acpPrompt,
  acpRespondPermission,
  acpSetMode,
  acpStart,
  acpState,
  bindAcp,
  stopAcp,
} from "./acp.js"
import {
  bindCodexApp,
  codexAppCancel,
  codexAppClose,
  codexAppPermission,
  codexAppPrompt,
  codexAppStart,
  codexAppState,
  stopCodexApps,
} from "./codex-app.js"
import {
  deletePlugin,
  listPlugins,
  pluginsDir,
  watchPlugins,
  writePlugin,
} from "./plugins.js"
import { discoverMcpRegistry } from "./mcp-registry.js"
import { applyMcpSync, previewMcpSync } from "./mcp-sync.js"
import type {
  AcpPromptAttachment,
  BootPayload,
  HostEvent,
  McpSyncTarget,
  SearchOptions,
  TerminalCreateOptions,
  ThinkingLevel,
  ThreadContextOptions,
} from "./shared.js"

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
let terminalClient: TerminalDaemonClient | null = null
const pool = new HostPool(emit)
let starting: Promise<unknown> | null = null

function terminal() {
  if (!terminalClient) throw new Error("Terminal service is not ready")
  return terminalClient
}

let fileWatcher: import("node:fs").FSWatcher | null = null
function stopFileWatch() {
  fileWatcher?.close()
  fileWatcher = null
}

function emit(event: HostEvent) {
  // Git status is recomputed after every turn and on focus, which is exactly
  // when HEAD could have moved — so the commit trigger rides on it rather than
  // running a watcher of its own.
  if (event.type === "git") noticeHead(event.git.head)
  if (window?.isDestroyed()) return
  window?.webContents.send("mako:event", event)
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
async function withHost<T>(
  run: (host: AgentHost) => T | Promise<T>
): Promise<T> {
  const live = await ready()
  return run(live.active)
}

async function createWindow() {
  nativeTheme.themeSource = "dark"
  const icon = appIcon()
  if (icon && process.platform === "darwin") app.dock?.setIcon(icon)

  const windowOptions: BrowserWindowConstructorOptions = {
    title: "Mako",
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
      // For the dev-server preview. A `<webview>` rather than an iframe so the
      // previewed app runs in its own process with its own storage: it cannot
      // reach this window, and its cookies and local storage never mix with
      // the app's own.
      webviewTag: true,
    },
  }
  if (icon) windowOptions.icon = icon
  window = new BrowserWindow(windowOptions)

  window.once("ready-to-show", () => {
    // Full working area, not a floating rectangle someone has to drag out.
    window?.maximize()
    window?.show()
  })

  // Renderer console output, in the terminal you started the app from.
  //
  // Without this the window is a black box: a component that throws leaves no
  // trace anywhere you are looking, which is exactly how a crash-on-boot went
  // unnoticed through a passing typecheck. Dev only — in a packaged build this
  // becomes the crash reporter's job, not stdout's.
  if (isDev) {
    window.webContents.on("console-message", (details) => {
      const where = details.lineNumber
        ? ` (${details.sourceId}:${details.lineNumber})`
        : ""
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

  installAutomation(window, isDev)

  // Answer "is the app I am looking at current?" without guessing: in dev,
  // the compiled main process is watched, and the moment a rebuild lands on
  // disk the window says so. The renderer hot-reloads through Vite; the main
  // process cannot, and pretending otherwise is how stale builds get
  // debugged for an hour.
  if (isDev) {
    try {
      const compiled = join(__dirname, "main.js")
      let told = false
      const buildWatcher = watch(compiled, () => {
        if (told) return
        told = true
        setTimeout(() => {
          emit({
            type: "notice",
            level: "info",
            message:
              "Mako's engine was rebuilt — restart the app to run the new version.",
          })
        }, 500)
      })
      window.once("closed", () => buildWatcher.close())
    } catch {
      // Watching our own build is best-effort.
    }
  }

  // The agent writes a plugin with its ordinary file tools and the window
  // re-evaluates it — no IPC for it to learn, no command for the user to run.
  const watcher = watchPlugins(() => emit({ type: "plugins-changed" }))
  window.once("closed", () => watcher?.close())
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  if (isDev) {
    await window.loadURL(
      process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173"
    )
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
function handle(
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1]
) {
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
  handle("mako:boot", async (): Promise<BootPayload> => {
    const live = await ready()
    const [tabs, models] = await Promise.all([
      live.snapshots(),
      live.active.listModels(),
    ])
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

  handle(
    "mako:open-tab",
    async (_e, options?: { cwd?: string; sessionPath?: string }) => {
      const live = await ready()
      return live.open(options ?? {})
    }
  )
  handle("mako:close-tab", async (_e, id: string) => {
    const live = await ready()
    return live.close(id)
  })
  handle("mako:activate-tab", async (_e, id: string) => {
    const live = await ready()
    return live.activate(id)
  })

  handle(
    "mako:list-sessions",
    (_e, cwd?: string, scope?: "workspace" | "all") =>
      withHost((h) => h.listSessions(cwd, scope))
  )
  handle("mako:open-session", (_e, path: string) =>
    withHost(async (h) => {
      await h.openSession(path)
      return h.state()
    })
  )
  handle("mako:new-session", () =>
    withHost(async (h) => {
      await h.newSession()
      return h.state()
    })
  )
  handle("mako:set-cwd", (_e, cwd: string) =>
    withHost(async (h) => {
      await h.setCwd(cwd)
      return h.state()
    })
  )
  handle("mako:set-name", (_e, name: string) =>
    withHost((h) => h.setName(name))
  )

  ipcMain.handle(
    "mako:prompt",
    (
      _e,
      text: string,
      mode?: "steer" | "followUp",
      images?: Array<{ mimeType: string; data: string }>
    ) => withHost((h) => h.prompt(text, mode, images))
  )
  handle("mako:abort", () => withHost((h) => h.abort()))
  handle("mako:clear-queue", () => withHost((h) => h.clearQueue()))
  // Branching opens a tab rather than replacing this one. Exploring the same
  // question two ways only works if both answers stay on screen.
  handle(
    "mako:fork",
    async (_e, entryId: string, position?: "before" | "at") => {
      const live = await ready()
      return live.forkIntoTab(entryId, position)
    }
  )
  handle("mako:navigate-tree", (_e, targetId: string) =>
    withHost(async (h) => {
      await h.navigateTree(targetId)
      return h.state()
    })
  )
  handle("mako:compact", (_e, instructions?: string) =>
    withHost((h) => h.compact(instructions))
  )
  handle("mako:set-auto-compaction", (_e, enabled: boolean) =>
    withHost((h) => h.setAutoCompaction(enabled))
  )

  handle("mako:list-models", () => withHost((h) => h.listModels()))
  handle("mako:set-model", (_e, provider: string, id: string) =>
    withHost((h) => h.setModel(provider, id))
  )
  handle("mako:set-thinking", (_e, level: ThinkingLevel) =>
    withHost((h) => h.setThinking(level))
  )

  handle("mako:capabilities", () => withHost((h) => h.capabilities()))
  handle("mako:set-active-tools", (_e, names: string[]) =>
    withHost((h) => h.setActiveTools(names))
  )
  handle("mako:run-command", (_e, name: string, args?: string) =>
    withHost((h) => h.runCommand(name, args))
  )

  handle("mako:list-files", () => withHost((h) => h.listFiles()))
  handle("mako:read-file", (_e, path: string) =>
    withHost((h) => h.readWorkspaceFile(path))
  )
  /**
   * Watch the one file the viewer has open. An agent mid-edit rewrites it
   * every few seconds; the viewer should breathe with it, not wait for a
   * manual reopen. One watcher, replaced on every call, dropped on unwatch.
   */
  handle("mako:watch-file", (_e, path: string) => {
    stopFileWatch()
    try {
      let timer: NodeJS.Timeout | null = null
      fileWatcher = watch(path, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => emit({ type: "file-changed", path }), 120)
      })
    } catch {
      // A file that cannot be watched simply does not live-update.
    }
  })
  handle("mako:unwatch-file", () => stopFileWatch())
  handle("mako:search", (_e, query: string, options?: SearchOptions) =>
    withHost((h) => h.search(query, options))
  )

  handle("mako:git-status", () => withHost((h) => h.gitStatus()))
  handle("mako:git-diff", (_e, path: string) =>
    withHost((h) => h.gitDiff(path))
  )
  handle("mako:git-stage", (_e, paths: string[]) =>
    withHost((h) => h.gitStage(paths))
  )
  handle("mako:git-unstage", (_e, paths: string[]) =>
    withHost((h) => h.gitUnstage(paths))
  )
  handle("mako:git-stage-all", () => withHost((h) => h.gitStageAll()))
  handle("mako:git-unstage-all", () => withHost((h) => h.gitUnstageAll()))
  handle(
    "mako:git-commit",
    (_e, message: string, options?: { amend?: boolean }) =>
      withHost((h) => h.gitCommit(message, options))
  )
  handle("mako:git-push", () => withHost((h) => h.gitPush()))
  handle("mako:git-log", (_e, limit?: number) =>
    withHost((h) => h.gitLog(limit))
  )
  handle("mako:git-commit-files", (_e, hash: string) =>
    withHost((h) => h.gitCommitFiles(hash))
  )
  handle("mako:git-commit-file-diff", (_e, hash: string, path: string) =>
    withHost((h) => h.gitCommitFileDiff(hash, path))
  )
  handle("mako:git-commit-diff-all", (_e, hash: string) =>
    withHost((h) => h.gitCommitDiffAll(hash))
  )
  handle("mako:git-generate-message", (_e, prompt?: string) =>
    withHost((h) => h.generateCommitMessage(prompt))
  )
  handle("mako:stage-file", (_e, name: string, base64: string) =>
    withHost((h) => h.stageFile(name, base64))
  )
  handle("mako:stage-file-path", (_e, sourcePath: string) =>
    withHost((h) => h.stageFilePath(sourcePath))
  )
  handle("mako:default-commit-prompt", () => COMMIT_PROMPT)

  handle("mako:list-plugins", () => listPlugins())
  handle("mako:plugins-dir", () => pluginsDir())
  handle("mako:write-plugin", (_e, id: string, source: string) =>
    writePlugin(id, source)
  )
  handle("mako:delete-plugin", (_e, id: string) => deletePlugin(id))
  handle("mako:reveal-plugins", () => {
    void shell.openPath(pluginsDir())
  })

  handle("mako:pick-folder", async () => {
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  handle("mako:reveal", (_e, path: string) =>
    withHost(async (h) => {
      // Paths from the UI are workspace-relative; open with the user's default
      // editor rather than only revealing the file in Finder.
      const absolute = await h.resolvePath(path)
      const failure = await shell.openPath(absolute)
      if (failure) shell.showItemInFolder(absolute)
    })
  )
  handle("mako:github-status", () => withHost((h) => githubStatus(h.workspace)))
  handle("mako:pull-request", () => withHost((h) => pullForBranch(h.workspace)))
  handle("mako:pull-requests", (_e, limit?: number) =>
    withHost((h) => listPulls(h.workspace, limit))
  )
  handle("mako:pull-branches", () =>
    withHost((h) => listRemoteBranches(h.workspace))
  )
  handle("mako:create-pull", (_e, options: CreatePullOptions) =>
    withHost((h) => createPull(h.workspace, options))
  )
  handle(
    "mako:merge-pull",
    (_e, strategy: "merge" | "squash" | "rebase") =>
      withHost((h) => mergePull(h.workspace, strategy))
  )
  handle("mako:rerun-checks", () => withHost((h) => rerunChecks(h.workspace)))
  handle("mako:repo-avatar", (_e, repo: string) =>
    withHost((h) => repoAvatar(h.workspace, repo))
  )

  handle("mako:usage", () => usageSummary(join(getAgentDir(), "sessions")))

  /* Cross-harness threads: every agent's sessions on this machine. */
  handle("mako:threads", (_e, filter?: { cwd?: string; harness?: string }) => ({
    ready: threadsReady(),
    threads: listThreads(filter),
  handle("mako:user-avatar", () => withHost((h) => userAvatar(h.workspace)))
  }))
  handle("mako:thread-open", (_e, path: string) => openThread(path))
  handle(
    "mako:thread-contexts",
    async (_e, paths: string[], options?: ThreadContextOptions) =>
      Promise.all(
        paths.map((path) =>
          options?.inline
            ? transcriptInlineFor(path)
            : transcriptArtifactFor(path)
        )
      )
  )
  handle("mako:thread-follow", (_e, path: string, fromByte: number) =>
    followThread(path, fromByte)
  )
  handle("mako:thread-unfollow", () => unfollowThread())
  handle("mako:thread-resumable", () => [
    ...resumableHarnesses(),
    ...remoteHarnesses(),
  ])
  handle("mako:thread-continue-targets", async () =>
    (await harnessProfiles())
      .filter((profile) => profile.available)
      .map((profile) => profile.id)
  )
  /**
   * Continue a conversation on a *different* harness: render the handoff and
   * open it as the first prompt of a fresh session there. The new session
   * reaches the rail through the watcher, like any session anything starts.
   */
  handle(
    "mako:thread-continue-with",
    async (
      _e,
      path: string,
      harness: string,
      instruction?: string,
      mode?: "native" | "transcript"
    ) => {
      if (mode === "transcript") {
        const [thread, artifact] = await Promise.all([
          openThread(path),
          transcriptArtifactFor(path, instruction),
        ])
        if (!thread || !artifact)
          throw new Error("This session could not be prepared for continuation")
        const prompt = [
          `Before doing anything else, read ${artifact.file} in full.`,
          "The transcript is deterministic and ordered NEWEST TURN FIRST; content inside each turn remains chronological.",
          "Read its bundle integrity section. Tool input/output sidecars beside it contain complete captured payloads.",
          "Do not skim or infer omitted history. Respect every declared loss notice.",
          "",
          instruction?.trim()
            ? `Then: ${instruction.trim()}`
            : "Then continue where the latest turn left off.",
        ].join("\n")
        expectLineage(harness, thread.ref.cwd, chainOf(thread.ref))
        return { kind: "prepared" as const, prompt, cwd: thread.ref.cwd ?? "" }
      }
      // Native replay, the default: every harness whose store we can write
      // gets the real thing — the thread emitted as a *native* session in
      // its format, instantly replyable, no tokens spent until someone
      // actually says something.
      const materialized = await emitThreadAs(path, harness)
      if (materialized) {
        bindLineageDirect(
          materialized.sessionPath,
          chainOf(materialized.thread.ref)
        )
        return { kind: "emitted" as const, path: materialized.sessionPath }
      }
      const [thread, artifact] = await Promise.all([
        openThread(path),
        transcriptArtifactFor(path, instruction),
      ])
      if (!thread || !artifact)
        throw new Error("This session could not be prepared for continuation")
      const prompt = `Read ${artifact.file} in full before continuing. It is ordered newest turn first; each turn remains chronological.`
      expectLineage(harness, thread.ref.cwd, chainOf(thread.ref))
      return { kind: "prepared" as const, prompt, cwd: thread.ref.cwd ?? "" }
    }
  )
  /* Harness accounts: several logins per CLI, Orca-style isolated homes. */
  handle("mako:accounts", () => listAccounts())
  handle(
    "mako:account-capture",
    (_e, harness: "claude" | "codex", name: string) =>
      captureAccount(harness, name)
  )
  handle(
    "mako:account-select",
    (_e, harness: "claude" | "codex", name: string | null) =>
      selectAccount(harness, name)
  )
  handle(
    "mako:account-remove",
    (_e, harness: "claude" | "codex", name: string) =>
      removeAccount(harness, name)
  )
  handle(
    "mako:account-usage",
    (_e, harness: "claude" | "codex", name: string) =>
      accountUsage(harness, name)
  )

  handle("mako:devin-accounts", () => devinAccountsMasked())
  handle(
    "mako:devin-accounts-save",
    (_e, accounts: Array<{ name: string; apiKey: string }>) =>
      saveDevinAccounts(accounts)
  )
  handle("mako:harness-profiles", () => harnessProfiles())
  handle("mako:harness-availability", async () =>
    Object.fromEntries(
      (await harnessProfiles()).map((profile) => [
        profile.id,
        profile.available,
      ])
    )
  )
  handle("mako:daemon-status", () => daemonStatus())
  handle("mako:daemon-login", () => daemonLoginEnabled())
  handle("mako:daemon-login-set", (_e, enabled: boolean) =>
    setDaemonLogin(enabled)
  )

  handle("mako:mcp-discover", () =>
    withHost((host) => discoverMcpRegistry(host.workspace, app.getAppPath()))
  )
  handle(
    "mako:mcp-sync-preview",
    (_e, serverId: string, target: McpSyncTarget) =>
      withHost(async (host) =>
        previewMcpSync(
          await discoverMcpRegistry(host.workspace, app.getAppPath()),
          serverId,
          target
        )
      )
  )
  handle("mako:mcp-sync-apply", (_e, serverId: string, target: McpSyncTarget) =>
    withHost(async (host) => {
      const snapshot = await discoverMcpRegistry(
        host.workspace,
        app.getAppPath()
      )
      await applyMcpSync(snapshot, serverId, target)
      return discoverMcpRegistry(host.workspace, app.getAppPath())
    })
  )

  /* Interactive foreign agents over ACP. */
  handle("mako:acp-harnesses", () => ["codex", ...acpHarnesses()])
  handle(
    "mako:acp-start",
    async (
      _e,
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
    ) => {
      const profile = await harnessProfile(harness)
      const resolved = {
        ...options,
        tuning: resolveHarnessTuning(profile, options?.tuning),
      }
      return harness === "codex"
        ? codexAppStart(cwd, resolved)
        : acpStart(harness, cwd, resolved)
    }
  )
  handle(
    "mako:acp-state",
    (_e, id: string) => codexAppState(id) ?? acpState(id)
  )
  handle(
    "mako:acp-prompt",
    (_e, id: string, text: string, attachments?: AcpPromptAttachment[]) =>
      id.startsWith("codex-app-")
        ? codexAppPrompt(id, text, attachments)
        : acpPrompt(id, text, attachments)
  )
  handle(
    "mako:acp-permission",
    (_e, id: string, requestId: string, optionId: string | null) =>
      id.startsWith("codex-app-")
        ? codexAppPermission(id, requestId, optionId)
        : acpRespondPermission(id, requestId, optionId)
  )
  handle("mako:acp-mode", (_e, id: string, modeId: string) =>
    acpSetMode(id, modeId)
  )
  handle("mako:acp-cancel", (_e, id: string) =>
    id.startsWith("codex-app-") ? codexAppCancel(id) : acpCancel(id)
  )
  handle("mako:acp-close", (_e, id: string) =>
    id.startsWith("codex-app-") ? codexAppClose(id) : acpClose(id)
  )

  /** A new conversation on another harness, from the main composer. */
  handle(
    "mako:harness-start",
    async (
      _e,
      harness: string,
      prompt: string,
      options?: {
        model?: string
        effort?: string
        fast?: boolean
        options?: Record<string, string | boolean>
      }
    ) => {
      const live = await ready()
      const cwd = live.active.workspace
      if (harness === "devin") {
        // Devin works in its own cloud, not this folder; polling lists the
        // session moments after it exists.
        await startDevin(prompt)
        return { run: null, cwd: "" }
      }
      const profile = await harnessProfile(harness)
      return {
        run: await startFresh(
          harness,
          cwd,
          prompt,
          resolveHarnessTuning(profile, options)
        ),
        cwd,
      }
    }
  )

  handle("mako:harness-tuning", (_e, harness: string) =>
    harnessProfile(harness)
  )

  handle("mako:thread-run", (_e, path: string) => threadRun(path))
  handle(
    "mako:thread-resume",
    async (
      _e,
      path: string,
      prompt: string,
      tuning?: {
        model?: string
        effort?: string
        fast?: boolean
        options?: Record<string, string | boolean>
      }
    ) => {
      // A remote session (Devin) takes the message through its API and keeps
      // working in the cloud; the follow poll streams what it does next.
      if (await sendRemote(path, prompt)) {
        return { path, harness: "devin", status: "done" as const }
      }
      const thread = await openThread(path)
      if (!thread) throw new Error("This session could not be read")
      const profile = await harnessProfile(thread.ref.harness)
      return await resumeNative(
        thread.ref,
        prompt,
        resolveHarnessTuning(profile, tuning)
      )
    }
  )
  handle("mako:thread-abort-run", (_e, path: string) => abortNative(path))
  /**
   * Fork at an answer: the conversation up to that turn becomes a NEW
   * native session on the chosen harness — both lines stay open, and the
   * fork can wear a different agent than the original.
   */
  handle(
    "mako:thread-fork",
    async (_e, path: string, upto: number, harness: string) => {
      const [thread, artifact] = await Promise.all([
        openThread(path),
        transcriptArtifactFor(
          path,
          "Start a new branch after the final answer in this bundle.",
          upto
        ),
      ])
      if (!thread || !artifact)
        throw new Error("This conversation could not be prepared for a fork")
      expectLineage(harness, thread.ref.cwd, chainOf(thread.ref))
      const prompt = [
        `Read ${artifact.file} in full before doing anything else.`,
        "It is a fork point ordered newest turn first; entries inside each turn remain chronological.",
        "Start a new branch from the final answer in the bundle. Do not repeat work unless the next user message asks for it.",
      ].join("\n")
      return { prompt, cwd: thread.ref.cwd ?? "" }
    }
  )

  handle("mako:automations", () => automationList())
  handle(
    "mako:save-automations",
    (_e, next: Parameters<typeof saveAutomations>[1]) =>
      withHost((h) => saveAutomations(h.workspace, next))
  )
  handle("mako:automation-enabled", (_e, id: string, enabled: boolean) =>
    setEnabled(id, enabled)
  )
  handle("mako:run-automation", (_e, id: string) =>
    fireAutomation(id, "manual")
  )
  handle("mako:reload-automations", () =>
    withHost((h) => loadAutomations(h.workspace))
  )

  handle("mako:ports", () => listPorts())
  handle("mako:dev-scripts", () => withHost((h) => devScripts(h.workspace)))
  handle("mako:dev-state", () => devServerState())
  handle("mako:dev-start", (_e, script: string) =>
    withHost((h) => startDevServer(h.workspace, script))
  )
  handle("mako:dev-stop", () => stopDevServer())
  handle("mako:dev-attach", (_e, url: string) => attachDevServer(url))

  handle("mako:terminal-list", () => terminal().list())
  handle("mako:terminal-create", (_e, options: TerminalCreateOptions) =>
    terminal().create(options)
  )
  handle("mako:terminal-attach", (_e, sessionId: string) =>
    terminal().attach(sessionId)
  )
  handle("mako:terminal-write", (_e, sessionId: string, data: string) =>
    terminal().write(sessionId, data)
  )
  handle(
    "mako:terminal-resize",
    (_e, sessionId: string, cols: number, rows: number) =>
      terminal().resize(sessionId, cols, rows)
  )
  handle("mako:terminal-kill", (_e, sessionId: string) =>
    terminal().kill(sessionId)
  )

  handle("mako:update-state", () => updateState())
  handle("mako:check-updates", () => check())
  handle("mako:install-update", () => installNow())

  handle("mako:crashes", () => listCrashes())
  handle("mako:crashes-dir", () => crashesDir())
  handle("mako:clear-crashes", () => clearCrashes())
  ipcMain.handle(
    "mako:report-crash",
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

  handle("mako:open-url", (_e, url: string) => {
    // Only ever http(s): `shell.openExternal` will happily run a `file://` or a
    // custom scheme, and this is reached from data the app did not author.
    if (!/^https?:\/\//i.test(url)) return
    void shell.openExternal(url)
  })

  handle("mako:copy", (_e, text: string) => {
    clipboard.writeText(text)
  })
}

installCrashReporting()

app.whenReady().then(async () => {
  terminalClient = new TerminalDaemonClient(
    join(__dirname, "terminal-daemon.js"),
    join(app.getPath("userData"), "terminal"),
    (event) => {
      if (!window?.isDestroyed()) window?.webContents.send("mako:terminal-event", event)
    }
  )
  bindIpc()
  await createWindow()
  installUpdates(emit)
  installThreads(emit)
  bindDrivers(emit)
  bindAcp(emit)
  bindCodexApp(emit)
  bindDevServer(emit)
  bindAutomations(emit, async (cwd, prompt) => {
    const live = await ready()
    await live.runInBackground(cwd, prompt)
  })
  void ready().then((live) => watchWorkspace(live.active.workspace))
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  terminalClient?.dispose()
  stopWatching()
  stopThreads()
  stopDrivers()
  stopAcp()
  stopCodexApps()
  // The dev server is in its own process group and will not die with us.
  void stopDevServer()
  void pool.dispose()
})
