import { FileTree } from "@/components/rail/file-tree"
import { AgentThreads } from "@/components/rail/agent-threads"
import { Slot } from "@/extend/slot"
import { setPref, usePrefs, type RailMode } from "@/state/prefs"
import { cn } from "@/lib/utils"


/**
 * The session rail: threads and files, two tabs.
 *
 * Threads is one list for every harness — the unified view lives in
 * AgentThreads, scoped to the project by default. The old split between
 * "this app's sessions" and "everyone else's" was the architecture showing
 * through, and it read as exactly that.
 */
export function SessionRail() {
  const mode = usePrefs((prefs) => prefs.railMode)

  return (
    <aside className="flex h-full min-h-0 flex-col">
      {/* No header here. The workspace name and "new session" live in the
          title strip's left segment, which is this column's header — a window
          has one header, not one per panel. */}
      <RailModes mode={mode} />
      {mode === "files" ? <FileTree /> : <AgentThreads />}
      <Slot name="rail.footer" />
    </aside>
  )
}

/**
 * Threads or the project.
 *
 * Two words rather than two icons: these are the rail's whole contents, they
 * are chosen rarely, and a pair of unlabelled glyphs here would be exactly the
 * mystery-meat navigation the rest of this app avoids.
 */
function RailModes({ mode }: { mode: RailMode }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-3">
      <ModeTab
        label="Threads"
        active={mode !== "files"}
        onClick={() => setPref("railMode", "threads")}
      />
      <ModeTab label="Files" active={mode === "files"} onClick={() => setPref("railMode", "files")} />
    </div>
  )
}

function ModeTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex h-8 items-center text-[11.5px] transition-colors duration-100",
        active ? "text-foreground" : "text-faint hover:text-muted-foreground"
      )}
    >
      {label}
      <span
        className={cn(
          "absolute inset-x-0 -bottom-px h-px bg-foreground/60 transition-opacity duration-150",
          active ? "opacity-100" : "opacity-0"
        )}
      />
    </button>
  )
}
