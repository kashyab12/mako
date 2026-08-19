import { getMako, hasBridge } from "@/lib/bridge"
import type {
  TerminalEvent,
  TerminalSession,
  TerminalSnapshot,
} from "@/lib/types"
import { createStore } from "@/state/store"

export interface TerminalOutput {
  sessionId: string
  sequence: number
  data: string
}

export interface TerminalState {
  phase: "idle" | "connecting" | "ready" | "error"
  sessions: TerminalSession[]
  activeId?: string
  snapshot?: TerminalSnapshot
  sequence: number
  fault?: string
}

export const terminalStore = createStore<TerminalState>({
  phase: "idle",
  sessions: [],
  sequence: 0,
})

let subscribers = 0
let unsubscribe: (() => void) | undefined
let resyncing = false
let recentOutputCharacters = 0
let recentOutputs: TerminalOutput[] = []
const outputListeners = new Set<(output: TerminalOutput) => void>()
const MAX_RECENT_OUTPUT_CHARACTERS = 128 * 1024

export function replayTerminalOutput(listener: (output: TerminalOutput) => void) {
  for (const output of recentOutputs) listener(output)
}

export function subscribeTerminalOutput(listener: (output: TerminalOutput) => void) {
  outputListeners.add(listener)
  replayTerminalOutput(listener)
  return () => {
    outputListeners.delete(listener)
  }
}

function rememberOutput(output: TerminalOutput) {
  recentOutputs.push(output)
  recentOutputCharacters += output.data.length
  while (recentOutputCharacters > MAX_RECENT_OUTPUT_CHARACTERS) {
    const removed = recentOutputs.shift()
    if (!removed) break
    recentOutputCharacters -= removed.data.length
  }
}

function clearRecentOutputs() {
  recentOutputs = []
  recentOutputCharacters = 0
}

function sortSessions(sessions: TerminalSession[]) {
  return [...sessions].sort((left, right) => right.createdAt - left.createdAt)
}

function upsert(session: TerminalSession) {
  const current = terminalStore.get().sessions
  return sortSessions([session, ...current.filter((entry) => entry.id !== session.id)])
}

function applySnapshot(snapshot: TerminalSnapshot) {
  recentOutputs = recentOutputs.filter(
    (output) =>
      output.sessionId === snapshot.session.id &&
      output.sequence > snapshot.sequence
  )
  recentOutputCharacters = recentOutputs.reduce(
    (total, output) => total + output.data.length,
    0
  )
  terminalStore.set({
    phase: "ready",
    sessions: upsert(snapshot.session),
    activeId: snapshot.session.id,
    snapshot,
    sequence: snapshot.sequence,
    fault: undefined,
  })
}

async function attach(sessionId: string) {
  try {
    const snapshot = await getMako().terminalAttach(sessionId)
    if (terminalStore.get().activeId === sessionId) applySnapshot(snapshot)
  } catch (error) {
    terminalStore.set({ phase: "error", fault: error instanceof Error ? error.message : String(error) })
  } finally {
    resyncing = false
  }
}

function applyEvent(event: TerminalEvent) {
  if (event.type === "wake") {
    const activeId = terminalStore.get().activeId
    if (activeId && !resyncing) {
      resyncing = true
      void attach(activeId)
    }
    return
  }
  if (event.type === "connection") {
    const previous = terminalStore.get().phase
    terminalStore.set({
      phase:
        event.state === "ready"
          ? "ready"
          : event.state === "connecting"
            ? "connecting"
            : "error",
      fault: event.error,
    })
    if (event.state === "ready" && previous === "error") void load()
    return
  }
  if (event.type === "snapshot") {
    if (terminalStore.get().activeId === event.snapshot.session.id) {
      applySnapshot(event.snapshot)
    }
    return
  }
  if (event.type === "status") {
    const state = terminalStore.get()
    terminalStore.set({ sessions: upsert(event.session) })
    if (
      state.activeId === event.session.id &&
      event.session.sequence > state.sequence &&
      !resyncing
    ) {
      resyncing = true
      void attach(event.session.id)
    }
    return
  }
  if (event.type === "removed") {
    const state = terminalStore.get()
    const sessions = state.sessions.filter((session) => session.id !== event.sessionId)
    if (state.activeId !== event.sessionId) {
      terminalStore.set({ sessions })
      return
    }
    const next = sessions[0]
    clearRecentOutputs()
    terminalStore.set({
      sessions,
      activeId: next?.id,
      snapshot: undefined,
      sequence: 0,
    })
    if (next) void attach(next.id)
    return
  }
  const state = terminalStore.get()
  if (event.sessionId !== state.activeId) return
  if (event.sequence !== state.sequence + 1) {
    if (!resyncing) {
      resyncing = true
      void attach(event.sessionId)
    }
    return
  }
  rememberOutput(event)
  for (const listener of outputListeners) listener(event)
  terminalStore.set({ sequence: event.sequence })
}

async function load() {
  try {
    const sessions = sortSessions(await getMako().terminalList())
    const current = terminalStore.get().activeId
    const held = sessions.find((session) => session.id === current)
    const activeId =
      (held?.status === "running" ? held.id : undefined) ??
      sessions.find((session) => session.status === "running")?.id ??
      held?.id ??
      sessions[0]?.id
    clearRecentOutputs()
    terminalStore.set({
      phase: "ready",
      sessions,
      activeId,
      snapshot: undefined,
      sequence: 0,
      fault: undefined,
    })
    if (activeId) await attach(activeId)
  } catch (error) {
    terminalStore.set({
      phase: "error",
      fault: error instanceof Error ? error.message : String(error),
    })
  }
}

export const terminalActions = {
  mount() {
    subscribers += 1
    if (subscribers === 1) {
      if (!hasBridge()) {
        terminalStore.set({
          phase: "error",
          fault: "The terminal is available in the desktop app.",
        })
      } else {
        terminalStore.set({ phase: "connecting", fault: undefined })
        unsubscribe = getMako().onTerminalEvent(applyEvent)
        void load()
      }
    }
    return () => {
      subscribers -= 1
      if (subscribers === 0) {
        unsubscribe?.()
        unsubscribe = undefined
        const activeId = terminalStore.get().activeId
        if (activeId && hasBridge()) {
          void getMako().terminalDetach(activeId).catch(() => {})
        }
      }
    }
  },

  refresh() {
    terminalStore.set({ phase: "connecting", fault: undefined })
    return load()
  },

  activate(sessionId: string) {
    if (terminalStore.get().activeId === sessionId) return
    clearRecentOutputs()
    terminalStore.set({
      activeId: sessionId,
      snapshot: undefined,
      sequence: 0,
      fault: undefined,
    })
    void attach(sessionId)
  },

  async create(cwd: string, cols = 80, rows = 24) {
    try {
      const session = await getMako().terminalCreate({ cwd, cols, rows })
      clearRecentOutputs()
      terminalStore.set({ sessions: upsert(session), activeId: session.id })
      await attach(session.id)
    } catch (error) {
      terminalStore.set({
        phase: "error",
        fault: error instanceof Error ? error.message : String(error),
      })
    }
  },

  resync() {
    const activeId = terminalStore.get().activeId
    if (!activeId || resyncing) return
    resyncing = true
    void attach(activeId)
  },

  acknowledge(sessionId: string, sequence: number) {
    void getMako()
      .terminalAcknowledge(sessionId, sequence)
      .catch(() => {
        if (!resyncing) {
          resyncing = true
          void attach(sessionId)
        }
      })
  },

  write(data: string) {
    const { activeId } = terminalStore.get()
    if (!activeId) return
    void getMako()
      .terminalWrite(activeId, data)
      .catch((error) =>
        terminalStore.set({
          fault: error instanceof Error ? error.message : String(error),
        })
      )
  },

  resize(cols: number, rows: number) {
    const { activeId } = terminalStore.get()
    if (!activeId) return
    void getMako()
      .terminalResize(activeId, cols, rows)
      .catch((error) =>
        terminalStore.set({
          fault: error instanceof Error ? error.message : String(error),
        })
      )
  },

  async kill(sessionId: string) {
    try {
      await getMako().terminalKill(sessionId)
    } catch (error) {
      terminalStore.set({ fault: error instanceof Error ? error.message : String(error) })
    }
  },
}
