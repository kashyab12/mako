import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell } from "electron"
import { watch } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { COMMIT_PROMPT, type AgentHost } from "./host.js"
import { breadcrumb, clearCrashes, crashesDir, installCrashReporting, listCrashes, record } from "./crash.js"
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
import { createPull, githubStatus, listPulls, pullForBranch, repoAvatar, rerunChecks, type CreatePullOptions } from "./github.js"
import { HostPool } from "./pool.js"
import { daemonStatus, devinAccountsMasked, startDevin, emitThreadAs, emitThreadAsClaude, emitThreadAsPi, followThread, threadsReady, handoffFor, installThreads, listThreads, openThread, remoteHarnesses, saveDevinAccounts, sendRemote, stopThreads, unfollowThread } from "./threads.js"
import { abortNative, bindDrivers, freshHarnesses, grokModels, harnessAvailability, HARNESS_TUNING, readHarnessDefaults, resumableHarnesses, resumeNative, startFresh, stopDrivers, threadRun } from "./drivers.js"
import { bindLineageDirect, chainOf, expectLineage } from "./lineage.js"
import { accountUsage, captureAccount, listAccounts, removeAccount, selectAccount } from "./accounts.js"
import { daemonLoginEnabled, setDaemonLogin } from "./daemon-login.js"
import { acpCancel, acpClose, acpHarnesses, acpPrompt, acpRespondPermission, acpSetMode, acpStart, acpState, bindAcp, stopAcp } from "./acp.js"
import { deletePlugin, listPlugins, pluginsDir, watchPlugins, writePlugin } from "./plugins.js"
import type { BootPayload, HostEvent, SearchOptions, ThinkingLevel } from "./shared.js"

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
const pool = new HostPool(emit)
let starting: Promise<unknown> | null = null

function emit(event: HostEvent) {
  // Git status is recomputed after every turn and on focus, which is exactly
  // when HEAD could have moved — so the commit trigger rides on it rather than
  // running a watcher of its own.
  if (event.type === "git") noticeHead(event.git.head)
  if (window?.isDestroyed()) return
  window?.webContents.send("pi:event", event)
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
async function withHost<T>(run: (host: AgentHost) => T | Promise<T>): Promise<T> {
  const live = await ready()
  return run(live.active)
}

async function createWindow() {
  nativeTheme.themeSource = "dark"
  const icon = appIcon()
  if (icon && process.platform === "darwin") app.dock?.setIcon(icon)

  window = new BrowserWindow({
    title: "Mako",
    ...(icon ? { icon } : {}),
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
  })

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
      const where = details.lineNumber ? ` (${details.sourceId}:${details.lineNumber})` : ""
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
            message: "Mako's engine was rebuilt — restart the app to run the new version.",
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
    await window.loadURL(process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173")
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
function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]) {
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
  handle("pi:boot", async (): Promise<BootPayload> => {
    const live = await ready()
    const [tabs, models] = await Promise.all([live.snapshots(), live.active.listModels()])
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

  handle("pi:open-tab", async (_e, options?: { cwd?: string; sessionPath?: string }) => {
    const live = await ready()
    return live.open(options ?? {})
  })
  handle("pi:close-tab", async (_e, id: string) => {
    const live = await ready()
    return live.close(id)
  })
  handle("pi:activate-tab", async (_e, id: string) => {
    const live = await ready()
    return live.activate(id)
  })

  handle("pi:list-sessions", (_e, cwd?: string, scope?: "workspace" | "all") =>
    withHost((h) => h.listSessions(cwd, scope))
  )
  handle("pi:open-session", (_e, path: string) =>
    withHost(async (h) => {
      await h.openSession(path)
      return h.state()
    })
  )
  handle("pi:new-session", () =>
    withHost(async (h) => {
      await h.newSession()
      return h.state()
    })
  )
  handle("pi:set-cwd", (_e, cwd: string) =>
    withHost(async (h) => {
      await h.setCwd(cwd)
      return h.state()
    })
  )
  handle("pi:set-name", (_e, name: string) => withHost((h) => h.setName(name)))

  ipcMain.handle(
    "pi:prompt",
    (
      _e,
      text: string,
      mode?: "steer" | "followUp",
      images?: Array<{ mimeType: string; data: string }>
    ) => withHost((h) => h.prompt(text, mode, images))
  )
  handle("pi:abort", () => withHost((h) => h.abort()))
  handle("pi:clear-queue", () => withHost((h) => h.clearQueue()))
  // Branching opens a tab rather than replacing this one. Exploring the same
  // question two ways only works if both answers stay on screen.
  handle("pi:fork", async (_e, entryId: string) => {
    const live = await ready()
    return live.forkIntoTab(entryId)
  })
  handle("pi:navigate-tree", (_e, targetId: string) =>
    withHost(async (h) => {
      await h.navigateTree(targetId)
      return h.state()
    })
  )
  handle("pi:compact", (_e, instructions?: string) => withHost((h) => h.compact(instructions)))
  handle("pi:set-auto-compaction", (_e, enabled: boolean) =>
    withHost((h) => h.setAutoCompaction(enabled))
  )

  handle("pi:list-models", () => withHost((h) => h.listModels()))
  handle("pi:set-model", (_e, provider: string, id: string) =>
    withHost((h) => h.setModel(provider, id))
  )
  handle("pi:set-thinking", (_e, level: ThinkingLevel) => withHost((h) => h.setThinking(level)))

  handle("pi:capabilities", () => withHost((h) => h.capabilities()))
  handle("pi:set-active-tools", (_e, names: string[]) => withHost((h) => h.setActiveTools(names)))
  handle("pi:run-command", (_e, name: string, args?: string) =>
    withHost((h) => h.runCommand(name, args))
  )

  handle("pi:list-files", () => withHost((h) => h.listFiles()))
  handle("pi:read-file", (_e, path: string) => withHost((h) => h.readWorkspaceFile(path)))
  handle("pi:search", (_e, query: string, options?: SearchOptions) =>
    withHost((h) => h.search(query, options))
  )

  handle("pi:git-status", () => withHost((h) => h.gitStatus()))
  handle("pi:git-diff", (_e, path: string) => withHost((h) => h.gitDiff(path)))
  handle("pi:git-stage", (_e, paths: string[]) => withHost((h) => h.gitStage(paths)))
  handle("pi:git-unstage", (_e, paths: string[]) => withHost((h) => h.gitUnstage(paths)))
  handle("pi:git-stage-all", () => withHost((h) => h.gitStageAll()))
  handle("pi:git-unstage-all", () => withHost((h) => h.gitUnstageAll()))
  handle("pi:git-commit", (_e, message: string, options?: { amend?: boolean }) =>
    withHost((h) => h.gitCommit(message, options))
  )
  handle("pi:git-push", () => withHost((h) => h.gitPush()))
  handle("pi:git-log", (_e, limit?: number) => withHost((h) => h.gitLog(limit)))
  handle("pi:git-commit-files", (_e, hash: string) => withHost((h) => h.gitCommitFiles(hash)))
  handle("pi:git-commit-file-diff", (_e, hash: string, path: string) =>
    withHost((h) => h.gitCommitFileDiff(hash, path))
  )
  handle("pi:git-commit-diff-all", (_e, hash: string) => withHost((h) => h.gitCommitDiffAll(hash)))
  handle("pi:git-generate-message", (_e, prompt?: string) =>
    withHost((h) => h.generateCommitMessage(prompt))
  )
  handle("pi:stage-file", (_e, name: string, base64: string) =>
    withHost((h) => h.stageFile(name, base64))
  )
  handle("pi:default-commit-prompt", () => COMMIT_PROMPT)

  handle("pi:list-plugins", () => listPlugins())
  handle("pi:plugins-dir", () => pluginsDir())
  handle("pi:write-plugin", (_e, id: string, source: string) => writePlugin(id, source))
  handle("pi:delete-plugin", (_e, id: string) => deletePlugin(id))
  handle("pi:reveal-plugins", () => {
    void shell.openPath(pluginsDir())
  })

  handle("pi:pick-folder", async () => {
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  handle("pi:reveal", (_e, path: string) =>
    withHost(async (h) => {
      // Paths from the UI are workspace-relative; open with the user's default
      // editor rather than only revealing the file in Finder.
      const absolute = await h.resolvePath(path)
      const failure = await shell.openPath(absolute)
      if (failure) shell.showItemInFolder(absolute)
    })
  )
  handle("pi:github-status", () => withHost((h) => githubStatus(h.workspace)))
  handle("pi:pull-request", () => withHost((h) => pullForBranch(h.workspace)))
  handle("pi:pull-requests", (_e, limit?: number) => withHost((h) => listPulls(h.workspace, limit)))
  handle("pi:create-pull", (_e, options: CreatePullOptions) =>
    withHost((h) => createPull(h.workspace, options))
  )
  handle("pi:rerun-checks", () => withHost((h) => rerunChecks(h.workspace)))
  handle("pi:repo-avatar", (_e, repo: string) => withHost((h) => repoAvatar(h.workspace, repo)))

  handle("pi:usage", () => usageSummary(join(getAgentDir(), "sessions")))

  /* Cross-harness threads: every agent's sessions on this machine. */
  handle("pi:threads", (_e, filter?: { cwd?: string; harness?: string }) => ({
    ready: threadsReady(),
    threads: listThreads(filter),
  }))
  handle("pi:thread-open", (_e, path: string) => openThread(path))
  handle("pi:thread-follow", (_e, path: string, fromByte: number) => followThread(path, fromByte))
  handle("pi:thread-unfollow", () => unfollowThread())
  handle("pi:thread-resumable", () => [...resumableHarnesses(), ...remoteHarnesses()])
  handle("pi:thread-continue-targets", () => ["pi", ...freshHarnesses()])
  /**
   * Continue a conversation on a *different* harness: render the handoff and
   * open it as the first prompt of a fresh session there. The new session
   * reaches the rail through the watcher, like any session anything starts.
   */
  handle("pi:thread-continue-with", async (_e, path: string, harness: string, instruction?: string) => {
    // Every harness whose store we can write gets the real thing: the
    // thread emitted as a *native* session in its format, instantly
    // replyable — no tokens spent until someone actually says something.
    const materialized = await emitThreadAs(path, harness)
    if (materialized) {
      bindLineageDirect(materialized.sessionPath, chainOf(materialized.thread.ref))
      return { kind: "emitted" as const, path: materialized.sessionPath }
    }
    // A harness without an emitter takes the universal transcript as the
    // first prompt of a fresh headless session instead.
    const [thread, handoff] = await Promise.all([openThread(path), handoffFor(path, instruction)])
    if (!thread || !handoff) throw new Error("This session could not be read for continuation")
    expectLineage(harness, thread.ref.cwd, chainOf(thread.ref))
    return { kind: "spawned" as const, run: await startFresh(harness, thread.ref.cwd, handoff) }
  })
  /* Harness accounts: several logins per CLI, Orca-style isolated homes. */
  handle("pi:accounts", () => listAccounts())
  handle("pi:account-capture", (_e, harness: "claude" | "codex", name: string) =>
    captureAccount(harness, name)
  )
  handle("pi:account-select", (_e, harness: "claude" | "codex", name: string | null) =>
    selectAccount(harness, name)
  )
  handle("pi:account-remove", (_e, harness: "claude" | "codex", name: string) =>
    removeAccount(harness, name)
  )
  handle("pi:account-usage", (_e, harness: "claude" | "codex", name: string) =>
    accountUsage(harness, name)
  )

  handle("pi:devin-accounts", () => devinAccountsMasked())
  handle("pi:devin-accounts-save", (_e, accounts: Array<{ name: string; apiKey: string }>) =>
    saveDevinAccounts(accounts)
  )
  handle("pi:harness-availability", () => harnessAvailability())
  handle("pi:daemon-status", () => daemonStatus())
  handle("pi:daemon-login", () => daemonLoginEnabled())
  handle("pi:daemon-login-set", (_e, enabled: boolean) => setDaemonLogin(enabled))

  /* Interactive foreign agents over ACP. */
  handle("pi:acp-harnesses", () => acpHarnesses())
  handle("pi:acp-start", (_e, harness: string, cwd: string, options?: { resume?: string; title?: string }) =>
    acpStart(harness, cwd, options)
  )
  handle("pi:acp-state", (_e, id: string) => acpState(id))
  handle("pi:acp-prompt", (_e, id: string, text: string) => acpPrompt(id, text))
  handle("pi:acp-permission", (_e, id: string, requestId: string, optionId: string | null) =>
    acpRespondPermission(id, requestId, optionId)
  )
  handle("pi:acp-mode", (_e, id: string, modeId: string) => acpSetMode(id, modeId))
  handle("pi:acp-cancel", (_e, id: string) => acpCancel(id))
  handle("pi:acp-close", (_e, id: string) => acpClose(id))

  /** A new conversation on another harness, from the main composer. */
  handle(
    "pi:harness-start",
    async (
      _e,
      harness: string,
      prompt: string,
      options?: { model?: string; effort?: string; fast?: boolean }
    ) => {
      const live = await ready()
      const cwd = live.active.workspace
      if (harness === "devin") {
        // Devin works in its own cloud, not this folder; polling lists the
        // session moments after it exists.
        await startDevin(prompt)
        return { run: null, cwd: "" }
      }
      return { run: await startFresh(harness, cwd, prompt, options), cwd }
    }
  )

  /**
   * What the composer can offer for a harness: models this machine has
   * actually used (from the catalog, most recent first) ahead of a curated
   * floor, plus the CLI's real tuning surface.
   */
  handle("pi:harness-tuning", async (_e, harness: string) => {
    const tuning = HARNESS_TUNING[harness]
    if (!tuning) return { models: [], efforts: [], fast: false, defaultModel: "" }
    // The default is whatever the CLI itself would do: read from its own
    // config files, refreshed as they change. The curated list is only a
    // floor under what this machine has actually run.
    const defaults = (await readHarnessDefaults())[harness] ?? {}
    const seen: string[] = []
    for (const ref of listThreads({ harness })) {
      const model = ref.model
      if (model && !model.includes("·") && !seen.includes(model)) seen.push(model)
      if (seen.length >= 8) break
    }
    const curated = harness === "grok" ? await grokModels() : tuning.curatedModels
    const models = [...seen, ...curated.filter((model) => !seen.includes(model))]
    return {
      models: models.slice(0, 12),
      efforts: tuning.efforts,
      fast: tuning.fast,
      defaultModel: defaults.model ?? tuning.defaultModel,
      defaultEffort: defaults.effort,
    }
  })

  handle("pi:thread-run", (_e, path: string) => threadRun(path))
  handle("pi:thread-resume", async (_e, path: string, prompt: string) => {
    // A remote session (Devin) takes the message through its API and keeps
    // working in the cloud; the follow poll streams what it does next.
    if (await sendRemote(path, prompt)) {
      return { path, harness: "devin", status: "done" as const }
    }
    const thread = await openThread(path)
    if (!thread) throw new Error("This session could not be read")
    return await resumeNative(thread.ref, prompt)
  })
  handle("pi:thread-abort-run", (_e, path: string) => abortNative(path))
  /**
   * Continue a foreign session here: a new tab in the thread's working
   * directory, opened with the conversation as its first prompt. Pi threads
   * never take this path — they open natively through `pi:open-tab`.
   */
  handle("pi:thread-continue", async (_e, path: string) => {
    // The deepest form: the thread becomes a *native Pi session* — emitted
    // into Pi's own store and opened like any other, full history in the
    // transcript and in context. No handoff preamble, and nothing runs
    // until the user actually says something.
    const materialized = await emitThreadAsPi(path)
    if (!materialized) throw new Error("This session could not be read for continuation")
    bindLineageDirect(materialized.sessionPath, chainOf(materialized.thread.ref))
    const live = await ready()
    const tab = await live.open({
      ...(materialized.thread.ref.cwd ? { cwd: materialized.thread.ref.cwd } : {}),
      sessionPath: materialized.sessionPath,
    })
    if (materialized.thread.ref.title) live.active.setName(materialized.thread.ref.title)
    return tab
  })
  /** The thread as a native Claude Code session, for interactive resume. */
  handle("pi:thread-emit-claude", async (_e, path: string) => {
    const materialized = await emitThreadAsClaude(path)
    if (!materialized) throw new Error("This session could not be read for continuation")
    bindLineageDirect(materialized.sessionPath, chainOf(materialized.thread.ref))
    return { sessionId: materialized.sessionId }
  })

  handle("pi:automations", () => automationList())
  handle("pi:save-automations", (_e, next: Parameters<typeof saveAutomations>[1]) =>
    withHost((h) => saveAutomations(h.workspace, next))
  )
  handle("pi:automation-enabled", (_e, id: string, enabled: boolean) => setEnabled(id, enabled))
  handle("pi:run-automation", (_e, id: string) => fireAutomation(id, "manual"))
  handle("pi:reload-automations", () => withHost((h) => loadAutomations(h.workspace)))

  handle("pi:ports", () => listPorts())
  handle("pi:dev-scripts", () => withHost((h) => devScripts(h.workspace)))
  handle("pi:dev-state", () => devServerState())
  handle("pi:dev-start", (_e, script: string) => withHost((h) => startDevServer(h.workspace, script)))
  handle("pi:dev-stop", () => stopDevServer())
  handle("pi:dev-attach", (_e, url: string) => attachDevServer(url))

  handle("pi:update-state", () => updateState())
  handle("pi:check-updates", () => check())
  handle("pi:install-update", () => installNow())

  handle("pi:crashes", () => listCrashes())
  handle("pi:crashes-dir", () => crashesDir())
  handle("pi:clear-crashes", () => clearCrashes())
  ipcMain.handle(
    "pi:report-crash",
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

  handle("pi:open-url", (_e, url: string) => {
    // Only ever http(s): `shell.openExternal` will happily run a `file://` or a
    // custom scheme, and this is reached from data the app did not author.
    if (!/^https?:\/\//i.test(url)) return
    void shell.openExternal(url)
  })

  handle("pi:copy", (_e, text: string) => {
    clipboard.writeText(text)
  })
}

installCrashReporting()

app.whenReady().then(async () => {
  bindIpc()
  await createWindow()
  installUpdates(emit)
  installThreads(emit)
  bindDrivers(emit)
  bindAcp(emit)
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
  stopWatching()
  stopThreads()
  stopDrivers()
  stopAcp()
  // The dev server is in its own process group and will not die with us.
  void stopDevServer()
  void pool.dispose()
})
