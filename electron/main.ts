import { resolveExecutable } from "./executable.js"
import { Appshots } from "./appshots.js"
import { imageSize } from "image-size"
import { ControlPreviews } from "./control-previews.js"
import { RelayConversations } from "./relay-conversations.js"
import { nativeCheckpoint, canResumeBinding } from "./native-continuation.js"
import { NativeRequests } from "./native-requests.js"
import type { NativeRequestInput } from "./shared.js"
import { startConversationMcp } from "./conversation-mcp.js"
import { BrowserService } from "./browser-service.js"
import { startControlService } from "./control-service.js"
import type { DelegateInput, ForkInput, TransferInput } from "./shared.js"
import { attachmentFiles } from "@mako/sessions"
import { WorkspaceFiles } from "./host-workspace.js"
import { WorkspaceGit } from "./host-git.js"
import { resolveFilePreview } from "./file-previews.js"
import { providerHost } from "./providers/index.js"
import { LiveConversations } from "./live-conversations.js"
import type { LiveStartOptions } from "./shared.js"
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  protocol,
  shell,
  type BrowserWindowConstructorOptions,
} from "electron"
import { watch } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { AgentHost } from "./host.js"
import {
  clearCrashes,
  crashesDir,
  installCrashReporting,
  listCrashes,
  record,
} from "./crash.js"
import { installAutomation } from "./automation.js"
import {
  computerPermissions,
  requestComputerPermissions,
} from "./computer-permissions.js"
import { check, installNow, installUpdates, updateState } from "./updates.js"
import { usageSummary } from "./usage.js"
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
  createPull,
  githubStatus,
  listPulls,
  listRemoteBranches,
  mergePull,
  pullForBranch,
  repoAvatar,
  rerunChecks,
  userAvatar,
  type CreatePullOptions,
} from "./github.js"
import { HostPool } from "./pool.js"
import { listExternalEditors, openInExternalEditor } from "./editors.js"
import { workspacePreviewPath } from "./workspace-preview.js"
import {
  daemonStatus,
  emitThreadAs,
  followThread,
  threadsReady,
  threadActivitySnapshot,
  installThreads,
  listThreads,
  openThread,
  pageThread,
  readThreadFile,
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
  threadRun,
  waitForNativeRun,
  startFresh,
  stopDrivers,
} from "./drivers.js"
import {
  harnessProfile,
  harnessProfiles,
  resolveHarnessTuning,
} from "./harnesses.js"
import { bindLineageDirect, chainOf } from "./lineage.js"
import {
  accountUsage,
  captureAccount,
  listAccounts,
  removeAccount,
  selectAccount,
  type AccountHarness,
  type AccountProvider,
} from "./accounts.js"
import { daemonLoginEnabled, setDaemonLogin } from "./daemon-login.js"
import { TerminalDaemonClient } from "./terminal-client.js"
import { ensureCuaEmbedded, stopCuaEmbedded } from "./cua-embedded.js"
import { bindAcp, stopAcp } from "./acp.js"
import { bindCodexApp, stopCodexApps } from "./codex-app.js"
import {
  deletePlugin,
  listPlugins,
  pluginsDir,
  watchPlugins,
  writePlugin,
} from "./plugins.js"
import { discoverMcpRegistry } from "./mcp-registry.js"
import { integrationCatalog } from "./integrations.js"
import {
  backendConnectionStatus,
  ensureBackendConnectionEnvironment,
} from "./backend-connection.js"
import { startSlackRelay, stopSlackRelay } from "./slack-relay.js"
import { applyMcpSync, previewMcpSync } from "./mcp-sync.js"
import { discoverSkillRegistry } from "./skill-registry.js"
import {
  applySkillSync,
  previewSkillRemove,
  previewSkillSync,
} from "./skill-sync.js"
import { installGitIpc } from "./ipc/git.js"
import { fileResponse } from "./file-response.js"
import { startWebHost } from "./web-host.js"
import { registerIpc as handle, invokeHost } from "./ipc/register.js"
import { installSessionIpc } from "./ipc/session.js"
import { installWorkspaceIpc, stopWorkspaceIpc } from "./ipc/workspace.js"
import type {
  LivePermissionResponse,
  PromptAttachment,
  HostEvent,
  McpSyncTarget,
  SkillSyncTarget,
  TerminalCreateOptions,
  ThreadContextOptions,
} from "./shared.js"

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mako-file",
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged && !process.env.MAKO_PROD
if (!app.requestSingleInstanceLock()) {
  console.error(
    "Mako is already running. Close the existing desk host before starting another desktop or web host."
  )
  app.exit(1)
}

/**
 * The Dock and window icon.
 *
 * A raw square PNG is not a macOS icon: the system draws it exactly as given,
 * so it renders with hard corners and no margin — visibly larger and squarer
 * than everything beside it. Packaged macOS uses the bundle icon directly;
 * decoding another copy here retains tens of megabytes of CoreGraphics image
 * backing for no visual change. The explicit image is only for development and
 * platforms whose windows need one.
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

let conversationMcp: Awaited<ReturnType<typeof startConversationMcp>> | null =
  null
let nativeRequests: NativeRequests | null = null
const appshots = new Appshots(async () => {
  const driver = resolveExecutable("cua-driver")
  const socket = await ensureMakoLocalControl()
  return driver && socket
    ? { command: driver, args: ["mcp", "--embedded", "--socket", socket] }
    : null
})
const browserControl = new BrowserService()
const controlPreviews = new ControlPreviews(
  browserControl,
  (image) => {
    const bytes = Buffer.from(image.data, "base64")
    const dimensions = imageSize(bytes)
    if (dimensions.width * dimensions.height > 32_000_000) return null
    const decoded = nativeImage.createFromBuffer(bytes)
    if (decoded.isEmpty()) return null
    return {
      data: decoded
        .resize({
          width: Math.min(960, decoded.getSize().width),
          quality: "good",
        })
        .toJPEG(55)
        .toString("base64"),
      mimeType: "image/jpeg",
    }
  },
  (activity) => emit({ type: "control-activity", activity })
)
let controlService: Awaited<ReturnType<typeof startControlService>> | null =
  null
let liveConversations: LiveConversations
let window: BrowserWindow | null = null
let webHost: Awaited<ReturnType<typeof startWebHost>> | undefined
const webSocket = isDev ? process.env.MAKO_WEB_SOCKET : undefined
let terminalClient: TerminalDaemonClient | null = null
const pool = new HostPool(emit)
let starting: Promise<unknown> | null = null

function terminal() {
  if (!terminalClient) throw new Error("Terminal service is not ready")
  return terminalClient
}

function ensureMakoLocalControl() {
  return ensureCuaEmbedded(
    join(app.getPath("userData"), "computer-use", "cua"),
    "dev.mako.app"
  )
}

function emitTerminalWake() {
  webHost?.terminal({ type: "wake" })
  if (!window?.isDestroyed()) {
    window?.webContents.send("mako:terminal-event", { type: "wake" })
  }
}

function emit(event: HostEvent) {
  if (event.type === "thread-run" && event.run.status !== "running")
    nativeRequests?.ready(event.run.path)
  // Git status is recomputed after every turn and on focus, which is exactly
  // when HEAD could have moved — so the commit trigger rides on it rather than
  // running a watcher of its own.
  if (event.type === "git") noticeHead(event.git.head)
  webHost?.event(event)
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
  const icon =
    process.platform === "darwin" && app.isPackaged ? undefined : appIcon()
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
    backgroundColor: "#140f0d",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Agent processes live in the host; a hidden renderer can sleep safely.
      backgroundThrottling: true,
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
  window.once("closed", () => {
    void terminalClient?.detachActive().catch(() => {})
    window = null
  })
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

function bindIpc() {
  installSessionIpc({
    liveSummaries: () => liveConversations.summaries(),
    ready,
    withHost,
    platform: process.platform,
    sourceRoot: isDev ? app.getAppPath() : undefined,
    onWorkspaceChanged: watchWorkspace,
  })

  installWorkspaceIpc({ withHost, emit })
  installGitIpc({ withHost })

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
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })
  handle("mako:external-editors", () => listExternalEditors())
  handle("mako:open-in-editor", (_e, path: string, editor?: string) =>
    withHost(async (h) => {
      const absolute = await h.resolvePath(path)
      await openInExternalEditor(absolute, editor)
    })
  )
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
  handle("mako:merge-pull", (_e, strategy: "merge" | "squash" | "rebase") =>
    withHost((h) => mergePull(h.workspace, strategy))
  )
  handle("mako:rerun-checks", () => withHost((h) => rerunChecks(h.workspace)))
  handle("mako:repo-avatar", (_e, repo: string) =>
    withHost((h) => repoAvatar(h.workspace, repo))
  )
  handle("mako:user-avatar", () => withHost((h) => userAvatar(h.workspace)))

  handle("mako:usage", () =>
    usageSummary(join(homedir(), ".mako", "sessions"), homedir())
  )

  /* Cross-harness threads: every agent's sessions on this machine. */
  handle("mako:threads", (_e, filter?: { cwd?: string; harness?: string }) => ({
    ready: threadsReady(),
    threads: listThreads(filter),
    activity: threadActivitySnapshot(),
  }))
  handle("mako:thread-open", (_e, path: string) => openThread(path))
  handle("mako:thread-file", (_e, threadPath: string, filePath: string) =>
    readThreadFile(threadPath, filePath)
  )
  handle(
    "mako:thread-page",
    (_e, path: string, before?: number, limit?: number) =>
      pageThread(path, before, limit)
  )
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
    ...new Set([
      ...resumableHarnesses(),
      ...providerHost.liveDrivers
        .list()
        .filter((driver) => driver.available(app.getAppPath()))
        .map((driver) => driver.provider),
    ]),
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
      return { kind: "prepared" as const, prompt, cwd: thread.ref.cwd ?? "" }
    }
  )
  /* Harness accounts: several logins per CLI, Orca-style isolated homes. */
  handle("mako:accounts", () => listAccounts())
  handle("mako:account-capture", (_e, harness: AccountHarness, name: string) =>
    captureAccount(harness, name)
  )
  handle(
    "mako:account-select",
    (_e, harness: AccountHarness, name: string | null) =>
      selectAccount(harness, name)
  )
  handle("mako:account-remove", (_e, harness: AccountHarness, name: string) =>
    removeAccount(harness, name)
  )
  handle("mako:account-usage", (_e, harness: AccountProvider, name: string) =>
    accountUsage(harness, name)
  )

  handle("mako:harness-profiles", (_event, force?: boolean) =>
    harnessProfiles(force === true)
  )
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

  handle("mako:computer-permissions", () => computerPermissions())
  handle(
    "mako:control-preview-source",
    async (_event, conversationId: string) => {
      const target = controlPreviews.nativeWindow(conversationId)
      if (!target) return null
      const source = await appshots.source(target)
      const current = controlPreviews.nativeWindow(conversationId)
      return current?.pid === target.pid && current.windowId === target.windowId
        ? source
        : null
    }
  )
  handle("mako:appshot-windows", () => appshots.windows(true))
  handle(
    "mako:appshot-capture",
    (_event, target: import("./shared.js").AppshotTarget) =>
      appshots.capture(target)
  )
  handle(
    "mako:control-preview",
    (_event, conversationId: string, watching: boolean, watcher: string) =>
      controlPreviews.read(conversationId, watching, watcher)
  )
  handle("mako:browser-control-status", () => browserControl.status())
  handle("mako:browser-control-connect", async (_event, browser: string) => {
    await browserControl.connect(browser)
    return browserControl.status()
  })
  handle("mako:browser-control-disconnect", (_event, browser: string) => {
    browserControl.disconnect(browser)
    return browserControl.status()
  })
  handle("mako:computer-permissions-request", () =>
    requestComputerPermissions(() => {
      window?.show()
      window?.focus()
      app.focus({ steal: true })
    })
  )

  handle("mako:mcp-discover", () =>
    withHost(async (host) => {
      await ensureMakoLocalControl().catch(() => null)
      return discoverMcpRegistry(host.workspace, app.getAppPath())
    })
  )
  handle("mako:integrations", () =>
    withHost(async (host) => {
      await ensureMakoLocalControl().catch(() => null)
      const [snapshot, github, backend] = await Promise.all([
        discoverMcpRegistry(host.workspace, app.getAppPath()),
        githubStatus(host.workspace),
        backendConnectionStatus(),
      ])
      return integrationCatalog(
        snapshot,
        computerPermissions(),
        github.authenticated,
        backend,
        browserControl.status()
      )
    })
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

  handle("mako:skills-discover", () =>
    withHost((host) => discoverSkillRegistry(host.workspace))
  )
  handle(
    "mako:skills-sync-preview",
    (_e, skillId: string, target: SkillSyncTarget) =>
      withHost(async (host) =>
        previewSkillSync(
          await discoverSkillRegistry(host.workspace),
          skillId,
          target
        )
      )
  )
  handle(
    "mako:skills-remove-preview",
    (_e, skillId: string, target: SkillSyncTarget) =>
      withHost(async (host) =>
        previewSkillRemove(
          await discoverSkillRegistry(host.workspace),
          skillId,
          target
        )
      )
  )
  handle(
    "mako:skills-sync-apply",
    (_e, skillId: string, targets: SkillSyncTarget[]) =>
      withHost(async (host) => {
        const snapshot = await discoverSkillRegistry(host.workspace)
        const source = snapshot.skills.find((skill) => skill.id === skillId)
          ?.origins[0]
        const ordered = [...targets].sort((left, right) => {
          const matches = (target: SkillSyncTarget) =>
            source?.provider === target.provider &&
            source.account === target.account &&
            source.scope === target.scope
          return Number(matches(left)) - Number(matches(right))
        })
        for (const target of ordered) {
          await applySkillSync(snapshot, skillId, target)
        }
        return discoverSkillRegistry(host.workspace)
      })
  )

  handle("mako:live-capabilities", () =>
    providerHost.liveDrivers
      .list()
      .filter((driver) => driver.available(app.getAppPath()))
      .map((driver) => ({
        provider: driver.provider,
        canResume: driver.canResume,
      }))
  )
  handle(
    "mako:live-start",
    async (_event, harness: string, cwd: string, options: LiveStartOptions) => {
      await ensureMakoLocalControl().catch(() => null)
      const profile = await harnessProfile(harness)
      await liveConversations.start(harness, cwd, {
        ...options,
        tuning: resolveHarnessTuning(profile, options.tuning),
      })
      return liveConversations.snapshot(options.conversationId)
    }
  )
  handle(
    "mako:native-receipt",
    (_event, id: string) => nativeRequests?.receipt(id) ?? null
  )
  handle("mako:native-dismiss", (_event, id: string) =>
    nativeRequests?.dismiss(id)
  )
  handle("mako:native-requests", () => nativeRequests?.list() ?? [])
  handle("mako:native-submit", (_event, input: NativeRequestInput) => {
    if (!nativeRequests)
      throw new Error("The native command service is not ready")
    return nativeRequests.submit(input)
  })
  handle("mako:live-delegate", (_event, id: string, input: DelegateInput) =>
    liveConversations.delegate(id, input)
  )
  handle("mako:live-child-cancel", (_event, id: string, childId: string) =>
    liveConversations.cancelChild(id, childId)
  )
  handle("mako:live-merge-fork", (_event, id: string, mergeId: string) =>
    liveConversations.mergeFork(id, mergeId)
  )
  handle("mako:live-fork", (_event, id: string, input: ForkInput) =>
    liveConversations.fork(id, input)
  )
  handle("mako:live-capture", (_event, id: string, path: string) =>
    liveConversations.capture(id, path)
  )
  handle(
    "mako:live-transfer",
    async (_event, id: string, input: TransferInput) => {
      const profile = await harnessProfile(input.provider)
      return liveConversations.transfer(id, {
        ...input,
        tuning: resolveHarnessTuning(profile, input.tuning),
      })
    }
  )
  handle("mako:live-clear-queue", (_event, id: string) =>
    liveConversations.clearQueue(id)
  )
  handle("mako:live-earlier", (_event, id: string) =>
    liveConversations.earlier(id)
  )
  handle("mako:live-bind", (_event, id: string, path: string) =>
    liveConversations.bind(id, path)
  )
  handle("mako:read-live-file", (_event, id: string, path: string) => {
    const snapshot = liveConversations.snapshot(id)
    if (!snapshot) throw new Error("That conversation is unavailable")
    const manifests = [
      ...(snapshot.control?.transfers.flatMap((transfer) =>
        transfer.state.kind === "accepted" ? [transfer.state.manifest] : []
      ) ?? []),
      ...(snapshot.control?.merges.map((merge) => merge.manifest) ?? []),
      ...snapshot.requests.flatMap((request) => request.context ?? []),
    ]
    const files = [
      ...manifests.flatMap((manifest) => [
        manifest.file,
        ...(manifest.resources ?? []),
      ]),
      ...attachmentFiles(snapshot.base?.entries ?? []),
      ...snapshot.blocks.flatMap((block) => {
        const attachments =
          block.type === "attachment"
            ? [block.attachment]
            : block.type === "tool" || block.type === "user"
              ? (block.attachments ?? [])
              : []
        return attachments.flatMap((attachment) =>
          attachment.source.kind === "file" ? [attachment.source.path] : []
        )
      }),
    ]
    return new WorkspaceFiles(
      snapshot.session.cwd,
      new WorkspaceGit(snapshot.session.cwd)
    ).read(path, files)
  })
  handle("mako:live-snapshot", (_event, id: string) =>
    liveConversations.snapshot(id)
  )
  handle(
    "mako:live-state",
    (_event, id: string) => liveConversations.snapshot(id)?.session ?? null
  )
  handle(
    "mako:live-prompt",
    (
      _event,
      id: string,
      requestId: string,
      text: string,
      attachments?: PromptAttachment[]
    ) => liveConversations.submit(id, requestId, text, attachments)
  )
  handle(
    "mako:live-permission",
    (_event, id: string, requestId: string, response: LivePermissionResponse) =>
      liveConversations.permission(id, requestId, response)
  )
  handle("mako:live-mode", (_event, id: string, modeId: string) =>
    liveConversations.setMode(id, modeId)
  )
  handle("mako:live-cancel", (_event, id: string) =>
    liveConversations.cancel(id)
  )
  handle("mako:live-close", (_event, id: string) => liveConversations.close(id))

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
  handle("mako:thread-abort-run", (_e, path: string) => abortNative(path))
  /**
   * Fork at an answer: the conversation up to that turn becomes a NEW
   * native session on the chosen harness — both lines stay open, and the
   * fork can wear a different agent than the original.
   */
  handle("mako:thread-fork", async (_e, path: string, upto: number) => {
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
    const prompt = [
      `Read ${artifact.file} in full before doing anything else.`,
      "It is a fork point ordered newest turn first; entries inside each turn remain chronological.",
      "Start a new branch from the final answer in the bundle. Do not repeat work unless the next user message asks for it.",
    ].join("\n")
    return { prompt, cwd: thread.ref.cwd ?? "" }
  })

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

  handle("mako:terminal-list", () => terminal().list())
  handle("mako:terminal-create", (_e, options: TerminalCreateOptions) =>
    terminal().create(options)
  )
  handle("mako:terminal-attach", (_e, sessionId: string) =>
    terminal().attach(sessionId)
  )
  handle("mako:terminal-detach", (_e, sessionId: string) =>
    terminal().detach(sessionId)
  )
  handle("mako:terminal-write", (_e, sessionId: string, data: string) =>
    terminal().write(sessionId, data)
  )
  handle(
    "mako:terminal-acknowledge",
    (_e, sessionId: string, sequence: number) =>
      terminal().acknowledge(sessionId, sequence)
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
  handle(
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

async function readFilePreview(request: Request): Promise<Response> {
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405 })
  const artifact = resolveFilePreview(request.url)
  if (artifact)
    return fileResponse(
      await net.fetch(pathToFileURL(artifact).toString(), {
        signal: request.signal,
      }),
      artifact,
      request
    )
  const path = workspacePreviewPath(request.url)
  if (!path) return new Response("Not found", { status: 404 })
  try {
    return await withHost(async (host) => {
      const absolute = await host.resolvePath(path)
      return fileResponse(
        await net.fetch(pathToFileURL(absolute).toString(), {
          signal: request.signal,
        }),
        absolute,
        request
      )
    })
  } catch {
    return new Response("Not found", { status: 404 })
  }
}

installCrashReporting()

app.whenReady().then(async () => {
  app.setAboutPanelOptions({
    applicationName: "Mako",
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: "© 2026 Verbiflow",
    credits:
      "Desktop app for Claude Code, Codex, Cursor, Grok, Devin, and OpenCode.",
  })
  await ensureBackendConnectionEnvironment()
  protocol.handle("mako-file", readFilePreview)
  terminalClient = new TerminalDaemonClient(
    join(__dirname, "terminal-daemon.js"),
    join(app.getPath("userData"), "terminal"),
    (event) => {
      webHost?.terminal(event)
      if (!window?.isDestroyed())
        window?.webContents.send("mako:terminal-event", event)
    }
  )
  powerMonitor.on("resume", emitTerminalWake)
  powerMonitor.on("unlock-screen", emitTerminalWake)
  liveConversations = new LiveConversations({
    checkpoint: nativeCheckpoint,
    canResume: (binding) =>
      canResumeBinding(
        binding,
        providerHost.processProbes.get(binding.provider)
      ),
    appPath: app.getAppPath(),
    root: join(app.getPath("userData"), "conversations"),
    tools: (bindingId, conversationId) => {
      const tools = conversationMcp?.mint(bindingId, conversationId)
      return tools
        ? { ...tools, control: controlService?.mint(conversationId, bindingId) }
        : undefined
    },
    providers: () =>
      providerHost.liveDrivers.list().map((driver) => driver.provider),
    driver: (provider) => providerHost.liveDrivers.get(provider),
    history: pageThread,
    emit,
  })
  nativeRequests = new NativeRequests(
    join(app.getPath("userData"), "native-requests"),
    {
      read: async (path) => (await openThread(path))?.ref ?? null,
      running: (path) => threadRun(path)?.status === "running",
      execute: async (ref, text, tuning) => {
        const profile = await harnessProfile(ref.harness)
        await resumeNative(ref, text, {
          ...resolveHarnessTuning(profile, tuning),
          captureOutput: true,
        })
        const result = await waitForNativeRun(ref.path)
        if (result.state.status !== "done")
          throw new Error(
            result.state.error ?? "Native execution did not complete"
          )
      },
      changed: (requests) => emit({ type: "native-requests", requests }),
      failed: (message) => emit({ type: "notice", level: "error", message }),
    }
  )
  conversationMcp = await startConversationMcp(liveConversations)
  controlService = await startControlService(
    browserControl,
    (conversationId, bindingId) => {
      liveConversations.authorizeAgent(conversationId, bindingId)
    },
    controlPreviews
  )
  browserControl.subscribe((browsers) =>
    emit({ type: "browser-control", browsers })
  )
  bindIpc()
  if (webSocket)
    webHost = await startWebHost(webSocket, invokeHost, readFilePreview)
  else await createWindow()
  installUpdates(emit)
  installThreads(emit)
  bindDrivers(emit)
  bindAcp((event) => liveConversations.observe(event))
  bindCodexApp((event) => liveConversations.observe(event))
  bindAutomations(emit, async (cwd, prompt) => {
    const resumable = new Set(resumableHarnesses())
    const profile = (await harnessProfiles()).find(
      (candidate) => candidate.available && resumable.has(candidate.id)
    )
    if (!profile)
      throw new Error("No provider is available for this automation")
    await startFresh(
      profile.id,
      cwd,
      prompt,
      resolveHarnessTuning(profile, undefined)
    )
  })
  void ready().then((live) => {
    watchWorkspace(live.active.workspace)
    return startSlackRelay({
      conversations: new RelayConversations(
        liveConversations,
        join(app.getPath("userData"), "conversations", "remote-assets")
      ),
      defaultCwd: () => live.active.workspace,
      deviceFile: join(app.getPath("userData"), "slack-relay", "device-id"),
      version: app.getVersion(),
    })
  })
  app.on("activate", () => {
    if (!webSocket && BrowserWindow.getAllWindows().length === 0)
      void createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  webHost?.close()
  powerMonitor.removeListener("resume", emitTerminalWake)
  powerMonitor.removeListener("unlock-screen", emitTerminalWake)
  terminalClient?.dispose()
  stopCuaEmbedded()
  void appshots.close()
  controlService?.close()
  stopWorkspaceIpc()
  stopWatching()
  stopSlackRelay()
  stopThreads()
  stopDrivers()
  stopAcp()
  stopCodexApps()
  nativeRequests?.stop()
  conversationMcp?.close()
  liveConversations?.stop()
  void pool.dispose()
})
