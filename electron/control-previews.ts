import { randomUUID } from "node:crypto"
import type { BrowserService } from "./browser-service.js"
import type { AppshotTarget } from "./contracts/appshots.js"
import type { BrowserTarget } from "./contracts/browser-control.js"
import {
  ControlImageSchema,
  type ControlActivity,
  type ControlImage,
  type ControlPreview,
} from "./contracts/control-preview.js"

interface PreviewEntry {
  preview: ControlPreview
  watchers: Map<string, number>
  captureFrame?: (signal: AbortSignal) => Promise<ControlImage | null>
  authorize?: () => void
  capture?: AbortController
  publish?: NodeJS.Timeout
}

/** One bounded image per task. Image bytes only cross IPC when its visible preview requests them. */
export class ControlPreviews {
  private readonly entries = new Map<string, PreviewEntry>()
  private readonly browser: BrowserService
  private readonly thumbnail: (image: ControlImage) => ControlImage | null
  private readonly computerPreview:
    | ((
        target: AppshotTarget,
        signal: AbortSignal
      ) => Promise<ControlImage | null>)
    | undefined
  private readonly changed: (activity: ControlActivity) => void
  constructor(
    browser: BrowserService,
    thumbnail: (image: ControlImage) => ControlImage | null,
    changed: (activity: ControlActivity) => void,
    computerPreview?: (
      target: AppshotTarget,
      signal: AbortSignal
    ) => Promise<ControlImage | null>
  ) {
    this.browser = browser
    this.thumbnail = thumbnail
    this.changed = changed
    this.computerPreview = computerPreview
  }

  observe(activity: Omit<ControlActivity, "updatedAt">, image?: ControlImage) {
    let entry = this.entries.get(activity.conversationId)
    const next = { ...activity, updatedAt: Date.now() }
    if (!entry) {
      if (this.entries.size >= 64) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined) this.remove(oldest)
      }
      entry = { preview: { activity: next, frame: null }, watchers: new Map() }
      this.entries.set(activity.conversationId, entry)
    }
    if (
      entry.preview.activity.kind !== activity.kind ||
      entry.preview.activity.target !== activity.target
    ) {
      entry.capture?.abort()
      entry.captureFrame = undefined
      entry.authorize = undefined
      entry.preview.frame = null
    }
    entry.preview.activity = next
    if (image) this.frame(entry, image)
    if (!entry.publish) {
      entry.publish = setTimeout(() => {
        entry.publish = undefined
        this.changed(entry.preview.activity)
      }, 250)
      entry.publish.unref()
    }
  }

  browserTarget(
    conversationId: string,
    target: BrowserTarget,
    authorize: () => void
  ) {
    const entry = this.entries.get(conversationId)
    if (!entry || entry.preview.activity.kind !== "browser") return
    entry.captureFrame = (signal) =>
      this.browser
        .preview(conversationId, target, signal, authorize)
        .then((value) => ControlImageSchema.parse(value))
    entry.authorize = authorize
    this.capture(entry)
  }

  computerTarget(
    conversationId: string,
    target: AppshotTarget,
    authorize: () => void
  ) {
    const entry = this.entries.get(conversationId)
    const capture = this.computerPreview
    if (!entry || !capture || entry.preview.activity.kind !== "computer") return
    entry.captureFrame = (signal) => capture(target, signal)
    entry.authorize = authorize
    this.capture(entry)
  }

  read(
    conversationId: string,
    watching: boolean,
    watcher = "panel"
  ): ControlPreview | null {
    const entry = this.entries.get(conversationId)
    if (!entry) return null
    for (const [id, until] of entry.watchers)
      if (until < Date.now()) entry.watchers.delete(id)
    if (watching) {
      if (entry.watchers.size < 16 || entry.watchers.has(watcher))
        entry.watchers.set(watcher, Date.now() + 3_000)
      this.capture(entry)
    } else {
      entry.watchers.delete(watcher)
      if (entry.watchers.size === 0) entry.capture?.abort()
    }
    return entry.preview
  }

  private frame(entry: PreviewEntry, image: ControlImage) {
    // The native thumbnail boundary decodes and bounds pixels before retention.
    let thumbnail: ControlImage | null
    try {
      thumbnail = this.thumbnail(image)
    } catch {
      return
    }
    if (!thumbnail || thumbnail.data.length > 512 * 1024) return
    entry.preview.frame = {
      id: randomUUID(),
      image: thumbnail,
      capturedAt: Date.now(),
    }
  }

  private capture(entry: PreviewEntry) {
    const capture = entry.captureFrame
    if (
      !capture ||
      !entry.authorize ||
      entry.capture ||
      ![...entry.watchers.values()].some((until) => until >= Date.now()) ||
      (entry.preview.activity.status !== "running" &&
        Date.now() - entry.preview.activity.updatedAt > 5_000) ||
      Date.now() - (entry.preview.frame?.capturedAt ?? 0) < 350
    )
      return
    const controller = new AbortController()
    entry.capture = controller
    const authorize = entry.authorize
    void Promise.resolve()
      .then(() => {
        authorize()
        return capture(
          AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)])
        )
      })
      .then((value) => {
        if (
          controller.signal.aborted ||
          entry.captureFrame !== capture ||
          ![...entry.watchers.values()].some((until) => until >= Date.now())
        )
          return
        authorize()
        if (value) this.frame(entry, value)
      })
      .catch(() => {
        /* A preview failure never fails, retries, or retargets an agent action. */
      })
      .finally(() => {
        if (entry.capture === controller) entry.capture = undefined
      })
  }

  remove(conversationId: string) {
    const entry = this.entries.get(conversationId)
    entry?.capture?.abort()
    if (entry?.publish) clearTimeout(entry.publish)
    this.entries.delete(conversationId)
  }

  close() {
    for (const id of this.entries.keys()) this.remove(id)
  }
}
