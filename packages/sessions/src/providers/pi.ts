/**
 * Pi coding-agent sessions.
 *
 * Native store: `~/.pi/agent/sessions/<cwd-slug>/<stamp>_<uuid>.jsonl`. The
 * header line is `{type:"session", version, id, timestamp, cwd}`; every
 * conversational line is `{type:"message", id, parentId, message}` with roles
 * `user`, `assistant` (content blocks: text / thinking / toolCall) and
 * `toolResult` (paired to its call by `toolCallId`). `model_change` and
 * `thinking_level_change` lines become events; `custom` lines are plugin
 * bookkeeping and are skipped.
 *
 * Pi sessions are trees — a fork writes a message whose `parentId` is an
 * earlier entry. Translation walks the file in order, which yields the last
 * active branch's history interleaved with abandoned ones; for cataloguing
 * and continuation that is the honest, cheap reading of the file. The native
 * store remains authoritative for tree navigation.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { stat } from "node:fs/promises"
import {
  clip,
  titleFrom,
  EntrySink,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
} from "../format.js"
import { parseLine, readHead, readLines, walkFiles } from "../jsonl.js"
import type { NativeFile, SessionProvider } from "./types.js"

interface PiLine {
  type?: string
  timestamp?: string
  id?: string
  cwd?: string
  modelId?: string
  provider?: string
  level?: string
  message?: {
    role?: string
    content?: unknown
    model?: string
    toolCallId?: string
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }
  }
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      const rec = part as Record<string, unknown>
      return rec?.type === "text" && typeof rec.text === "string" ? rec.text : ""
    })
    .join("")
}

export class PiProvider implements SessionProvider {
  harness = "pi" as const
  displayName = "Pi"
  private root: string

  constructor(home = homedir()) {
    this.root = join(home, ".pi", "agent", "sessions")
  }

  roots(): string[] {
    return [this.root]
  }

  async discover(): Promise<NativeFile[]> {
    const paths = await walkFiles(this.root, (name) => name.endsWith(".jsonl"), 2)
    const files = await Promise.all(
      paths.map(async (path) => {
        try {
          const info = await stat(path)
          return { path, bytes: info.size, mtimeMs: info.mtimeMs }
        } catch {
          return null
        }
      })
    )
    return files.filter((file): file is NativeFile => file !== null)
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const head = await readHead(file.path, 131_072)
    let ref: ThreadRef | null = null
    for (const raw of head.split("\n")) {
      const line = parseLine(raw) as PiLine | null
      if (!line?.type) continue
      if (line.type === "session") {
        if (typeof line.id !== "string") return null
        ref = {
          harness: this.harness,
          nativeId: line.id,
          path: file.path,
          cwd: line.cwd,
          startedAt: line.timestamp,
          updatedAt: new Date(file.mtimeMs).toISOString(),
          bytes: file.bytes,
        }
        continue
      }
      if (!ref) continue
      if (line.type === "model_change" && typeof line.modelId === "string") ref.model = line.modelId
      if (!ref.title && line.type === "message" && line.message?.role === "user") {
        ref.title = titleFrom(plainText(line.message.content))
        if (ref.title) break
      }
    }
    return ref
  }

  async read(path: string): Promise<Thread | null> {
    const file = await stat(path).catch(() => null)
    if (!file) return null
    const ref = await this.peek({ path, bytes: file.size, mtimeMs: file.mtimeMs })
    if (!ref) return null
    const into = translator()
    await readLines(path, 0, into.push)
    return { ref, entries: into.done() }
  }

  async tail(path: string, fromByte: number): Promise<{ entries: ThreadEntry[]; nextByte: number }> {
    const into = translator()
    const nextByte = await readLines(path, fromByte, into.push)
    return { entries: into.done(), nextByte }
  }
}

function translator(): { push: (raw: string) => void; done: () => ThreadEntry[] } {
  type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
  const sink = new EntrySink()
  let assistant: AssistantEntry | null = null
  const toolsById = new Map<string, EntryBlock & { type: "tool" }>()

  const push = (raw: string): void => {
    const line = parseLine(raw) as PiLine | null
    if (!line?.type) return

    if (line.type === "model_change") {
      sink.push({
        kind: "event",
        at: line.timestamp,
        label: "Model changed",
        detail: [line.provider, line.modelId].filter(Boolean).join(" · ") || undefined,
      })
      return
    }
    if (line.type === "thinking_level_change") {
      sink.push({ kind: "event", at: line.timestamp, label: "Thinking level", detail: line.level })
      return
    }
    if (line.type !== "message" || !line.message) return
    const message = line.message

    if (message.role === "user") {
      const text = plainText(message.content)
      if (!text.trim()) return
      assistant = null
      sink.push({ kind: "user", at: line.timestamp, text })
      return
    }

    if (message.role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : ""
      const block = toolsById.get(id)
      if (block) {
        block.output = clip(plainText(message.content))
        toolsById.delete(id)
      }
      return
    }

    if (message.role !== "assistant") return
    if (!assistant) {
      assistant = { kind: "assistant", at: line.timestamp, model: message.model, blocks: [] }
      sink.push(assistant)
    }
    const turn: AssistantEntry = assistant
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const rec = part as Record<string, unknown>
        switch (rec?.type) {
          case "text":
            if (typeof rec.text === "string" && rec.text) {
              turn.blocks.push({ type: "text", text: rec.text })
            }
            break
          case "thinking":
            if (typeof rec.thinking === "string" && rec.thinking) {
              turn.blocks.push({ type: "thinking", text: rec.thinking })
            }
            break
          case "toolCall": {
            const block: EntryBlock & { type: "tool" } = {
              type: "tool",
              name: String(rec.name ?? "tool"),
              input: clip(rec.arguments === undefined ? undefined : JSON.stringify(rec.arguments)),
            }
            if (typeof rec.id === "string") toolsById.set(rec.id, block)
            turn.blocks.push(block)
            break
          }
        }
      }
    }
    const usage = message.usage
    if (usage) {
      turn.usage = {
        input: Number(usage.input ?? 0),
        output: Number(usage.output ?? 0),
        cacheRead: Number(usage.cacheRead ?? 0),
        cacheWrite: Number(usage.cacheWrite ?? 0),
        costUsd: Number(usage.cost?.total ?? 0) || undefined,
      }
    }
  }

  return { push, done: () => sink.done() }
}
