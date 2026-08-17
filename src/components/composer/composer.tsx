import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ModelPicker } from "@/components/composer/model-picker"
import { EffortPicker } from "@/components/composer/effort-picker"
import { MentionMenu, type MentionKind } from "@/components/composer/mention-menu"
import { AttachmentStrip } from "@/components/composer/attachments"
import { buildPrompt, useAttachments } from "@/lib/attachments"
import { ReferenceOverlay } from "@/components/composer/reference-overlay"
import { Chip, IconAction, Keys } from "@/components/ui/kit"
import { Slot } from "@/extend/slot"
import { formatChord } from "@/extend/commands"
import { mentionAt, replaceMention, type ActiveMention } from "@/lib/mentions"
import { actions, shallowEqual, useSession } from "@/state/session"
import { cn } from "@/lib/utils"
import {
  ArrowUpIcon,
  AtSignIcon,
  CornerDownLeftIcon,
  PaperclipIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"

/** Drafts survive session switches within a run; nobody should lose a paragraph. */
const drafts = new Map<string, string>()

const MAX_HEIGHT = 320

export function Composer() {
  const sessionId = useSession((state) => state.meta?.sessionId)
  const status = useSession(
    useCallback(
      (state) => ({
        streaming: state.meta?.isStreaming ?? false,
        compacting: state.meta?.isCompacting ?? false,
        retrying: state.meta?.isRetrying ?? false,
        queued:
          (state.meta?.queued.steering.length ?? 0) + (state.meta?.queued.followUp.length ?? 0),
      }),
      []
    ),
    shallowEqual
  )
  const meta = useSession((state) => state.meta)

  const [draft, setDraft] = useState("")
  const [focused, setFocused] = useState(false)
  const [mention, setMention] = useState<ActiveMention | null>(null)
  const [dragging, setDragging] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const attachments = useAttachments()

  /** Insert the markers the attachments produced at the caret. */
  const attach = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const markers = await attachments.add(files)
      if (markers) window.dispatchEvent(new CustomEvent("pi:insert", { detail: `${markers} ` }))
    },
    [attachments]
  )

  // Swap in the draft belonging to whichever session just became active.
  const [lastSession, setLastSession] = useState(sessionId)
  if (lastSession !== sessionId) {
    setLastSession(sessionId)
    setDraft(sessionId ? (drafts.get(sessionId) ?? "") : "")
    setMention(null)
  }

  const update = useCallback(
    (value: string) => {
      setDraft(value)
      if (sessionId) drafts.set(sessionId, value)
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
      setMention({ sigil: "/" as never, query: slash[1], start: 0, end: node.value.length })
      return
    }
    setMention(found)
  }, [])

  // Autogrow, measured in a layout effect so the row never flashes at the
  // wrong height between the keystroke and the paint.
  useLayoutEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = "0px"
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`
    node.style.overflowY = node.scrollHeight > MAX_HEIGHT ? "auto" : "hidden"
  }, [draft])

  useEffect(() => {
    const focus = () => textarea.current?.focus()
    const setText = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail
      update(detail)
      requestAnimationFrame(() => {
        const node = textarea.current
        node?.focus()
        node?.setSelectionRange(detail.length, detail.length)
      })
    }
    const insert = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail
      const node = textarea.current
      const at = node?.selectionStart ?? draft.length
      const next = `${draft.slice(0, at)}${detail}${draft.slice(at)}`
      update(next)
      requestAnimationFrame(() => {
        node?.focus()
        node?.setSelectionRange(at + detail.length, at + detail.length)
      })
    }
    window.addEventListener("pi:focus-composer", focus)
    window.addEventListener("pi:compose", setText)
    window.addEventListener("pi:insert", insert)
    return () => {
      window.removeEventListener("pi:focus-composer", focus)
      window.removeEventListener("pi:compose", setText)
      window.removeEventListener("pi:insert", insert)
    }
  }, [draft, update])

  const submit = useCallback(
    async (mode?: "steer" | "followUp") => {
      const text = draft.trim()
      if (!text && attachments.items.length === 0) return
      const built = buildPrompt(draft, attachments.items)
      update("")
      setMention(null)
      attachments.clear()
      await actions.send(built.text, mode, built.images)
    },
    [attachments, draft, update]
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
      const next = replaceMention(draft, mention, value)
      update(next.text)
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
    if (mention && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void submit(event.metaKey || event.ctrlKey ? "followUp" : undefined)
    }
    if (event.key === "Escape" && status.streaming) {
      event.preventDefault()
      void actions.abort()
    }
  }

  const busy = status.streaming || status.compacting

  return (
    <div className="shrink-0 px-6 pt-1 pb-4">
      <div className="mx-auto w-full max-w-[760px]">
        <Slot name="composer.above" meta={meta} />

        {status.compacting ? <Banner text="Compacting the conversation…" /> : null}
        {status.retrying ? <Banner text="Retrying after a provider error…" /> : null}
        {status.queued > 0 ? (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] text-faint">
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
            "surface-glass lit-edge relative rounded-xl bg-surface ring-1 transition-[box-shadow] duration-150",
            dragging ? "ring-foreground/40" : focused ? "ring-border" : "ring-hairline"
          )}
        >
          {mention ? (
            <MentionMenu
              kind={mention.sigil as MentionKind}
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
          <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />

          <div className="relative">
            <ReferenceOverlay text={draft} />
            <textarea
              ref={textarea}
              value={draft}
              rows={1}
              onChange={(event) => {
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
              placeholder={
                status.streaming ? "Steer the current turn…" : "Ask Pi to change something"
              }
              spellCheck={false}
              className={cn(
                "relative block max-h-[320px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1",
                "font-sans text-[13.5px] leading-[1.55] placeholder:text-faint focus:outline-none",
                // Transparent glyphs let the overlay show through; the caret
                // and selection stay native and visible.
                "text-transparent caret-foreground selection:bg-brand-soft selection:text-transparent"
              )}
            />
          </div>

          <div className="mt-0.5 flex items-center gap-1 border-t border-hairline/60 px-1.5 py-1.5">
            <ModelPicker />
            <EffortPicker />
            <IconAction
              label="Reference a file"
              keys={["@"]}
              side="top"
              size="xs"
              onClick={() => {
                window.dispatchEvent(new CustomEvent("pi:insert", { detail: "@" }))
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
         * One quiet line, and only while the composer is empty. A permanent
         * row of key chips reads as clutter the moment you have learned them,
         * which is after the first session.
         */}
        <div
          className={cn(
            "mt-1.5 flex h-4 items-center px-1 text-[10.5px] text-faint",
            "transition-opacity duration-200",
            draft || focused ? "opacity-0" : "opacity-100"
          )}
        >
          <span>
            <span className="font-mono text-faint/80">@</span> files ·{" "}
            <span className="font-mono text-faint/80">$</span> skills ·{" "}
            <span className="font-mono text-faint/80">/</span> commands
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Keys keys={formatChord(status.streaming ? "mod+enter" : "mod+k")} />
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
function SendButton({
  ready,
  steering,
  onSend,
}: {
  ready: boolean
  steering: boolean
  onSend: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSend}
      disabled={!ready}
      aria-label={steering ? "Steer the current turn" : "Send"}
      title={steering ? "Steer the current turn" : "Send"}
      className={cn(
        "pressable relative flex size-7 shrink-0 items-center justify-center rounded-full",
        "[transition:transform_var(--duration-press)_var(--ease-out),background-color_160ms_ease,opacity_160ms_ease,box-shadow_160ms_ease]",
        ready
          ? "action-primary text-background"
          : "bg-foreground/10 text-faint shadow-none"
      )}
    >
      {steering ? (
        <CornerDownLeftIcon className="size-3.5" />
      ) : (
        <ArrowUpIcon className="size-4" strokeWidth={2.4} />
      )}
    </button>
  )
}

function Banner({ text }: { text: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-md bg-raised px-2 py-1 text-[11.5px] text-muted-foreground">
      <span className="size-1 animate-live rounded-full bg-current" />
      {text}
    </div>
  )
}
