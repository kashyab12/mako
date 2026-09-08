import type { ExtensionCommand, ExtensionMessage } from "../electron/browser-extension-protocol.js"
import { ExtensionFieldsSchema } from "../electron/browser-extension-protocol.js"

interface AttachedTarget {
  client: string
  sessionId: string
  target: chrome.debugger.TargetInfo
}

/** One extension owns debugger attachments; each attachment belongs to one host client. */
export class ExtensionRouter {
  private readonly attached = new Map<string, AttachedTarget>()
  private readonly creating = new Map<string, string>()
  private readonly clients = new Set<string>()
  private tail: Promise<void> = Promise.resolve()
  constructor(
    private readonly api: Pick<typeof chrome, "debugger" | "tabs">,
    private readonly emit: (message: ExtensionMessage) => void
  ) {}

  async request(client: string, command: ExtensionCommand): Promise<void> {
    this.clients.add(client)
    try {
      const result = command.method.startsWith("Target.")
        ? await this.serial(() => this.targetCommand(client, command))
        : await this.sessionCommand(client, command)
      this.emit({ kind: "response", client, id: command.id, result: result ?? {} })
    } catch (error) {
      this.emit({ kind: "error", client, id: command.id, message: error instanceof Error ? error.message.slice(0, 4000) : "Browser command failed" })
    }
  }

  private serial<Value>(run: () => Promise<Value>): Promise<Value> {
    const next = this.tail.then(run, run)
    this.tail = next.then(() => {}, () => {})
    return next
  }

  private owned(client: string, sessionId: string | undefined): AttachedTarget {
    const attached = sessionId ? this.attached.get(sessionId) : undefined
    if (!attached || attached.client !== client) throw new Error("The exact tab session is no longer owned by this client")
    return attached
  }

  private async sessionCommand(client: string, command: ExtensionCommand) {
    const attached = this.owned(client, command.sessionId)
    const result = await this.api.debugger.sendCommand({ targetId: attached.target.id }, command.method, command.params)
    return ExtensionFieldsSchema.parse(result ?? {})
  }

  private async targetCommand(client: string, command: ExtensionCommand): Promise<ReturnType<typeof ExtensionFieldsSchema.parse>> {
    if (!this.clients.has(client)) throw new Error("Browser client disconnected")
    if (command.method === "Target.setDiscoverTargets") return {}
    if (command.method === "Target.detachFromTarget") {
      const sessionId = command.params.sessionId
      if (typeof sessionId !== "string") throw new Error("Missing tab session")
      const attached = this.owned(client, sessionId)
      await this.api.debugger.detach({ targetId: attached.target.id })
      this.attached.delete(sessionId)
      return {}
    }
    if (command.method === "Target.createTarget") {
      if (this.creating.size >= 512) throw new Error("Release unused tabs first")
      const url = command.params.url
      if (typeof url !== "string" || !/^(https?:|about:)/.test(url)) throw new Error("Unsupported page URL")
      const tab = await this.api.tabs.create({ url, active: false })
      for (let attempt = 0; attempt < 20; attempt++) {
        const target = (await this.api.debugger.getTargets()).find((entry) => entry.tabId === tab.id)
        if (target) {
          if (!this.clients.has(client)) {
            if (tab.id !== undefined) await this.api.tabs.remove(tab.id)
            throw new Error("Browser client disconnected")
          }
          this.creating.set(target.id, client)
          return { targetId: target.id }
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (tab.id !== undefined) await this.api.tabs.remove(tab.id)
      throw new Error("The new tab did not become available")
    }
    const targets = await this.api.debugger.getTargets()
    if (command.method === "Target.getTargets") return { targetInfos: targets.map(targetInfo) }
    const target = targets.find((entry) => entry.id === command.params.targetId)
    if (!target) throw new Error("No target with given id")
    if (command.method === "Target.getTargetInfo") return { targetInfo: targetInfo(target) }
    if (command.method === "Target.attachToTarget") {
      if (this.attached.size >= 512) throw new Error("Release unused tab sessions first")
      if ([...this.attached.values()].some((entry) => entry.target.id === target.id)) throw new Error("Another client owns this tab")
      await this.api.debugger.attach({ targetId: target.id }, "1.3")
      if (!this.clients.has(client)) {
        await this.api.debugger.detach({ targetId: target.id })
        throw new Error("Browser client disconnected")
      }
      const sessionId = crypto.randomUUID()
      this.attached.set(sessionId, { client, sessionId, target })
      this.creating.delete(target.id)
      return { sessionId }
    }
    const owned = [...this.attached.values()].some((entry) => entry.client === client && entry.target.id === target.id)
    if (!owned && this.creating.get(target.id) !== client) throw new Error("Another client owns this tab")
    if (command.method === "Target.closeTarget" && target.tabId !== undefined) {
      await this.api.tabs.remove(target.tabId)
      this.creating.delete(target.id)
      return { success: true }
    }
    if (command.method === "Target.activateTarget" && target.tabId !== undefined) {
      await this.api.tabs.update(target.tabId, { active: true })
      return {}
    }
    throw new Error(`${command.method} is not available through the browser extension`)
  }

  event(source: chrome.debugger.DebuggerSession, method: string, params: object | undefined): void {
    const fields = ExtensionFieldsSchema.safeParse(params ?? {})
    if (!fields.success) return
    for (const attached of this.attached.values()) {
      if (source.targetId === attached.target.id || (source.tabId !== undefined && source.tabId === attached.target.tabId)) {
        this.emit({ kind: "event", client: attached.client, sessionId: attached.sessionId, method, params: fields.data })
      }
    }
  }

  detached(source: chrome.debugger.Debuggee): void {
    for (const [id, attached] of this.attached) {
      if (source.targetId !== attached.target.id && (source.tabId === undefined || source.tabId !== attached.target.tabId)) continue
      this.attached.delete(id)
      this.emit({ kind: "event", client: attached.client, method: "Target.detachedFromTarget", params: { sessionId: id, targetId: attached.target.id } })
    }
  }

  async disconnect(client: string): Promise<void> {
    this.clients.delete(client)
    for (const [id, attached] of this.attached) {
      if (attached.client !== client) continue
      this.attached.delete(id)
      await this.api.debugger.detach({ targetId: attached.target.id }).catch(() => {})
    }
    for (const [target, owner] of this.creating) if (owner === client) this.creating.delete(target)
  }

  async close(): Promise<void> {
    for (const client of [...this.clients]) await this.disconnect(client)
  }
}

function targetInfo(target: chrome.debugger.TargetInfo) {
  return { targetId: target.id, type: target.type, title: target.title, url: target.url, attached: target.attached }
}
