import { getMako, hasBridge } from "@/lib/bridge"
import type {
  AcpPermissionRequest,
  AcpPromptAttachment,
  ThreadRef,
} from "@/lib/types"
import {
  activeIs,
  applyAcpPermission as applyLiveAcpPermission,
  updateLive,
} from "@/state/acp-live"
import { sendTo } from "@/state/acp-queue"
import {
  beginStart,
  failStart,
  launch,
  updateStarting,
  waitForPromotion,
  type AcpStartOptions,
} from "@/state/acp-start"
import {
  acpForThread,
  acpStore,
  activeAcp,
  activeLiveAcp,
  liveAcpConversations,
  liveAcpForThread,
  removeAcpConversation,
  updateAcpConversation,
  useAcp,
  type AcpConversation,
  type AcpQueuedPrompt,
  type AcpState,
  type LiveAcpConversation,
  type StartingAcpConversation,
} from "@/state/acp-state"
import { draftText, rememberDraft } from "@/state/drafts"
import { viewedThread } from "@/state/thread-viewing"
import {
  canResumeInteractively,
  markThreadReviewed,
  setThreadAttention,
  setThreadRunning,
  threadsStore,
  withConversion,
} from "@/state/threads"
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
export {
  applyAcpSession,
  applyAcpUpdate,
  applyAcpUpdates,
} from "@/state/acp-live"
export type {
  AcpConversation,
  AcpQueuedPrompt,
  AcpState,
  LiveAcpConversation,
  StartingAcpConversation,
}

export function applyAcpPermission(request: AcpPermissionRequest): void {
  applyLiveAcpPermission(request, acp.activate)
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
