import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"
import {
  canResumeInteractively,
  setThreadAttention,
  setThreadRunning,
  setThreadWorkDetail,
  threadsStore,
  withConversion,
} from "@/state/threads"
import type { AcpBlock } from "@/lib/acp-blocks"
import { viewedThread } from "@/state/thread-viewing"
import type {
  AcpPermissionRequest,
  AcpPromptAttachment,
  AcpSessionState,
  AcpUpdate,
  ThreadRef,
} from "@/lib/types"

/**
 * One interactive foreign agent, live.
 *
 * The host runs the agent over ACP and streams updates here; this store
 * reduces them into renderable blocks — chunks append to the open text or
 * thinking block, tool updates find their call by id, a plan replaces the
 * previous plan. Exactly one interactive session is on screen at a time,
 * which is not a protocol limit but a UI decision: this panel is a focused
 * conversation, not a fleet console.
 */

interface AcpState {
  session: AcpSessionState | null
  blocks: AcpBlock[]
  permission: AcpPermissionRequest | null
  starting: boolean
  canceling: boolean
  threadPath?: string
  /** Typed while the agent was working; sent the moment it goes quiet. */
  queued: { text: string; attachments: AcpPromptAttachment[] } | null
  hiddenUserPrompt: string | null
}

type AcpStartOptions = NonNullable<
  Parameters<ReturnType<typeof getMako>["acpStart"]>[2]
>

export const acpStore = createStore<AcpState>({
  session: null,
  blocks: [],
  permission: null,
  starting: false,
  canceling: false,
  queued: null,
  hiddenUserPrompt: null,
})
export const useAcp = createHook(acpStore)

export function applyAcpSession(session: AcpSessionState) {
  const { session: current, queued, threadPath, canceling } = acpStore.get()
  if (!current || current.id !== session.id) return
  const previousStatus = current.status
  acpStore.set({
    session,
    canceling: session.status === "running" ? canceling : false,
  })
  if (threadPath) {
    setThreadRunning(threadPath, session.status === "running")
    if (session.status === "running") setThreadAttention(threadPath, null)
    else if (session.status === "failed")
      setThreadAttention(threadPath, {
        kind: "failed",
        at: Date.now(),
        detail: session.error,
      })
    else if (
      previousStatus === "running" &&
      session.status === "ready" &&
      !queued
    )
      setThreadAttention(threadPath, {
        kind: "review",
        at: Date.now(),
        unread: threadsStore.get().viewing?.ref.path !== threadPath,
      })
  }
  if (session.status === "failed" && session.error) toast.error(session.error)
  // A message typed mid-turn goes the moment the agent goes quiet — that is
  // what queueing promised.
  if (current.status === "running" && session.status === "ready" && queued) {
    acpStore.set({ queued: null })
    void acp.send(queued.text, queued.attachments)
  }
}

export function applyAcpUpdate(id: string, update: AcpUpdate) {
  applyAcpUpdates(id, [update])
}

export function applyAcpUpdates(id: string, updates: AcpUpdate[]) {
  const { session, blocks, threadPath, hiddenUserPrompt } = acpStore.get()
  if (!session || session.id !== id) return
  let hidden = false
  const visible = hiddenUserPrompt
    ? updates.filter((update) => {
        if (!hidden && update.kind === "user" && update.text === hiddenUserPrompt) {
          hidden = true
          return false
        }
        return true
      })
    : updates
  acpStore.set({
    blocks: reduceUpdates(blocks, visible),
    hiddenUserPrompt: hidden ? null : hiddenUserPrompt,
  })
  if (!threadPath) return
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const update = visible[index]
    if (update.kind === "tool") {
      setThreadWorkDetail(threadPath, update.title)
      return
    }
    if (update.kind === "text") {
      setThreadWorkDetail(threadPath, "Writing response")
      return
    }
    if (update.kind === "thinking") {
      setThreadWorkDetail(threadPath, "Reasoning")
      return
    }
  }
}

export function applyAcpPermission(request: AcpPermissionRequest) {
  const { session, threadPath } = acpStore.get()
  if (!session || session.id !== request.sessionId) {
    // Nobody is looking at this session; answering nothing cancels the tool,
    // which is the safe default for an unwatched agent.
    if (hasBridge())
      void getMako().acpPermission(request.sessionId, request.id, {
        kind: "choice",
        optionId: null,
      })
    return
  }
  acpStore.set({ permission: request })
  if (threadPath)
    setThreadAttention(threadPath, {
      kind: "needs-permission",
      since: Date.now(),
      detail: request.title,
    })
}

function reduceUpdates(
  blocks: AcpBlock[],
  updates: AcpUpdate[]
): AcpBlock[] {
  const next = [...blocks]
  for (const update of updates) {
    const last = next[next.length - 1]
    switch (update.kind) {
      case "user":
        if (last?.type !== "user" || last.text !== update.text) {
          next.push({ type: "user", text: update.text })
        }
        break
      case "text":
        if (last?.type === "text")
          next[next.length - 1] = {
            type: "text",
            text: last.text + update.text,
          }
        else next.push({ type: "text", text: update.text })
        break
      case "thinking":
        if (last?.type === "thinking")
          next[next.length - 1] = {
            type: "thinking",
            text: last.text + update.text,
          }
        else next.push({ type: "thinking", text: update.text })
        break
      case "tool":
        next.push({
          type: "tool",
          id: update.id,
          title: update.title,
          toolKind: update.toolKind,
          status: update.status,
          input: update.input,
        })
        break
      case "tool-update": {
        const index = next.findIndex(
          (block) => block.type === "tool" && block.id === update.id
        )
        const block = next[index]
        if (block?.type === "tool")
          next[index] = {
            ...block,
            title: update.title ?? block.title,
            status: update.status ?? block.status,
            input: update.input ?? block.input,
            output: update.output ?? block.output,
          }
        break
      }
      case "plan": {
        const index = next.findIndex((block) => block.type === "plan")
        if (index >= 0) next.splice(index, 1)
        next.push({ type: "plan", entries: update.entries })
        break
      }
    }
  }
  return next
}

export const acp = {
  /** Open a provider-owned session directly when its live protocol can resume it. */
  async openInteractive(ref: ThreadRef) {
    if (!hasBridge()) return
    acpStore.set({
      starting: true,
      canceling: false,
      blocks: [],
      permission: null,
    })
    try {
      const canResume = canResumeInteractively(ref.harness)
      const harness = canResume
        ? ref.harness
        : threadsStore.get().composerHarness
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
      }
      const options: AcpStartOptions = {
        title: ref.title,
        tuning: threadsStore.get().composerTuning[harness],
      }
      if (canResume) options.resume = ref.nativeId
      const session = await getMako().acpStart(harness, ref.cwd ?? "", options)
      acpStore.set({
        session,
        starting: false,
        threadPath: ref.path,
        hiddenUserPrompt: contextPrompt,
      })
      if (contextPrompt) await getMako().acpPrompt(session.id, contextPrompt)
    } catch (error) {
      acpStore.set({
        starting: false,
        blocks: [],
        threadPath: undefined,
        hiddenUserPrompt: null,
      })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  async resumeAndSend(
    ref: ThreadRef,
    prompt: string,
    attachments: AcpPromptAttachment[] = []
  ) {
    if (!hasBridge()) return false
    const previous = acpStore.get().session
    if (previous) await getMako().acpClose(previous.id)
    setThreadRunning(ref.path, true)
    acpStore.set({
      starting: true,
      canceling: false,
      blocks: [{ type: "user", text: prompt }],
      permission: null,
      threadPath: ref.path,
      hiddenUserPrompt: null,
    })
    try {
      const session = await getMako().acpStart(ref.harness, ref.cwd ?? "", {
        title: ref.title,
        resume: ref.nativeId,
        tuning: threadsStore.get().composerTuning[ref.harness],
      })
      acpStore.set({ session, starting: false })
      await getMako().acpPrompt(session.id, prompt, attachments)
      return true
    } catch {
      setThreadRunning(ref.path, false)
      acpStore.set({
        starting: false,
        blocks: [],
        threadPath: undefined,
        hiddenUserPrompt: null,
      })
      return false
    }
  },

  /**
   * A brand-new live conversation: the agent starts in the workspace and the
   * first prompt goes the moment the session is ready. This is what makes
   * ACP sessions stream, interrupt, and request permissions in place instead
   * of running as blind one-shot shell commands.
   */
  async startFresh(
    harness: string,
    cwd: string,
    prompt: string,
    attachments: AcpPromptAttachment[] = [],
    displayPrompt = prompt,
    threadPath?: string
  ) {
    if (!hasBridge()) return false
    acpStore.set({
      starting: true,
      canceling: false,
      blocks: displayPrompt ? [{ type: "user", text: displayPrompt }] : [],
      permission: null,
      threadPath,
      hiddenUserPrompt: displayPrompt === prompt ? null : prompt,
    })
    try {
      const session = await getMako().acpStart(harness, cwd, {
        tuning: threadsStore.get().composerTuning[harness],
      })
      acpStore.set({ session, starting: false })
      await getMako().acpPrompt(session.id, prompt, attachments)
      return true
    } catch (error) {
      acpStore.set({
        starting: false,
        blocks: [],
        threadPath: undefined,
        hiddenUserPrompt: null,
      })
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async handoff(harness: string, prompt: string) {
    const current = acpStore.get()
    const session = current.session
    if (!session || !hasBridge()) return false
    acpStore.set({
      blocks: [...current.blocks, { type: "user", text: prompt }],
    })

    const locate = (refs: ThreadRef[]) =>
      refs.find((ref) =>
        current.threadPath
          ? ref.path === current.threadPath
          : ref.harness === session.harness && ref.nativeId === session.nativeId
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

      await getMako().acpClose(session.id)
      threadsStore.set({
        viewing: viewedThread(thread),
        run: null,
        composerHarness: harness,
      })
      acpStore.set({
        session: null,
        blocks: [],
        permission: null,
        starting: false,
        canceling: false,
        queued: null,
        threadPath: undefined,
        hiddenUserPrompt: null,
      })
      const { threads } = await import("@/state/threads")
      return threads.moveAndSend(thread.ref, harness, prompt)
    } catch (error) {
      acpStore.set({ blocks: current.blocks })
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async send(text: string, attachments: AcpPromptAttachment[] = []) {
    const { session } = acpStore.get()
    if (!session || !hasBridge()) return
    if (session.status === "running") {
      // Not lost, not an error: it goes next.
      acpStore.set({ queued: { text, attachments } })
      return
    }
    try {
      await getMako().acpPrompt(session.id, text, attachments)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  unqueue() {
    acpStore.set({ queued: null })
  },

  answerPermission(
    optionId: string | null,
    answers?: Record<string, string[]>
  ) {
    const { session, permission, threadPath } = acpStore.get()
    if (!session || !permission || !hasBridge()) return
    void getMako().acpPermission(
      session.id,
      permission.id,
      answers
        ? { kind: "answers", answers }
        : { kind: "choice", optionId }
    )
    acpStore.set({ permission: null })
    if (threadPath) setThreadAttention(threadPath, null)
  },

  setMode(modeId: string) {
    const { session } = acpStore.get()
    if (!session || !hasBridge()) return
    void getMako().acpSetMode(session.id, modeId)
  },

  async cancel() {
    const { session, canceling } = acpStore.get()
    if (!session || !hasBridge() || canceling) return false
    acpStore.set({ canceling: true })
    try {
      await getMako().acpCancel(session.id)
      globalThis.setTimeout(() => {
        const current = acpStore.get()
        if (
          current.session?.id === session.id &&
          current.session.status === "running" &&
          current.canceling
        ) {
          acpStore.set({ canceling: false })
          toast.error("The provider did not stop the current turn")
        }
      }, 10_000)
      return true
    } catch (error) {
      acpStore.set({ canceling: false })
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  close() {
    const { session, threadPath } = acpStore.get()
    if (session && hasBridge()) void getMako().acpClose(session.id)
    if (threadPath) setThreadRunning(threadPath, false)
    acpStore.set({
      session: null,
      blocks: [],
      permission: null,
      canceling: false,
      queued: null,
      threadPath: undefined,
      hiddenUserPrompt: null,
    })
  },
}
