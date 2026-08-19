/**
 * Which harnesses a conversation has lived on.
 *
 * A thread continued from Devin to Claude Code is one conversation, and the
 * interface should say so: both marks, one title. No harness's store has a
 * field for "where this came from", so the fact lives here, on this side —
 * a small JSON map from session path to its earlier lives.
 *
 * The awkward part is that a fresh continuation's session file does not
 * exist yet when we start it — the CLI creates it moments later, with an id
 * we do not choose. So a continuation first records an *expectation*:
 * harness, working directory, the moment it started, and the chain it
 * carries. When the catalog notices a new session that matches — same
 * harness, same folder, born after the expectation — the chain binds to its
 * path. Expectations expire in ten minutes; a CLI that failed to start
 * should not haunt the next week's sessions.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { app } from "electron"
import type { ThreadOrigin, ThreadRef } from "@mako/sessions"
import type { JsonObject, JsonValue } from "./codex-app-json.js"

interface Expectation {
  harness: string
  cwd?: string
  at: number
  chain: ThreadOrigin[]
}

interface LineageFile {
  version: 1
  byPath: Record<string, ThreadOrigin[]>
  pending: Expectation[]
}

const EXPECT_TTL_MS = 10 * 60 * 1000

let state: LineageFile = { version: 1, byPath: {}, pending: [] }
let loaded = false
let saveTimer: NodeJS.Timeout | null = null

function filePath(): string {
  return join(app.getPath("userData"), "lineage.json")
}

export async function loadLineage(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const parsed = parseLineageFile(await readFile(filePath(), "utf8"))
    if (parsed) state = parsed
  } catch {
    // First run, or an unreadable file: lineage starts empty.
  }
  prune()
}

function parseLineageFile(raw: string): LineageFile | null {
  const value: JsonValue = JSON.parse(raw)
  const root = objectValue(value)
  const byPathValue = objectValue(root?.byPath)
  if (root?.version !== 1 || !byPathValue || !Array.isArray(root.pending))
    return null

  const byPath: Record<string, ThreadOrigin[]> = {}
  for (const [path, chainValue] of Object.entries(byPathValue)) {
    const chain = parseOriginList(chainValue)
    if (!chain) return null
    byPath[path] = chain
  }

  const pending: Expectation[] = []
  for (const pendingValue of root.pending) {
    const expectation = parseExpectation(pendingValue)
    if (!expectation) return null
    pending.push(expectation)
  }
  return { version: 1, byPath, pending }
}

function parseExpectation(value: JsonValue): Expectation | null {
  const root = objectValue(value)
  const harness = stringValue(root?.harness)
  const at = numberValue(root?.at)
  const chain = parseOriginList(root?.chain)
  if (!root || harness === undefined || at === undefined || !chain) return null

  const expectation: Expectation = { harness, at, chain }
  const cwd = stringValue(root.cwd)
  if (cwd !== undefined) expectation.cwd = cwd
  return expectation
}

function parseOriginList(value: JsonValue | undefined): ThreadOrigin[] | null {
  if (!Array.isArray(value)) return null
  const origins: ThreadOrigin[] = []
  for (const originValue of value) {
    const root = objectValue(originValue)
    const harness = stringValue(root?.harness)
    if (!root || harness === undefined) return null
    const origin: ThreadOrigin = { harness }
    const title = stringValue(root.title)
    if (title !== undefined) origin.title = title
    origins.push(origin)
  }
  return origins
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return isNumber(value) ? value : undefined
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

/**
 * The chain a continuation of `ref` would carry: everywhere the conversation
 * has been, ending with the ref's own life.
 */
export function chainOf(ref: ThreadRef): ThreadOrigin[] {
  return [...(ref.lineage ?? []), { harness: ref.harness, title: ref.title }]
}

/** A continuation just started; bind its chain to the session that appears. */
export function expectLineage(
  harness: string,
  cwd: string | undefined,
  chain: ThreadOrigin[]
): void {
  prune()
  state.pending.push({ harness, cwd, at: Date.now(), chain })
  scheduleSave()
}

/**
 * Offer a ref to the pending expectations. First match wins: same harness,
 * same folder, and a session that began after the expectation did (with a
 * minute of clock slack — some CLIs stamp the session before we hear back).
 */
export function bindLineage(ref: ThreadRef): boolean {
  if (state.byPath[ref.path]) return false
  const started = ref.startedAt ? Date.parse(ref.startedAt) : Date.now()
  const index = state.pending.findIndex(
    (pending) =>
      pending.harness === ref.harness &&
      (pending.cwd === undefined ||
        ref.cwd === undefined ||
        pending.cwd === ref.cwd) &&
      started >= pending.at - 60_000 &&
      Date.now() - pending.at < EXPECT_TTL_MS
  )
  if (index === -1) return false
  const [expectation] = state.pending.splice(index, 1)
  if (!expectation) return false
  state.byPath[ref.path] = expectation.chain
  scheduleSave()
  return true
}

/** A continuation whose file we created ourselves binds without guessing. */
export function bindLineageDirect(path: string, chain: ThreadOrigin[]): void {
  state.byPath[path] = chain
  scheduleSave()
}

/** Decorate a ref with its lineage, inheriting the title where it should. */
export function annotate(ref: ThreadRef): ThreadRef {
  const chain = state.byPath[ref.path]
  if (!chain || chain.length === 0) return ref
  const inherited = [...chain].reverse().find((origin) => origin.title)?.title
  // The conversation's name travels with it. The native store's own title is
  // the handoff preamble ("You are continuing a conversation…"), which is
  // provenance, not a name — the title it had before is the one that means
  // anything to the person who started it.
  const preamble =
    ref.title?.startsWith("You are continuing a conversation") ||
    ref.title?.startsWith("# Continuing a conversation") ||
    ref.title?.startsWith("Continuing a conversation")
  const title = inherited && (!ref.title || preamble) ? inherited : ref.title
  return { ...ref, lineage: chain, title }
}

function prune(): void {
  const now = Date.now()
  state.pending = state.pending.filter(
    (pending) => now - pending.at < EXPECT_TTL_MS
  )
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void save()
  }, 1000)
}

async function save(): Promise<void> {
  try {
    await mkdir(dirname(filePath()), { recursive: true })
    await writeFile(filePath(), JSON.stringify(state), "utf8")
  } catch {
    // Lost lineage is cosmetic; the sessions themselves are untouched.
  }
}
