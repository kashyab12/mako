import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { Action, IconAction, Keys } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { git } from "@/state/git"
import { actions, useSession } from "@/state/session"
import { usePrefs } from "@/state/prefs"
import { commitDrafts, useCommitDraft } from "@/state/commit-drafts"
import { Settings2Icon, SparklesIcon, UploadIcon } from "lucide-react"
import { toast } from "sonner"

/**
 * The commit box.
 *
 * Modelled on Zed's: a message field with a draft button beside it and commit
 * on ⌘↩. The draft goes through the session's own model against the staged
 * patch (or the working tree when nothing is staged), which is the same rule
 * Zed follows and the one that matches what the commit will actually contain.
 */
export function CommitBox({
  staged,
  total,
}: {
  staged: number
  total: number
}) {
  const cwd = useSession((state) => state.git?.cwd ?? state.meta?.cwd ?? "")
  const draftState = useCommitDraft(cwd)
  const message = draftState.text
  const drafting = draftState.requestId !== null
  const model = usePrefs((prefs) => prefs.commitModel)
  const hasModel = Boolean(model && model !== "current" && model !== "auto")
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

  const draft = useCallback(
    async function draftCommitMessage() {
      if (drafting || busy || !cwd || !total) return
      if (!hasModel) {
        window.dispatchEvent(
          new CustomEvent("mako:settings", { detail: "commits" })
        )
        return
      }
      await commitDrafts.generate(cwd)
    },
    [drafting, busy, cwd, total, hasModel]
  )

  const commit = useCallback(
    async function commitChanges() {
      if (!message.trim() || busy || drafting) return
      setBusy(true)
      try {
        await git.commit(message.trim())
        commitDrafts.committed(cwd, draftState.revision)
        await actions.refreshGit()
      } catch (error) {
        toast.error("Changes were not committed", {
          duration: Infinity,
          description: error instanceof Error ? error.message : String(error),
          action: { label: "Retry", onClick: () => void commitChanges() },
        })
      } finally {
        setBusy(false)
      }
    },
    [busy, message, drafting, cwd, draftState.revision]
  )

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

  const subject = message.split("\n")[0] ?? ""
  const overLong = subject.length > 50

  return (
    <div data-commit-box className="shrink-0 border-t border-hairline p-2.5">
      {draftState.error ? (
        <div role="alert" className="mb-2 px-1 text-label text-negative">
          <p>{draftState.error}</p>
          <Action size="xs" onClick={() => void draft()}>
            Retry
          </Action>
          <Action
            size="xs"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("mako:settings", { detail: "commits" })
              )
            }
          >
            Model settings
          </Action>
        </div>
      ) : null}
      {draftState.suggestion ? (
        <div className="mb-2 rounded-md border border-hairline p-2">
          <p className="mb-2 text-label text-faint">
            Your message was kept. Review the generated draft before replacing
            it.
          </p>
          <pre className="max-h-36 overflow-auto font-sans text-ui whitespace-pre-wrap">
            {draftState.suggestion.message}
          </pre>
          <div className="mt-2 flex gap-2">
            <Action
              size="xs"
              tone="outline"
              onClick={() => commitDrafts.accept(cwd)}
            >
              Use generated draft
            </Action>
            <Action size="xs" onClick={() => commitDrafts.dismiss(cwd)}>
              Keep mine
            </Action>
          </div>
        </div>
      ) : null}
      {(draftState.suggestion ?? draftState.result)?.warnings.length ? (
        <details className="mb-2 px-1 text-label text-caution">
          <summary className="pressable cursor-pointer">
            Some file content was omitted
          </summary>
          <ul className="mt-1 max-h-24 overflow-y-auto">
            {(draftState.suggestion ?? draftState.result)?.warnings.map(
              (warning) => (
                <li key={warning}>{warning}</li>
              )
            )}
          </ul>
        </details>
      ) : null}
      <div className="relative rounded-lg bg-raised ring-1 ring-hairline focus-within:ring-border">
        <textarea
          aria-label="Commit message"
          ref={field}
          rows={1}
          value={message}
          onChange={(event) => commitDrafts.edit(cwd, event.target.value)}
          placeholder={
            total === 0
              ? "Nothing to commit"
              : staged > 0
                ? `Message for ${staged} staged file${staged === 1 ? "" : "s"}`
                : `Message for all ${total} change${total === 1 ? "" : "s"}`
          }
          disabled={total === 0}
          spellCheck={false}
          className="block max-h-40 min-h-11 w-full resize-none bg-transparent px-3 pt-2.5 pb-2 text-ui leading-5 placeholder:text-faint focus:outline-none disabled:opacity-50"
        />

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1">
            {drafting ? (
              <>
                <Action size="xs" onClick={() => void commitDrafts.cancel(cwd)}>
                  Cancel
                </Action>
                <span role="status" className="text-label text-faint">
                  Drafting...
                </span>
              </>
            ) : hasModel ? (
              <>
                <Action
                  size="xs"
                  aria-label="Draft a message from the diff"
                  title={`Generate with ${model} · ${formatChord(draftKeys).join(" ")}`}
                  disabled={total === 0 || busy}
                  onClick={() => void draft()}
                >
                  <SparklesIcon />
                  Generate
                </Action>
                <IconAction
                  label={`Drafting model: ${model}. Open model settings`}
                  size="xs"
                  side="top"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("mako:settings", { detail: "commits" })
                    )
                  }
                >
                  <Settings2Icon />
                </IconAction>
              </>
            ) : (
              <Action
                size="xs"
                aria-label="Connect commit model"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("mako:settings", { detail: "commits" })
                  )
                }
              >
                <SparklesIcon />
                Connect model
              </Action>
            )}
          </div>

          {/* The subject-length hint appears only once it matters. */}
          {overLong ? (
            <span className="tabular text-label text-caution">
              {subject.length}/50 characters
            </span>
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
              disabled={!message.trim() || busy || drafting || total === 0}
              onClick={() => void commit()}
              className="gap-1.5"
            >
              {staged === 0 && total > 0 ? "Commit all" : "Commit"}
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
    await git.push()
    await actions.refreshGit()
  } catch (error) {
    toast.error("Branch was not pushed", {
      duration: Infinity,
      description: error instanceof Error ? error.message : String(error),
      action: { label: "Retry", onClick: () => void guardedPush() },
    })
  }
}
