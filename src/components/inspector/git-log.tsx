import { useEffect, useState } from "react"
import { Blank } from "@/components/ui/kit"
import { getPi } from "@/lib/bridge"
import { formatRelative } from "@/lib/format"
import { useSession } from "@/state/session"
import { cn } from "@/lib/utils"
import type { GitCommitEntry } from "@/lib/types"
import { GitCommitHorizontalIcon } from "lucide-react"

/**
 * Commit history for the current repository.
 *
 * Read on demand and re-read whenever the working tree changes, which is the
 * cheapest way to stay correct: a commit made here, in a terminal, or by the
 * agent all move the same status, and all three should refresh this list.
 */
export function GitLog() {
  const files = useSession((state) => state.git?.files.length ?? 0)
  const branch = useSession((state) => state.git?.branch)
  const root = useSession((state) => state.git?.root)
  const ahead = useSession((state) => state.git?.ahead ?? 0)

  const [commits, setCommits] = useState<GitCommitEntry[] | null>(null)

  useEffect(() => {
    if (!root) return
    let cancelled = false
    void getPi()
      .gitLog(80)
      .then((next) => {
        if (!cancelled) setCommits(next)
      })
      .catch(() => {
        if (!cancelled) setCommits([])
      })
    return () => {
      cancelled = true
    }
    // `files` participates so the list refreshes after a commit lands.
  }, [root, files, branch])

  if (!root) return null
  if (commits === null) {
    return <p className="shimmer px-2.5 py-2 text-[11.5px]">Reading history…</p>
  }
  if (commits.length === 0) {
    return (
      <Blank
        icon={<GitCommitHorizontalIcon />}
        title="No commits yet"
        body="Once you make the first commit, the history shows up here."
      />
    )
  }

  return (
    <div className="py-1">
      {commits.map((commit, index) => (
        <div
          key={commit.hash}
          className="contain-turn group flex gap-2 px-2.5 py-1 [contain-intrinsic-size:auto_38px]"
        >
          <span className="relative flex w-3 shrink-0 justify-center">
            {index < commits.length - 1 ? (
              <span className="absolute top-3.5 bottom-[-4px] w-px bg-hairline" />
            ) : null}
            <span
              className={cn(
                "relative z-10 mt-[7px] size-1.5 rounded-full",
                // Unpushed commits are the ones still under your control.
                index < ahead ? "bg-caution" : "bg-foreground/30"
              )}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/85">
                {commit.subject}
              </span>
              <span className="tabular shrink-0 text-[10px] text-faint">
                {formatRelative(commit.date)}
              </span>
            </span>
            <span className="flex items-center gap-2 text-[10px] text-faint">
              <span className="font-mono">{commit.shortHash}</span>
              <span className="truncate">{commit.author}</span>
              {commit.insertions || commit.deletions ? (
                <span className="tabular ml-auto shrink-0">
                  <span className="text-added">+{commit.insertions}</span>{" "}
                  <span className="text-removed">−{commit.deletions}</span>
                </span>
              ) : null}
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}
