import { AttachmentStrip } from "./attachments"
import { InterruptedSends } from "./interrupted-sends"
import {
  preserveSendingDraft,
  settleSendingDraft,
  interruptSendingDraft,
} from "@/state/send-recovery"
import { PromptQueue } from "./prompt-queue"
import { promptDelivery } from "@/state/prompt-delivery"
import type { ProposedPlan } from "@mako/sessions/content"
import { appendPlanContext, parsePlanContext } from "@/lib/proposed-plan"
import { PlanContextChips } from "@/components/composer/plan-context"
import { hostConnectionStore, useHostConnection } from "@/state/host-connection"
import { toast } from "sonner"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  removeAttachmentReference,
  attachmentRanges,
  editAttachmentReferences,
  restoreAttachmentReferences,
} from "@/lib/attachment-references"
import { Banner } from "@/components/composer/banner"
import { ComposerActionButton } from "@/components/composer/composer-action-button"
import { ComposerRouting } from "@/components/composer/composer-routing"
import { ContextDial } from "@/components/composer/context-dial"
import { harnessTitle } from "@/components/composer/harness-title"
import { MentionMenu } from "@/components/composer/mention-menu"
import { ReferenceOverlay } from "@/components/composer/reference-overlay"
import { Chip, IconAction } from "@/components/ui/kit"
import { Slot } from "@/extend/slot"
import {
  buildForeignPrompt,
  useAttachments,
  type Attachment,
  type AttachmentInput,
} from "@/lib/attachments"
import { composerActionKind, composerTurnRunning } from "@/lib/composer-action"
import { textOf } from "@/lib/format"
import { mentionAt, replaceMention, type ActiveMention } from "@/lib/mentions"
import {
  appendThreadReferences,
  prefetchThreadReferences,
} from "@/lib/thread-references"
import type { PromptAttachment } from "@/lib/types"
import { cn } from "@/lib/utils"
import { acp, acpStore, activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import {
  draftText,
  projectDraftKey,
  rememberDraft,
  clearCapturedDraft,
  restoreEmptyDraft,
  appendRecoveredDraft,
  removeDraftPlan,
  replaceDraftPlans,
  retainRejectedDraft,
  takeRejectedDraft,
  useDrafts,
} from "@/state/drafts"
import {
  actions,
  shallowEqual,
  store as sessionStore,
  useSession,
} from "@/state/session"
import { threads, threadsStore, useThreads } from "@/state/threads"
import { AtSignIcon, PaperclipIcon, XIcon, Maximize2Icon, Minimize2Icon } from "lucide-react"

interface CommandMention {
  sigil: "/"
  query: string
  start: number
  end: number
}

type ComposerMention = ActiveMention | CommandMention

type ComposerTextEvent = CustomEvent<string>
type ComposerDraftEvent = CustomEvent<{
  text: string
  attachments?: Attachment[]
}>

interface RestorableDraft {
  plans?: ProposedPlan[]
  text: string
  attachments: Attachment[]
}

declare global {
  interface WindowEventMap {
    "mako:compose": ComposerDraftEvent
    "mako:insert": ComposerTextEvent
  }
}

function toAcpPromptAttachment(item: Attachment): PromptAttachment {
  return {
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    data: item.kind === "image" ? item.data : undefined,
    path: item.stagedPath,
  }
}


export function Composer() {
  const hostConnected = useHostConnection((state) => state.kind === "connected")
  const workspaceCwd = useSession((state) => state.meta?.cwd ?? "")
  const viewingPath = useThreads(
    (state) => state.opening?.ref.path ?? state.viewing?.ref.path
  )
  const opening = useThreads((state) => state.opening)
  const liveDraftKey = useAcp((state) => activeAcp(state)?.draftKey)
  const draftKey = liveDraftKey ?? viewingPath ?? projectDraftKey(workspaceCwd)
  const draftReady = Boolean(liveDraftKey || viewingPath || workspaceCwd)
  const status = useSession(
    useCallback(
      (state) => ({
        streaming: state.meta?.isStreaming ?? false,
        compacting: state.meta?.isCompacting ?? false,
        retrying: state.meta?.isRetrying ?? false,
        queued:
          (state.meta?.queued.steering.length ?? 0) +
          (state.meta?.queued.followUp.length ?? 0),
      }),
      []
    ),
    shallowEqual
  )
  const meta = useSession((state) => state.meta)
  const cwd = meta?.cwd

  const savedDraft = useDrafts((state) =>
    state.drafts.find((entry) => entry.key === draftKey)
  )
  const attachments = useAttachments(draftKey)
  const { reattach } = attachments
  const storedDraft = savedDraft?.text ?? ""
  const draft = restoreAttachmentReferences(storedDraft, attachments.items)
  const draftPlans = savedDraft?.plans
  const [mention, setMention] = useState<ComposerMention | null>(null)
  const [dragging, setDragging] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const activeAttachmentDraft = useRef(draftKey)
  const preparingSends = useRef(new Set<string>())
  useLayoutEffect(() => {
    activeAttachmentDraft.current = draftKey
  }, [draftKey])
  const rejectedDrafts = useDrafts((state) =>
    state.rejected.filter((item) => item.key === draftKey)
  )

  /**
   * Up-arrow prompt recall, the way every terminal taught your hands: with
   * the caret at the very start, ↑ steps back through what you asked in
   * this conversation — the open thread's turns, or the native session's —
   * and ↓ walks forward until your unfinished draft comes back. Typing
   * anything ends the walk.
   */
  const promptHistory = useRef<{
    list: string[]
    at: number
    stash: string
  } | null>(null)
  const collectPromptHistory = useCallback((): string[] => {
    const viewing = threadsStore.get().viewing
    if (viewing) {
      return viewing.entries
        .filter(
          (entry): entry is Extract<typeof entry, { kind: "user" }> =>
            entry.kind === "user"
        )
        .map((entry) => entry.text.trim())
        .filter(Boolean)
    }
    return sessionStore
      .get()
      .messages.filter((message) => message.role === "user")
      .map((message) => textOf(message.blocks).trim())
      .filter(Boolean)
  }, [])

  /** Insert the markers the attachments produced at the caret. */
  const attach = useCallback(
    async (files: AttachmentInput[]) => {
      if (files.length === 0) return
      const markers = attachments.add(files)
      if (markers && activeAttachmentDraft.current !== draftKey) {
        toast.info("Attachments were saved to the original task’s draft.")
        return
      }
      if (markers)
        window.dispatchEvent(
          new CustomEvent("mako:insert", { detail: `${markers} ` })
        )
    },
    [attachments, draftKey]
  )

  /** Drop an attachment and the marker that stands for it, from either surface. */
  const removeAttachment = (id: string) => {
    update(removeAttachmentReference(draft, attachments.items, id))
    attachments.remove(id)
    textarea.current?.focus()
  }

  // Swap in the draft belonging to whichever session just became active.
  const [lastDraftKey, setLastDraftKey] = useState(draftKey)
  if (lastDraftKey !== draftKey) {
    setLastDraftKey(draftKey)
    setMention(null)
  }

  const update = useCallback(
    (value: string) => {
      rememberDraft(draftKey, value)
    },
    [draftKey]
  )
  const draftRef = useRef(draft)
  const updateRef = useRef(update)
  useEffect(() => {
    draftRef.current = draft
    updateRef.current = update
  }, [draft, update])

  /** Re-read the token under the caret after any edit or caret move. */
  const syncMention = useCallback(() => {
    const node = textarea.current
    if (!node) return
    const caret = node.selectionStart ?? 0
    const found = mentionAt(node.value, caret)
    // `/` only opens a menu at the very start of an empty-ish draft, the way
    // slash commands work everywhere else.
    const slash = /^\/([\w-]*)$/.exec(node.value)
    if (slash) {
      setMention({
        sigil: "/",
        query: slash[1] ?? "",
        start: 0,
        end: node.value.length,
      })
      return
    }
    setMention(found)
  }, [])

  /*
   * Autogrow, measured in a layout effect so the row never flashes at the
   * wrong height between the keystroke and the paint.
   *
   * The textarea itself never scrolls — it is always exactly as tall as its
   * content, and the wrapper around it is what clips and scrolls. That is not
   * a style choice: the chips are painted on a layer *behind* a transparent
   * textarea, and if the textarea scrolled on its own the painted glyphs would
   * stay put while the real ones moved. Pasting anything over ~15 lines used to
   * tear the two layers apart completely. Both layers now live inside one
   * scroller, so they cannot drift by construction.
   */
  useLayoutEffect(() => {
    const node = textarea.current
    if (!node) return
    if (!CSS.supports("field-sizing", "content")) {
      node.style.height = "0px"
      node.style.height = `${node.scrollHeight}px`
    }

    // Keep the caret in view. After typing or pasting at the end — which is
    // nearly always — that means the bottom. Anywhere else and the browser has
    // already scrolled the wrapper to reveal it.
    const box = scroller.current
    if (box && (node.selectionStart ?? 0) >= draft.length) {
      box.scrollTop = box.scrollHeight
    }
  }, [draft])

  useEffect(() => {
    const focus = () => textarea.current?.focus()
    const setText = (event: ComposerDraftEvent) => {
      const { detail } = event
      const { body, plans } = parsePlanContext(detail.text)
      if (detail.attachments) reattach(detail.attachments)
      updateRef.current(body)
      replaceDraftPlans(activeAttachmentDraft.current, plans)
      requestAnimationFrame(() => {
        const node = textarea.current
        node?.focus()
        node?.setSelectionRange(body.length, body.length)
      })
    }
    const insert = (event: ComposerTextEvent) => {
      const { detail } = event
      const node = textarea.current
      const current = draftRef.current
      const at = node?.selectionStart ?? current.length
      const next = `${current.slice(0, at)}${detail}${current.slice(at)}`
      updateRef.current(next)
      requestAnimationFrame(() => {
        node?.focus()
        node?.setSelectionRange(at + detail.length, at + detail.length)
      })
    }
    window.addEventListener("mako:focus-composer", focus)
    window.addEventListener("mako:compose", setText)
    window.addEventListener("mako:insert", insert)
    return () => {
      window.removeEventListener("mako:focus-composer", focus)
      window.removeEventListener("mako:compose", setText)
      window.removeEventListener("mako:insert", insert)
    }
  }, [reattach])

  const submitDraft = useCallback(
    async (mode?: "steer" | "followUp") => {
      if (hostConnectionStore.get().kind === "disconnected") {
        toast.error(
          "Reconnect the Mako host before sending. Your draft is saved."
        )
        return
      }
      if (threadsStore.get().opening) {
        toast.error(
          "Wait for this conversation to load before sending. Your draft is saved."
        )
        return
      }
      const submittedDraftKey = draftKey
      const text = draft.trim()
      if (!text && attachments.items.length === 0) return

      // One composer, routed. A live agent gets the message directly; an
      // open conversation resumes through the provider that owns it; a new
      // conversation starts through that provider's richest live protocol.
      // Attachments ride as staged file paths so every local CLI reads the
      // same bytes without base64 crossing IPC.
      const activeConversation = activeAcp(acpStore.get())
      const live = activeLiveAcp(acpStore.get())
      const liveSession = live?.session
      const liveThreadPath = activeConversation?.threadPath
      const viewingRef = threadsStore.get().viewing?.ref
      const viewingOwnsComposer = Boolean(
        viewingRef && viewingRef.path !== liveThreadPath
      )
      const harness = threadsStore.get().composerHarness
      // Wait out staging — a screenshot mid-copy must not race the send
      // and leave a dead [Attachment N] marker with no file behind it —
      // then put even inline-shaped images on disk, since a CLI reads
      // files, not base64.
      const settledItems = attachments.items.some((item) => item.pending)
        ? await attachments.settled()
        : attachments.items
      if (
        settledItems.some(
          (item) => item.pending || item.error || !item.stagedPath
        )
      ) {
        toast.error(
          "Your attachments are not ready. Wait for staging or remove the failed attachment."
        )
        return
      }
      const staged = settledItems
      const attachmentPrompt = buildForeignPrompt(text, staged)
      const full = await appendThreadReferences(
        appendPlanContext(attachmentPrompt, draftPlans),
        threadsStore.get().threads
      )
      if (!full.trim()) return
      const acpAttachments = staged.map(toAcpPromptAttachment)
      const recoveryId = preserveSendingDraft({
        key: submittedDraftKey,
        text: draft,
        plans: draftPlans,
        attachments: staged,
      })
      if (!recoveryId) return
      const restorableDraft: RestorableDraft = {
        text: draft,
        plans: draftPlans,
        attachments: attachments.detach(),
      }
      clearCapturedDraft(submittedDraftKey, storedDraft, draftPlans)
      draftRef.current = draftText(submittedDraftKey)
      setMention(null)
      let ok: boolean
      try {
        if (viewingRef && (!liveSession || viewingOwnsComposer)) {
          // An archived conversation has no native session to resume — a
          // reply re-materializes it: the emitters write a fresh native
          // session (same harness or any other) from the archived history,
          // and the message goes out as its next turn.
          ok =
            harness === viewingRef.harness &&
            !viewingRef.archived &&
            !viewingRef.resumeUnavailable
              ? await threads.reply(viewingRef, full, acpAttachments)
              : await threads.moveAndSend(
                  viewingRef,
                  harness,
                  full,
                  acpAttachments
                )
        } else if (activeConversation) {
          if (harness !== activeConversation.harness) {
            if (liveSession)
              ok = await acp.handoff(harness, full, acpAttachments)
            else {
              acp.deactivate()
              ok = await acp.startFresh(
                harness,
                cwd ?? activeConversation.cwd,
                full,
                acpAttachments
              )
            }
          } else {
            if (
              mode === "steer" &&
              liveSession?.status === "running" &&
              acp.canSteer()
            ) {
              ok = await acp.steer(full, acpAttachments)
            } else {
              ok = await acp.send(full, acpAttachments)
            }
          }
        } else if (threadsStore.get().acpable.includes(harness)) {
          ok = await acp.startFresh(harness, cwd ?? "", full, acpAttachments)
        } else {
          ok = await threads.startNew(harness, full)
        }
      } catch (error) {
        interruptSendingDraft(recoveryId)
        toast.error(error instanceof Error ? error.message : String(error))
        return
      }
      if (ok) attachments.discard(restorableDraft.attachments)
      else {
        const currentDraftKey =
          activeAcp(acpStore.get())?.draftKey ??
          threadsStore.get().opening?.ref.path ??
          threadsStore.get().viewing?.ref.path ??
          projectDraftKey(sessionStore.get().meta?.cwd ?? "")
        // This callback still owns the submitted attachment bucket, even after navigation.
        const restored = restoreEmptyDraft(
          submittedDraftKey,
          restorableDraft.text,
          restorableDraft.plans
        )
        if (restored) {
          attachments.reattach(restorableDraft.attachments)
        } else {
          retainRejectedDraft(
            submittedDraftKey,
            restorableDraft.text,
            restorableDraft.attachments,
            restorableDraft.plans
          )
        }
        if (currentDraftKey === submittedDraftKey && restored) {
          draftRef.current = restorableDraft.text
        } else {
          toast.error(
            "The message was not sent. Your original draft is saved in its conversation."
          )
        }
      }
      settleSendingDraft(recoveryId)
      return
    },
    [attachments, draft, storedDraft, draftKey, draftPlans, cwd]
  )

  const submit = useCallback(async (mode?: "steer" | "followUp") => {
    if (preparingSends.current.has(draftKey)) return
    preparingSends.current.add(draftKey)
    try {
      await submitDraft(mode)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      preparingSends.current.delete(draftKey)
    }
  }, [draftKey, submitDraft])

  const pick = useCallback(
    (value: string) => {
      if (!mention) return
      if (value.startsWith("/")) {
        update("")
        setMention(null)
        void actions.runCommand(value.slice(1))
        return
      }
      if (mention.sigil === "/") return
      const next = replaceMention(draft, mention, value)
      update(next.text)
      if (value.startsWith("@thread:")) {
        prefetchThreadReferences(value, threadsStore.get().threads)
      }
      setMention(null)
      requestAnimationFrame(() => {
        const node = textarea.current
        node?.focus()
        node?.setSelectionRange(next.caret, next.caret)
      })
    },
    [draft, mention, update]
  )

  const stopCurrentTurn = useCallback(() => actions.stopCurrentTurn(), [])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    // The mention menu owns navigation keys while it is open.
    if (
      mention &&
      ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
    )
      return
    const node = textarea.current
    if (node && (event.key === "Backspace" || event.key === "Delete")) {
      const start = node.selectionStart
      const end = node.selectionEnd
      const touched = attachmentRanges(draft, attachments.items).filter(
        (range) =>
          start !== end
            ? range.start < end && range.end > start
            : event.key === "Backspace"
              ? range.start < start && range.end >= start
              : range.start <= start && range.end > start
      )
      if (touched.length)
        node.setSelectionRange(
          Math.min(start, ...touched.map((range) => range.start)),
          Math.max(end, ...touched.map((range) => range.end))
        )
    }
    if (
      event.key === "ArrowUp" &&
      node &&
      node.selectionStart === 0 &&
      node.selectionEnd === 0
    ) {
      if (!promptHistory.current) {
        const list = collectPromptHistory()
        if (list.length > 0)
          promptHistory.current = { list, at: list.length, stash: draft }
      }
      const history = promptHistory.current
      if (history && history.at > 0) {
        event.preventDefault()
        history.at -= 1
        const recalled = history.list[history.at]!
        update(recalled)
        requestAnimationFrame(() => node.setSelectionRange(0, 0))
        return
      }
    }
    if (event.key === "ArrowDown" && promptHistory.current) {
      const history = promptHistory.current
      event.preventDefault()
      history.at += 1
      if (history.at >= history.list.length) {
        update(history.stash)
        promptHistory.current = null
      } else {
        update(history.list[history.at]!)
      }
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      promptHistory.current = null
      event.preventDefault()
      void submit(event.metaKey || event.ctrlKey ? "steer" : undefined)
    }
    if (event.key === "Escape" && turnRunning) {
      event.preventDefault()
      void stopCurrentTurn()
    }
  }

  const busy = status.streaming || status.compacting
  const liveHarness = useAcp((state) => activeAcp(state)?.harness ?? null)
  const supportsSteering = useThreads((state) =>
    state.liveCapabilities.some(
      (item) => item.provider === liveHarness && item.canSteer
    )
  )
  const liveRunning = useAcp((state) => {
    const active = activeAcp(state)
    return (
      active?.kind === "starting" ||
      Boolean(
        active &&
        (active.session.status === "running" ||
          active.requests?.some(
            (request) => request.status === "dispatching"
          ) ||
          promptDelivery(active).starting)
      )
    )
  })
  const liveStarting = useAcp((state) => {
    const active = activeAcp(state)
    return (
      active?.kind === "starting" ||
      Boolean(
        active &&
        active.session.status !== "running" &&
        (active.session.status === "starting" ||
          active.requests?.some(
            (request) => request.status === "dispatching"
          ) ||
          promptDelivery(active).starting)
      )
    )
  })
  const liveWorking = useAcp(
    (state) => activeLiveAcp(state)?.session.status === "running"
  )
  const canSteer = supportsSteering && liveWorking
  const stopping = useAcp((state) => activeLiveAcp(state)?.canceling ?? false)
  const liveThreadPath = useAcp((state) => activeAcp(state)?.threadPath)
  const routedHarness = useThreads(
    (state) => state.opening?.ref.harness ?? state.viewing?.ref.harness ?? null
  )
  const routedPath = useThreads((state) => state.viewing?.ref.path)
  const liveOwnsComposer = Boolean(
    liveHarness && (!routedPath || routedPath === liveThreadPath)
  )
  const viewingRunning = useThreads((state) => state.run?.status === "running")
  const turnRunning = composerTurnRunning({
    builtinRunning: status.streaming,
    livePresent: Boolean(liveHarness),
    liveRunning,
    liveThreadPath,
    viewingPath: routedPath,
    viewingRunning,
  })
  const hasContent = Boolean(draft.trim()) || attachments.items.length > 0
  const primaryAction = composerActionKind({
    running: turnRunning && hostConnected && !opening,
    hasContent,
  })
  const viewingResumeUnavailable = useThreads(
    (state) => state.viewing?.ref.resumeUnavailable
  )
  const viewingArchived = useThreads((state) =>
    Boolean(state.viewing?.ref.archived)
  )
  const newHarness = useThreads((state) => state.composerHarness)
  const placeholder = opening
    ? `Draft a reply for ${harnessTitle(opening.ref.harness)} — ${opening.kind === "loading" ? "loading conversation…" : "conversation could not load"}`
    : liveOwnsComposer && liveHarness
      ? liveStarting
        ? `Queue a message for ${harnessTitle(liveHarness)}`
        : liveRunning
          ? `Queue a message for ${harnessTitle(liveHarness)}`
          : `Reply — ${harnessTitle(liveHarness)} answers live`
      : routedHarness
        ? newHarness !== routedHarness
          ? `Reply — moves this conversation to ${harnessTitle(newHarness)}`
          : viewingResumeUnavailable
            ? `Reply — continues in a new ${harnessTitle(routedHarness)} session`
            : viewingArchived
              ? `Reply — revives this archived conversation in ${harnessTitle(routedHarness)}`
              : viewingRunning
                ? `Queue a message for ${harnessTitle(routedHarness)}`
                : `Reply — ${harnessTitle(routedHarness)} answers`
        : `Ask ${harnessTitle(newHarness)} for a change`

  // The composer is a structural pane, not a floating card: it tiles the full
  // width of the conversation under one hairline, like every other pane, so
  // the queue, permissions and the input share one edge and the control row
  // has the room it needs.
  return (
    <div data-composer inert={!draftReady} aria-busy={!draftReady} className={cn("flex min-h-0 shrink-0 flex-col border-t border-hairline bg-surface", expanded ? "max-h-[80dvh]" : "max-h-[55dvh]")}>
      <div className="flex min-h-0 w-full flex-col">
        <Slot name="composer.above" meta={meta} />
        <PromptQueue />

        {status.compacting ? (
          <Banner text="Compacting the conversation…" />
        ) : null}
        {status.retrying ? (
          <Banner text="Retrying after a provider error…" />
        ) : null}
        {status.queued > 0 ? (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-label text-faint">
            <Chip>{status.queued} queued</Chip>
            <span>will be sent when this turn ends</span>
            <button
              type="button"
              onClick={() => void actions.clearQueue()}
              className="pressable ml-auto flex items-center gap-1 rounded px-1 hover:text-foreground"
            >
              <XIcon className="size-3" />
              Clear
            </button>
          </div>
        ) : null}

        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void attach([...(event.target.files ?? [])])
            event.target.value = ""
          }}
        />

        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            void attach([...event.dataTransfer.files])
          }}
          className={cn(
            "relative flex min-h-0 flex-col",
            dragging && "ring-1 ring-foreground/40 ring-inset"
          )}
        >
          {mention ? (
            <MentionMenu
              kind={mention.sigil}
              query={mention.query}
              onPick={pick}
              onDismiss={() => {
                setMention(null)
                textarea.current?.focus()
              }}
            />
          ) : null}

          {/*
           * The chips are painted behind a transparent textarea, glyph for
           * glyph. Keeping the real <textarea> as the input is what preserves
           * native caret, IME, undo, and spellcheck — a contenteditable would
           * trade all four for the same visual result.
           */}
          <InterruptedSends
            onRestore={(recovered) => {
              appendRecoveredDraft(draftKey, recovered)
              attachments.reattach(recovered.attachments)
              textarea.current?.focus()
            }}
          />
          {rejectedDrafts.map((rejected) => (
            <button
              key={rejected.id}
              type="button"
              className="pressable mx-2 mb-1 text-left text-ui text-caution"
              onClick={() => {
                const recovered = takeRejectedDraft(rejected.id)
                if (!recovered) return
                appendRecoveredDraft(draftKey, recovered)
                attachments.reattach(recovered.attachments)
              }}
            >
              Restore unsent message:{" "}
              {rejected.text.slice(0, 80) || "Attachments"}
            </button>
          ))}
          <PlanContextChips
            plans={draftPlans ?? []}
            onRemove={(plan) => removeDraftPlan(draftKey, plan)}
          />
          <AttachmentStrip
            items={attachments.items}
            onRemove={removeAttachment}
          />

          <div
            ref={scroller}
            className={cn("relative min-h-0 overflow-y-auto overscroll-contain", expanded ? "max-h-[60dvh]" : "max-h-[min(320px,35dvh)]")}
          >
            <ReferenceOverlay
              text={draft}
              attachments={attachments.items}
            />
            <textarea
              ref={textarea}
              value={draft}
              rows={1}
              onChange={(event) => {
                promptHistory.current = null
                const edited = editAttachmentReferences(
                  draft,
                  event.target.value,
                  attachments.items
                )
                update(edited.text)
                attachments.restoreRemoved(edited.text)
                for (const id of edited.removed) attachments.remove(id)
                if (edited.text !== event.target.value) {
                  requestAnimationFrame(() =>
                    textarea.current?.setSelectionRange(
                      edited.caret,
                      edited.caret
                    )
                  )
                }
                syncMention()
              }}
              onKeyUp={syncMention}
              onClick={syncMention}
              onBlur={() => {
                // Let a click inside the menu land before it unmounts.
                setTimeout(() => setMention(null), 120)
              }}
              onKeyDown={onKeyDown}
              onPaste={(event) => {
                const files = [...event.clipboardData.files]
                if (files.length === 0) return
                event.preventDefault()
                void attach(files)
              }}
              readOnly={!draftReady}
              placeholder={draftReady ? placeholder : "Opening workspace…"}
              spellCheck={false}
              className={cn(
                // No max-height and no scrolling of its own — the wrapper owns
                // both, so the painted layer behind it stays in register.
                "composer-input relative block min-h-20 w-full resize-none overflow-hidden bg-transparent px-4 pt-4 pb-2",
                "font-sans text-ui leading-[1.55] placeholder:text-faint focus:outline-none",
                // Transparent glyphs let the overlay show through; the caret
                // and selection stay native and visible.
                "text-transparent caret-ember selection:bg-fill-selected selection:text-transparent"
              )}
            />
          </div>

          <div className="flex min-h-11 shrink-0 items-center gap-1 px-3 pb-3">
            <IconAction
              label="Reference a file"
              keys={["@"]}
              side="top"
              size="xs"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("mako:insert", { detail: "@" })
                )
                requestAnimationFrame(syncMention)
              }}
            >
              <AtSignIcon />
            </IconAction>
            <IconAction
              label="Attach a file"
              side="top"
              size="xs"
              onClick={() => filePicker.current?.click()}
            >
              <PaperclipIcon />
            </IconAction>
            <Slot
              name="composer.controls"
              meta={meta}
              disabled={busy}
              attachFiles={attach}
            />
            <div className="mx-1 h-4 w-px shrink-0 bg-hairline" />
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&>*]:shrink-0 [&::-webkit-scrollbar]:hidden">
              <ComposerRouting />
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Slot
                name="composer.trailing"
                meta={meta}
                disabled={busy}
                attachFiles={attach}
              />
              <IconAction label={expanded ? "Collapse draft" : "Expand draft"} size="xs" side="top" onClick={() => { setExpanded((value) => !value); textarea.current?.focus({ preventScroll: true }) }}>
                {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
              </IconAction>
              <ContextDial />
              {liveOwnsComposer && liveRunning && canSteer ? (
                <button
                  type="button"
                  className="pressable rounded px-2 py-1 text-label text-muted-foreground hover:bg-fill-hover disabled:opacity-40"
                  disabled={!hasContent || !hostConnected || Boolean(opening)}
                  onClick={() => void submit("steer")}
                  title="Send this message to the active turn"
                >
                  Steer
                </button>
              ) : null}
              <ComposerActionButton
                action={primaryAction}
                ready={hasContent && !opening && hostConnected}
                stopping={liveOwnsComposer && stopping}
                onSend={() => void submit()}
                onStop={() => void stopCurrentTurn()}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
