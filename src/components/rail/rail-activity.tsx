import type { ThreadFolder } from "@/lib/thread-folders"
import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"

export function FolderActivity({ folder }: { folder: ThreadFolder }) {
  const running = folder.running + folder.active
  const state: ActivityState = folder.needsInput ? "waiting" : folder.failed ? "failed" : running ? "working" : folder.unread ? "complete" : "idle"
  if (state === "idle") return null
  const label = folder.needsInput ? `${folder.needsInput} ${folder.needsInput === 1 ? "needs" : "need"} input`
    : folder.failed ? `${folder.failed} failed`
    : running ? `${running} running` : `${folder.unread} to review`
  const description = [
    folder.running ? `${folder.running} running in this Mako` : null,
    folder.active ? `${folder.active} running outside this Mako` : null,
    folder.needsInput ? `${folder.needsInput} awaiting approval` : null,
    folder.failed ? `${folder.failed} failed` : null,
    folder.unread ? `${folder.unread} replies to review` : null,
  ].filter(Boolean).join(", ")
  return (
    <span data-folder-activity={state} title={description} aria-label={`${folder.name}: ${description}`} className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
      <ActivityMark state={state} size={20} />
      <span>{label}</span>
    </span>
  )
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
