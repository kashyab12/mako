import { ipcMain } from "electron"
import type { AgentHost } from "../host.js"
import type { HostPool } from "../pool.js"
import type {
  BootPayload,
  ThinkingLevel,
} from "../shared.js"
import { registerIpc } from "./register.js"

export interface SessionIpcContext {
  ready(): Promise<HostPool>
  withHost<TResult>(
    operation: (host: AgentHost) => TResult | Promise<TResult>
  ): Promise<TResult>
  platform: NodeJS.Platform
  sourceRoot?: string
}

export function installSessionIpc(context: SessionIpcContext): void {
  const { ready, withHost } = context
  registerIpc("mako:boot", async (): Promise<BootPayload> => {
    const live = await ready()
    const [tabs, models] = await Promise.all([
      live.snapshots(),
      live.active.listModels(),
    ])
    return {
      tabs,
      activeTabId: live.activeId,
      models,
      platform: context.platform,
      // Only when the renderer is coming from Vite: that is exactly the
      // condition under which an edit here shows up without a restart.
      sourceRoot: context.sourceRoot,
    }
  })

  registerIpc(
    "mako:open-tab",
    async (_event, options?: { cwd?: string; sessionPath?: string }) => {
      const live = await ready()
      return live.open(options ?? {})
    }
  )
  registerIpc("mako:close-tab", async (_event, id: string) => {
    const live = await ready()
    return live.close(id)
  })
  registerIpc("mako:activate-tab", async (_event, id: string) => {
    const live = await ready()
    return live.activate(id)
  })

  registerIpc(
    "mako:list-sessions",
    (_event, cwd?: string, scope?: "workspace" | "all") =>
      withHost((host) => host.listSessions(cwd, scope))
  )
  registerIpc("mako:open-session", (_event, path: string) =>
    withHost(async (host) => {
      await host.openSession(path)
      return host.state()
    })
  )
  registerIpc("mako:new-session", () =>
    withHost(async (host) => {
      await host.newSession()
      return host.state()
    })
  )
  registerIpc("mako:set-cwd", (_event, cwd: string) =>
    withHost(async (host) => {
      await host.setCwd(cwd)
      return host.state()
    })
  )
  registerIpc("mako:set-name", (_event, name: string) =>
    withHost((host) => host.setName(name))
  )

  ipcMain.handle(
    "mako:prompt",
    (
      _event,
      text: string,
      mode?: "steer" | "followUp",
      images?: Array<{ mimeType: string; data: string }>
    ) => withHost((host) => host.prompt(text, mode, images))
  )
  registerIpc("mako:abort", () => withHost((host) => host.abort()))
  registerIpc("mako:clear-queue", () =>
    withHost((host) => host.clearQueue())
  )
  // Branching opens a tab rather than replacing this one. Exploring the same
  // question two ways only works if both answers stay on screen.
  registerIpc(
    "mako:fork",
    async (_event, entryId: string, position?: "before" | "at") => {
      const live = await ready()
      return live.forkIntoTab(entryId, position)
    }
  )
  registerIpc("mako:navigate-tree", (_event, targetId: string) =>
    withHost(async (host) => {
      await host.navigateTree(targetId)
      return host.state()
    })
  )
  registerIpc("mako:compact", (_event, instructions?: string) =>
    withHost((host) => host.compact(instructions))
  )
  registerIpc("mako:set-auto-compaction", (_event, enabled: boolean) =>
    withHost((host) => host.setAutoCompaction(enabled))
  )

  registerIpc("mako:list-models", () =>
    withHost((host) => host.listModels())
  )
  registerIpc("mako:set-model", (_event, provider: string, id: string) =>
    withHost((host) => host.setModel(provider, id))
  )
  registerIpc("mako:set-thinking", (_event, level: ThinkingLevel) =>
    withHost((host) => host.setThinking(level))
  )
  registerIpc("mako:capabilities", () =>
    withHost((host) => host.capabilities())
  )
  registerIpc("mako:set-active-tools", (_event, names: string[]) =>
    withHost((host) => host.setActiveTools(names))
  )
  registerIpc("mako:run-command", (_event, name: string, args?: string) =>
    withHost((host) => host.runCommand(name, args))
  )
}
