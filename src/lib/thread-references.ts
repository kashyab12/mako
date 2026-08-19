import { getPi } from "@/lib/bridge"
import { tokenize } from "@/lib/mentions"
import type { ThreadRef } from "@/lib/types"

interface ThreadArtifact {
  file: string
  title?: string
  harness: string
}

const pending = new Map<string, Promise<ThreadArtifact | null>>()

function references(text: string, threads: ThreadRef[]): ThreadRef[] {
  const found = new Map<string, ThreadRef>()
  for (const segment of tokenize(text)) {
    if (segment.kind !== "thread") continue
    const thread = threads.find(
      (entry) => entry.harness === segment.harness && entry.nativeId === segment.nativeId
    )
    if (thread) found.set(thread.path, thread)
  }
  return [...found.values()]
}

function artifact(path: string): Promise<ThreadArtifact | null> {
  const held = pending.get(path)
  if (held) return held
  const request = getPi()
    .threadContexts([path])
    .then((items) => {
      const item = items[0] ?? null
      if (!item) pending.delete(path)
      return item
    })
    .catch(() => {
      pending.delete(path)
      return null
    })
  pending.set(path, request)
  return request
}

function artifactBatch(paths: string[]): Promise<Array<ThreadArtifact | null>> {
  const missing = [...new Set(paths.filter((path) => !pending.has(path)))]
  if (missing.length > 0) {
    const request = getPi().threadContexts(missing)
    for (let index = 0; index < missing.length; index += 1) {
      const path = missing[index]!
      pending.set(
        path,
        request
          .then((items) => {
            const item = items[index] ?? null
            if (!item) pending.delete(path)
            return item
          })
          .catch(() => {
            pending.delete(path)
            return null
          })
      )
    }
  }
  return Promise.all(paths.map((path) => artifact(path)))
}

export function prefetchThreadReferences(text: string, threads: ThreadRef[]): void {
  const paths = references(text, threads).map((thread) => thread.path)
  if (paths.length > 0) void artifactBatch(paths)
}

export function stripThreadReferenceAppendix(text: string): string {
  const at = text.lastIndexOf("\n---\n[Referenced conversation ")
  return at === -1 ? text : text.slice(0, at).trimEnd()
}

export async function appendThreadReferences(text: string, threads: ThreadRef[]): Promise<string> {
  const refs = references(text, threads)
  if (refs.length === 0) return text
  const artifacts = await artifactBatch(refs.map((thread) => thread.path))
  const lines: string[] = []
  for (let index = 0; index < refs.length; index += 1) {
    const thread = refs[index]!
    const prepared = artifacts[index]
    if (!prepared) continue
    lines.push(
      `[Referenced conversation ${index + 1}] ${prepared.title ?? thread.title ?? "Untitled conversation"} (${prepared.harness})`,
      `Transcript bundle: ${prepared.file}`,
      "Read transcript.md in its displayed newest-first order before using this reference. Preserve the chronological order inside each turn. Tool payload sidecars are next to the transcript and contain the complete captured inputs and outputs."
    )
  }
  if (lines.length === 0) return text
  return `${text.trimEnd()}\n\n---\n${lines.join("\n\n")}`
}
