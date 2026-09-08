import { currentSettingsTarget, threadSettingsTarget, settingsForSend } from "@/state/composer-settings"
import { leaveViewerForLive } from "@/state/thread-viewing"
import { applyLiveSnapshot, hydrateLive } from "@/state/live-recovery"
import { getMako, hasBridge } from "@/lib/bridge"
import type { PromptAttachment, ThreadRef, TransferInput } from "@/lib/types"
import { activeIs, updateLive } from "@/state/acp-live"
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
  useAcp,
  type AcpConversation,
  type AcpQueuedPrompt,
  type AcpState,
  type LiveAcpConversation,
  type StartingAcpConversation,
} from "@/state/acp-state"
import {
  canResumeInteractively,
  markThreadReviewed,
  setThreadAttention,
  setThreadRunning,
  threadsStore,
  threads,
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
export type {
  AcpConversation,
  AcpQueuedPrompt,
  AcpState,
  LiveAcpConversation,
  StartingAcpConversation,
}

export const acp = {
  activate(key: string): boolean {
    const conversation = acpStore.get().conversations[key]
    if (!conversation) return false
    acpStore.set({ activeKey: key })
    if (conversation.kind === "live" && !conversation.hydrated)
      void hydrateLive(key)
    threadsStore.set({ composerHarness: conversation.harness })
    const path = conversation.threadPath
    if (path) markThreadReviewed(path)
    if (threadsStore.get().viewing?.ref.path === path) return true
    threadsStore.set({
      viewing: null,
      opening: null,

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
      void getMako()
        .liveBind(conversation.key, ref.path)
        .then(applyLiveSnapshot)
        .catch((error) => toast.error(String(error)))
      const next = updateLive(conversation.key, (current) => ({
        ...current,
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
    const harness = canResume ? ref.harness : threadsStore.get().composerHarness
    const starting = beginStart({
      settingsTarget: canResume ? threadSettingsTarget(ref) : { kind: "new", harness, cwd: ref.cwd ?? "" },
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
    attachments: PromptAttachment[] = []
  ): Promise<boolean> {
    if (!hasBridge()) return false
    const existing = acpForThread(acpStore.get(), ref.path)
    if (existing) {
      acp.activate(existing.key)
      if (existing.kind === "live")
        return sendTo(existing.key, prompt, attachments)
      return (await waitForPromotion(existing.draftKey))
        ? sendTo(existing.key, prompt, attachments)
        : false
    }
    setThreadRunning(ref.path, true)
    const starting = beginStart({
      settingsTarget: threadSettingsTarget(ref),
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
    attachments: PromptAttachment[] = [],
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
      {},
      prompt,
      attachments
    )
  },

  async delegate(provider: string, task: string): Promise<boolean> {
    const parent = activeLiveAcp(acpStore.get())
    if (!parent || !hasBridge()) return false
    const id = crypto.randomUUID()
    try {
      applyLiveSnapshot(
        await getMako().liveDelegate(parent.key, { id, provider, task })
      )
      return true
    } catch (error) {
      const snapshot = await getMako()
        .liveSnapshot(parent.key)
        .catch(() => null)
      if (snapshot?.control?.children.some((child) => child.id === id)) {
        applyLiveSnapshot(snapshot)
        return true
      }
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async cancelChild(childId: string): Promise<void> {
    const parent = activeLiveAcp(acpStore.get())
    if (!parent || !hasBridge()) return
    try {
      applyLiveSnapshot(await getMako().liveCancelChild(parent.key, childId))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  async openRelated(id: string): Promise<void> {
    await hydrateLive(id)
    acp.activate(id)
  },

  async mergeFork(): Promise<void> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge()) return
    const id = crypto.randomUUID()
    try {
      applyLiveSnapshot(await getMako().liveMergeFork(current.key, id))
      toast("Fork findings will be included in the parent's next turn")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  async fork(requestId: string): Promise<boolean> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge()) return false
    try {
      const snapshot = await getMako().liveFork(current.key, {
        id: crypto.randomUUID(),
        provider: current.harness,
        point: { kind: "run", requestId },
      })
      applyLiveSnapshot(snapshot)
      acp.activate(snapshot.session.id)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  viewProviderHistory(path: string): void {
    const ref = threadsStore
      .get()
      .threads.find((candidate) => candidate.path === path)
    if (ref) void threads.view(ref, "native")
    else toast.error("This provider history is not available in the catalog")
  },

  async handoff(
    harness: string,
    prompt: string,
    attachments: PromptAttachment[] = [],
    tuning?: TransferInput["tuning"]
  ): Promise<boolean> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge()) return false
    const id = crypto.randomUUID()
    try {
      const snapshot = await getMako().liveTransfer(current.key, {
        id,
        provider: harness,
        text: prompt,
        attachments,
        tuning: tuning ?? await settingsForSend(currentSettingsTarget(harness)),
      })
      applyLiveSnapshot(snapshot)
      leaveViewerForLive(harness)
      return true
    } catch (error) {
      const snapshot = await getMako()
        .liveSnapshot(current.key)
        .catch(() => null)
      if (
        snapshot?.control?.transfers.some(
          (transfer) => transfer.input.id === id
        )
      ) {
        applyLiveSnapshot(snapshot)
        return true
      }
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  send(text: string, attachments: PromptAttachment[] = []): Promise<boolean> {
    const current = activeAcp(acpStore.get())
    if (!current) return Promise.resolve(false)
    if (current.kind === "starting")
      return waitForPromotion(current.draftKey).then((ready) =>
        ready ? sendTo(current.key, text, attachments) : false
      )
    return sendTo(current.key, text, attachments)
  },

  async cancel(): Promise<boolean> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge()) return false
    updateLive(current.key, (conversation) => ({
      ...conversation,
      canceling: true,
    }))
    try {
      await getMako().liveCancel(current.key)
      return true
    } catch (error) {
      updateLive(current.key, (conversation) => ({
        ...conversation,
        canceling: false,
      }))
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  answerPermission(
    optionId: string | null,
    answers?: Record<string, string[]>
  ): void {
    const current = activeLiveAcp(acpStore.get())
    if (!current?.permission || !hasBridge()) return
    void getMako()
      .livePermission(
        current.key,
        current.permission.id,
        answers ? { kind: "answers", answers } : { kind: "choice", optionId }
      )
      .catch((error) => toast.error(String(error)))
  },

  setMode(modeId: string): void {
    const current = activeLiveAcp(acpStore.get())
    if (current && hasBridge())
      void getMako()
        .liveSetMode(current.key, modeId)
        .catch((error) => toast.error(String(error)))
  },

  async unqueue(): Promise<void> {
    const current = activeLiveAcp(acpStore.get())
    if (current) applyLiveSnapshot(await getMako().liveClearQueue(current.key))
  },

  close(): boolean {
    const active = activeAcp(acpStore.get())
    if (!active) return false
    if (active.kind === "starting") {
      if (active.threadPath) setThreadRunning(active.threadPath, false)
      removeAcpConversation(active.key)
      return true
    }
    if (hasBridge()) void getMako().liveClose(active.session.id)
    if (active.threadPath) {
      setThreadRunning(active.threadPath, false)
      setThreadAttention(active.threadPath, null)
    }
    removeAcpConversation(active.key)
    return true
  },
}
