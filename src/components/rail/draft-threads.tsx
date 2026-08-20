import { PencilLineIcon } from "lucide-react"
import { workspaceName } from "@/lib/format"
import { useDrafts, type SessionDraft } from "@/state/drafts"
import { actions } from "@/state/session"
import { useTabs } from "@/state/tabs"
import { useThreads } from "@/state/threads"

function sameDrafts(left: SessionDraft[], right: SessionDraft[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (draft, index) =>
        draft.key === right[index]?.key &&
        draft.text === right[index]?.text &&
        draft.updatedAt === right[index]?.updatedAt
    )
  )
}

export function DraftThreads() {
  const tabs = useTabs((state) => state.tabs)
  const activeTabId = useTabs((state) => state.activeId)
  const viewingPath = useThreads((state) => state.viewing?.ref.path)
  const drafts = useDrafts(
    (state) =>
      state.drafts
        .filter(
          (draft) =>
            draft.key !== activeTabId && draft.key !== viewingPath
        )
        .sort((left, right) => right.updatedAt - left.updatedAt),
    sameDrafts
  )
  const rows = drafts.flatMap((draft) => {
    const tab = tabs.find((candidate) => candidate.id === draft.key)
    return tab ? [{ draft, tab }] : []
  })
  if (!rows.length) return null
  return (
    <section className="pt-1 pb-2">
      <p className="flex h-7 items-center gap-1.5 px-1.5 text-label font-medium text-faint">
        <PencilLineIcon className="size-3 opacity-60" />
        Drafts
      </p>
      {rows.slice(0, 4).map(({ draft, tab }) => (
        <button
          key={draft.key}
          type="button"
          onClick={() => void actions.switchTab(tab.id)}
          title={draft.text}
          className="group flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors duration-100 hover:bg-fill-hover"
        >
          <PencilLineIcon className="size-3 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">
            {draft.text.split("\n", 1)[0]}
          </span>
          <span className="max-w-20 shrink-0 truncate text-label text-faint/70">
            {workspaceName(tab.cwd)}
          </span>
        </button>
      ))}
    </section>
  )
}
