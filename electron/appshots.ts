import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { z } from "zod"
import type { ComputerBackend } from "./computer-tools-main.js"
import type {
  Appshot,
  AppshotTarget,
  AppshotWindow,
} from "./contracts/appshots.js"
import {
  ControlImageSchema,
  type ControlImage,
} from "./contracts/control-preview.js"

const windowList = z.object({
  windows: z
    .array(
      z.object({
        pid: z.number().int(),
        window_id: z.number().int(),
        app_name: z.string(),
        title: z.string(),
        is_on_screen: z.boolean(),
      })
    )
    .max(2000),
})
const response = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.json().optional(),
  content: z.array(z.json()),
})

/** Explicit window capture. This connection never focuses an app or sends input. */
export class Appshots {
  private connection: Promise<Client> | undefined
  private readonly backend: () => Promise<ComputerBackend | null>
  constructor(backend: () => Promise<ComputerBackend | null>) {
    this.backend = backend
  }

  private client(): Promise<Client> {
    this.connection ??= (async () => {
      const backend = await this.backend()
      if (!backend)
        throw new Error("Appshots require the macOS computer-control driver.")
      const client = new Client({ name: "mako-appshots", version: "1" })
      client.onclose = () => {
        this.connection = undefined
      }
      try {
        await client.connect(
          new StdioClientTransport({ ...backend, stderr: "pipe" })
        )
        return client
      } catch (error) {
        await client.close()
        throw error
      }
    })().catch((error) => {
      this.connection = undefined
      throw error
    })
    return this.connection
  }

  private async call(
    name: string,
    args: { [key: string]: number | boolean },
    signal?: AbortSignal
  ) {
    const client = await this.client()
    const result = response.parse(
      await client.callTool({ name, arguments: args }, undefined, {
        timeout: 15_000,
        signal,
      })
    )
    if (result.isError)
      throw new Error(
        "The window could not be captured. Check computer permissions and select the window again."
      )
    return result
  }

  async windows(includeThumbnails = false): Promise<AppshotWindow[]> {
    const result = await this.call("list_windows", { on_screen_only: true })
    const windows: AppshotWindow[] = windowList
      .parse(result.structuredContent)
      .windows.filter(
        (window) =>
          window.pid > 0 && window.window_id > 0 && window.is_on_screen
      )
      .map((window) => ({
        pid: window.pid,
        windowId: window.window_id,
        app: window.app_name,
        title: window.title,
      }))
      .sort(
        (a, b) => a.app.localeCompare(b.app) || a.title.localeCompare(b.title)
      )
    if (!includeThumbnails) return windows
    const { desktopCapturer } = await import("electron")
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: true,
    })
    const byId = new Map(
      sources.map((source) => [Number(source.id.split(":")[1]), source])
    )
    return windows
      .filter((window) => byId.has(window.windowId))
      .slice(0, 80)
      .map((window) => {
        const source = byId.get(window.windowId)
        if (!source) return window
        return {
          ...window,
          title: window.title || source.name,
          thumbnail: source.thumbnail.isEmpty()
            ? undefined
            : {
                mimeType: "image/jpeg",
                data: source.thumbnail
                  .resize({ width: 320 })
                  .toJPEG(65)
                  .toString("base64"),
              },
          icon:
            !source.appIcon || source.appIcon.isEmpty()
              ? undefined
              : {
                  mimeType: "image/png",
                  data: source.appIcon
                    .resize({ width: 24, height: 24 })
                    .toPNG()
                    .toString("base64"),
                },
        }
      })
  }

  async capture(target: AppshotTarget): Promise<Appshot> {
    const window = (await this.windows()).find(
      (window) =>
        window.pid === target.pid && window.windowId === target.windowId
    )
    if (!window)
      throw new Error(
        "That window has closed. Select it again from the window list."
      )
    const result = await this.call("get_window_state", {
      pid: target.pid,
      window_id: target.windowId,
      include_screenshot: true,
      max_elements: 1000,
      max_depth: 25,
    })
    const image = result.content
      .map((value) => ControlImageSchema.safeParse(value))
      .find((value) => value.success)?.data
    if (!image)
      throw new Error(
        "The selected window did not return a screenshot. Check Screen Recording permission and try again."
      )
    const context = z
      .object({
        tree_markdown: z.string().optional(),
        element_count: z.number().optional(),
        truncated: z.boolean().optional(),
        elements_complete: z.boolean().optional(),
      })
      .parse(result.structuredContent)
    const text =
      context.tree_markdown ??
      "No accessibility text was available for this window."
    return {
      window,
      capturedAt: Date.now(),
      image,
      text: text.slice(0, 100_000),
      truncated:
        text.length > 100_000 ||
        context.truncated === true ||
        context.elements_complete === false ||
        (context.element_count ?? 0) >= 1000,
    }
  }

  async preview(
    target: AppshotTarget,
    signal: AbortSignal
  ): Promise<ControlImage | null> {
    const result = await this.call(
      "get_window_state",
      {
        pid: target.pid,
        window_id: target.windowId,
        include_screenshot: true,
        max_elements: 1,
        max_depth: 1,
      },
      signal
    )
    return (
      result.content
        .map((value) => ControlImageSchema.safeParse(value))
        .find((value) => value.success)?.data ?? null
    )
  }

  async close() {
    const connection = this.connection
    this.connection = undefined
    if (connection)
      await connection.then((client) => client.close()).catch(() => {})
  }
}
