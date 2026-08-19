import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { AgentPicker } from "@/components/composer/agent-picker"
import { ForeignEffortPicker } from "@/components/composer/foreign-effort"
import { ForeignModelPicker } from "@/components/composer/foreign-model"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { MentionMenu } from "@/components/composer/mention-menu"
import { AttachmentStrip } from "@/components/composer/attachments"
import {
  buildForeignPrompt,
  useAttachments,
  type Attachment,
} from "@/lib/attachments"
import { ReferenceOverlay } from "@/components/composer/reference-overlay"
import { Chip, IconAction, Keys } from "@/components/ui/kit"
import { Slot } from "@/extend/slot"
import { formatChord } from "@/extend/commands"
import { mentionAt, replaceMention, type ActiveMention } from "@/lib/mentions"
import { textOf } from "@/lib/format"
import {
  appendThreadReferences,
  prefetchThreadReferences,
} from "@/lib/thread-references"
import {
  actions,
  shallowEqual,
  store as sessionStore,
  useSession,
} from "@/state/session"
import { threads, threadsStore, useThreads } from "@/state/threads"
import { acp, acpStore, useAcp } from "@/state/acp"
import { getMako } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import type { AcpPromptAttachment, Harness } from "@/lib/types"
import {
  ArrowUpIcon,
  AtSignIcon,
  CornerDownLeftIcon,
  GitBranchIcon,
  PaperclipIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"

interface StoredDraft {
  text: string
}

interface CommandMention {
  sigil: "/"
  query: string
  start: number
  end: number
}

type ComposerMention = ActiveMention | CommandMention

type ComposerTextEvent = CustomEvent<string>

interface RestorableDraft {
  text: string
  attachments: Attachment[]
}

interface SendButtonProps {
  ready: boolean
  steering: boolean
  onSend: () => void
}

interface BannerProps {
  text: string
}

declare global {
  interface WindowEventMap {
    "mako:compose": ComposerTextEvent
    "mako:insert": ComposerTextEvent
  }
}

function toAcpPromptAttachment(item: Attachment): AcpPromptAttachment {
  return {
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    data: item.kind === "image" ? item.data : undefined,
    path: item.stagedPath,
  }
}

const isMac = navigator.platform.startsWith("Mac")

/** Drafts survive session switches within a run; nobody should lose a paragraph. */
const drafts = new Map<string, StoredDraft>()

export function Composer() {
  const sessionId = useSession((state) => state.meta?.sessionId)
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

  const [draft, setDraft] = useState("")
  const [focused, setFocused] = useState(false)
  const [mention, setMention] = useState<ComposerMention | null>(null)
  const [dragging, setDragging] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const attachments = useAttachments()

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
    async (files: File[]) => {
      if (files.length === 0) return
      const markers = await attachments.add(files)
      if (markers)
        window.dispatchEvent(
          new CustomEvent("mako:insert", { detail: `${markers} ` })
        )
    },
    [attachments]
  )

  // Swap in the draft belonging to whichever session just became active.
  const [lastSession, setLastSession] = useState(sessionId)
  if (lastSession !== sessionId) {
    setLastSession(sessionId)
    setDraft(sessionId ? (drafts.get(sessionId)?.text ?? "") : "")
    setMention(null)
  }

  const update = useCallback(
    (value: string) => {
      setDraft(value)
      if (sessionId) drafts.set(sessionId, { text: value })
    },
    [sessionId]
  )

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
    node.style.height = "0px"
    node.style.height = `${node.scrollHeight}px`

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
    const setText = (event: ComposerTextEvent) => {
      const { detail } = event
      update(detail)
      requestAnimationFrame(() => {
        const node = textarea.current
        node?.focus()
        node?.setSelectionRange(detail.length, detail.length)
      })
    }
    const insert = (event: ComposerTextEvent) => {
      const { detail } = event
      const node = textarea.current
      const at = node?.selectionStart ?? draft.length
      const next = `${draft.slice(0, at)}${detail}${draft.slice(at)}`
      update(next)
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
  }, [draft, update])

  const submit = useCallback(
    async (mode?: "steer" | "followUp") => {
      const text = draft.trim()
      if (!text && attachments.items.length === 0) return

      // One composer, routed. A live agent gets the message directly; an
      // open conversation resumes through the provider that owns it; a new
      // conversation starts through that provider's richest live protocol.
      // Attachments ride as staged file paths so every local CLI reads the
      // same bytes without base64 crossing IPC.
      const liveSession = acpStore.get().session
      const viewingRef = threadsStore.get().viewing?.ref
      const harness = threadsStore.get().composerHarness
      // Wait out staging — a screenshot mid-copy must not race the send
      // and leave a dead [Attachment N] marker with no file behind it —
      // then put even inline-shaped images on disk, since a CLI reads
      // files, not base64.
      const settledItems = attachments.items.some((item) => item.pending)
        ? await attachments.settled()
        : attachments.items
      const staged = await Promise.all(
        settledItems.map(async (item) => {
          if (item.stagedPath || item.kind !== "image" || !item.data)
            return item
          try {
            const file = await getMako().stageFile(item.name, item.data)
            return { ...item, stagedPath: file.path }
          } catch {
            return item
          }
        })
      )
      const attachmentPrompt = buildForeignPrompt(text, staged)
      const full = await appendThreadReferences(
        attachmentPrompt,
        threadsStore.get().threads,
        {
          // Only Devin Cloud cannot open this machine's transcript paths.
          // Local Devin ACP reads the content-addressed bundle like every other
          // local provider and keeps the larger, sidecar-preserving context.
          inline:
            viewingRef?.path.startsWith("devin://") ||
            (harness === "devin" &&
              !threadsStore.get().acpable.includes("devin")),
        }
      )
      if (!full.trim()) return
      const acpAttachments = staged.map(toAcpPromptAttachment)
      const restorableDraft: RestorableDraft = {
        text: draft,
        attachments: attachments.detach(),
      }
      update("")
      setMention(null)
      let ok: boolean
      if (liveSession) {
        // Mod+Enter while the agent runs: stop the turn, then send — the
        // live protocol's own interrupt. Plain Enter queues agent-side.
        if (mode && liveSession.status === "running") acp.cancel()
        await acp.send(full, acpAttachments)
        ok = true
      } else if (viewingRef) {
        // An archived conversation has no native session to resume — a
        // reply re-materializes it: the emitters write a fresh native
        // session (same harness or any other) from the archived history,
        // and the message goes out as its next turn.
        ok =
          harness === viewingRef.harness && !viewingRef.archived
            ? mode
              ? await threads.interruptAndSend(viewingRef, full)
              : await threads.reply(viewingRef, full)
            : await threads.moveAndSend(viewingRef, harness, full)
      } else if (threadsStore.get().acpable.includes(harness)) {
        ok = await acp.startFresh(
          harness,
          meta?.cwd ?? "",
          full,
          acpAttachments
        )
      } else {
        ok = await threads.startNew(harness, full)
      }
      if (ok) attachments.discard(restorableDraft.attachments)
      else {
        update(restorableDraft.text)
        attachments.reattach(restorableDraft.attachments)
      }
      return
    },
    [attachments, draft, meta?.cwd, update]
  )

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

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // The mention menu owns navigation keys while it is open.
    if (
      mention &&
      ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
    )
      return
    const node = textarea.current
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
      void submit(event.metaKey || event.ctrlKey ? "followUp" : undefined)
    }
    if (event.key === "Escape" && status.streaming) {
      event.preventDefault()
      void actions.abort()
    }
  }

  const busy = status.streaming || status.compacting
  const liveHarness = useAcp((state) => state.session?.harness ?? null)
  const liveRunning = useAcp((state) => state.session?.status === "running")
  const routedHarness = useThreads(
    (state) => state.viewing?.ref.harness ?? null
  )
  const viewingRunning = useThreads((state) => state.run?.status === "running")
  const viewingArchived = useThreads((state) =>
    Boolean(state.viewing?.ref.archived)
  )
  const newHarness = useThreads((state) => state.composerHarness)
  const placeholder = liveHarness
    ? liveRunning
      ? `${harnessTitle(liveHarness)} is working — Enter queues your message`
      : `Reply — ${harnessTitle(liveHarness)} answers live`
    : routedHarness
      ? newHarness !== routedHarness
        ? `Reply — moves this conversation to ${harnessTitle(newHarness)}`
        : viewingArchived
          ? `Reply — revives this archived conversation in ${harnessTitle(routedHarness)}`
          : viewingRunning
            ? `${harnessTitle(routedHarness)} is working — Enter queues, ${isMac ? "⌘" : "Ctrl+"}Enter interrupts`
            : `Reply — ${harnessTitle(routedHarness)} answers`
      : `Ask ${harnessTitle(newHarness)} for a change`

  return (
    <div className="shrink-0 px-6 pt-1 pb-4">
      <div className="mx-auto w-full max-w-content">
        <Slot name="composer.above" meta={meta} />

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
            "relative rounded-2xl bg-popover shadow-[var(--elevation-card)] ring-1 transition-[box-shadow] duration-150",
            dragging
              ? "ring-foreground/40"
              : focused
                ? "ring-border"
                : "ring-hairline"
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
          <AttachmentStrip
            items={attachments.items}
            onRemove={attachments.remove}
          />

          <div
            ref={scroller}
            className="relative max-h-[320px] overflow-y-auto overscroll-contain"
          >
            <ReferenceOverlay text={draft} />
            <textarea
              ref={textarea}
              value={draft}
              rows={1}
              onChange={(event) => {
                promptHistory.current = null
                update(event.target.value)
                syncMention()
              }}
              onKeyUp={syncMention}
              onClick={syncMention}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false)
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
              placeholder={placeholder}
              spellCheck={false}
              className={cn(
                // No max-height and no scrolling of its own — the wrapper owns
                // both, so the painted layer behind it stays in register.
                "relative block min-h-[84px] w-full resize-none overflow-hidden bg-transparent px-3 pt-2.5 pb-1",
                "font-sans text-ui leading-[1.55] placeholder:text-faint focus:outline-none",
                // Transparent glyphs let the overlay show through; the caret
                // and selection stay native and visible.
                "text-transparent caret-ember selection:bg-fill-selected selection:text-transparent"
              )}
            />
          </div>

          <div className="flex items-center gap-1 px-1.5 pb-1.5">
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
            <Slot name="composer.controls" meta={meta} disabled={busy} />

            <div className="ml-auto flex items-center gap-1">
              <Slot name="composer.trailing" meta={meta} disabled={busy} />
              {status.streaming ? (
                <IconAction
                  label="Stop"
                  keys={["Esc"]}
                  side="top"
                  tone="danger"
                  onClick={() => void actions.abort()}
                >
                  <SquareIcon />
                </IconAction>
              ) : null}
              <SendButton
                ready={Boolean(draft.trim()) || attachments.items.length > 0}
                steering={status.streaming}
                onSend={() => void submit()}
              />
            </div>
          </div>
        </div>

        {/*
         * The context line, below the field the way Cursor keeps its branch
         * and machine: who answers, on what model, at what effort — read
         * without opening anything, changed without leaving the keyboard's
         * neighborhood. The key hints share the line and yield while typing.
         */}
        <div className="mt-1.5 flex min-h-7 items-center gap-1 px-1">
          <ComposerRouting />
          <BranchChip />
          <span
            className={cn(
              "ml-auto flex items-center gap-1 text-label text-faint",
              "transition-opacity duration-200",
              draft || focused ? "opacity-0" : "opacity-100"
            )}
          >
            <Keys
              keys={formatChord(status.streaming ? "mod+enter" : "mod+k")}
            />
            {status.streaming ? "queue" : "commands"}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * The primary action.
 *
 * Circular and lit rather than a flat pill: it is the only control in the
 * window that should look pressable from across the room, and a flat fill at
 * this size reads as a disabled placeholder. Inert until there is something to
 * send, so the composer never invites a no-op.
 */
function SendButton({ ready, steering, onSend }: SendButtonProps) {
  return (
    <button
      type="button"
      onClick={onSend}
      disabled={!ready}
      aria-label={steering ? "Steer the current turn" : "Send"}
      title={steering ? "Steer the current turn" : "Send"}
      className={cn(
        "pressable relative flex size-6 shrink-0 items-center justify-center rounded-full",
        "[transition:transform_var(--duration-press)_var(--ease-out),background-color_160ms_ease,opacity_160ms_ease]",
        ready
          ? "bg-foreground text-background hover:opacity-90"
          : "bg-foreground/10 text-faint"
      )}
    >
      {steering ? (
        <CornerDownLeftIcon className="size-3" />
      ) : (
        <ArrowUpIcon className="size-3.5" strokeWidth={2.2} />
      )}
    </button>
  )
}

/** The branch under the field, the way Cursor keeps its own. Quiet fact,
 * not a control — knowing where an agent is about to write is half of
 * trusting it. */
function BranchChip() {
  const branch = useSession((state) => state.git?.branch)
  if (!branch) return null
  return (
    <span className="flex h-7 max-w-[11rem] items-center gap-1 px-1.5 text-label text-faint">
      <GitBranchIcon className="size-3 shrink-0" />
      <span className="truncate">{branch}</span>
    </span>
  )
}

function Banner({ text }: BannerProps) {
  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-md bg-raised px-2 py-1 text-ui text-muted-foreground">
      <span className="animate-live size-1 rounded-full bg-current" />
      {text}
    </div>
  )
}

function harnessTitle(harness: Harness): string {
  switch (harness) {
    case "claude":
      return "Claude Code"
    case "codex":
      return "Codex"
    case "cursor":
      return "Cursor"
    case "grok":
      return "Grok"
    case "devin":
      return "Devin"
    default:
      return harness
  }
}

/**
 * The left half of the toolbar, routed like the box above it.
 *
 * An open foreign conversation locks the composer to its harness — the mark
 * and name say so, and the run's state rides beside them. Otherwise the
 * provider picker chooses who answers next; model options come directly
 * from that provider's runtime catalog.
 */
function ComposerRouting() {
  const viewing = useThreads((state) => state.viewing?.ref)
  const run = useThreads((state) => state.run)
  const viewingQueued = useThreads((state) =>
    state.viewing
      ? (state.queuedReplies[state.viewing.ref.path]?.prompts.length ?? 0)
      : 0
  )
  const harness = useThreads((state) => state.composerHarness)
  const live = useAcp((state) => state.session)
  const queued = useAcp((state) => state.queued)

  if (live) {
    return (
      <span className="flex h-7 items-center gap-1.5 rounded-md bg-raised px-2 text-ui text-foreground/85">
        <HarnessIcon harness={live.harness} className="size-3.5" />
        {harnessTitle(live.harness)}
        <span className="text-label text-ember/80">live</span>
        {live.status === "running" ? (
          <button
            type="button"
            onClick={() => acp.cancel()}
            title="Stops this turn only — the session stays live"
            className="pressable ml-1 rounded px-1 text-label text-faint hover:text-foreground"
          >
            stop turn
          </button>
        ) : null}
        {queued ? (
          <span className="text-label text-faint">1 queued</span>
        ) : null}
      </span>
    )
  }

  const moving = viewing && harness !== viewing.harness
  return (
    <>
      <AgentPicker />
      <ForeignModelPicker harness={harness} />
      <ForeignEffortPicker harness={harness} />
      {viewing && run?.status === "running" ? (
        <button
          type="button"
          onClick={() => void threads.abortReply(viewing)}
          className="pressable flex h-7 items-center gap-1.5 rounded-md bg-raised px-2 text-label text-faint hover:text-foreground"
        >
          <span className="size-1.5 animate-live rounded-full bg-ember" />
          working — stop
        </button>
      ) : null}
      {viewingQueued > 0 ? (
        <span className="flex h-7 items-center rounded-md bg-raised px-2 text-label text-faint">
          {viewingQueued} queued
        </span>
      ) : null}
      {moving ? (
        <span className="animate-enter flex h-7 items-center gap-1 rounded-md bg-fill-selected px-2 text-label font-medium text-foreground">
          moves here on send
        </span>
      ) : null}
    </>
  )
}
