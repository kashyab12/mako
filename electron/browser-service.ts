import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { z } from "zod"
import { imageSize } from "image-size"
import {
  BrowserConnection,
  type BrowserProtocolEvent,
} from "./browser-connection.js"
import { navigatePage, screenshotGeometry } from "./browser-page.js"
import {
  AccessibilityNodeSchema,
  browserObservation,
} from "./browser-observation.js"
import { localBrowsers, type LocalBrowser } from "./browser-discovery.js"
import {
  BrowserFault,
  type BrowserCommand,
  type BrowserControlStatus,
  type BrowserTarget,
} from "./contracts/browser-control.js"
import type { JsonObject, JsonValue } from "./codex-app-json.js"

const targetInfo = z.object({
  targetId: z.string(),
  type: z.string(),
  title: z.string(),
  url: z.string(),
})
const targetsResult = z.object({ targetInfos: z.array(targetInfo) })
const sessionResult = z.object({ sessionId: z.string() })
interface Binding {
  owner: string
  target: BrowserTarget
  connection: BrowserConnection
  sessionId: string
  page: boolean
  uncertain: boolean
  running: number
  tail: Promise<void>
  refs: Map<string, number>
  events: BrowserProtocolEvent[]
}
interface BrowserEntry {
  definition: LocalBrowser
  status: BrowserControlStatus
  connection?: BrowserConnection
  connecting?: Promise<BrowserConnection>
  connectAbort?: AbortController
  selections: Promise<void>
}
function fault(
  code:
    | "target-closed"
    | "target-busy"
    | "stale-target"
    | "invalid-request"
    | "disconnected",
  message: string
): never {
  throw new BrowserFault({ code, message, outcome: "not-dispatched" })
}
function pageUrl(url: string): string {
  const parsed = new URL(url)
  if (!["http:", "https:", "about:"].includes(parsed.protocol))
    fault("invalid-request", "Navigation supports http, https and about URLs.")
  return parsed.href
}

/** Host-owned transport; task-owned bindings. No implicit current tab exists. */
export class BrowserService {
  private readonly browsers: Map<string, BrowserEntry>
  private readonly bindings = new Map<string, Binding>()
  private readonly listeners = new Set<
    (statuses: BrowserControlStatus[]) => void
  >()
  private closing = false
  private readonly discover: () => LocalBrowser[]

  constructor(definitions?: LocalBrowser[]) {
    this.discover = definitions ? () => definitions : localBrowsers
    this.browsers = new Map(
      this.discover().map((definition) => [
        definition.id,
        {
          definition,
          selections: Promise.resolve(),
          status: {
            id: definition.id,
            name: definition.name,
            connection: { status: "disconnected" },
          },
        },
      ])
    )
  }

  status(): BrowserControlStatus[] {
    return Array.from(this.browsers.values(), (entry) => entry.status)
  }
  refresh(): BrowserControlStatus[] {
    const definitions = this.discover()
    const available = new Set(definitions.map((definition) => definition.id))
    let changed = false
    for (const [id, entry] of this.browsers) {
      if (!available.has(id) && !entry.connection && !entry.connecting) {
        this.browsers.delete(id)
        changed = true
      }
    }
    for (const definition of definitions) {
      const entry = this.browsers.get(definition.id)
      if (entry) {
        entry.definition = definition
        if (entry.status.name !== definition.name) {
          entry.status = { ...entry.status, name: definition.name }
          changed = true
        }
      } else {
        this.browsers.set(definition.id, {
          definition,
          selections: Promise.resolve(),
          status: {
            id: definition.id,
            name: definition.name,
            connection: { status: "disconnected" },
          },
        })
        changed = true
      }
    }
    if (changed) this.changed()
    return this.status()
  }
  subscribe(listener: (statuses: BrowserControlStatus[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed(): void {
    for (const listener of this.listeners) listener(this.status())
  }
  private entry(id: string): BrowserEntry {
    const entry = this.browsers.get(id)
    if (!entry)
      fault("invalid-request", "Choose a browser ID returned by status.")
    return entry
  }

  connect(id: string): Promise<BrowserConnection> {
    if (this.closing)
      fault("disconnected", "Mako browser control is shutting down.")
    const entry = this.entry(id)
    if (entry.connection) return Promise.resolve(entry.connection)
    if (!entry.connecting) {
      const abort = new AbortController()
      entry.connectAbort = abort
      entry.connecting = this.start(entry, abort).finally(() => {
        if (entry.connectAbort === abort) {
          entry.connecting = undefined
          entry.connectAbort = undefined
        }
      })
    }
    return entry.connecting
  }

  private async start(
    entry: BrowserEntry,
    abort: AbortController
  ): Promise<BrowserConnection> {
    let opened: BrowserConnection | undefined
    try {
      const endpoint = await entry.definition.endpoint()
      abort.signal.throwIfAborted()
      entry.status = {
        ...entry.status,
        connection:
          entry.definition.requiresApproval === false
            ? { status: "connecting" }
            : { status: "awaiting-approval", startedAt: Date.now() },
      }
      this.changed()
      const connection = await BrowserConnection.connect(endpoint, abort.signal)
      opened = connection
      if (this.closing) {
        connection.close()
        fault("disconnected", "Mako browser control closed during connection.")
      }
      connection.onClose(() => {
        if (entry.connection !== connection) return
        entry.connection = undefined
        entry.status = {
          ...entry.status,
          connection: { status: "disconnected" },
        }
        for (const [key, binding] of this.bindings)
          if (binding.connection === connection) this.bindings.delete(key)
        this.changed()
      })
      connection.onEvent((event) => this.event(connection, event))
      await connection.send(
        "Target.setDiscoverTargets",
        { discover: true },
        AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])
      )
      abort.signal.throwIfAborted()
      entry.connection = connection
      entry.status = {
        ...entry.status,
        connection: { status: "connected", generation: connection.generation },
      }
      this.changed()
      return connection
    } catch (error) {
      opened?.close()
      if (entry.connectAbort === abort) {
        entry.status = {
          ...entry.status,
          connection: {
            status: "unavailable",
            reason:
              error instanceof Error
                ? error.message
                : "Browser connection failed",
          },
        }
        this.changed()
      }
      throw error
    }
  }

  private event(
    connection: BrowserConnection,
    event: BrowserProtocolEvent
  ): void {
    for (const [key, binding] of this.bindings) {
      if (binding.connection !== connection) continue
      if (
        (event.method === "Target.targetDestroyed" &&
          event.params.targetId === binding.target.tab) ||
        (event.method === "Target.detachedFromTarget" &&
          event.params.sessionId === binding.sessionId)
      ) {
        this.bindings.delete(key)
        continue
      }
      if (event.sessionId !== binding.sessionId) continue
      if (event.method === "Page.frameNavigated") binding.refs.clear()
      const bounded =
        JSON.stringify(event.params).length > 16_384
          ? { ...event, params: { truncated: true } }
          : event
      binding.events.push(bounded)
      if (binding.events.length > 128) binding.events.shift()
    }
  }

  private connection(id: string): BrowserConnection {
    const connection = this.entry(id).connection
    if (!connection)
      fault(
        "disconnected",
        "Connect this browser first. Actions never initiate or retry a Chrome connection."
      )
    return connection
  }
  private key(target: Pick<BrowserTarget, "browser" | "tab">): string {
    return `${target.browser}:${target.tab}`
  }

  private select(
    owner: string,
    browser: string,
    tab: string,
    takeover: boolean,
    signal: AbortSignal
  ): Promise<BrowserTarget> {
    const entry = this.entry(browser)
    const result = entry.selections.then(() => {
      signal.throwIfAborted()
      return this.attach(owner, browser, tab, takeover, signal)
    })
    entry.selections = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  private async attach(
    owner: string,
    browser: string,
    tab: string,
    takeover: boolean,
    signal: AbortSignal
  ): Promise<BrowserTarget> {
    const connection = this.connection(browser)
    const target = {
      browser,
      tab,
      generation: connection.generation,
      lease: randomUUID(),
    }
    const key = this.key(target)
    const existing = this.bindings.get(key)
    if (existing?.owner === owner) return existing.target
    if (!existing && this.bindings.size >= 512)
      fault(
        "invalid-request",
        "Release unused tab bindings before opening more."
      )
    if (existing && (!takeover || existing.running > 0))
      fault(
        "target-busy",
        "Another task owns this tab. Choose another tab, or explicitly take over after its action finishes."
      )
    const info = z
      .object({ targetInfo })
      .parse(
        await connection.send("Target.getTargetInfo", { targetId: tab }, signal)
      )
    if (existing) {
      if (existing.page)
        await connection.send(
          "Emulation.setFocusEmulationEnabled",
          { enabled: false },
          signal,
          existing.sessionId
        )
      await connection.send(
        "Target.detachFromTarget",
        { sessionId: existing.sessionId },
        signal
      )
      this.bindings.delete(key)
    }
    const { sessionId } = sessionResult.parse(
      await connection.send(
        "Target.attachToTarget",
        { targetId: tab, flatten: true },
        signal
      )
    )
    const page = ["page", "iframe", "webview"].includes(info.targetInfo.type)
    try {
      if (page) {
        await connection.send("Page.enable", {}, signal, sessionId)
        // Hidden tabs can acknowledge Input commands without delivering events.
        // Focus emulation keeps this target interactive without activating its tab.
        await connection.send(
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
          signal,
          sessionId
        )
      }
      this.bindings.set(key, {
        owner,
        target,
        connection,
        sessionId,
        page,
        uncertain: false,
        running: 0,
        tail: Promise.resolve(),
        refs: new Map(),
        events: [],
      })
    } catch (error) {
      await connection
        .send(
          "Target.detachFromTarget",
          { sessionId },
          AbortSignal.timeout(2000)
        )
        .catch(() => {})
      throw error
    }
    return target
  }

  /** UI-only capture does not acknowledge uncertain agent input or refresh agent refs. */
  async preview(
    owner: string,
    target: BrowserTarget,
    signal: AbortSignal,
    authorize: () => void
  ): Promise<JsonValue> {
    authorize()
    const binding = this.binding(owner, target)
    if (binding.running)
      fault("target-busy", "The target is executing an agent command")
    binding.running++
    try {
      const geometry = await screenshotGeometry(
        binding.connection,
        binding.sessionId,
        false,
        signal
      )
      const result = z.object({ data: z.string().max(512 * 1024) }).parse(
        await binding.connection.send(
          "Page.captureScreenshot",
          {
            format: "jpeg",
            quality: 55,
            captureBeyondViewport: false,
            clip: {
              ...geometry.clip,
              scale:
                geometry.clip.scale *
                Math.min(
                  1,
                  640 / geometry.clip.width,
                  480 / geometry.clip.height
                ),
            },
          },
          signal,
          binding.sessionId
        )
      )
      return { mimeType: "image/jpeg", data: result.data }
    } finally {
      binding.running--
    }
  }

  async execute(
    owner: string,
    command: BrowserCommand,
    signal: AbortSignal,
    authorize: () => void = () => {}
  ): Promise<JsonValue> {
    authorize()
    signal.throwIfAborted()
    if (command.action === "status")
      return this.refresh().map((status) => ({
        ...status,
        connection: { ...status.connection },
      }))
    if (command.action === "connect") {
      await this.connect(command.browser)
      return { ...this.entry(command.browser).status.connection }
    }
    if (command.action === "tabs") {
      const result = targetsResult.parse(
        await this.connection(command.browser).send(
          "Target.getTargets",
          {},
          signal
        )
      )
      return result.targetInfos.map((tab) => ({
        ...tab,
        claimed: this.bindings.has(
          this.key({ browser: command.browser, tab: tab.targetId })
        ),
      }))
    }
    if (command.action === "select")
      return {
        ...(await this.select(
          owner,
          command.browser,
          command.tab,
          command.takeover,
          signal
        )),
      }
    if (command.action === "open") {
      if (this.bindings.size >= 512)
        fault(
          "invalid-request",
          "Release unused bindings before opening more targets."
        )
      const url = pageUrl(command.url)
      const { targetId } = z
        .object({ targetId: z.string() })
        .parse(
          await this.connection(command.browser).send(
            "Target.createTarget",
            { url: "about:blank", background: command.background },
            signal
          )
        )
      const target = await this.select(
        owner,
        command.browser,
        targetId,
        false,
        signal
      )
      if (url !== "about:blank")
        await this.execute(
          owner,
          { action: "navigate", target, url },
          signal,
          authorize
        )
      return { ...target }
    }
    const binding = this.binding(owner, command.target)
    const run = async () => {
      authorize()
      this.binding(owner, command.target)
      signal.throwIfAborted()
      const observation = [
        "observe",
        "screenshot",
        "events",
        "release",
      ].includes(command.action)
      if (binding.uncertain && !observation)
        throw new BrowserFault({
          code: "outcome-unknown",
          message:
            "The previous action's outcome is unknown. Observe or capture this exact target before taking another action.",
          outcome: "not-dispatched",
        })
      binding.running++
      try {
        const value = await this.bound(binding, command, signal)
        if (command.action === "observe" || command.action === "screenshot")
          binding.uncertain = false
        return value
      } catch (error) {
        if (
          error instanceof BrowserFault &&
          /Session with given id not found|No target with given id|Target closed/i.test(
            error.message
          )
        ) {
          this.bindings.delete(this.key(binding.target))
          throw new BrowserFault({
            code: "target-closed",
            message:
              "The exact tab session closed. No command was retried and no other tab was selected.",
            outcome: "rejected",
          })
        }
        if (
          !observation &&
          error instanceof BrowserFault &&
          error.detail.outcome === "unknown"
        )
          binding.uncertain = true
        throw error
      } finally {
        binding.running--
      }
    }
    // Explicit concurrent CDP lets a task answer paused Fetch requests or dialogs
    // while its navigation is waiting. The exact owner and lease still apply.
    if (
      command.action === "events" ||
      (command.action === "cdp" && command.concurrent)
    )
      return run()
    const result = binding.tail.then(run)
    binding.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private binding(owner: string, target: BrowserTarget): Binding {
    const connection = this.connection(target.browser)
    if (connection.generation !== target.generation)
      fault(
        "stale-target",
        "This target belongs to an earlier Chrome connection. List and select the exact tab again."
      )
    const binding = this.bindings.get(this.key(target))
    if (!binding)
      fault(
        "target-closed",
        "This tab binding is closed or released. No other tab was selected."
      )
    if (binding.owner !== owner)
      fault("target-busy", "This tab is owned by another task.")
    if (binding.target.lease !== target.lease)
      fault(
        "stale-target",
        "This handle belongs to an earlier claim of the tab. Use the handle returned by your latest select call."
      )
    return binding
  }

  private async bound(
    binding: Binding,
    command: Extract<BrowserCommand, { target: BrowserTarget }>,
    signal: AbortSignal
  ): Promise<JsonValue> {
    const send = (method: string, params: JsonObject = {}) =>
      binding.connection.send(method, params, signal, binding.sessionId)
    const root = (method: string, params: JsonObject) =>
      binding.connection.send(method, params, signal)
    switch (command.action) {
      case "observe": {
        const info = await root("Target.getTargetInfo", {
          targetId: binding.target.tab,
        })
        const result = z
          .object({ nodes: z.array(AccessibilityNodeSchema) })
          .parse(await send("Accessibility.getFullAXTree"))
        const observation = browserObservation({
          target: binding.target,
          info,
          nodes: result.nodes,
          maxNodes: command.maxNodes,
        })
        binding.refs = observation.refs
        return observation.value
      }
      case "screenshot": {
        const geometry = await screenshotGeometry(
          binding.connection,
          binding.sessionId,
          command.fullPage,
          signal
        )
        const result = z
          .object({ data: z.string().max(24 * 1024 * 1024) })
          .parse(
            await send("Page.captureScreenshot", {
              format: command.format,
              ...(command.format === "jpeg"
                ? { quality: command.quality }
                : { optimizeForSpeed: true }),
              captureBeyondViewport: command.fullPage,
              clip: geometry.clip,
            })
          )
        const { width, height } = imageSize(Buffer.from(result.data, "base64"))
        const coordinates = {
          units: "CSS pixels",
          imageWidth: width,
          imageHeight: height,
          imageScaleX: width / geometry.clip.width,
          imageScaleY: height / geometry.clip.height,
          pageX: geometry.clip.x,
          pageY: geometry.clip.y,
          viewportPageX: geometry.viewport.pageX,
          viewportPageY: geometry.viewport.pageY,
          instruction:
            "For click coordinates: x = imageX / imageScaleX + pageX - viewportPageX; y = imageY / imageScaleY + pageY - viewportPageY. Scroll offscreen content into view before clicking.",
        }
        return {
          target: { ...binding.target },
          coordinates,
          clip: geometry.clip,
          mimeType: command.format === "png" ? "image/png" : "image/jpeg",
          data: result.data,
        }
      }
      case "events":
        return {
          target: { ...binding.target },
          events: binding.events
            .filter((event) => event.cursor > command.after)
            .map((event) => ({ ...event, sessionId: event.sessionId ?? null })),
          cursor: binding.events.at(-1)?.cursor ?? command.after,
          gap:
            command.after > 0 &&
            binding.events.length === 128 &&
            command.after < binding.events[0].cursor,
        }
      case "evaluate": {
        const result = await send("Runtime.evaluate", {
          expression: command.expression,
          awaitPromise: true,
          returnByValue: true,
        })
        if (result.exceptionDetails)
          throw new BrowserFault({
            code: "protocol-error",
            message: JSON.stringify(result.exceptionDetails),
            outcome: "rejected",
          })
        return result
      }
      case "navigate":
        return navigatePage(
          binding.connection,
          binding.sessionId,
          pageUrl(command.url),
          signal,
          command.waitUntil ?? "load"
        )
      case "close": {
        const result = await root("Target.closeTarget", {
          targetId: binding.target.tab,
        })
        this.bindings.delete(this.key(binding.target))
        return result
      }
      case "release": {
        if (binding.page)
          await send("Emulation.setFocusEmulationEnabled", { enabled: false })
        const result = await root("Target.detachFromTarget", {
          sessionId: binding.sessionId,
        })
        this.bindings.delete(this.key(binding.target))
        return result
      }
      case "cdp": {
        // Target lifecycle stays in the owner so raw protocol calls cannot silently change its bindings.
        if (
          command.method.startsWith("Target.") &&
          ![
            "Target.getTargets",
            "Target.getTargetInfo",
            "Target.activateTarget",
          ].includes(command.method)
        )
          fault(
            "invalid-request",
            "Use open, select, release and close for target lifecycle. Other CDP domains are available through this exact session."
          )
        if (
          command.method === "Target.getTargetInfo" ||
          command.method === "Target.activateTarget"
        )
          return root(command.method, { targetId: binding.target.tab })
        return command.method.startsWith("Target.") ||
          command.method.startsWith("Browser.") ||
          command.method.startsWith("SystemInfo.")
          ? root(command.method, command.params)
          : send(command.method, command.params)
      }
      case "type": {
        if (command.ref)
          await send("DOM.focus", {
            backendNodeId: this.node(binding, command.ref),
          })
        return send("Input.insertText", { text: command.text })
      }
      case "upload": {
        if (!command.files.every(isAbsolute))
          fault(
            "invalid-request",
            "Upload paths must be explicit absolute local paths."
          )
        return send("DOM.setFileInputFiles", {
          backendNodeId: this.node(binding, command.ref),
          files: command.files,
        })
      }
      case "click": {
        const point =
          "ref" in command.at
            ? await this.point(binding, command.at.ref, signal)
            : command.at
        try {
          await send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...point,
            button: command.button,
            clickCount: command.count,
          })
        } catch (error) {
          if (
            error instanceof BrowserFault &&
            error.detail.outcome === "unknown"
          )
            await binding.connection
              .send(
                "Input.dispatchMouseEvent",
                {
                  type: "mouseReleased",
                  ...point,
                  button: command.button,
                  clickCount: command.count,
                },
                AbortSignal.timeout(2000),
                binding.sessionId
              )
              .catch(() => {})
          throw error
        }
        const released = await binding.connection.send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            ...point,
            button: command.button,
            clickCount: command.count,
          },
          AbortSignal.timeout(2000),
          binding.sessionId
        )
        if (signal.aborted)
          throw new BrowserFault({
            code: "cancelled",
            message:
              "Click was dispatched and its button released before cancellation. Observe before deciding whether to click again.",
            outcome: "unknown",
          })
        return released
      }
    }
  }

  private node(binding: Binding, ref: string): number {
    const id = binding.refs.get(ref)
    if (id === undefined)
      fault(
        "stale-target",
        "This element reference is stale. Observe the exact tab again."
      )
    return id
  }

  private async point(
    binding: Binding,
    ref: string,
    signal: AbortSignal
  ): Promise<{ x: number; y: number }> {
    const node = await binding.connection.send(
      "DOM.resolveNode",
      { backendNodeId: this.node(binding, ref) },
      signal,
      binding.sessionId
    )
    const {
      object: { objectId },
    } = z.object({ object: z.object({ objectId: z.string() }) }).parse(node)
    const result = await binding.connection.send(
      "Runtime.callFunctionOn",
      {
        objectId,
        returnByValue: true,
        functionDeclaration:
          "function(){if(!this.isConnected)throw Error('Element detached');this.scrollIntoView({block:'center',inline:'center'});const r=this.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=this.getRootNode().elementFromPoint(x,y);if(!r.width||!r.height||!(hit===this||this.contains(hit)))throw Error('Element is hidden or covered');return {x,y}}",
      },
      signal,
      binding.sessionId
    )
    return z
      .object({
        result: z.object({ value: z.object({ x: z.number(), y: z.number() }) }),
      })
      .parse(result).result.value
  }

  disconnect(id: string): void {
    const entry = this.entry(id)
    const connection = entry.connection
    entry.connectAbort?.abort()
    entry.connectAbort = undefined
    entry.connecting = undefined
    entry.connection = undefined
    entry.status = { ...entry.status, connection: { status: "disconnected" } }
    for (const [key, binding] of this.bindings)
      if (binding.target.browser === id) this.bindings.delete(key)
    connection?.close()
    this.changed()
  }
  close(): void {
    this.closing = true
    for (const id of this.browsers.keys()) this.disconnect(id)
    this.bindings.clear()
  }
}
