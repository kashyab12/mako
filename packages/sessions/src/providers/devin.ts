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

interface DevinSessionSummary {
  session_id?: string
  title?: string
  created_at?: string
  updated_at?: string
  status_enum?: string
}

interface DevinMessage {
  type?: string
  message?: string
  timestamp?: string
  username?: string
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
          const body = (await this.request(account, `/v1/sessions?limit=${LIST_LIMIT}`)) as {
            sessions?: DevinSessionSummary[]
          }
          return (body.sessions ?? []).flatMap((session) => {
            if (!session.session_id) return []
            const ref: ThreadRef = {
              harness: this.harness,
              nativeId: session.session_id,
              path: `devin://${account.name}/${session.session_id}`,
              title: titleFrom(session.title) ?? session.title,
              startedAt: session.created_at,
              updatedAt: session.updated_at ?? session.created_at,
              model: session.status_enum ? `Devin · ${session.status_enum}` : "Devin",
            }
            return [ref]
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
      const body = (await this.request(account, `/v1/session/${sessionId}`)) as {
        title?: string
        created_at?: string
        updated_at?: string
        status_enum?: string
        messages?: DevinMessage[]
      }
      const ref: ThreadRef = {
        harness: this.harness,
        nativeId: sessionId,
        path,
        title: titleFrom(body.title) ?? body.title,
        startedAt: body.created_at,
        updatedAt: body.updated_at ?? body.created_at,
        model: body.status_enum ? `Devin · ${body.status_enum}` : "Devin",
      }
      const entries: ThreadEntry[] = []
      for (const message of body.messages ?? []) {
        const text = message.message ?? ""
        if (!text.trim()) continue
        if (message.type === "user_message") {
          entries.push({ kind: "user", at: message.timestamp, text })
        } else if (message.type === "devin_message") {
          entries.push({
            kind: "assistant",
            at: message.timestamp,
            blocks: [{ type: "text", text }],
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
    const body = (await this.request(account, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    })) as { session_id?: string }
    if (!body.session_id) throw new Error("Devin did not return a session id")
    return { sessionId: body.session_id, path: `devin://${account.name}/${body.session_id}` }
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
    const account = this.accounts.find((entry) => entry.name === match[1])
    return account ? { account, sessionId: match[2] as string } : null
  }

  private async request(account: DevinAccount, path: string, init: RequestInit = {}): Promise<unknown> {
    const base = (account.apiUrl ?? DEFAULT_API).replace(/\/$/, "")
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      throw new Error(`Devin API ${response.status} for ${path}`)
    }
    const text = await response.text()
    return text ? (JSON.parse(text) as unknown) : {}
  }
}
