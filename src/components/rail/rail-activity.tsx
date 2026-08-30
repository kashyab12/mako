import { harnessLabel } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import type { ThreadFolder } from "@/lib/thread-folders"
import {
  Loader2Icon,
  ShieldQuestionIcon,
  TriangleAlertIcon,
} from "lucide-react"

export interface AgentActivity {
  harness: string
  count: number
}

export function ActiveAgents({ activity }: { activity: AgentActivity[] }) {
  if (activity.length === 0) return null
  return (
    <div className="flex h-7 items-center gap-2 overflow-x-auto px-3 text-label text-faint">
      {activity.map((entry) => (
        <span key={entry.harness} className="flex shrink-0 items-center gap-1.5">
          <HarnessIcon harness={entry.harness} className="size-3" />
          <span>{harnessLabel(entry.harness)}</span>
          <span className="size-1.5 animate-live rounded-full bg-current" />
          {entry.count > 1 ? <span>{entry.count} active</span> : <span>active</span>}
        </span>
      ))}
    </div>
  )
}

export function FolderActivity({ folder }: { folder: ThreadFolder }) {
  const working = folder.running ? `${folder.running} working` : null
  if (folder.needsInput)
    return (
      <span className="flex shrink-0 items-center gap-1 text-label text-caution">
        <ShieldQuestionIcon className="size-3" />
        {folder.needsInput} needs input{working ? ` · ${working}` : ""}
      </span>
    )
  if (folder.failed)
    return (
      <span className="flex shrink-0 items-center gap-1 text-label text-negative">
        <TriangleAlertIcon className="size-3" />
        {folder.failed} failed{working ? ` · ${working}` : ""}
      </span>
    )
  if (folder.unread)
    return (
      <span className="shrink-0 text-label text-positive">
        {folder.unread} done{working ? ` · ${working}` : ""}
      </span>
    )
  if (folder.running)
    return (
      <span className="flex shrink-0 items-center gap-1 text-label text-faint">
        <Loader2Icon className="size-3 animate-spin" />
        {working}
      </span>
    )
  if (folder.active)
    return (
      <span className="flex shrink-0 items-center gap-1 text-label text-faint">
        <Loader2Icon className="size-3 animate-spin" />
        {folder.active} active
      </span>
    )
  return null
}

/**
 * The catalog warming up, drawn as the thing it is about to become: two
 * folder groups, a few rows each. Bars breathe together on one slow pulse
 * and stagger their widths so the shape reads as content, not as stripes.
 */
export function RailSkeleton() {
  const widths = [72, 54, 63, 78, 48]
  return (
    <div className="pt-1" aria-hidden>
      {[0, 1].map((group) => (
        <div key={group} className="pb-2">
          <div className="flex h-7 items-center gap-1.5 px-1.5">
            <span className="skeleton size-3.5" />
            <span className="skeleton h-2.5" style={{ width: group === 0 ? 64 : 88 }} />
          </div>
          {widths.slice(0, group === 0 ? 4 : 3).map((width, row) => (
            <div key={row} className="flex h-7 items-center gap-2 pl-[26px] pr-2">
              <span className="skeleton size-3 rounded-full" />
              <span
                className="skeleton h-2.5"
                style={{ width: `${width}%`, opacity: 1 - (group * 4 + row) * 0.09 }}
              />
              <span className="skeleton ml-auto h-2 w-6 opacity-60" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
