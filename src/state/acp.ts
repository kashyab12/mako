import { getMako, hasBridge } from "@/lib/bridge"
import type { AcpBlock } from "@/lib/acp-blocks"
import type {
  AcpPermissionRequest,
  AcpPromptAttachment,
  AcpSessionState,
  AcpUpdate,
  ThreadRef,
} from "@/lib/types"
import {
  canResumeInteractively,
  markThreadReviewed,
  setThreadAttention,
  setThreadRunning,
  setThreadWorkDetail,
  threadsStore,
  withConversion,
} from "@/state/threads"
import {
  acpForThread,
  acpStore,
  activeAcp,
  activeLiveAcp,
  liveAcpConversations,
  liveAcpForThread,
  removeAcpConversation,
  replaceAcpConversation,
  updateAcpConversation,
  useAcp,
  type AcpConversation,
  type AcpQueuedPrompt,
  type AcpState,
  type LiveAcpConversation,
  type StartingAcpConversation,
} from "@/state/acp-state"
import { draftText, rememberDraft } from "@/state/drafts"
import { reduceAcpUpdates } from "@/state/acp-reducer"
import { viewedThread } from "@/state/thread-viewing"
import { toast } from "sonner"

export {
  acpForThread,
  acpStore,
  activeAcp,
  activeLiveAcp,
  liveAcpConversations,
  liveAcpForThread,
  useAcp,
}
export type {
  AcpConversation,
  AcpQueuedPrompt,
  AcpState,
  LiveAcpConversation,
  StartingAcpConversation,
}

type AcpStartOptions = NonNullable<
  Parameters<ReturnType<typeof getMako>["acpStart"]>[2]
>

interface BeginStartInput {
  harness: string
  cwd: string
  title?: string
  threadPath?: string
  blocks: AcpBlock[]
  hiddenUserPrompt: string | null
}

let startCounter = 0
const MAX_RESIDENT_SESSIONS = 12
const MAX_BUFFERED_UPDATES = 2_000
const MAX_BUFFERED_SESSIONS = 16

function beginStart(input: BeginStartInput): StartingAcpConversation {
  const now = Date.now()
  const key = `starting-${now}-${++startCounter}`
  const conversation: StartingAcpConversation = {
    kind: "starting",
    key,
    draftKey: input.threadPath ?? key,
    harness: input.harness,
    cwd: input.cwd,
    title: input.title,
    threadPath: input.threadPath,
    blocks: input.blocks,
    queued: [],
    hiddenUserPrompt: input.hiddenUserPrompt,
    createdAt: now,
    updatedAt: now,
  }
  replaceAcpConversation(key, conversation)
  acpStore.set({ activeKey: key })
  return conversation
}

function updateStarting(
  key: string,
  patch: Partial<
    Pick<StartingAcpConversation, "hiddenUserPrompt" | "blocks">
  >
): void {
  updateAcpConversation(key, (conversation) =>
    conversation.kind === "starting"
      ? { ...conversation, ...patch, updatedAt: Date.now() }
      : conversation
  )
}

function promoteStart(
  key: string,
  session: AcpSessionState
): LiveAcpConversation | null {
  const state = acpStore.get()
  const starting = state.conversations[key]
  if (!starting || starting.kind !== "starting") {
    if (hasBridge()) void getMako().acpClose(session.id)
    return null
  }
  const buffered = starting.threadPath
    ? []
    : (state.bufferedUpdates[session.id] ?? [])
  const conversations = { ...state.conversations }
  delete conversations[key]
  const live: LiveAcpConversation = {
    ...starting,
    kind: "live",
    key: session.id,
    session,
    blocks: reduceAcpUpdates(starting.blocks, buffered),
    permission: state.bufferedPermissions[session.id] ?? null,
    sending: false,
    canceling: false,
    updatedAt: Date.now(),
  }
  conversations[session.id] = live
  const bufferedUpdates = { ...state.bufferedUpdates }
  const bufferedPermissions = { ...state.bufferedPermissions }
  delete bufferedUpdates[session.id]
  delete bufferedPermissions[session.id]
  acpStore.set({
    conversations,
    bufferedUpdates,
    bufferedPermissions,
    activeKey: state.activeKey === key ? session.id : state.activeKey,
  })
  if (live.permission && live.threadPath)
    setThreadAttention(live.threadPath, {
      kind: "needs-permission",
      since: Date.now(),
      detail: live.permission.title,
    })
  pruneResidentSessions()
  return live
}

function failStart(key: string): void {
  removeAcpConversation(key)
}

function waitForPromotion(draftKey: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      const conversation = Object.values(acpStore.get().conversations).find(
        (candidate) => candidate.draftKey === draftKey
      )
      if (conversation?.kind === "live") {
        unsubscribe()
        resolve(true)
      } else if (!conversation) {
        unsubscribe()
        resolve(false)
      }
    }
    const unsubscribe = acpStore.subscribe(check)
    check()
  })
}

function updateLive(
  id: string,
  update: (conversation: LiveAcpConversation) => LiveAcpConversation
): LiveAcpConversation | null {
  const next = updateAcpConversation(id, (conversation) =>
    conversation.kind === "live" ? update(conversation) : conversation
  )
  return next?.kind === "live" ? next : null
}

function bufferUpdates(id: string, updates: AcpUpdate[]): void {
  if (updates.length === 0) return
  const state = acpStore.get()
  const current = state.bufferedUpdates[id] ?? []
  const bufferedUpdates = {
    ...state.bufferedUpdates,
    [id]: [...current, ...updates].slice(-MAX_BUFFERED_UPDATES),
  }
  const ids = Object.keys(bufferedUpdates)
  const oldest = ids[0]
  if (ids.length > MAX_BUFFERED_SESSIONS && oldest)
    delete bufferedUpdates[oldest]
  acpStore.set({ bufferedUpdates })
}

function activeIs(id: string): boolean {
  return acpStore.get().activeKey === id
}

function syncThreadStatus(
  conversation: LiveAcpConversation,
  previousStatus: AcpSessionState["status"]
): void {
  const { session, threadPath, queued } = conversation
  if (!threadPath) return
  setThreadRunning(threadPath, session.status === "running")
  if (session.status === "running") {
    if (!conversation.permission) setThreadAttention(threadPath, null)
    return
  }
  if (conversation.permission) {
    setThreadAttention(threadPath, {
      kind: "needs-permission",
      since: Date.now(),
      detail: conversation.permission.title,
    })
    return
  }
  if (session.status === "failed") {
    setThreadAttention(threadPath, {
      kind: "failed",
      at: Date.now(),
      detail: session.error,
    })
    return
  }
  if (
    previousStatus === "running" &&
    session.status === "ready" &&
    queued.length === 0
  ) {
    setThreadAttention(
      threadPath,
      activeIs(session.id)
        ? null
        : { kind: "review", at: Date.now(), unread: true }
    )
  }
}

export function applyAcpSession(session: AcpSessionState): void {
  const current = acpStore.get().conversations[session.id]
  if (!current || current.kind !== "live") {
    if (session.status === "failed" || session.status === "closed") {
      const bufferedUpdates = { ...acpStore.get().bufferedUpdates }
      const bufferedPermissions = { ...acpStore.get().bufferedPermissions }
      delete bufferedUpdates[session.id]
      delete bufferedPermissions[session.id]
      acpStore.set({ bufferedUpdates, bufferedPermissions })
    }
    return
  }
  const previousStatus = current.session.status
  if (session.status === "closed") {
    if (current.threadPath) {
      setThreadRunning(current.threadPath, false)
      setThreadAttention(current.threadPath, null)
    }
    removeAcpConversation(session.id)
    return
  }
  const next = updateLive(session.id, (conversation) => ({
    ...conversation,
    session,
    sending: false,
    canceling: session.status === "running" ? conversation.canceling : false,
    permission: conversation.permission,
    updatedAt: Date.now(),
  }))
  if (!next) return
  syncThreadStatus(next, previousStatus)
  if (session.status === "failed" && session.error)
    toast.error(session.error, { description: session.title })

  if (session.status === "ready") drainQueue(session.id)
  if (session.status !== "running") pruneResidentSessions()
}

export function applyAcpUpdate(id: string, update: AcpUpdate): void {
  applyAcpUpdates(id, [update])
}

export function applyAcpUpdates(id: string, updates: AcpUpdate[]): void {
  const current = acpStore.get().conversations[id]
  if (!current || current.kind !== "live") {
    bufferUpdates(id, updates)
    return
  }
  let hidden = false
  const visible = current.hiddenUserPrompt
    ? updates.filter((update) => {
        if (
          !hidden &&
          update.kind === "user" &&
          update.text === current.hiddenUserPrompt
        ) {
          hidden = true
          return false
        }
        return true
      })
    : updates
  const next = updateLive(id, (conversation) => ({
    ...conversation,
    blocks: reduceAcpUpdates(conversation.blocks, visible),
    hiddenUserPrompt: hidden ? null : conversation.hiddenUserPrompt,
    updatedAt: Date.now(),
  }))
  if (!next?.threadPath) return
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const update = visible[index]
    if (update.kind === "tool") {
      setThreadWorkDetail(next.threadPath, update.title)
      return
    }
    if (update.kind === "text") {
      setThreadWorkDetail(next.threadPath, "Writing response")
      return
    }
    if (update.kind === "thinking") {
      setThreadWorkDetail(next.threadPath, "Reasoning")
      return
    }
  }
}

export function applyAcpPermission(request: AcpPermissionRequest): void {
  const state = acpStore.get()
  const current = state.conversations[request.sessionId]
  if (!current || current.kind !== "live") {
    const bufferedPermissions = {
      ...state.bufferedPermissions,
      [request.sessionId]: request,
    }
    const ids = Object.keys(bufferedPermissions)
    const oldest = ids[0]
    if (ids.length > MAX_BUFFERED_SESSIONS && oldest)
      delete bufferedPermissions[oldest]
    acpStore.set({ bufferedPermissions })
    return
  }
  const next = updateLive(request.sessionId, (conversation) => ({
    ...conversation,
    permission: request,
    updatedAt: Date.now(),
  }))
  if (!next) return
  if (next.threadPath)
    setThreadAttention(next.threadPath, {
      kind: "needs-permission",
      since: Date.now(),
      detail: request.title,
    })
  if (!activeIs(request.sessionId)) {
    toast(`${next.session.title ?? next.session.harness} needs input`, {
      description: request.title,
      action: {
        label: "View",
        onClick: () => {
          const ref = next.threadPath
            ? threadsStore
                .get()
                .threads.find((candidate) => candidate.path === next.threadPath)
            : undefined
          if (ref)
            void import("@/state/thread-viewing").then(
              ({ threadViewingActions }) => threadViewingActions.view(ref)
            )
          else acp.activate(request.sessionId)
        },
      },
    })
  }
}

async function sendTo(
  id: string,
  text: string,
  attachments: AcpPromptAttachment[] = []
): Promise<boolean> {
  const current = acpStore.get().conversations[id]
  if (!current || current.kind !== "live" || !hasBridge()) return false
  if (current.session.status === "running" || current.sending) {
    updateLive(id, (conversation) => ({
      ...conversation,
      queued: [...conversation.queued, { text, attachments }],
      updatedAt: Date.now(),
    }))
    return true
  }
  updateLive(id, (conversation) => ({
    ...conversation,
    sending: true,
    updatedAt: Date.now(),
  }))
  try {
    await getMako().acpPrompt(id, text, attachments)
    return true
  } catch (error) {
    updateLive(id, (conversation) => ({
      ...conversation,
      sending: false,
      updatedAt: Date.now(),
    }))
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}

function drainQueue(id: string): void {
  const current = acpStore.get().conversations[id]
  if (
    !current ||
    current.kind !== "live" ||
    current.session.status !== "ready" ||
    current.sending
  )
    return
  const [queued, ...rest] = current.queued
  if (!queued) return
  updateLive(id, (conversation) => ({ ...conversation, queued: rest }))
  void sendTo(id, queued.text, queued.attachments).then((sent) => {
    if (sent) return
    updateLive(id, (conversation) => ({
      ...conversation,
      queued: [queued, ...conversation.queued],
    }))
  })
}

function pruneResidentSessions(): void {
  const state = acpStore.get()
  const live = liveAcpConversations(state)
  if (live.length <= MAX_RESIDENT_SESSIONS) return
  const removable = live
    .filter(
      (conversation) =>
        conversation.key !== state.activeKey &&
        conversation.session.status !== "running" &&
        !conversation.permission &&
        !conversation.sending &&
        !conversation.canceling &&
        conversation.queued.length === 0
    )
    .sort((left, right) => left.updatedAt - right.updatedAt)
  for (let count = live.length; count > MAX_RESIDENT_SESSIONS; count -= 1) {
    const conversation = removable.shift()
    if (!conversation) return
    if (hasBridge()) void getMako().acpClose(conversation.session.id)
    if (conversation.threadPath)
      setThreadRunning(conversation.threadPath, false)
    removeAcpConversation(conversation.key)
  }
}

async function launch(
  starting: StartingAcpConversation,
  options: AcpStartOptions,
  prompt?: string,
  attachments: AcpPromptAttachment[] = []
): Promise<boolean> {
  try {
    const session = await getMako().acpStart(
      starting.harness,
      starting.cwd,
      options
    )
    const live = promoteStart(starting.key, session)
    if (!live) return false
    if (prompt === undefined) {
      drainQueue(live.key)
      return true
    }
    return sendTo(live.key, prompt, attachments)
  } catch (error) {
    failStart(starting.key)
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}

export const acp = {
  activate(key: string): boolean {
    const conversation = acpStore.get().conversations[key]
    if (!conversation) return false
    acpStore.set({ activeKey: key })
    threadsStore.set({ composerHarness: conversation.harness })
    const path = conversation.threadPath
    if (path) markThreadReviewed(path)
    if (threadsStore.get().viewing?.ref.path === path) return true
    threadsStore.set({
      viewing: null,
      opening: null,
      viewingBusy: false,
      run: null,
    })
    return true
  },

  activateThread(path: string): boolean {
    const conversation = acpForThread(acpStore.get(), path)
    return conversation ? acp.activate(conversation.key) : false
  },

  deactivate(): void {
    acpStore.set({ activeKey: null })
  },

  bindThreads(refs: ThreadRef[]): void {
    const state = acpStore.get()
    const claimedPaths = new Set(
      liveAcpConversations(state)
        .map((conversation) => conversation.threadPath)
        .filter((path): path is string => Boolean(path))
    )
    for (const conversation of Object.values(state.conversations)) {
      if (
        conversation.kind !== "live" ||
        conversation.threadPath ||
        !conversation.session.nativeId
      )
        continue
      const ref = refs.find(
        (candidate) =>
          candidate.harness === conversation.session.harness &&
          candidate.nativeId === conversation.session.nativeId
      )
      if (!ref || claimedPaths.has(ref.path)) continue
      claimedPaths.add(ref.path)
      const heldDraft = draftText(conversation.draftKey)
      const threadDraft = draftText(ref.path)
      if (heldDraft && heldDraft !== threadDraft)
        rememberDraft(
          ref.path,
          threadDraft ? `${threadDraft}\n\n${heldDraft}` : heldDraft
        )
      if (conversation.draftKey !== ref.path)
        rememberDraft(conversation.draftKey, "")
      const next = updateLive(conversation.key, (current) => ({
        ...current,
        draftKey: ref.path,
        threadPath: ref.path,
        title: ref.title ?? current.title,
        updatedAt: Date.now(),
      }))
      if (!next) continue
      setThreadRunning(ref.path, next.session.status === "running")
      if (next.session.status === "failed")
        setThreadAttention(ref.path, {
          kind: "failed",
          at: Date.now(),
          detail: next.session.error,
        })
      else if (
        next.session.status === "ready" &&
        next.session.lastStop &&
        !/(?:cancel|interrupt|abort)/i.test(next.session.lastStop)
      )
        setThreadAttention(
          ref.path,
          activeIs(next.key)
            ? null
            : { kind: "review", at: Date.now(), unread: true }
        )
    }
  },

  async openInteractive(ref: ThreadRef): Promise<boolean> {
    if (!hasBridge()) return false
    const existing = acpForThread(acpStore.get(), ref.path)
    if (existing) return acp.activate(existing.key)
    const canResume = canResumeInteractively(ref.harness)
    const harness = canResume
      ? ref.harness
      : threadsStore.get().composerHarness
    const starting = beginStart({
      harness,
      cwd: ref.cwd ?? "",
      title: ref.title,
      threadPath: ref.path,
      blocks: [],
      hiddenUserPrompt: null,
    })
    try {
      let contextPrompt: string | null = null
      if (!canResume) {
        const prepared = await withConversion(
          ref.harness,
          harness,
          ref.title,
          async () => {
            const [artifact] = await getMako().threadContexts([ref.path])
            return artifact
          }
        )
        if (!prepared)
          throw new Error("This conversation could not be prepared")
        contextPrompt = `Read ${prepared.file} in full before continuing. It is ordered newest turn first.`
        updateStarting(starting.key, { hiddenUserPrompt: contextPrompt })
      }
      const options: AcpStartOptions = {
        title: ref.title,
        tuning: threadsStore.get().composerTuning[harness],
      }
      if (canResume) options.resume = ref.nativeId
      return launch(starting, options, contextPrompt ?? undefined)
    } catch (error) {
      failStart(starting.key)
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async resumeAndSend(
    ref: ThreadRef,
    prompt: string,
    attachments: AcpPromptAttachment[] = []
  ): Promise<boolean> {
    if (!hasBridge()) return false
    const existing = acpForThread(acpStore.get(), ref.path)
    if (existing) {
      acp.activate(existing.key)
      if (existing.kind === "live")
        return sendTo(existing.key, prompt, attachments)
      updateAcpConversation(existing.key, (conversation) => ({
        ...conversation,
        queued: [...conversation.queued, { text: prompt, attachments }],
        updatedAt: Date.now(),
      }))
      return true
    }
    setThreadRunning(ref.path, true)
    const starting = beginStart({
      harness: ref.harness,
      cwd: ref.cwd ?? "",
      title: ref.title,
      threadPath: ref.path,
      blocks: [{ type: "user", text: prompt }],
      hiddenUserPrompt: null,
    })
    const sent = await launch(
      starting,
      {
        title: ref.title,
        resume: ref.nativeId,
        tuning: threadsStore.get().composerTuning[ref.harness],
      },
      prompt,
      attachments
    )
    if (!sent) setThreadRunning(ref.path, false)
    return sent
  },

  async startFresh(
    harness: string,
    cwd: string,
    prompt: string,
    attachments: AcpPromptAttachment[] = [],
    displayPrompt = prompt,
    threadPath?: string
  ): Promise<boolean> {
    if (!hasBridge()) return false
    const existing = threadPath
      ? acpForThread(acpStore.get(), threadPath)
      : null
    if (existing) {
      acp.activate(existing.key)
      return acp.send(prompt, attachments)
    }
    const starting = beginStart({
      harness,
      cwd,
      threadPath,
      blocks: displayPrompt ? [{ type: "user", text: displayPrompt }] : [],
      hiddenUserPrompt: displayPrompt === prompt ? null : prompt,
    })
    return launch(
      starting,
      { tuning: threadsStore.get().composerTuning[harness] },
      prompt,
      attachments
    )
  },

  async handoff(harness: string, prompt: string): Promise<boolean> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge()) return false
    updateLive(current.key, (conversation) => ({
      ...conversation,
      blocks: [...conversation.blocks, { type: "user", text: prompt }],
      updatedAt: Date.now(),
    }))
    const locate = (refs: ThreadRef[]) =>
      refs.find((ref) =>
        current.threadPath
          ? ref.path === current.threadPath
          : ref.harness === current.session.harness &&
            ref.nativeId === current.session.nativeId
      )
    try {
      let ref = locate(threadsStore.get().threads)
      for (let attempt = 0; !ref && attempt < 20; attempt += 1) {
        const catalog = await getMako().threads()
        ref = locate(catalog.threads)
        if (!ref) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!ref) throw new Error("This live session is still being saved")
      const thread = await getMako().openThread(ref.path)
      if (!thread) throw new Error("This live session could not be read")
      await getMako().acpClose(current.session.id)
      if (current.threadPath) setThreadRunning(current.threadPath, false)
      removeAcpConversation(current.key)
      threadsStore.set({
        viewing: viewedThread(thread),
        run: null,
        composerHarness: harness,
      })
      const { threads } = await import("@/state/threads")
      return threads.moveAndSend(thread.ref, harness, prompt)
    } catch (error) {
      updateLive(current.key, (conversation) => {
        const blocks = [...conversation.blocks]
        const optimistic = blocks.findLastIndex(
          (block) => block.type === "user" && block.text === prompt
        )
        if (optimistic >= 0) blocks.splice(optimistic, 1)
        return { ...conversation, blocks, updatedAt: Date.now() }
      })
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  send(text: string, attachments: AcpPromptAttachment[] = []): Promise<boolean> {
    const current = activeAcp(acpStore.get())
    if (!current) return Promise.resolve(false)
    if (current.kind === "starting") {
      updateAcpConversation(current.key, (conversation) => ({
        ...conversation,
        queued: [...conversation.queued, { text, attachments }],
        updatedAt: Date.now(),
      }))
      return waitForPromotion(current.draftKey)
    }
    return sendTo(current.key, text, attachments)
  },

  unqueue(): void {
    const current = activeAcp(acpStore.get())
    if (!current) return
    updateAcpConversation(current.key, (conversation) => ({
      ...conversation,
      queued: [],
      updatedAt: Date.now(),
    }))
  },

  answerPermission(
    optionId: string | null,
    answers?: Record<string, string[]>
  ): void {
    const current = activeLiveAcp(acpStore.get())
    if (!current?.permission || !hasBridge()) return
    void getMako().acpPermission(
      current.session.id,
      current.permission.id,
      answers
        ? { kind: "answers", answers }
        : { kind: "choice", optionId }
    )
    updateLive(current.key, (conversation) => ({
      ...conversation,
      permission: null,
      updatedAt: Date.now(),
    }))
    if (current.threadPath) setThreadAttention(current.threadPath, null)
  },

  setMode(modeId: string): void {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge()) return
    void getMako().acpSetMode(current.session.id, modeId)
  },

  async cancel(): Promise<boolean> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge() || current.canceling) return false
    updateLive(current.key, (conversation) => ({
      ...conversation,
      canceling: true,
      updatedAt: Date.now(),
    }))
    try {
      await getMako().acpCancel(current.session.id)
      globalThis.setTimeout(() => {
        const latest = acpStore.get().conversations[current.key]
        if (
          latest?.kind === "live" &&
          latest.session.status === "running" &&
          latest.canceling
        ) {
          updateLive(current.key, (conversation) => ({
            ...conversation,
            canceling: false,
            updatedAt: Date.now(),
          }))
          toast.error("The provider did not stop the current turn")
        }
      }, 10_000)
      return true
    } catch (error) {
      updateLive(current.key, (conversation) => ({
        ...conversation,
        canceling: false,
        updatedAt: Date.now(),
      }))
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  close(): boolean {
    const active = activeAcp(acpStore.get())
    if (!active) return false
    if (active.kind === "starting") {
      if (active.threadPath) setThreadRunning(active.threadPath, false)
      removeAcpConversation(active.key)
      return true
    }
    if (hasBridge()) void getMako().acpClose(active.session.id)
    if (active.threadPath) {
      setThreadRunning(active.threadPath, false)
      setThreadAttention(active.threadPath, null)
    }
    removeAcpConversation(active.key)
    return true
  },
}
