/**
 * Devin cloud sessions.
 *
 * Unlike every other provider, Devin's sessions do not live on this disk —
 * they live behind `api.devin.ai`, keyed by an organization service key
 * (`apk_…`), one per account. So this is a *remote source*: the same
 * `ThreadRef`/`Thread` shapes, listed by REST rather than by walking a
 * directory, refreshed by polling rather than by a file watcher — polling
 * being the only kind of watching a remote store offers.
 *
 * Several accounts are first-class: each gets its own key and name, and a
 * ref's path says which one it came from — `devin://<account>/<session-id>`
 * — so two accounts' sessions sit side by side in the same catalog without
 * ever crossing keys.
 *
 * Replying is `POST /v1/session/{id}/message`: Devin's own resume, no CLI
 * involved. The message lands in the running session exactly as if typed at
 * app.devin.ai.
 */

import { titleFrom, type Thread, type ThreadEntry, type ThreadRef } from "../format.js"

export interface DevinAccount {
  /** Display name, and the account segment of every ref path. */
  name: string
  /** An organization service key from app.devin.ai settings (`apk_…`). */
  apiKey: string
  apiUrl?: string
}

const DEFAULT_API = "https://api.devin.ai"
const LIST_LIMIT = 100

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

interface DevinRequestOptions {
  method: "GET" | "POST"
  body?: string
}

interface DevinSessionSummary {
  sessionId: string
  title?: string
  createdAt?: string
  updatedAt?: string
  status?: string
}

interface DevinSessionDetails {
  title?: string
  createdAt?: string
  updatedAt?: string
  status?: string
  messages: DevinMessage[]
}

interface DevinMessage {
  kind: "user" | "assistant"
  text: string
  timestamp?: string
}

export class DevinRemote {
  harness = "devin" as const
  displayName = "Devin"
  private accounts: DevinAccount[]

  constructor(accounts: DevinAccount[]) {
    this.accounts = accounts.filter((account) => account.name && account.apiKey)
  }

  get configured(): boolean {
    return this.accounts.length > 0
  }

  owns(path: string): boolean {
    return path.startsWith("devin://")
  }

  /** Every account's sessions, merged. One failing account drops only its own. */
  async list(): Promise<ThreadRef[]> {
    const perAccount = await Promise.all(
      this.accounts.map(async (account) => {
        try {
          const sessions = parseSessionList(
            await this.request(account, `/v1/sessions?limit=${LIST_LIMIT}`, { method: "GET" })
          )
          return sessions.map((session) => {
            const ref: ThreadRef = {
              harness: this.harness,
              nativeId: session.sessionId,
              path: `devin://${account.name}/${session.sessionId}`,
              title: titleFrom(session.title) ?? session.title,
              startedAt: session.createdAt,
              updatedAt: session.updatedAt ?? session.createdAt,
              model: session.status ? `Devin · ${session.status}` : "Devin",
            }
            return ref
          })
        } catch {
          return []
        }
      })
    )
    return perAccount.flat()
  }

  async read(path: string): Promise<Thread | null> {
    const located = this.locate(path)
    if (!located) return null
    const { account, sessionId } = located
    try {
      const body = parseSessionDetails(
        await this.request(account, `/v1/session/${sessionId}`, { method: "GET" })
      )
      if (!body) return null
      const ref: ThreadRef = {
        harness: this.harness,
        nativeId: sessionId,
        path,
        title: titleFrom(body.title) ?? body.title,
        startedAt: body.createdAt,
        updatedAt: body.updatedAt ?? body.createdAt,
        model: body.status ? `Devin · ${body.status}` : "Devin",
      }
      const entries: ThreadEntry[] = []
      for (const message of body.messages) {
        if (!message.text.trim()) continue
        if (message.kind === "user") {
          entries.push({ kind: "user", at: message.timestamp, text: message.text })
        } else {
          entries.push({
            kind: "assistant",
            at: message.timestamp,
            blocks: [{ type: "text", text: message.text }],
          })
        }
      }
      return { ref, entries }
    } catch {
      return null
    }
  }

  /**
   * A new cloud session from a prompt — Devin's native "start work". Uses
   * the first account unless one is named. Returns the ref path the catalog
   * will list it under, so the caller can open it the moment polling sees it.
   */
  async createSession(prompt: string, accountName?: string): Promise<{ sessionId: string; path: string }> {
    const account = accountName
      ? this.accounts.find((entry) => entry.name === accountName)
      : this.accounts[0]
    if (!account) throw new Error("No Devin account is configured")
    const sessionId = parseCreatedSession(
      await this.request(account, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ prompt }),
      })
    )
    if (!sessionId) throw new Error("Devin did not return a session id")
    return { sessionId, path: `devin://${account.name}/${sessionId}` }
  }

  /** Devin's native resume: the message joins the running cloud session. */
  async send(path: string, message: string): Promise<void> {
    const located = this.locate(path)
    if (!located) throw new Error("This Devin session's account is no longer configured")
    await this.request(located.account, `/v1/session/${located.sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ message }),
    })
  }

  /* ------------------------------------------------------------ internals */

  private locate(path: string): { account: DevinAccount; sessionId: string } | null {
    const match = /^devin:\/\/([^/]+)\/(.+)$/.exec(path)
    if (!match) return null
    const accountName = match[1]
    const sessionId = match[2]
    if (!accountName || !sessionId) return null
    const account = this.accounts.find((entry) => entry.name === accountName)
    return account ? { account, sessionId } : null
  }

  private async request(
    account: DevinAccount,
    path: string,
    options: DevinRequestOptions
  ): Promise<string> {
    const base = (account.apiUrl ?? DEFAULT_API).replace(/\/$/, "")
    const response = await fetch(`${base}${path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        "Content-Type": "application/json",
      },
      body: options.body,
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      throw new Error(`Devin API ${response.status} for ${path}`)
    }
    return response.text()
  }
}

function parseSessionList(raw: string): DevinSessionSummary[] {
  const root = parseJsonRecord(raw)
  if (!root) return []
  const value = root["sessions"]
  if (!Array.isArray(value)) return []
  const sessions: DevinSessionSummary[] = []
  for (const candidate of value) {
    if (!isJsonRecord(candidate)) continue
    const sessionId = readString(candidate, "session_id")
    if (!sessionId) continue
    sessions.push({
      sessionId,
      title: readString(candidate, "title"),
      createdAt: readString(candidate, "created_at"),
      updatedAt: readString(candidate, "updated_at"),
      status: readString(candidate, "status_enum"),
    })
  }
  return sessions
}

function parseSessionDetails(raw: string): DevinSessionDetails | null {
  const root = parseJsonRecord(raw)
  if (!root) return null
  const messages = root["messages"]
  if (messages !== undefined && !Array.isArray(messages)) return null
  return {
    title: readString(root, "title"),
    createdAt: readString(root, "created_at"),
    updatedAt: readString(root, "updated_at"),
    status: readString(root, "status_enum"),
    messages: parseMessages(messages),
  }
}

function parseMessages(value: JsonValue | undefined): DevinMessage[] {
  if (!Array.isArray(value)) return []
  const messages: DevinMessage[] = []
  for (const candidate of value) {
    if (!isJsonRecord(candidate)) continue
    const type = readString(candidate, "type")
    const text = readString(candidate, "message")
    if (!text) continue
    const kind = type === "user_message" ? "user" : type === "devin_message" ? "assistant" : null
    if (!kind) continue
    messages.push({ kind, text, timestamp: readString(candidate, "timestamp") })
  }
  return messages
}

function parseCreatedSession(raw: string): string | undefined {
  const root = parseJsonRecord(raw)
  return root ? readString(root, "session_id") : undefined
}

function parseJsonRecord(raw: string): JsonRecord | null {
  if (!raw) return null
  try {
    const value: JsonValue = JSON.parse(raw)
    return isJsonRecord(value) ? value : null
  } catch {
    return null
  }
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return Object.prototype.toString.call(value) === "[object String]" ? String(value) : undefined
}
