import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Action, IconAction, Keys } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { getMako } from "@/lib/bridge"
import { actions, useSession } from "@/state/session"
import { prefsStore, usePrefs } from "@/state/prefs"
import { cn } from "@/lib/utils"
import { SparklesIcon, UploadIcon } from "lucide-react"
import { toast } from "sonner"

/**
 * The commit box.
 *
 * Modelled on Zed's: a message field with a draft button beside it and commit
 * on ⌘↩. The draft goes through the session's own model against the staged
 * patch (or the working tree when nothing is staged), which is the same rule
 * Zed follows and the one that matches what the commit will actually contain.
 */
export function CommitBox({ staged, total }: { staged: number; total: number }) {
  const [message, setMessage] = useState("")
  const [drafting, setDrafting] = useState(false)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const draftKeys = usePrefs(
    (prefs) => prefs.keybindings["workspace.generate-commit"] ?? "mod+shift+g"
  )

  const ahead = useSession((state) => state.git?.ahead ?? 0)
  const branch = useSession((state) => state.git?.branch)
  const hasUpstream = useSession((state) => Boolean(state.git?.upstream))

  useLayoutEffect(() => {
    const node = field.current
    if (!node) return
    node.style.height = "0px"
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`
  }, [message])

  const draft = useCallback(async function draftCommitMessage() {
    if (drafting) return
    setDrafting(true)
    try {
      const next = await getMako().generateCommitMessage(prefsStore.get().commitPrompt)
      setMessage(next)
      requestAnimationFrame(() => field.current?.focus())
    } catch (error) {
      toast.error("Commit message was not generated", {
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Retry", onClick: () => void draftCommitMessage() },
      })
    } finally {
      setDrafting(false)
    }
  }, [drafting])

  const commit = useCallback(async function commitChanges() {
    if (!message.trim() || busy) return
    setBusy(true)
    try {
      await getMako().gitCommit(message.trim())
      setMessage("")
      await actions.refreshGit()
    } catch (error) {
      toast.error("Changes were not committed", {
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Retry", onClick: () => void commitChanges() },
      })
    } finally {
      setBusy(false)
    }
  }, [busy, message])

  // ⌘↩ commits while the message field has focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod) return
      if (event.key === "Enter" && field.current === document.activeElement) {
        event.preventDefault()
        void commit()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [commit])

  useEffect(() => {
    const draftFromCommand = () => void draft()
    window.addEventListener("mako:draft-commit", draftFromCommand)
    return () => window.removeEventListener("mako:draft-commit", draftFromCommand)
  }, [draft])

  const subject = message.split("\n")[0] ?? ""
  const overLong = subject.length > 50

  return (
    <div className="shrink-0 border-t border-hairline p-2">
      <div className="relative rounded-lg bg-raised ring-1 ring-hairline focus-within:ring-border">
        <textarea
          ref={field}
          rows={1}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={
            total === 0
              ? "Nothing to commit"
              : staged > 0
                ? `Message for ${staged} staged file${staged === 1 ? "" : "s"}`
                : `Message for all ${total} change${total === 1 ? "" : "s"}`
          }
          disabled={total === 0}
          spellCheck={false}
          className="block max-h-40 w-full resize-none bg-transparent px-2.5 pt-2 pb-1 text-[12.5px] leading-[1.5] placeholder:text-faint focus:outline-none disabled:opacity-50"
        />

        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <IconAction
            label="Draft a message from the diff"
            keys={formatChord(draftKeys)}
            side="top"
            size="xs"
            disabled={total === 0 || drafting}
            onClick={() => void draft()}
          >
            <SparklesIcon className={cn(drafting && "animate-live")} />
          </IconAction>

          {/* The subject-length hint appears only once it matters. */}
          {overLong ? (
            <span className="tabular text-[10px] text-caution">{subject.length}/50</span>
          ) : null}

          <div className="ml-auto flex items-center gap-1">
            {ahead > 0 ? (
              <Action
                tone="ghost"
                size="xs"
                title={
                  hasUpstream
                    ? `Push ${ahead} commit${ahead === 1 ? "" : "s"}`
                    : `Publish ${branch} to origin`
                }
                onClick={() => void guardedPush()}
              >
                <UploadIcon />
                {hasUpstream ? `Push ${ahead}` : "Publish"}
              </Action>
            ) : null}
            <Action
              tone={message.trim() ? "solid" : "ghost"}
              size="xs"
              disabled={!message.trim() || busy || total === 0}
              onClick={() => void commit()}
              className="gap-1.5"
            >
              Commit
              <Keys keys={formatChord("mod+enter")} />
            </Action>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Pushing publishes work outside the machine, so it stays a deliberate,
 * separately-labelled action and never rides along with a commit.
 */
async function guardedPush() {
  try {
    await getMako().gitPush()
    await actions.refreshGit()
  } catch (error) {
    toast.error("Branch was not pushed", {
      description: error instanceof Error ? error.message : String(error),
      action: { label: "Retry", onClick: () => void guardedPush() },
    })
  }
}
