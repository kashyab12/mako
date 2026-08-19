import { useCallback, useEffect, useMemo, useState } from "react"
import { Action, IconAction } from "@/components/ui/kit"
import { getMako } from "@/lib/bridge"
import { github, useGitHub } from "@/state/github"
import { actions, useSession } from "@/state/session"
import { prefsStore } from "@/state/prefs"
import { cn } from "@/lib/utils"
import type { CheckSummary, GitHubStatus, PullRequest as Pull } from "@/lib/types"
import {
  CheckIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  RefreshCwIcon,
  SparklesIcon,
  UploadIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

/**
 * The pull request for this branch.
 *
 * Under the commit box rather than in a tab of its own, because it is the end
 * of one continuous motion — stage, commit, push, open — and splitting the last
 * step into separate chrome would make it read as a different activity than it
 * is. It appears only when there is something to say: a PR that exists, or a
 * branch with commits that could become one.
 */
export function PullRequestCard() {
  const status = useGitHub((state) => state.status)
  const pull = useGitHub((state) => state.pull)
  const loading = useGitHub((state) => state.loading)
  const cached = useGitHub((state) => state.branch)

  const branch = useSession((state) => state.git?.branch)
  const ahead = useSession((state) => state.git?.ahead ?? 0)
  const upstream = useSession((state) => state.git?.upstream)
  const behind = useSession((state) => state.git?.behind ?? 0)
  const root = useSession((state) => state.git?.root)
  const [composing, setComposing] = useState(false)
  const [pushing, setPushing] = useState(false)

  const push = useCallback(async function pushBranch() {
    if (pushing) return
    setPushing(true)
    try {
      await getMako().gitPush()
      await actions.refreshGit()
      toast.success("Pushed")
    } catch (error) {
      toast.error("Branch was not pushed", {
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Retry", onClick: () => void pushBranch() },
      })
    } finally {
      setPushing(false)
    }
  }, [pushing])

  useEffect(() => {
    if (!root) return
    if (cached !== branch) void github.refresh(branch)
  }, [branch, cached, root])

  if (!root || !status) return null

  const onDefault = Boolean(status.defaultBranch && branch === status.defaultBranch)
  const unpublished = Boolean(branch) && !upstream
  const hasWork = onDefault ? ahead > 0 : ahead > 0 || unpublished

  if ((!status.installed || !status.authenticated || !status.repo) && !hasWork) {
    return null
  }
  if (!status.installed || !status.authenticated || !status.repo) {
    return <GitHubSetup status={status} />
  }

  if (composing) {
    return <ComposePull base={status.defaultBranch} branch={branch} onDone={() => setComposing(false)} />
  }

  if (pull) return <PullSummary pull={pull} loading={loading} />
  if (!hasWork) return null
  if (behind > 0) {
    return <BehindBranch behind={behind} upstream={upstream} />
  }

  const commits = unpublished && ahead === 0 ? "unpushed" : `${ahead} ${ahead === 1 ? "commit" : "commits"}`

  return (
    <div className="shrink-0 border-t border-hairline px-2.5 py-2">
      <button
        type="button"
        onClick={() => (onDefault ? void push() : setComposing(true))}
        disabled={pushing}
        className={cn(
          "pressable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-[12px] text-muted-foreground transition-colors duration-100 hover:bg-raised hover:text-foreground"
        )}
      >
        {onDefault ? (
          <UploadIcon className="size-3.5 shrink-0" />
        ) : (
          <GitPullRequestIcon className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {onDefault
            ? pushing
              ? `Pushing to ${branch}…`
              : `Push to ${branch}`
            : `Open a pull request for ${branch}`}
        </span>
        <span className="tabular shrink-0 text-[10.5px] text-faint">{commits}</span>
      </button>
    </div>
  )
}

function GitHubSetup({ status }: { status: GitHubStatus }) {
  const copyLogin = () => {
    void navigator.clipboard.writeText("gh auth login")
    toast.success("Copied gh auth login")
  }
  const title = !status.installed
    ? "Install the GitHub CLI to open a pull request"
    : !status.authenticated
      ? "Sign in to GitHub before opening a pull request"
      : "Add a GitHub remote before opening a pull request"
  const detail = !status.installed
    ? "Mako uses the gh CLI so it can reuse your existing GitHub account."
    : !status.authenticated
      ? "Run gh auth login once; Mako will use that login without asking again."
      : "Push this repository to GitHub, then refresh the Changes panel."

  return (
    <div className="shrink-0 border-t border-hairline px-2.5 py-2">
      <div className="flex items-start gap-2 rounded-md bg-surface px-2 py-2 ring-1 ring-hairline">
        <GitPullRequestIcon className="mt-0.5 size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1">
          <span className="block text-[11.5px] text-foreground/90">{title}</span>
          <span className="mt-0.5 block text-[10.5px] leading-relaxed text-faint">{detail}</span>
        </span>
        {status.installed && !status.authenticated ? (
          <Action tone="ghost" size="xs" onClick={copyLogin}>Copy login command</Action>
        ) : null}
      </div>
    </div>
  )
}

function BehindBranch({ behind, upstream }: { behind: number; upstream?: string }) {
  const copyUpdate = () => {
    void navigator.clipboard.writeText("git pull --rebase")
    toast.success("Copied git pull --rebase")
  }
  return (
    <div className="shrink-0 border-t border-hairline px-2.5 py-2">
      <div className="flex items-center gap-2 rounded-md bg-caution/10 px-2 py-1.5 ring-1 ring-caution/20">
        <GitPullRequestIcon className="size-3.5 shrink-0 text-caution" />
        <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
          This branch is {behind} {behind === 1 ? "commit" : "commits"} behind {upstream ?? "its upstream"}. Update it before opening a pull request; Mako will never force-push it.
        </span>
        <Action tone="ghost" size="xs" onClick={copyUpdate}>Copy update command</Action>
      </div>
    </div>
  )
}

/**
 * Drafting the pull request.
 *
 * Nothing is published until the button is pressed, and the button says
 * exactly what it does. The agent can draft the title and body from the diff —
 * the same model, the same idea as the commit draft — but what it writes is a
 * starting point in an editable field, not a thing that happens to you.
 */
function ComposePull({
  base,
  branch,
  onDone,
}: {
  base?: string
  branch?: string
  onDone: () => void
}) {
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [drafting, setDrafting] = useState(false)

  const compose = useCallback(async function composePull() {
    if (drafting) return
    setDrafting(true)
    try {
      // The commit drafter already reads the diff and writes a subject and a
      // body; a pull request wants the same two things from the same source.
      const text = await getMako().generateCommitMessage(prefsStore.get().commitPrompt)
      const [first, ...rest] = text.split("\n")
      setTitle((current) => current || (first ?? "").trim())
      setBody((current) => current || rest.join("\n").trim())
    } catch (error) {
      toast.error("Pull request draft was not generated", {
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Retry", onClick: () => void composePull() },
      })
    } finally {
      setDrafting(false)
    }
  }, [drafting])

  const create = useCallback(async function createPullRequest() {
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const pull = await github.create({ title: title.trim(), body: body.trim(), base, draft })
      toast.success(pull ? `Opened #${pull.number}` : "Pull request opened")
      onDone()
    } catch (error) {
      toast.error("Pull request was not created", {
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Retry", onClick: () => void createPullRequest() },
      })
    } finally {
      setBusy(false)
    }
  }, [base, body, busy, draft, onDone, title])

  return (
    <div className="shrink-0 border-t border-hairline px-2.5 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <GitPullRequestIcon className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint">
          {branch} → {base ?? "the default branch"}
        </span>
        <IconAction label="Draft it from the diff" size="xs" onClick={() => void compose()}>
          <SparklesIcon className={drafting ? "animate-spin" : undefined} />
        </IconAction>
        <IconAction label="Cancel" size="xs" onClick={onDone}>
          <XIcon />
        </IconAction>
      </div>

      <input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title"
        className="mb-1 h-8 w-full rounded-md bg-raised px-2 text-[12.5px] placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-border"
      />
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="What changed, and why"
        rows={4}
        className="w-full resize-none rounded-md bg-raised px-2 py-1.5 text-[12px] leading-relaxed placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-border"
      />

      <div className="mt-1.5 flex items-center gap-2">
        <Action tone="brand" disabled={!title.trim() || busy} onClick={() => void create()}>
          {busy ? "Opening…" : draft ? "Open as draft" : "Create pull request"}
        </Action>
        <button
          type="button"
          onClick={() => setDraft(!draft)}
          className={cn(
            "pressable rounded px-1.5 py-1 text-[11px] transition-colors duration-100",
            draft ? "bg-raised text-foreground" : "text-faint hover:text-foreground"
          )}
        >
          Draft
        </button>
        <span className="ml-auto text-[10.5px] text-faint">pushes the branch first</span>
      </div>
    </div>
  )
}

/** An open pull request, in one line plus whatever CI has to say. */
function PullSummary({ pull, loading }: { pull: Pull; loading: boolean }) {
  const checks = useMemo(() => summarize(pull.checks), [pull.checks])

  return (
    <div className="shrink-0 border-t border-hairline px-2.5 py-2">
      <div className="flex items-center gap-2">
        <GitPullRequestIcon
          className={cn(
            "size-3.5 shrink-0",
            pull.state === "merged"
              ? "text-brand"
              : pull.state === "closed"
                ? "text-removed"
                : pull.draft
                  ? "text-faint"
                  : "text-added"
          )}
        />
        <span className="tabular shrink-0 text-[11.5px] text-faint">#{pull.number}</span>
        <button
          type="button"
          onClick={() => void getMako().openUrl(pull.url)}
          title={pull.url}
          className="min-w-0 flex-1 truncate text-left text-[12px] text-foreground/90 hover:text-foreground"
        >
          {pull.title}
        </button>
        <IconAction
          label="Refresh"
          size="xs"
          onClick={() => void github.refresh(pull.head)}
          data-on={loading || undefined}
        >
          <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
        </IconAction>
        <IconAction label="Open on GitHub" size="xs" onClick={() => void getMako().openUrl(pull.url)}>
          <ExternalLinkIcon />
        </IconAction>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[22px] text-[10.5px] text-faint">
        <span>
          {pull.state === "open" && pull.draft ? "draft" : pull.state} · {pull.base}
        </span>
        <span className="tabular text-added">+{pull.additions}</span>
        <span className="tabular text-removed">−{pull.deletions}</span>

        {checks.total > 0 ? (
          <span
            className={cn(
              "flex items-center gap-1",
              checks.failed > 0 ? "text-removed" : checks.running > 0 ? "text-caution" : "text-added"
            )}
          >
            {checks.failed > 0 ? (
              <XIcon className="size-2.5" />
            ) : checks.running > 0 ? (
              <span className="size-1.5 animate-live rounded-full bg-caution" />
            ) : (
              <CheckIcon className="size-2.5" />
            )}
            {checks.failed > 0
              ? `${checks.failed} failing`
              : checks.running > 0
                ? `${checks.running} running`
                : "checks pass"}
          </span>
        ) : null}

        {pull.reviewDecision === "approved" ? (
          <span className="text-added">approved</span>
        ) : pull.reviewDecision === "changes" ? (
          <span className="text-caution">changes requested</span>
        ) : pull.reviewDecision === "required" ? (
          <span>review needed</span>
        ) : null}

        {pull.mergeable === "conflicting" ? <span className="text-removed">conflicts</span> : null}

        {checks.failed > 0 ? (
          <button
            type="button"
            onClick={() => void github.rerun()}
            className="pressable ml-auto rounded px-1 text-faint hover:text-foreground"
          >
            Re-run failed
          </button>
        ) : null}
      </div>
    </div>
  )
}

function summarize(checks: CheckSummary[]) {
  let passed = 0
  let failed = 0
  let running = 0
  for (const check of checks) {
    if (check.state === "passed") passed += 1
    else if (check.state === "failed") failed += 1
    else if (check.state === "running") running += 1
  }
  return { total: checks.length, passed, failed, running }
}
